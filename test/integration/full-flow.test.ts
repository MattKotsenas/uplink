import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer } from '../../src/server/index.js';
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionPromptParams,
  SessionPromptResult,
  SessionUpdate,
} from '../../src/shared/acp-types.js';

const TEST_TIMEOUT = 15_000;
const COLLECT_TIMEOUT = 2_000;
const REQUEST_TIMEOUT = 10_000;
const MESSAGE_TIMEOUT = 5_000;
const COPILOT_COMMAND = process.platform === 'win32' ? 'cmd.exe' : 'npx';
const COPILOT_ARGS =
  process.platform === 'win32'
    ? ['/c', 'npx', 'tsx', 'src/mock/mock-agent.ts', '--acp', '--stdio']
    : ['tsx', 'src/mock/mock-agent.ts', '--acp', '--stdio'];

let server: Server;
let port: number;
let sessionToken: string;
const sockets: WebSocket[] = [];
let nextJsonRpcId = 1;

beforeAll(async () => {
  const result = startServer({
    port: 0,
    copilotCommand: COPILOT_COMMAND,
    copilotArgs: COPILOT_ARGS,
  });
  server = result.server;
  sessionToken = result.sessionToken;

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      port = address?.port ?? 0;
      resolve();
    });
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  nextJsonRpcId = 1;
});

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(closeSocket));
});

function wsUrl(): string {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}`;
}

function connectWS(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    sockets.push(ws);
    ws.on('open', () => {
      ws.off('error', reject);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    ws.once('close', () => resolve());
    ws.close();
  });
}

function createPromptParams(sessionId: string, text: string): SessionPromptParams {
  return {
    sessionId,
    prompt: [{ type: 'text', text }],
  };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg || 'error' in msg;
}

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

function isSessionUpdateNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return isNotification(msg) && msg.method === 'session/update';
}

function getSessionUpdates(messages: JsonRpcMessage[]): SessionUpdate[] {
  return messages
    .filter(isSessionUpdateNotification)
    .map((notif) => (notif.params as { update: SessionUpdate }).update);
}

function getPromptResponse(
  messages: JsonRpcMessage[],
  requestId: number,
): JsonRpcResponse | undefined {
  return messages.find((msg): msg is JsonRpcResponse => isResponse(msg) && msg.id === requestId);
}

function expectStopReason(
  messages: JsonRpcMessage[],
  requestId: number,
  reason: SessionPromptResult['stopReason'],
): void {
  const response = getPromptResponse(messages, requestId);
  expect(response).toBeDefined();
  expect((response!.result as SessionPromptResult).stopReason).toBe(reason);
}

function wsSend(ws: WebSocket, payload: object): void {
  ws.send(JSON.stringify(payload));
}

function allocateId(): number {
  return nextJsonRpcId++;
}

async function rpcRequest<T>(
  ws: WebSocket,
  method: string,
  params: unknown,
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

function sendNotification(ws: WebSocket, method: string, params: unknown): void {
  wsSend(ws, { jsonrpc: '2.0', method, params });
}

function sendPermissionResponse(
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

function waitForMessage(
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

function promptWithCollection(
  ws: WebSocket,
  sessionId: string,
  text: string,
  timeout = COLLECT_TIMEOUT,
) {
  const requestId = allocateId();
  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'session/prompt',
    params: createPromptParams(sessionId, text),
  };
  const promise = sendAndCollect(ws, payload, timeout);
  return { requestId, promise };
}

function sendAndCollect(ws: WebSocket, msg: object, timeout = 2_000): Promise<JsonRpcMessage[]> {
  return new Promise((resolve) => {
    const messages: JsonRpcMessage[] = [];
    const handler = (data: WebSocket.Data) => {
      messages.push(JSON.parse(data.toString()) as JsonRpcMessage);
    };
    ws.on('message', handler);
    wsSend(ws, msg);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, timeout);
  });
}

async function bootstrapSession(ws: WebSocket): Promise<string> {
  const initResult = await rpcRequest<{ protocolVersion: number; agentInfo?: { name: string } }>(
    ws,
    'initialize',
    { protocolVersion: 1, clientCapabilities: {} },
  );
  expect(initResult.protocolVersion).toBe(1);
  expect(initResult.agentInfo?.name).toBe('mock-agent');

  const sessionResult = await rpcRequest<{ sessionId: string }>(ws, 'session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  });

  expect(sessionResult.sessionId).toMatch(/^mock-session-/);
  return sessionResult.sessionId;
}

describe('ACP bridge full-flow integration', () => {
  it(
    'runs initialize → new session → prompt with streaming chunks',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);
      const { requestId, promise } = promptWithCollection(ws, sessionId, 'simple request');
      const messages = await promise;
      const chunks = getSessionUpdates(messages).filter(
        (u) => u.sessionUpdate === 'agent_message_chunk',
      );
      expect(chunks).toHaveLength(3);
      const texts = chunks.map((chunk) =>
        chunk.content.type === 'text' ? chunk.content.text : '',
      );
      expect(texts).toEqual(['Hello ', 'from ', 'mock agent!']);
      expectStopReason(messages, requestId, 'end_turn');
    },
    TEST_TIMEOUT,
  );

  it(
    'handles tool call lifecycle and final response',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);
      const { requestId, promise } = promptWithCollection(ws, sessionId, 'tool please');
      const messages = await promise;
      const updates = getSessionUpdates(messages);
      expect(updates[0]).toMatchObject({ sessionUpdate: 'tool_call', status: 'pending' });
      expect(updates[1]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'in_progress' });
      expect(updates[2]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' });
      expect(updates[3]).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
      expectStopReason(messages, requestId, 'end_turn');
    },
    TEST_TIMEOUT,
  );

  it(
    'approves permission request and allows tool completion',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);
      const { requestId, promise } = promptWithCollection(ws, sessionId, 'permission allow');
      const permissionRequest = (await waitForMessage(
        ws,
        (msg) => isRequest(msg) && msg.method === 'session/request_permission',
      )) as JsonRpcRequest;
      expect(permissionRequest.params).toBeDefined();
      sendPermissionResponse(ws, permissionRequest.id, 'allow');
      const messages = await promise;
      const completion = getSessionUpdates(messages).find(
        (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed',
      );
      expect(completion).toBeDefined();
      expectStopReason(messages, requestId, 'end_turn');
    },
    TEST_TIMEOUT,
  );

  it(
    'denies permission request and reports failed tool',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);
      const { requestId, promise } = promptWithCollection(ws, sessionId, 'permission deny');
      const permissionRequest = (await waitForMessage(
        ws,
        (msg) => isRequest(msg) && msg.method === 'session/request_permission',
      )) as JsonRpcRequest;
      sendPermissionResponse(ws, permissionRequest.id, 'reject');
      const messages = await promise;
      const failed = getSessionUpdates(messages).find(
        (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed',
      );
      expect(failed).toBeDefined();
      expectStopReason(messages, requestId, 'end_turn');
    },
    TEST_TIMEOUT,
  );

  it(
    'supports multi-turn prompts within a session',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);

      const first = promptWithCollection(ws, sessionId, 'simple turn one');
      const firstMessages = await first.promise;
      expectStopReason(firstMessages, first.requestId, 'end_turn');

      const second = promptWithCollection(ws, sessionId, 'simple turn two');
      const secondMessages = await second.promise;
      expectStopReason(secondMessages, second.requestId, 'end_turn');
    },
    TEST_TIMEOUT,
  );

  it(
    'handles cancellation mid-stream',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);
      const { requestId, promise } = promptWithCollection(ws, sessionId, 'stream please', 2_000);
      sendNotification(ws, 'session/cancel', { sessionId });
      const messages = await promise;
      expectStopReason(messages, requestId, 'cancelled');
    },
    TEST_TIMEOUT,
  );

  it(
    'ensures bridge emits valid JSON-RPC envelopes',
    async () => {
      const ws = await connectWS();
      const sessionId = await bootstrapSession(ws);
      const { requestId, promise } = promptWithCollection(ws, sessionId, 'simple integrity check');
      const messages = await promise;
      expect(messages.length).toBeGreaterThan(0);
      messages.forEach((msg) => {
        expect(msg.jsonrpc).toBe('2.0');
      });
      expectStopReason(messages, requestId, 'end_turn');
      const notifications = messages.filter(isSessionUpdateNotification);
      notifications.forEach((notif) => {
        expect(Object.prototype.hasOwnProperty.call(notif, 'id')).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );
});
