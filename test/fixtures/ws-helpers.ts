/**
 * Shared JSON-RPC and WebSocket helpers for integration tests.
 */
import WebSocket from 'ws';
import { expect } from 'vitest';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionPromptParams,
  SessionPromptResult,
  SessionUpdate,
} from '../../src/shared/acp-types.js';

// ─── Constants ────────────────────────────────────────────────────────

export const REQUEST_TIMEOUT = 10_000;
export const MESSAGE_TIMEOUT = 5_000;

// ─── JSON-RPC Type Guards ─────────────────────────────────────────────

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg || 'error' in msg;
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function isSessionUpdateNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return isNotification(msg) && msg.method === 'session/update';
}

// ─── JSON-RPC Helpers ─────────────────────────────────────────────────

export function getSessionUpdates(messages: JsonRpcMessage[]): SessionUpdate[] {
  return messages
    .filter(isSessionUpdateNotification)
    .map((notif) => (notif.params as { update: SessionUpdate }).update);
}

export function getPromptResponse(
  messages: JsonRpcMessage[],
  requestId: number,
): JsonRpcResponse | undefined {
  return messages.find((msg): msg is JsonRpcResponse => isResponse(msg) && msg.id === requestId);
}

export function expectStopReason(
  messages: JsonRpcMessage[],
  requestId: number,
  reason: SessionPromptResult['stopReason'],
): void {
  const response = getPromptResponse(messages, requestId);
  expect(response).toBeDefined();
  expect((response!.result as SessionPromptResult).stopReason).toBe(reason);
}

export function createPromptParams(sessionId: string, text: string): SessionPromptParams {
  return {
    sessionId,
    prompt: [{ type: 'text', text }],
  };
}

// ─── WebSocket Helpers ────────────────────────────────────────────────

export function wsSend(ws: WebSocket, payload: object): void {
  ws.send(JSON.stringify(payload));
}

export function connectWS(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      ws.off('error', reject);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

export function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

export function sendNotification(ws: WebSocket, method: string, params: unknown): void {
  wsSend(ws, { jsonrpc: '2.0', method, params });
}

export function sendPermissionResponse(
  ws: WebSocket,
  id: number | string,
  optionId: 'allow' | 'reject',
): void {
  wsSend(ws, {
    jsonrpc: '2.0',
    id,
    result: { outcome: { outcome: 'selected', optionId } },
  });
}

export function waitForMessage(
  ws: WebSocket,
  predicate: (msg: JsonRpcMessage) => boolean,
  timeout = MESSAGE_TIMEOUT,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as JsonRpcMessage;
      if (predicate(msg)) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(msg);
      }
    };

    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Timed out waiting for message'));
    }, timeout);

    ws.on('message', handler);
  });
}

/**
 * ID allocator for JSON-RPC requests within a test.
 * Call `createIdAllocator()` per test/suite to get an isolated counter.
 */
export function createIdAllocator(): () => number {
  let nextId = 1;
  return () => nextId++;
}

/**
 * Send a JSON-RPC request and await the response.
 */
export function rpcRequest<T>(
  ws: WebSocket,
  method: string,
  params: unknown,
  allocateId: () => number,
  timeout = REQUEST_TIMEOUT,
): Promise<T> {
  const id = allocateId();
  const message = { jsonrpc: '2.0', id, method, params };

  return new Promise<T>((resolve, reject) => {
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as JsonRpcMessage;
      if (isResponse(msg) && msg.id === id) {
        ws.off('message', handler);
        clearTimeout(timer);
        if ('error' in msg && msg.error) {
          reject(new Error(msg.error.message));
          return;
        }
        resolve(msg.result as T);
      }
    };

    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timed out waiting for ${method} response`));
    }, timeout);

    ws.on('message', handler);
    wsSend(ws, message);
  });
}

/**
 * Send a prompt and collect all messages until the prompt response arrives.
 */
export function promptAndCollect(
  ws: WebSocket,
  sessionId: string,
  text: string,
  allocateId: () => number,
  timeout = 5_000,
): { requestId: number; promise: Promise<JsonRpcMessage[]> } {
  const requestId = allocateId();
  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'session/prompt',
    params: createPromptParams(sessionId, text),
  };
  const promise = new Promise<JsonRpcMessage[]>((resolve, reject) => {
    const messages: JsonRpcMessage[] = [];
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as JsonRpcMessage;
      messages.push(msg);
      if (isResponse(msg) && msg.id === requestId) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(messages);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timed out after ${timeout}ms collecting messages for request ${requestId}`));
    }, timeout);
    ws.on('message', handler);
    wsSend(ws, payload);
  });
  return { requestId, promise };
}
