import type { SessionStore } from './session-store.js';

// ─── Bridge → Client routing ─────────────────────────────────────────

export type BridgeMessageAction =
  | { type: 'eager_init_resolved'; response: string }
  | { type: 'eager_init_rejected'; error: string }
  | { type: 'server_rpc_resolved'; id: number | string; result: unknown }
  | { type: 'server_rpc_rejected'; id: number | string; error: string }
  | { type: 'forward'; line: string }
  | { type: 'drop' };

export function routeBridgeMessage(
  line: string,
  opts: {
    eagerInitId: string | null;
    pendingServerRpcIds: Set<number | string>;
    wsOpen: boolean;
  },
): BridgeMessageAction {
  try {
    const msg = JSON.parse(line);

    // Check eager init response
    if (opts.eagerInitId !== null && msg.id === opts.eagerInitId) {
      if (msg.result) {
        return { type: 'eager_init_resolved', response: JSON.stringify(msg.result) };
      }
      if (msg.error) {
        return { type: 'eager_init_rejected', error: msg.error.message ?? 'Eager initialize failed' };
      }
    }

    // Check server-originated RPC response
    if (msg.id != null && opts.pendingServerRpcIds.has(msg.id)) {
      if (msg.error) {
        return { type: 'server_rpc_rejected', id: msg.id, error: msg.error.message ?? 'RPC error' };
      }
      return { type: 'server_rpc_resolved', id: msg.id, result: msg.result };
    }
  } catch {
    // Not valid JSON - fall through to forward/drop
  }

  if (!opts.wsOpen) {
    return { type: 'drop' };
  }

  return { type: 'forward', line };
}

// ─── Client → Bridge routing ─────────────────────────────────────────

export type ClientMessageAction =
  | { type: 'shell'; id: number | string | undefined; command: string }
  | { type: 'clear_history'; id: number | string | undefined; sessionId: string }
  | { type: 'rename_session'; id: number | string; sessionId: string; summary: string }
  | { type: 'rename_session_error'; id: number | string; message: string }
  | { type: 'initialize_cached'; id: number | string; response: string }
  | { type: 'initialize_pending'; id: number | string }
  | { type: 'initialize_error'; id: number | string; message: string }
  | { type: 'session_load_replay'; id: number | string; sessionId: string }
  | { type: 'session_load_forward'; id: number | string; sessionId: string }
  | { type: 'forward'; raw: string; trackSessionNew?: number | string; trackPrompt?: { id: number | string; sessionId: string; prompt: Array<{ type: string; text?: string }> } }
  | { type: 'noop' };

export function routeClientMessage(
  raw: string,
  opts: {
    cachedInitializeResponse: string | null;
    hasInitializePromise: boolean;
    sessionStore: SessionStore;
    cwd: string;
  },
): ClientMessageAction {
  let parsed: {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: {
      command?: string;
      model?: string;
      sessionId?: string;
      summary?: string;
      skipReplay?: boolean;
      prompt?: Array<{ type: string; text?: string }>;
    };
  } | undefined;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not valid JSON - forward as-is
    return { type: 'forward', raw };
  }

  // uplink/shell
  if (parsed?.method === 'uplink/shell') {
    return { type: 'shell', id: parsed.id, command: parsed.params?.command ?? '' };
  }

  // uplink/clear_history
  if (parsed?.method === 'uplink/clear_history') {
    const sid = parsed.params?.sessionId;
    if (sid) {
      return { type: 'clear_history', id: parsed.id, sessionId: sid };
    }
    return { type: 'noop' };
  }

  // uplink/rename_session
  if (parsed?.method === 'uplink/rename_session') {
    const { sessionId, summary } = parsed.params ?? {};
    if (parsed.id !== undefined && sessionId && summary) {
      return { type: 'rename_session', id: parsed.id, sessionId, summary };
    }
    if (parsed.id !== undefined) {
      return { type: 'rename_session_error', id: parsed.id, message: 'Missing sessionId or summary' };
    }
    return { type: 'noop' };
  }

  // initialize
  if (parsed?.method === 'initialize' && parsed.id != null) {
    if (opts.cachedInitializeResponse) {
      return { type: 'initialize_cached', id: parsed.id, response: opts.cachedInitializeResponse };
    }
    if (opts.hasInitializePromise) {
      return { type: 'initialize_pending', id: parsed.id };
    }
    return { type: 'initialize_error', id: parsed.id, message: 'Bridge not available' };
  }

  // Build the forward action with optional tracking metadata
  const forward: ClientMessageAction & { type: 'forward' } = { type: 'forward', raw };

  // session/new - track for session recording
  if (parsed?.method === 'session/new' && parsed.id != null) {
    forward.trackSessionNew = parsed.id;
  }

  // session/load - replay from buffer or forward
  if (parsed?.method === 'session/load' && parsed.id != null) {
    const requestedId = parsed.params?.sessionId;
    if (requestedId) {
      const hasBuffer = opts.sessionStore.has(requestedId);
      if (hasBuffer) {
        return {
          type: 'session_load_replay',
          id: parsed.id,
          sessionId: requestedId,
        };
      }
      // No buffer - return dedicated action (caller sets activeSessionId + forwards)
      return {
        type: 'session_load_forward',
        id: parsed.id,
        sessionId: requestedId,
      };
    }
  }

  // session/prompt - track for replay buffer
  if (parsed?.method === 'session/prompt' && opts.sessionStore.activeSessionId) {
    const sid = parsed.params?.sessionId;
    if (sid && parsed.id != null) {
      forward.trackPrompt = {
        id: parsed.id,
        sessionId: sid,
        prompt: parsed.params?.prompt ?? [],
      };
    }
  }

  return forward;
}
