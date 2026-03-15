import type { SessionInfo } from '../shared/acp-types.js';
import createDebug from 'debug';

const log = createDebug('uplink:session');

export interface SessionBufferEntry {
  result: string;
  history: string[];
  /** JSON-RPC ID of the in-flight session/prompt (set when forwarded to bridge, cleared on response). */
  activePromptRequestId?: number | string;
}

export class SessionBuffer {
  activeSessionId: string | null = null;

  private readonly sessionBuffers = new Map<string, SessionBufferEntry>();

  // In-memory supplement for session listing. Tracks sessions created during
  // this bridge's lifetime because the CLI's session/list doesn't index them
  // until the next CLI process restart.
  private readonly recentSessions = new Map<string, SessionInfo>();

  constructor(private readonly cwd: string) {}

  /** Buffer a session/update notification for replay on reconnect. */
  bufferUpdate(line: string): void {
    if (!this.activeSessionId) return;
    if (!line.includes('"session/update"')) return;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'session/update') {
        const sid = msg.params?.sessionId;
        const buf = sid ? this.sessionBuffers.get(sid) : undefined;
        if (buf) buf.history.push(line);
      }
    } catch { /* Not valid JSON - ignore malformed message */ }
  }

  /** Track when a prompt response arrives, clear activePromptRequestId. */
  trackPromptCompletion(line: string): void {
    if (!this.activeSessionId) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const buf = this.sessionBuffers.get(this.activeSessionId);
        if (buf?.activePromptRequestId != null && msg.id === buf.activePromptRequestId) {
          buf.activePromptRequestId = undefined;
        }
      }
    } catch { /* Not valid JSON - ignore malformed message */ }
  }

  /** Capture session/new result, create buffer entry and recentSessions entry. */
  captureNewSession(requestId: number | string, line: string, cwd: string): boolean {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && msg.id === requestId && msg.result?.sessionId) {
        const newSid = msg.result.sessionId;
        this.activeSessionId = newSid;
        this.sessionBuffers.set(newSid, { result: JSON.stringify(msg.result), history: [] });
        this.recentSessions.set(newSid, {
          id: newSid,
          cwd,
          title: null,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
    } catch {
      // Not valid JSON — ignore
    }
    return false;
  }

  /** Capture session/load result, update buffer. */
  captureLoadSession(requestId: number | string, line: string): boolean {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && msg.id === requestId && msg.result) {
        if (this.activeSessionId) {
          const buf = this.sessionBuffers.get(this.activeSessionId);
          if (buf) buf.result = JSON.stringify(msg.result);
        }
        return true;
      }
    } catch { /* Not valid JSON - ignore malformed message */ }
    return false;
  }

  /** Get replay data for a session. Returns null if no buffer exists. */
  replaySession(sessionId: string): { result: string; history: string[]; promptInProgress: boolean } | null {
    const buf = this.sessionBuffers.get(sessionId);
    if (!buf) return null;
    log('replaying %d buffered updates for session %s', buf.history.length, sessionId);
    this.activeSessionId = sessionId;
    return {
      result: buf.result,
      history: buf.history,
      promptInProgress: buf.activePromptRequestId != null,
    };
  }

  /** Buffer outgoing prompt as user_message_chunk and set activePromptRequestId. */
  trackPrompt(
    requestId: number | string,
    sessionId: string,
    prompt: Array<{ type: string; text?: string }>,
  ): void {
    const buf = this.sessionBuffers.get(sessionId);
    if (!buf) return;
    buf.activePromptRequestId = requestId;
    for (const part of prompt) {
      if (part.type === 'text' && part.text) {
        buf.history.push(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: part.text } },
          },
        }));
      }
    }
  }

  /** Clear history for a session. */
  clearHistory(sessionId: string): void {
    const buf = this.sessionBuffers.get(sessionId);
    if (buf) buf.history = [];
  }

  /** Update title in recentSessions. */
  updateSessionTitle(sessionId: string, title: string): void {
    const info = this.recentSessions.get(sessionId);
    if (info) info.title = title;
  }

  /** Return recentSessions filtered by cwd. */
  listSessions(cwd: string): SessionInfo[] {
    return [...this.recentSessions.values()].filter(s => s.cwd === cwd);
  }

  /** Clear all state (called when bridge dies). */
  reset(): void {
    this.activeSessionId = null;
    this.sessionBuffers.clear();
    this.recentSessions.clear();
  }
}
