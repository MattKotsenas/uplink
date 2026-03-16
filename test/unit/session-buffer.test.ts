import { describe, it, expect, beforeEach } from 'vitest';
import { SessionBuffer } from '../../src/server/session-buffer';

function makeSessionNewResponse(id: number | string, sessionId: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId } });
}

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

describe('SessionBuffer', () => {
  let buffer: SessionBuffer;

  beforeEach(() => {
    buffer = new SessionBuffer('/test/cwd');
  });

  // ── Buffer and replay ─────────────────────────────────────────────

  describe('buffer and replay', () => {
    it('buffers session/update lines and replays them', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      const line = makeSessionUpdate('sess-1');
      buffer.bufferUpdate(line);

      const replay = buffer.replaySession('sess-1');
      expect(replay).not.toBeNull();
      expect(replay!.history).toHaveLength(1);
      expect(replay!.history[0]).toBe(line);
    });

    it('does not buffer lines without session/update method', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      buffer.bufferUpdate(JSON.stringify({ jsonrpc: '2.0', method: 'other/method', params: {} }));

      const replay = buffer.replaySession('sess-1');
      expect(replay!.history).toHaveLength(0);
    });

    it('does not buffer lines for wrong session ID', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      buffer.bufferUpdate(makeSessionUpdate('sess-OTHER'));

      const replay = buffer.replaySession('sess-1');
      expect(replay!.history).toHaveLength(0);
    });

    it('returns null for unknown session', () => {
      expect(buffer.replaySession('nonexistent')).toBeNull();
    });
  });

  // ── Prompt tracking ───────────────────────────────────────────────

  describe('prompt tracking', () => {
    it('trackPrompt sets activePromptRequestId and replay shows promptInProgress', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      buffer.trackPrompt(42, 'sess-1', [{ type: 'text', text: 'hello' }]);

      const replay = buffer.replaySession('sess-1');
      expect(replay!.promptInProgress).toBe(true);
    });

    it('trackPromptCompletion with matching ID clears promptInProgress', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');
      buffer.trackPrompt(42, 'sess-1', [{ type: 'text', text: 'hello' }]);

      buffer.trackPromptCompletion(makeJsonRpcResponse(42));

      const replay = buffer.replaySession('sess-1');
      expect(replay!.promptInProgress).toBe(false);
    });

    it('trackPromptCompletion with wrong ID does not clear promptInProgress', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');
      buffer.trackPrompt(42, 'sess-1', [{ type: 'text', text: 'hello' }]);

      buffer.trackPromptCompletion(makeJsonRpcResponse(999));

      const replay = buffer.replaySession('sess-1');
      expect(replay!.promptInProgress).toBe(true);
    });

    it('trackPrompt buffers user_message_chunk into history', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      buffer.trackPrompt(42, 'sess-1', [{ type: 'text', text: 'my prompt' }]);

      const replay = buffer.replaySession('sess-1');
      expect(replay!.history).toHaveLength(1);
      const parsed = JSON.parse(replay!.history[0]);
      expect(parsed.method).toBe('session/update');
      expect(parsed.params.update.sessionUpdate).toBe('user_message_chunk');
      expect(parsed.params.update.content.text).toBe('my prompt');
    });
  });

  // ── Session capture ───────────────────────────────────────────────

  describe('session capture', () => {
    it('captureNewSession creates buffer entry, sets activeSessionId, adds to recentSessions', () => {
      const captured = buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      expect(captured).toBe(true);
      expect(buffer.activeSessionId).toBe('sess-1');
      expect(buffer.replaySession('sess-1')).not.toBeNull();

      const sessions = buffer.listSessions('/test/cwd');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('sess-1');
    });

    it('captureLoadSession updates existing buffer result', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');

      const newResult = { sessionId: 'sess-1', extra: 'data' };
      const captured = buffer.captureLoadSession(2, makeJsonRpcResponse(2, newResult));

      expect(captured).toBe(true);
      const replay = buffer.replaySession('sess-1');
      expect(JSON.parse(replay!.result)).toEqual(newResult);
    });
  });

  // ── Reset ─────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all buffers, sessions, and activeSessionId', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');
      buffer.bufferUpdate(makeSessionUpdate('sess-1'));

      buffer.reset();

      expect(buffer.activeSessionId).toBeNull();
      expect(buffer.replaySession('sess-1')).toBeNull();
      expect(buffer.listSessions('/test/cwd')).toHaveLength(0);
    });
  });

  // ── Session listing ───────────────────────────────────────────────

  describe('listSessions', () => {
    it('returns recentSessions filtered by cwd', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-a'), '/cwd/one');
      buffer.captureNewSession(2, makeSessionNewResponse(2, 'sess-b'), '/cwd/two');

      const cwdOneSessions = buffer.listSessions('/cwd/one');
      expect(cwdOneSessions).toHaveLength(1);
      expect(cwdOneSessions[0].id).toBe('sess-a');

      const cwdTwoSessions = buffer.listSessions('/cwd/two');
      expect(cwdTwoSessions).toHaveLength(1);
      expect(cwdTwoSessions[0].id).toBe('sess-b');
    });
  });

  // ── clearHistory ──────────────────────────────────────────────────

  describe('clearHistory', () => {
    it('empties history array but keeps the buffer entry', () => {
      buffer.captureNewSession(1, makeSessionNewResponse(1, 'sess-1'), '/test/cwd');
      buffer.bufferUpdate(makeSessionUpdate('sess-1'));
      expect(buffer.replaySession('sess-1')!.history).toHaveLength(1);

      buffer.clearHistory('sess-1');

      const replay = buffer.replaySession('sess-1');
      expect(replay).not.toBeNull();
      expect(replay!.history).toHaveLength(0);
    });
  });

  // ── ensureBuffer (session/load forward path) ─────────────────────

  describe('ensureBuffer', () => {
    it('creates buffer entry so bufferUpdate captures replayed notifications', () => {
      // Simulates session/load forward: activeSessionId is set and buffer
      // is ensured BEFORE the CLI replays. Without ensureBuffer, the
      // replayed session/update notifications would be silently dropped.
      buffer.activeSessionId = 'forwarded-sess';
      buffer.ensureBuffer('forwarded-sess');

      // CLI replays history (these arrive before the session/load response)
      buffer.bufferUpdate(makeSessionUpdate('forwarded-sess'));
      buffer.bufferUpdate(makeSessionUpdate('forwarded-sess'));

      // Then the session/load response arrives
      buffer.captureLoadSession(99, makeJsonRpcResponse(99, { sessionId: 'forwarded-sess' }));

      const replay = buffer.replaySession('forwarded-sess');
      expect(replay).not.toBeNull();
      expect(replay!.history).toHaveLength(2);
    });

    it('without ensureBuffer, replayed notifications are lost', () => {
      // This is the bug: activeSessionId is set but no buffer exists.
      // bufferUpdate silently drops the notifications.
      buffer.activeSessionId = 'forwarded-sess';
      // NO ensureBuffer call

      buffer.bufferUpdate(makeSessionUpdate('forwarded-sess'));
      buffer.bufferUpdate(makeSessionUpdate('forwarded-sess'));

      // captureLoadSession creates the buffer entry, but too late
      buffer.captureLoadSession(99, makeJsonRpcResponse(99, { sessionId: 'forwarded-sess' }));

      const replay = buffer.replaySession('forwarded-sess');
      // Buffer exists (from captureLoadSession) but history is empty
      expect(replay).not.toBeNull();
      expect(replay!.history).toHaveLength(0); // BUG: should be 2
    });
  });
});
