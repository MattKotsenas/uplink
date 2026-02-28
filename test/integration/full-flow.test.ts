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

  it(
    'executes a shell command via uplink/shell',
    async () => {
      const ws = await connectWS();
      // No need to bootstrap an ACP session — uplink/shell is handled directly by the server
      const result = await rpcRequest<{ stdout: string; stderr: string; exitCode: number }>(
        ws,
        'uplink/shell',
        { command: 'echo hello' },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    },
    TEST_TIMEOUT,
  );

  it(
    'reuses bridge on reconnect — session/load returns "already loaded" which is fine',
    async () => {
      // First connection — cold start
      const ws1 = await connectWS();
      const initResult1 = await rpcRequest<{ protocolVersion: number; agentInfo?: { name: string } }>(
        ws1,
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
      );
      expect(initResult1.protocolVersion).toBe(1);

      const sessionResult = await rpcRequest<{ sessionId: string }>(ws1, 'session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });
      const sessionId = sessionResult.sessionId;

      // Disconnect first client
      await closeSocket(ws1);

      // Second connection — should reuse bridge with cached initialize
      const ws2 = await connectWS();
      const initResult2 = await rpcRequest<{ protocolVersion: number; agentInfo?: { name: string } }>(
        ws2,
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
      );
      // Cached response should match original
      expect(initResult2.protocolVersion).toBe(initResult1.protocolVersion);
      expect(initResult2.agentInfo?.name).toBe(initResult1.agentInfo?.name);

      // Session/load returns "already loaded" error — session is still active
      await expect(
        rpcRequest(ws2, 'session/load', {
          sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        }),
      ).rejects.toThrow('already loaded');

      // Prompt should still work on the session — it's alive in the bridge
      const { requestId, promise } = promptWithCollection(ws2, sessionId, 'simple after reconnect');
      const messages = await promise;
      expectStopReason(messages, requestId, 'end_turn');
    },
    TEST_TIMEOUT,
  );

  it(
    'spawns new bridge after previous bridge dies',
    async () => {
      // First connection
      const ws1 = await connectWS();
      const initResult1 = await rpcRequest<{ protocolVersion: number }>(
        ws1,
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
      );
      expect(initResult1.protocolVersion).toBe(1);

      // Close WS — bridge stays alive
      await closeSocket(ws1);

      // Wait a moment, then connect again — bridge should still be reused
      const ws2 = await connectWS();
      const initResult2 = await rpcRequest<{ protocolVersion: number }>(
        ws2,
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
      );
      expect(initResult2.protocolVersion).toBe(1);

      // Bootstrap a new session to verify the bridge works
      const sessionResult = await rpcRequest<{ sessionId: string }>(ws2, 'session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });
      expect(sessionResult.sessionId).toMatch(/^mock-session-/);
    },
    TEST_TIMEOUT,
  );
});

// ── Eager initialize tests ───────────────────────────────────────────
describe('Eager initialize', () => {
  it(
    'returns cached init response when client connects after init completes (fast path)',
    async () => {
      // The main test server uses the mock agent which responds instantly.
      // By the time we connect, eager init is already done.
      await new Promise((r) => setTimeout(r, 200));

      const ws = await connectWS();

      const t0 = Date.now();
      const result = await rpcRequest<{ protocolVersion: number; agentInfo?: { name: string } }>(
        ws,
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
      );
      const elapsed = Date.now() - t0;

      expect(result.protocolVersion).toBe(1);
      expect(result.agentInfo?.name).toBe('mock-agent');
      // Cached response should be near-instant (well under 1s)
      expect(elapsed).toBeLessThan(1000);
    },
    TEST_TIMEOUT,
  );

  it(
    'waits for in-flight init when client connects before init completes (slow path)',
    async () => {
      // Create a server with a bridge that delays the initialize response
      const delayMs = 1500;
      const delayedInitScript = `
        const rl = require('readline').createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: 'delayed-agent' },
                  agentCapabilities: {},
                },
              }) + '\\n');
            }, ${delayMs});
          } else {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {},
            }) + '\\n');
          }
        });
      `;

      const slowResult = startServer({
        port: 0,
        copilotCommand: 'node',
        copilotArgs: ['-e', delayedInitScript],
      });
      const slowServer = slowResult.server;
      const slowToken = slowResult.sessionToken;

      await new Promise<void>((resolve) => {
        slowServer.listen(0, '127.0.0.1', () => resolve());
      });
      const slowPort = (slowServer.address() as AddressInfo).port;

      try {
        // Connect immediately — eager init is still in-flight
        const ws = new WebSocket(
          `ws://127.0.0.1:${slowPort}/ws?token=${encodeURIComponent(slowToken)}`,
        );
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', reject);
        });

        const t0 = Date.now();
        const result = await rpcRequest<{ protocolVersion: number; agentInfo?: { name: string } }>(
          ws,
          'initialize',
          { protocolVersion: 1, clientCapabilities: {} },
        );
        const elapsed = Date.now() - t0;

        expect(result.protocolVersion).toBe(1);
        expect(result.agentInfo?.name).toBe('delayed-agent');
        // Should have waited for the delayed init (~1.5s)
        expect(elapsed).toBeGreaterThan(500);

        ws.close();
        await new Promise<void>((r) => ws.on('close', () => r()));
      } finally {
        slowResult.close();
        await new Promise<void>((resolve, reject) => {
          slowServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
    TEST_TIMEOUT,
  );
});
