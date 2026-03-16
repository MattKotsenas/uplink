import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../../src/server/session-store';

function makeSessionUpdate(sessionId: string, update: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', ...update } },
  });
}

function makeJsonRpcResponse(id: number | string, result: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  // ── getOrCreate and replay ────────────────────────────────────────

  describe('getOrCreate and replay', () => {
    it('creates a session and records updates for replay', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd', '{"sessionId":"sess-1"}');
      store.activeSessionId = 'sess-1';

      const line = makeSessionUpdate('sess-1');
      session.recordUpdate(line);

      expect(session.history).toHaveLength(1);
      expect(session.history[0]).toBe(line);
      expect(session.result).toBe('{"sessionId":"sess-1"}');
    });

    it('returns existing session on second call', () => {
      const s1 = store.getOrCreate('sess-1', '/test/cwd', '{"a":1}');
      const s2 = store.getOrCreate('sess-1', '/test/cwd', '{"a":2}');
      expect(s1).toBe(s2);
      // Result is NOT overwritten by second call
      expect(s1.result).toBe('{"a":1}');
    });

    it('returns undefined for unknown session via get', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });
  });

  // ── Prompt tracking ───────────────────────────────────────────────

  describe('prompt tracking', () => {
    it('startPrompt sets active prompt and hasActivePrompt is true', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';

      session.startPrompt(42);
      session.recordUserMessage('sess-1', [{ type: 'text', text: 'hello' }]);

      expect(session.hasActivePrompt).toBe(true);
    });

    it('checkPromptCompletion with matching ID clears active prompt', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';
      session.startPrompt(42);
      session.recordUserMessage('sess-1', [{ type: 'text', text: 'hello' }]);

      session.checkPromptCompletion(makeJsonRpcResponse(42));

      expect(session.hasActivePrompt).toBe(false);
    });

    it('checkPromptCompletion with wrong ID does not clear active prompt', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';
      session.startPrompt(42);
      session.recordUserMessage('sess-1', [{ type: 'text', text: 'hello' }]);

      session.checkPromptCompletion(makeJsonRpcResponse(999));

      expect(session.hasActivePrompt).toBe(true);
    });

    it('recordUserMessage adds user_message_chunk into history', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';

      session.startPrompt(42);
      session.recordUserMessage('sess-1', [{ type: 'text', text: 'my prompt' }]);

      expect(session.history).toHaveLength(1);
      const parsed = JSON.parse(session.history[0]);
      expect(parsed.method).toBe('session/update');
      expect(parsed.params.update.sessionUpdate).toBe('user_message_chunk');
      expect(parsed.params.update.content.text).toBe('my prompt');
    });
  });

  // ── Session capture ───────────────────────────────────────────────

  describe('session capture', () => {
    it('getOrCreate + registerRecent tracks new sessions', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd', '{"sessionId":"sess-1"}');
      store.activeSessionId = 'sess-1';
      store.registerRecent('sess-1', '/test/cwd');

      expect(store.activeSessionId).toBe('sess-1');
      expect(store.get('sess-1')).toBe(session);

      const sessions = store.list('/test/cwd');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('sess-1');
    });

    it('updating session result works via setter', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';

      const newResult = { sessionId: 'sess-1', extra: 'data' };
      session.result = JSON.stringify(newResult);

      expect(JSON.parse(session.result)).toEqual(newResult);
    });
  });

  // ── Reset ─────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all sessions and activeSessionId', () => {
      store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';
      store.registerRecent('sess-1', '/test/cwd');

      store.reset();

      expect(store.activeSessionId).toBeNull();
      expect(store.get('sess-1')).toBeUndefined();
      expect(store.list('/test/cwd')).toHaveLength(0);
    });
  });

  // ── Session listing ───────────────────────────────────────────────

  describe('list', () => {
    it('returns recentSessions filtered by cwd', () => {
      store.getOrCreate('sess-a', '/cwd/one');
      store.registerRecent('sess-a', '/cwd/one');
      store.getOrCreate('sess-b', '/cwd/two');
      store.registerRecent('sess-b', '/cwd/two');

      const cwdOneSessions = store.list('/cwd/one');
      expect(cwdOneSessions).toHaveLength(1);
      expect(cwdOneSessions[0].id).toBe('sess-a');

      const cwdTwoSessions = store.list('/cwd/two');
      expect(cwdTwoSessions).toHaveLength(1);
      expect(cwdTwoSessions[0].id).toBe('sess-b');
    });
  });

  // ── clearHistory ──────────────────────────────────────────────────

  describe('clearHistory', () => {
    it('empties history array but keeps the session', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';
      session.recordUpdate(makeSessionUpdate('sess-1'));
      expect(session.history).toHaveLength(1);

      session.clearHistory();

      expect(store.get('sess-1')).toBeDefined();
      expect(session.history).toHaveLength(0);
    });
  });

  // ── has ───────────────────────────────────────────────────────────

  describe('has', () => {
    it('returns true for existing session', () => {
      store.getOrCreate('sess-1', '/test/cwd');
      expect(store.has('sess-1')).toBe(true);
    });

    it('returns false for nonexistent session', () => {
      expect(store.has('nonexistent')).toBe(false);
    });
  });

  // ── getOrCreate eliminates the ensureBuffer bug ───────────────────

  describe('getOrCreate (replaces ensureBuffer)', () => {
    it('session always exists when recording updates - no lost notifications', () => {
      // Simulates session/load forward: getOrCreate is called BEFORE the CLI
      // replays, so updates are never lost.
      store.activeSessionId = 'forwarded-sess';
      const session = store.getOrCreate('forwarded-sess', '/test/cwd');

      // CLI replays history (these arrive before the session/load response)
      session.recordUpdate(makeSessionUpdate('forwarded-sess'));
      session.recordUpdate(makeSessionUpdate('forwarded-sess'));

      // Then the session/load response arrives
      session.result = JSON.stringify({ sessionId: 'forwarded-sess' });

      expect(session.history).toHaveLength(2);
      expect(JSON.parse(session.result).sessionId).toBe('forwarded-sess');
    });
  });

  // ── snapshot ──────────────────────────────────────────────────────

  describe('snapshot', () => {
    it('returns current state for diagnostics', () => {
      const session = store.getOrCreate('sess-1', '/test/cwd');
      store.activeSessionId = 'sess-1';
      store.registerRecent('sess-1', '/test/cwd');
      session.recordUpdate(makeSessionUpdate('sess-1'));
      session.startPrompt(42);

      const snap = store.snapshot();
      expect(snap.activeSessionId).toBe('sess-1');
      expect(snap.buffers['sess-1'].historyLength).toBe(1);
      expect(snap.buffers['sess-1'].hasActivePrompt).toBe(true);
      expect(snap.recentSessionCount).toBe(1);
    });
  });
});
