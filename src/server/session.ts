/**
 * Per-session state machine and message log.
 *
 * Each Session tracks:
 * - Lifecycle state (created → active → prompting → active)
 * - An append-only log of session/update JSON lines for replay
 * - The session/new or session/load result for replaying the initial response
 * - In-flight prompt tracking for reconnect awareness
 *
 * Sessions are created once and live for the lifetime of the bridge.
 * The server maintains a Map<string, Session> for all known sessions.
 */

export type SessionState = 'created' | 'active' | 'prompting';

export class Session {
  private _state: SessionState = 'created';
  private _activePromptRequestId: number | string | undefined;
  private _result: string;
  private readonly _history: string[] = [];
  readonly cwd: string;
  title: string | null;
  readonly createdAt: string;

  constructor(
    readonly id: string,
    cwd: string,
    result: string = '{}',
  ) {
    this.cwd = cwd;
    this._result = result;
    this.title = null;
    this.createdAt = new Date().toISOString();
  }

  // ─── State machine ──────────────────────────────────────────────────

  get state(): SessionState {
    return this._state;
  }

  /** Mark the session as active (prompt completed or initial setup done). */
  activate(): void {
    this._state = 'active';
    this._activePromptRequestId = undefined;
  }

  /** Record that a prompt was sent. */
  startPrompt(requestId: number | string): void {
    this._state = 'prompting';
    this._activePromptRequestId = requestId;
  }

  /** Check if a JSON-RPC response completes the in-flight prompt. */
  checkPromptCompletion(line: string): boolean {
    if (this._activePromptRequestId == null) return false;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && msg.id === this._activePromptRequestId) {
        this.activate();
        return true;
      }
    } catch { /* Not valid JSON */ }
    return false;
  }

  get hasActivePrompt(): boolean {
    return this._activePromptRequestId != null;
  }

  get activePromptRequestId(): number | string | undefined {
    return this._activePromptRequestId;
  }

  // ─── Message log ────────────────────────────────────────────────────

  /** Record a raw session/update JSON line. */
  recordUpdate(line: string): void {
    this._history.push(line);
  }

  /** Record a user message (from session/prompt params). */
  recordUserMessage(sessionId: string, prompt: Array<{ type: string; text?: string }>): void {
    for (const part of prompt) {
      if (part.type === 'text' && part.text) {
        this._history.push(JSON.stringify({
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

  /** Get all recorded history lines for replay. */
  get history(): readonly string[] {
    return this._history;
  }

  /** Clear the history log (e.g., /clear command). */
  clearHistory(): void {
    this._history.length = 0;
  }

  // ─── Session result ─────────────────────────────────────────────────

  /** Get the session result (from session/new or session/load response). */
  get result(): string {
    return this._result;
  }

  /** Update the session result (e.g., when session/load response arrives). */
  set result(value: string) {
    this._result = value;
  }

  // ─── Snapshot for diagnostics ───────────────────────────────────────

  snapshot(): { historyLength: number; hasActivePrompt: boolean; state: SessionState } {
    return {
      historyLength: this._history.length,
      hasActivePrompt: this.hasActivePrompt,
      state: this._state,
    };
  }
}
