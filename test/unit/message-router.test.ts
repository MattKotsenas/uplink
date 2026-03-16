import { describe, it, expect } from 'vitest';
import { routeBridgeMessage, routeClientMessage } from '../../src/server/message-router.js';
import { SessionStore } from '../../src/server/session-store.js';

// ─── routeBridgeMessage ───────────────────────────────────────────────

describe('routeBridgeMessage', () => {
  const baseOpts = {
    eagerInitId: null as string | null,
    pendingServerRpcIds: new Set<number | string>(),
    wsOpen: true,
  };

  it('returns eager_init_resolved when response matches eager init ID', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: '__eager_init__', result: { protocolVersion: 1 } });
    const action = routeBridgeMessage(line, { ...baseOpts, eagerInitId: '__eager_init__' });
    expect(action).toEqual({
      type: 'eager_init_resolved',
      response: JSON.stringify({ protocolVersion: 1 }),
    });
  });

  it('returns eager_init_rejected when error matches eager init ID', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: '__eager_init__', error: { code: -1, message: 'init failed' } });
    const action = routeBridgeMessage(line, { ...baseOpts, eagerInitId: '__eager_init__' });
    expect(action).toEqual({
      type: 'eager_init_rejected',
      error: 'init failed',
    });
  });

  it('forwards non-eager-init messages even when init is pending', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} });
    const action = routeBridgeMessage(line, { ...baseOpts, eagerInitId: '__eager_init__' });
    expect(action).toEqual({ type: 'forward', line });
  });

  it('returns server_rpc_resolved for matching server RPC ID', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 100001, result: { sessions: [] } });
    const action = routeBridgeMessage(line, {
      ...baseOpts,
      pendingServerRpcIds: new Set([100001]),
    });
    expect(action).toEqual({
      type: 'server_rpc_resolved',
      id: 100001,
      result: { sessions: [] },
    });
  });

  it('returns server_rpc_rejected for matching server RPC ID with error', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 100001, error: { code: -1, message: 'timeout' } });
    const action = routeBridgeMessage(line, {
      ...baseOpts,
      pendingServerRpcIds: new Set([100001]),
    });
    expect(action).toEqual({
      type: 'server_rpc_rejected',
      id: 100001,
      error: 'timeout',
    });
  });

  it('forwards normal messages when WS is open', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } });
    const action = routeBridgeMessage(line, baseOpts);
    expect(action).toEqual({ type: 'forward', line });
  });

  it('drops normal messages when WS is closed', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} });
    const action = routeBridgeMessage(line, { ...baseOpts, wsOpen: false });
    expect(action).toEqual({ type: 'drop' });
  });

  it('forwards invalid JSON when WS is open', () => {
    const line = 'not json at all';
    const action = routeBridgeMessage(line, baseOpts);
    expect(action).toEqual({ type: 'forward', line });
  });

  it('drops invalid JSON when WS is closed', () => {
    const line = 'not json at all';
    const action = routeBridgeMessage(line, { ...baseOpts, wsOpen: false });
    expect(action).toEqual({ type: 'drop' });
  });
});

// ─── routeClientMessage ──────────────────────────────────────────────

describe('routeClientMessage', () => {
  function makeStore(): SessionStore {
    return new SessionStore();
  }

  const baseOpts = {
    cachedInitializeResponse: null as string | null,
    hasInitializePromise: false,
    sessionStore: makeStore(),
    cwd: '/test/cwd',
  };

  it('returns shell action for uplink/shell', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'uplink/shell', params: { command: 'echo hi' } });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'shell', id: 1, command: 'echo hi' });
  });

  it('returns shell action with empty command when command is missing', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'uplink/shell', params: {} });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'shell', id: 1, command: '' });
  });

  it('returns clear_history for uplink/clear_history', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'uplink/clear_history', params: { sessionId: 's1' } });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'clear_history', id: 2, sessionId: 's1' });
  });

  it('returns noop for uplink/clear_history without sessionId', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'uplink/clear_history', params: {} });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'noop' });
  });

  it('returns rename_session for valid params', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'uplink/rename_session',
      params: { sessionId: 's1', summary: 'new name' },
    });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'rename_session', id: 3, sessionId: 's1', summary: 'new name' });
  });

  it('returns rename_session_error when params are missing', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'uplink/rename_session',
      params: { sessionId: 's1' },
    });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'rename_session_error', id: 3, message: 'Missing sessionId or summary' });
  });

  it('returns initialize_cached when cached response exists', () => {
    const cached = JSON.stringify({ protocolVersion: 1 });
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const action = routeClientMessage(raw, { ...baseOpts, cachedInitializeResponse: cached });
    expect(action).toEqual({ type: 'initialize_cached', id: 1, response: cached });
  });

  it('returns initialize_pending when promise exists but no cache', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const action = routeClientMessage(raw, { ...baseOpts, hasInitializePromise: true });
    expect(action).toEqual({ type: 'initialize_pending', id: 1 });
  });

  it('returns initialize_error when no bridge and no promise', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'initialize_error', id: 1, message: 'Bridge not available' });
  });

  it('returns session_load_replay when session exists in store', () => {
    const store = makeStore();
    const sessionId = 'test-session-1';
    store.getOrCreate(sessionId, '/test/cwd', JSON.stringify({ sessionId }));

    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'session/load',
      params: { sessionId },
    });
    const action = routeClientMessage(raw, { ...baseOpts, sessionStore: store });
    expect(action.type).toBe('session_load_replay');
    if (action.type === 'session_load_replay') {
      expect(action.id).toBe(5);
      expect(action.sessionId).toBe(sessionId);
    }
  });

  it('returns session_load_forward when no session exists', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'session/load',
      params: { sessionId: 'unknown-session' },
    });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({
      type: 'session_load_forward',
      id: 5,
      sessionId: 'unknown-session',
    });
  });

  it('returns forward with trackPrompt for session/prompt', () => {
    const store = makeStore();
    store.activeSessionId = 's1';

    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'session/prompt',
      params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] },
    });
    const action = routeClientMessage(raw, { ...baseOpts, sessionStore: store });
    expect(action.type).toBe('forward');
    if (action.type === 'forward') {
      expect(action.trackPrompt).toEqual({
        id: 7,
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'hello' }],
      });
    }
  });

  it('returns forward with trackSessionNew for session/new', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'session/new',
      params: { cwd: '/test', mcpServers: [] },
    });
    const action = routeClientMessage(raw, baseOpts);
    expect(action.type).toBe('forward');
    if (action.type === 'forward') {
      expect(action.trackSessionNew).toBe(6);
    }
  });

  it('returns plain forward for regular messages', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } });
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'forward', raw });
  });

  it('returns forward for invalid JSON', () => {
    const raw = 'not valid json';
    const action = routeClientMessage(raw, baseOpts);
    expect(action).toEqual({ type: 'forward', raw });
  });

  it('does not track prompt when no active session', () => {
    const store = makeStore();
    // activeSessionId is null by default
    const raw = JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'session/prompt',
      params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] },
    });
    const action = routeClientMessage(raw, { ...baseOpts, sessionStore: store });
    expect(action.type).toBe('forward');
    if (action.type === 'forward') {
      expect(action.trackPrompt).toBeUndefined();
    }
  });
});
