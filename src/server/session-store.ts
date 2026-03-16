import type { SessionInfo } from '../shared/acp-types.js';
import { Session } from './session.js';
import createDebug from 'debug';

const log = createDebug('uplink:session');

export class SessionStore {
  activeSessionId: string | null = null;

  private readonly sessions = new Map<string, Session>();

  // In-memory supplement for session listing. Tracks sessions created during
  // this bridge's lifetime because the CLI's session/list doesn't index them
  // until the next CLI process restart.
  private readonly recentSessions = new Map<string, SessionInfo>();

  /** Get or create a session. If the session already exists, returns it as-is. */
  getOrCreate(sessionId: string, cwd: string, result?: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Session(sessionId, cwd, result);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** Get an existing session (returns undefined if not found). */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Check if a session exists. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Register a session in the recent sessions listing. */
  registerRecent(sessionId: string, cwd: string): void {
    this.recentSessions.set(sessionId, {
      id: sessionId,
      cwd,
      title: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Update title in recentSessions. */
  updateSessionTitle(sessionId: string, title: string): void {
    const info = this.recentSessions.get(sessionId);
    if (info) info.title = title;
  }

  /** Return recentSessions filtered by cwd. */
  list(cwd: string): SessionInfo[] {
    return [...this.recentSessions.values()].filter(s => s.cwd === cwd);
  }

  /** Clear all state (called when bridge dies). */
  reset(): void {
    this.activeSessionId = null;
    this.sessions.clear();
    this.recentSessions.clear();
  }

  /** Return a snapshot of store state for diagnostics. */
  snapshot(): {
    activeSessionId: string | null;
    buffers: Record<string, { historyLength: number; hasActivePrompt: boolean }>;
    recentSessionCount: number;
  } {
    const buffers: Record<string, { historyLength: number; hasActivePrompt: boolean }> = {};
    for (const [id, session] of this.sessions) {
      buffers[id] = {
        historyLength: session.history.length,
        hasActivePrompt: session.hasActivePrompt,
      };
    }
    return {
      activeSessionId: this.activeSessionId,
      buffers,
      recentSessionCount: this.recentSessions.size,
    };
  }
}
