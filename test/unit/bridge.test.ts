import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { Bridge } from '../../src/server/bridge.js';
import { startServer } from '../../src/server/index.js';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Simple echo script: reads stdin line-by-line and writes each line to stdout
const echoScript = `
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => { process.stdout.write(line + '\\n'); });
`;

// Script that writes multiple NDJSON lines to stdout then exits
const multiLineScript = (lines: string[]) =>
  `${lines.map((l) => `process.stdout.write(${JSON.stringify(l + '\n')})`).join(';')};setTimeout(()=>process.exit(0),50);`;

describe('Bridge class', () => {
  let bridge: Bridge;

  afterEach(() => {
    try {
      bridge?.kill();
    } catch {
      // already dead
    }
  });

  // ── NDJSON line handling ──────────────────────────────────────────

  describe('NDJSON line handling', () => {
    it('sends a complete JSON line → onMessage receives it', async () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();

      const received = new Promise<string>((resolve) => {
        bridge.onMessage((line) => resolve(line));
      });

      bridge.send(JSON.stringify({ hello: 'world' }));

      const line = await received;
      expect(JSON.parse(line)).toEqual({ hello: 'world' });
    });

    it('sends partial line then rest → onMessage receives complete line', async () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();

      const received = new Promise<string>((resolve) => {
        bridge.onMessage((line) => resolve(line));
      });

      // Write two halves directly to stdin — readline will buffer until \n
      const half1 = '{"half":';
      const half2 = '"done"}\n';
      bridge['child']!.stdin!.write(half1);
      // Ensure two separate chunks via event loop tick
      await new Promise((r) => setImmediate(r));
      bridge['child']!.stdin!.write(half2);

      const line = await received;
      expect(JSON.parse(line)).toEqual({ half: 'done' });
    });

    it('sends multiple lines in one chunk → onMessage called for each', async () => {
      const lines = [
        JSON.stringify({ seq: 1 }),
        JSON.stringify({ seq: 2 }),
        JSON.stringify({ seq: 3 }),
      ];

      bridge = new Bridge({
        command: 'node',
        args: ['-e', multiLineScript(lines)],
      });

      const received: string[] = [];
      const done = new Promise<void>((resolve) => {
        bridge.onMessage((line) => {
          received.push(line);
          if (received.length === 3) resolve();
        });
      });

      bridge.spawn();
      await done;

      expect(received).toHaveLength(3);
      expect(JSON.parse(received[0])).toEqual({ seq: 1 });
      expect(JSON.parse(received[1])).toEqual({ seq: 2 });
      expect(JSON.parse(received[2])).toEqual({ seq: 3 });
    });

    it('skips empty lines', async () => {
      // Script writes an empty line, a blank-space line, then a real line
      const script = `
        process.stdout.write('\\n');
        process.stdout.write('   \\n');
        process.stdout.write('{"ok":true}\\n');
        setTimeout(() => process.exit(0), 50);
      `;

      bridge = new Bridge({ command: 'node', args: ['-e', script] });

      const received: string[] = [];
      const done = new Promise<void>((resolve) => {
        bridge.onMessage((line) => {
          received.push(line);
          resolve();
        });
      });

      bridge.spawn();
      await done;
      // Wait for the process to exit — confirms no extra messages will arrive
      await new Promise<void>((resolve) => { bridge.onClose(() => resolve()); });

      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0])).toEqual({ ok: true });
    });

    it('handles a very long JSON line', async () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();

      const bigPayload = { data: 'x'.repeat(100_000) };
      const received = new Promise<string>((resolve) => {
        bridge.onMessage((line) => resolve(line));
      });

      bridge.send(JSON.stringify(bigPayload));

      const line = await received;
      expect(JSON.parse(line)).toEqual(bigPayload);
    });
  });

  // ── Process lifecycle ─────────────────────────────────────────────

  describe('process lifecycle', () => {
    it('spawn() starts the child process', () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();
      expect(bridge.isAlive()).toBe(true);
    });

    it('spawn() throws if called twice', () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();
      expect(() => bridge.spawn()).toThrow('Process already spawned');
    });

    it('kill() terminates the process', async () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();
      expect(bridge.isAlive()).toBe(true);

      bridge.kill();
      expect(bridge.isAlive()).toBe(false);
    });

    it('onClose callback fires when process exits', async () => {
      const script = 'setTimeout(() => process.exit(42), 50);';
      bridge = new Bridge({ command: 'node', args: ['-e', script] });

      const exitCode = new Promise<number | null>((resolve) => {
        bridge.onClose((code) => resolve(code));
      });

      bridge.spawn();
      const code = await exitCode;
      expect(code).toBe(42);
    });

    it('onError callback fires on spawn error', async () => {
      bridge = new Bridge({
        command: 'nonexistent-command-that-should-not-exist',
        args: [],
      });

      const error = new Promise<Error>((resolve) => {
        bridge.onError((err) => resolve(err));
      });

      bridge.spawn();
      const err = await error;
      expect(err).toBeInstanceOf(Error);
    });

    it('isAlive() returns false after process exits', async () => {
      const script = 'process.exit(0);';
      bridge = new Bridge({ command: 'node', args: ['-e', script] });

      const closed = new Promise<void>((resolve) => {
        bridge.onClose(() => resolve());
      });

      bridge.spawn();
      await closed;
      expect(bridge.isAlive()).toBe(false);
    });
  });

  // ── Message sending ───────────────────────────────────────────────

  describe('message sending', () => {
    it('send() writes to stdin with newline', async () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();

      const received = new Promise<string>((resolve) => {
        bridge.onMessage((line) => resolve(line));
      });

      bridge.send('hello');
      const line = await received;
      expect(line).toBe('hello');
    });

    it('send() with existing newline does not double-newline', async () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      bridge.spawn();

      const firstMessage = new Promise<string>((resolve) => {
        bridge.onMessage((line) => resolve(line));
      });

      bridge.send('single\n');

      const line = await firstMessage;
      expect(line).toBe('single');
    });

    it('send() silently returns when process is not spawned', () => {
      bridge = new Bridge({ command: 'node', args: ['-e', echoScript] });
      // Don't spawn — send should not throw
      expect(() => bridge.send('noop')).not.toThrow();
    });
  });
});

// ── Server integration tests ──────────────────────────────────────────

describe('Server integration', () => {
  let server: Server;
  let port: number;
  let sessionToken: string;
  let closeServer: () => void;
  const sockets: WebSocket[] = [];

  function wsUrl() {
    return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}`;
  }

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      sockets.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  beforeAll(async () => {
    const result = startServer({
      port: 0,
      copilotCommand: 'node',
      copilotArgs: ['-e', echoScript],
    });
    server = result.server;
    sessionToken = result.sessionToken;
    closeServer = result.close;

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    closeServer();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    sockets.length = 0;
  });

  it('connects via WebSocket', async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('enforces single connection — old socket closed when new one connects', async () => {
    const ws1 = await connectWs();

    const ws1Closed = new Promise<void>((resolve) => {
      ws1.on('close', () => resolve());
    });

    const ws2 = await connectWs();

    await ws1Closed;
    expect(ws1.readyState).toBe(WebSocket.CLOSED);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
  });

  it('closes WS cleanly', async () => {
    const ws = await connectWs();

    const closed = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    ws.close();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('bridge process exit → WS closed', async () => {
    // This test needs its own server with a short-lived bridge
    const result = startServer({
      port: 0,
      copilotCommand: 'node',
      copilotArgs: ['-e', 'setTimeout(() => process.exit(0), 100);'],
    });
    const exitServer = result.server;
    const exitClose = result.close;

    await new Promise<void>((resolve) => {
      exitServer.listen(0, '127.0.0.1', () => resolve());
    });
    const exitPort = (exitServer.address() as AddressInfo).port;

    const ws = new WebSocket(
      `ws://127.0.0.1:${exitPort}/ws?token=${encodeURIComponent(result.sessionToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const wsClosed = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    await wsClosed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);

    exitClose();
    await new Promise<void>((resolve, reject) => {
      exitServer.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
