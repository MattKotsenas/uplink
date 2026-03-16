import { describe, it, expect } from 'vitest';
import { Session } from '../../src/server/session';

function makeSessionUpdate(sessionId: string, text = 'hello'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
}

describe('Session', () => {
  // ── Lifecycle state machine ────────────────────────────────────────

  describe('state machine', () => {
    it('starts in created state', () => {
      const session = new Session('s1', '/cwd');
      expect(session.state).toBe('created');
    });

    it('activate transitions to active', () => {
      const session = new Session('s1', '/cwd');
      session.activate();
      expect(session.state).toBe('active');
    });

    it('startPrompt transitions to prompting', () => {
      const session = new Session('s1', '/cwd');
      session.activate();
      session.startPrompt(42);
      expect(session.state).toBe('prompting');
      expect(session.hasActivePrompt).toBe(true);
      expect(session.activePromptRequestId).toBe(42);
    });

    it('checkPromptCompletion with matching ID transitions back to active', () => {
      const session = new Session('s1', '/cwd');
      session.activate();
      session.startPrompt(42);

      const completed = session.checkPromptCompletion(
        JSON.stringify({ jsonrpc: '2.0', id: 42, result: { stopReason: 'end_turn' } }),
      );

      expect(completed).toBe(true);
      expect(session.state).toBe('active');
      expect(session.hasActivePrompt).toBe(false);
    });

    it('checkPromptCompletion with wrong ID does not transition', () => {
      const session = new Session('s1', '/cwd');
      session.activate();
      session.startPrompt(42);

      const completed = session.checkPromptCompletion(
        JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }),
      );

      expect(completed).toBe(false);
      expect(session.state).toBe('prompting');
      expect(session.hasActivePrompt).toBe(true);
    });

    it('checkPromptCompletion with no active prompt returns false', () => {
      const session = new Session('s1', '/cwd');
      session.activate();

      const completed = session.checkPromptCompletion(
        JSON.stringify({ jsonrpc: '2.0', id: 42, result: {} }),
      );

      expect(completed).toBe(false);
    });

    it('checkPromptCompletion with invalid JSON returns false', () => {
      const session = new Session('s1', '/cwd');
      session.activate();
      session.startPrompt(42);

      expect(session.checkPromptCompletion('not json')).toBe(false);
      expect(session.state).toBe('prompting');
    });
  });

  // ── Message log ────────────────────────────────────────────────────

  describe('message log', () => {
    it('recordUpdate appends to history', () => {
      const session = new Session('s1', '/cwd');
      const line = makeSessionUpdate('s1');
      session.recordUpdate(line);
      session.recordUpdate(line);

      expect(session.history).toHaveLength(2);
      expect(session.history[0]).toBe(line);
    });

    it('recordUserMessage creates user_message_chunk entries', () => {
      const session = new Session('s1', '/cwd');
      session.recordUserMessage('s1', [{ type: 'text', text: 'hello world' }]);

      expect(session.history).toHaveLength(1);
      const parsed = JSON.parse(session.history[0]);
      expect(parsed.params.update.sessionUpdate).toBe('user_message_chunk');
      expect(parsed.params.update.content.text).toBe('hello world');
    });

    it('clearHistory empties the log', () => {
      const session = new Session('s1', '/cwd');
      session.recordUpdate(makeSessionUpdate('s1'));
      session.recordUpdate(makeSessionUpdate('s1'));
      expect(session.history).toHaveLength(2);

      session.clearHistory();
      expect(session.history).toHaveLength(0);
    });

    it('history is always available (no buffer creation needed)', () => {
      // This is the key design improvement: history is always ready to
      // accept updates. No "ensureBuffer" required.
      const session = new Session('s1', '/cwd');
      session.recordUpdate(makeSessionUpdate('s1'));
      expect(session.history).toHaveLength(1);
    });
  });

  // ── Session result ─────────────────────────────────────────────────

  describe('session result', () => {
    it('defaults to empty object', () => {
      const session = new Session('s1', '/cwd');
      expect(session.result).toBe('{}');
    });

    it('can be set from constructor', () => {
      const result = JSON.stringify({ sessionId: 's1', models: {} });
      const session = new Session('s1', '/cwd', result);
      expect(session.result).toBe(result);
    });

    it('can be updated', () => {
      const session = new Session('s1', '/cwd');
      const newResult = JSON.stringify({ sessionId: 's1', extra: 'data' });
      session.result = newResult;
      expect(session.result).toBe(newResult);
    });
  });

  // ── Snapshot ────────────────────────────────────────────────────────

  describe('snapshot', () => {
    it('returns current state for diagnostics', () => {
      const session = new Session('s1', '/cwd');
      session.activate();
      session.recordUpdate(makeSessionUpdate('s1'));
      session.recordUpdate(makeSessionUpdate('s1'));
      session.startPrompt(42);

      const snap = session.snapshot();
      expect(snap.historyLength).toBe(2);
      expect(snap.hasActivePrompt).toBe(true);
      expect(snap.state).toBe('prompting');
    });
  });
});
