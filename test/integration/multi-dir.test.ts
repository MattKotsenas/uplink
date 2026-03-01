import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer } from '../../src/server/index.js';
import type {
  JsonRpcMessage,
  JsonRpcResponse,
} from '../../src/shared/acp-types.js';

const TEST_TIMEOUT = 15_000;
const REQUEST_TIMEOUT = 10_000;

// Use absolute path so mock-agent works regardless of bridge cwd
const MOCK_AGENT = `${process.cwd()}/src/mock/mock-agent.ts`;
const COPILOT_COMMAND = process.platform === 'win32' ? 'cmd.exe' : 'npx';
const COPILOT_ARGS =
  process.platform === 'win32'
    ? ['/c', 'npx', 'tsx', MOCK_AGENT, '--acp', '--stdio']
    : ['tsx', MOCK_AGENT, '--acp', '--stdio'];

// Two directories — both must exist. Use repo root and a subdirectory.
const DIR_A = process.cwd();
const DIR_B = `${process.cwd()}/src`;

let server: Server;
let port: number;
let sessionToken: string;
const sockets: WebSocket[] = [];
let nextJsonRpcId = 1;

// ── Helpers ───────────────────────────────────────────────────────────

function wsUrl(cwd?: string): string {
  const base = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}`;
  return cwd ? `${base}&cwd=${encodeURIComponent(cwd)}` : base;
}

function connectWS(cwd?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(cwd));
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
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
    ws.close();
  });
}

function allocateId(): number { return nextJsonRpcId++; }

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'result' in msg || 'error' in msg;
}

async function rpcRequest<T>(ws: WebSocket, method: string, params: unknown, timeout = REQUEST_TIMEOUT): Promise<T> {
  const id = allocateId();
  return new Promise<T>((resolve, reject) => {
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as JsonRpcMessage;
      if (isResponse(msg) && msg.id === id) {
        ws.off('message', handler);
        clearTimeout(timer);
        if ('error' in msg && msg.error) { reject(new Error(msg.error.message)); return; }
        resolve(msg.result as T);
      }
    };
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timed out waiting for ${method}`)); }, timeout);
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

// ── Suite ─────────────────────────────────────────────────────────────

describe('Multi-directory server', () => {
  beforeAll(async () => {
    const result = startServer({
      port: 0,
      copilotCommand: COPILOT_COMMAND,
      copilotArgs: COPILOT_ARGS,
      dirs: [DIR_A, DIR_B],
    });
    server = result.server;
    sessionToken = result.sessionToken;

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(async () => {
    nextJsonRpcId = 1;
    await Promise.all(sockets.splice(0).map(closeSocket));
  });

  // ── /api/config endpoint ────────────────────────────────────────────

  describe('/api/config', () => {
    it('returns multi-dir config with configured directories', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.multiDir).toBe(true);
      expect(json.dirs).toEqual([DIR_A, DIR_B]);
      expect(json.cwd).toBe(process.cwd());
    });
  });

  // ── Per-CWD WebSocket routing ───────────────────────────────────────

  describe('per-cwd WebSocket connections', () => {
    it('accepts connections for allowed directories', async () => {
      const wsA = await connectWS(DIR_A);
      expect(wsA.readyState).toBe(WebSocket.OPEN);
    });

    it('rejects connections for disallowed directories', async () => {
      const ws = new WebSocket(wsUrl('/not/allowed/path'));
      sockets.push(ws);
      const code = await new Promise<number>((resolve) => ws.on('close', resolve));
      expect(code).toBe(4003);
    });

    it('maintains independent sockets for different directories', async () => {
      const wsA = await connectWS(DIR_A);
      const wsB = await connectWS(DIR_B);

      // Both sockets should be open simultaneously
      expect(wsA.readyState).toBe(WebSocket.OPEN);
      expect(wsB.readyState).toBe(WebSocket.OPEN);

      // Close one — the other stays alive
      await closeSocket(wsA);
      expect(wsB.readyState).toBe(WebSocket.OPEN);
    });

    it('replaces old socket for same directory but keeps other dirs alive', async () => {
      const wsA1 = await connectWS(DIR_A);
      const wsB = await connectWS(DIR_B);
      const wsA2 = await connectWS(DIR_A);

      // wsA1 should be closed (replaced), wsA2 and wsB should be open
      await new Promise((r) => setTimeout(r, 100));
      expect(wsA1.readyState).toBe(WebSocket.CLOSED);
      expect(wsA2.readyState).toBe(WebSocket.OPEN);
      expect(wsB.readyState).toBe(WebSocket.OPEN);
    });
  });

  // ── Independent session per directory ───────────────────────────────

  describe('independent sessions per directory', () => {
    it('initializes and creates sessions on two directories independently', async () => {
      // Connect and init DIR_A (eagerly initialized — fast)
      const wsA = await connectWS(DIR_A);
      const initA = await rpcRequest<{ agentCapabilities: unknown }>(wsA, 'initialize', { clientInfo: { name: 'test', version: '0' } });
      expect(initA.agentCapabilities).toBeDefined();

      // Connect and init DIR_B (bridge spawns lazily — needs more time)
      const wsB = await connectWS(DIR_B);
      const initB = await rpcRequest<{ agentCapabilities: unknown }>(wsB, 'initialize', { clientInfo: { name: 'test', version: '0' } });
      expect(initB.agentCapabilities).toBeDefined();

      // Both open at the same time
      expect(wsA.readyState).toBe(WebSocket.OPEN);
      expect(wsB.readyState).toBe(WebSocket.OPEN);

      // Create separate sessions
      const sessA = await rpcRequest<{ sessionId: string }>(wsA, 'session/new', {});
      const sessB = await rpcRequest<{ sessionId: string }>(wsB, 'session/new', {});
      expect(sessA.sessionId).toBeDefined();
      expect(sessB.sessionId).toBeDefined();
      // Both sessions exist and were created successfully (IDs may match since
      // mock-agent uses Date.now() — real Copilot CLI generates UUIDs)
      expect(typeof sessA.sessionId).toBe('string');
      expect(typeof sessB.sessionId).toBe('string');
    }, 20_000);
  });
});

// ── Single-dir /api/config ────────────────────────────────────────────

describe('Single-directory /api/config', () => {
  let singleServer: Server;
  let singlePort: number;

  beforeAll(async () => {
    const result = startServer({
      port: 0,
      copilotCommand: COPILOT_COMMAND,
      copilotArgs: COPILOT_ARGS,
      // No dirs — single-dir mode
    });
    singleServer = result.server;

    await new Promise<void>((resolve) => {
      singleServer.listen(0, '127.0.0.1', () => {
        singlePort = (singleServer.address() as AddressInfo).port;
        resolve();
      });
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      singleServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns single-dir config when no dirs configured', async () => {
    const res = await fetch(`http://127.0.0.1:${singlePort}/api/config`);
    const json = await res.json();
    expect(json.multiDir).toBe(false);
    expect(json.dirs).toEqual([]);
    expect(json.cwd).toBe(process.cwd());
  });
});
