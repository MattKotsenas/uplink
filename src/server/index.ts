import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge, type BridgeOptions } from './bridge.js';
import path from 'node:path';
import { homedir } from 'node:os';
import type { SessionInfo } from '../shared/acp-types.js';
import createDebug from 'debug';

const log = {
  server: createDebug('uplink:server'),
  bridge: createDebug('uplink:bridge'),
  session: createDebug('uplink:session'),
  timing: createDebug('uplink:timing'),
};

export interface ServerOptions {
  port: number;                    // default 3000
  staticDir?: string;             // directory to serve static files from
  copilotCommand?: string;        // default: process.env.COPILOT_COMMAND || 'copilot'
  copilotArgs?: string[];         // default: ['--acp', '--stdio']
  cwd?: string;                   // working directory for copilot
}

export interface ServerResult {
  server: ReturnType<typeof createServer>;
  sessionToken: string;
  close: () => void;
  /** Resolves when the bridge's eager initialize completes. */
  initializePromise: Promise<void>;
}

/**
 * Discover plugin skills directories so copilot in ACP mode can find them.
 * Copilot CLI doesn't load installed-plugin skills in --acp mode unless
 * COPILOT_SKILLS_DIRS is set.
 */
function discoverPluginSkillsDirs(): string | undefined {
  const pluginsRoot = path.join(
    process.env.XDG_CONFIG_HOME ?? homedir(),
    process.env.XDG_CONFIG_HOME ? 'installed-plugins' : '.copilot/installed-plugins',
  );

  if (!existsSync(pluginsRoot)) return undefined;

  const dirs: string[] = [];
  try {
    // Walk two levels: marketplace/plugin/skills or _direct/plugin/skills
    for (const marketplace of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const mpPath = path.join(pluginsRoot, marketplace.name);
      for (const plugin of readdirSync(mpPath, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const skillsDir = path.join(mpPath, plugin.name, 'skills');
        if (existsSync(skillsDir)) dirs.push(skillsDir);
      }
    }
  } catch {
    // ignore permission errors
  }

  return dirs.length > 0 ? dirs.join(',') : undefined;
}

const SHELL_TIMEOUT_MS = 30_000;

function handleShellCommand(
  ws: WebSocket,
  id: number | string | undefined,
  command: string | undefined,
  cwd: string,
): void {
  if (id === undefined || !command) {
    if (id !== undefined) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing command parameter' },
      }));
    }
    return;
  }

  exec(command, { cwd, timeout: SHELL_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (err && (err as any).killed) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -1, message: 'Command timed out' },
      }));
      return;
    }

    const exitCode = err ? (err.code ?? 1) : 0;
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { stdout, stderr, exitCode },
    }));
  });
}

export function startServer(options: ServerOptions): ServerResult {
  const app = express();
  const port = options.port || 3000;
  const sessionToken = randomBytes(32).toString('hex');

  const resolvedCwd = options.cwd || process.cwd();

  // Token endpoint (must be before SPA fallback)
  app.get('/api/token', (_req, res) => {
    res.json({ token: sessionToken, cwd: resolvedCwd });
  });

  // Sessions endpoint — forwards session/list to the CLI bridge and merges
  // with in-memory supplement for sessions created during this bridge lifetime.
  app.get('/api/sessions', async (req, res) => {
    const cwd = req.query.cwd as string | undefined;
    if (!cwd) {
      res.status(400).json({ error: 'Missing required query parameter: cwd' });
      return;
    }

    // Collect sessions from CLI via session/list RPC (if bridge is alive)
    let cliSessions: SessionInfo[] = [];
    if (activeBridge?.isAlive()) {
      try {
        cliSessions = await listSessionsViaBridge(activeBridge, cwd);
      } catch (err) {
        log.session('session/list RPC failed: %O', err);
      }
    }

    // Merge with in-memory supplement (sessions created this bridge lifetime)
    const cliIds = new Set(cliSessions.map(s => s.id));
    const supplement = [...recentSessions.values()]
      .filter(s => s.cwd === cwd && !cliIds.has(s.id));

    const merged = [...cliSessions, ...supplement]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    res.json({ sessions: merged });
  });
  
  // Serve static files if configured
  if (options.staticDir) {
    app.use(express.static(options.staticDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('manifest.json')) {
          res.setHeader('Content-Type', 'application/manifest+json');
        }
      },
    }));
    // SPA fallback: serve index.html for unknown routes
    app.get('*', (req, res) => {
      if (options.staticDir) {
        res.sendFile(path.join(options.staticDir, 'index.html'));
      } else {
        res.status(404).send('Not found');
      }
    });
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Track the active bridge, socket, and cached protocol state
  let activeBridge: Bridge | null = null;
  let activeSocket: WebSocket | null = null;
  let cachedInitializeResponse: string | null = null;
  let initializePromise: Promise<string> | null = null;

  // Session replay buffer — remembers session history so we can replay it
  // when a client reconnects and session/load returns "already loaded".
  // Keyed by session ID; survives session switches within the same bridge.
  let activeSessionId: string | null = null;
  const sessionBuffers = new Map<string, { result: string; history: string[] }>();

  // In-memory supplement for session listing. Tracks sessions created during
  // this bridge's lifetime because the CLI's session/list doesn't index them
  // until the next CLI process restart.
  const recentSessions = new Map<string, SessionInfo>();

  /** Internal request ID counter for server-originated RPC calls to the bridge. */
  let serverRpcId = 100_000;

  // Resolve bridge command and args once (same for all connections)
  let bridgeCommand: string;
  let bridgeArgs: string[];
  const envCommand = !options.copilotCommand ? process.env.COPILOT_COMMAND : undefined;
  if (envCommand) {
    const parts = envCommand.split(' ');
    bridgeCommand = parts[0];
    bridgeArgs = parts.slice(1);
  } else {
    bridgeCommand = options.copilotCommand ?? 'copilot';
    bridgeArgs = options.copilotArgs ?? ['--acp', '--stdio'];
  }
  const bridgeEnvObj: Record<string, string | undefined> = {};
  const skillsDirs = process.env.COPILOT_SKILLS_DIRS ?? discoverPluginSkillsDirs();
  if (skillsDirs) {
    bridgeEnvObj.COPILOT_SKILLS_DIRS = skillsDirs;
  }
  const bridgeOptions: BridgeOptions = {
    command: bridgeCommand,
    args: bridgeArgs,
    cwd: resolvedCwd,
    env: Object.keys(bridgeEnvObj).length > 0 ? bridgeEnvObj : undefined,
  };

  function ensureBridge(): Bridge {
    if (activeBridge?.isAlive()) {
      log.bridge('reusing existing bridge');
      return activeBridge;
    }

    // Clean up dead bridge state
    cachedInitializeResponse = null;
    initializePromise = null;

    log.bridge('spawning: %s %o', bridgeOptions.command, bridgeOptions.args);
    const spawnStart = Date.now();
    const bridge = new Bridge(bridgeOptions);
    activeBridge = bridge;

    bridge.spawn();
    log.timing('bridge spawn: %dms', Date.now() - spawnStart);

    // When bridge dies on its own, clean up
    bridge.onClose((code) => {
      log.bridge('closed with code %d', code);
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.close(1000, 'Bridge closed');
      }
      if (activeBridge === bridge) {
        activeBridge = null;
        cachedInitializeResponse = null;
        initializePromise = null;
        rejectEagerInit?.(new Error('Bridge closed during eager initialize'));
        resolveEagerInit = null;
        rejectEagerInit = null;
        // Clear session buffers — sessions are gone with the bridge
        activeSessionId = null;
        sessionBuffers.clear();
        recentSessions.clear();
      }
    });

    bridge.onError((err) => {
      log.bridge('error: %O', err);
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.close(1011, 'Bridge error');
      }
    });

    return bridge;
  }

  // Pending server-originated RPC callbacks — responses are intercepted in
  // the bridge→client message handler (just like pendingSessionNewIds).
  const pendingServerRpcs = new Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Send a JSON-RPC request from the server to the bridge and await the result.
   * The response is intercepted in the bridge→client onMessage handler.
   */
  function sendBridgeRpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++serverRpcId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingServerRpcs.delete(id);
        reject(new Error(`Bridge RPC timeout: ${method}`));
      }, 10_000);

      pendingServerRpcs.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      activeBridge?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /**
   * Send session/list RPC to the bridge and collect all pages.
   */
  async function listSessionsViaBridge(bridge: Bridge, cwd: string): Promise<SessionInfo[]> {
    if (!bridge.isAlive()) return [];

    const all: SessionInfo[] = [];
    let cursor: string | undefined;
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { cwd };
      if (cursor) params.cursor = cursor;

      const result = await sendBridgeRpc<{
        sessions: Array<{ sessionId: string; cwd: string; title?: string; updatedAt: string }>;
        nextCursor?: string;
      }>('session/list', params);

      for (const s of result.sessions ?? []) {
        all.push({ id: s.sessionId, cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt });
      }

      if (!result.nextCursor || result.sessions.length === 0) break;
      cursor = result.nextCursor;
    }

    return all;
  }

  // Eagerly start bridge and send initialize before any client connects.
  // The ~24s cold start happens while the user opens the URL / scans QR.
  const EAGER_INIT_ID = '__eager_init__';
  let resolveEagerInit: ((cached: string) => void) | null = null;
  let rejectEagerInit: ((err: Error) => void) | null = null;

  function eagerInitialize(): void {
    const bridge = ensureBridge();

    initializePromise = new Promise<string>((resolve, reject) => {
      resolveEagerInit = resolve;
      rejectEagerInit = reject;
    });
    // Prevent unhandled rejection if bridge dies before anyone awaits
    initializePromise.catch(() => {});

    // The response will be caught by whatever onMessage handler is active.
    // It checks for EAGER_INIT_ID and calls resolveEagerInit.
    bridge.onMessage((line) => {
      handleEagerInitResponse(line);
    });

    bridge.send(JSON.stringify({
      jsonrpc: '2.0',
      id: EAGER_INIT_ID,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'uplink', version: '1.0.0' },
      },
    }));

    log.session('eager initialize sent');
  }

  function handleEagerInitResponse(line: string): boolean {
    if (!resolveEagerInit) return false;
    try {
      const msg = JSON.parse(line);
      if (msg.id === EAGER_INIT_ID && msg.result) {
        cachedInitializeResponse = JSON.stringify(msg.result);
        log.timing('eager initialize complete');
        resolveEagerInit(cachedInitializeResponse);
        resolveEagerInit = null;
        rejectEagerInit = null;
        return true;
      } else if (msg.id === EAGER_INIT_ID && msg.error) {
        rejectEagerInit!(new Error(msg.error.message ?? 'Eager initialize failed'));
        resolveEagerInit = null;
        rejectEagerInit = null;
        return true;
      }
    } catch {
      // Not valid JSON — ignore
    }
    return false;
  }

  eagerInitialize();

  wss.on('connection', (ws, request) => {
    // Validate session token
    const url = new URL(request.url!, `http://localhost`);
    const token = url.searchParams.get('token');
    if (token !== sessionToken) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Enforce single connection (close old socket, but DON'T kill bridge)
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      log.server('new connection replacing existing one');
      activeSocket.close();
    }

    log.server('client connected');
    activeSocket = ws;

    let bridge: Bridge;
    try {
      bridge = ensureBridge();
    } catch (err) {
      log.server('failed to spawn bridge: %O', err);
      ws.close(1011, 'Failed to spawn bridge');
      return;
    }

    // Track pending session/new request IDs for session recording
    const pendingSessionNewIds = new Set<number | string>();
    // Track pending session/load request IDs for capturing the result
    const pendingSessionLoadIds = new Set<number | string>();

    // Bridge -> WebSocket (forward messages, intercept session/new and eager init)
    bridge.onMessage((line) => {
      // Check if this is the eager init response (arrives here if client
      // connected before bridge responded to the eager initialize)
      if (handleEagerInitResponse(line)) return;

      // Buffer session/update notifications for replay on reconnect
      if (activeSessionId && line.includes('"session/update"')) {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'session/update') {
            const sid = msg.params?.sessionId;
            const buf = sid ? sessionBuffers.get(sid) : undefined;
            if (buf) buf.history.push(line);
          }
        } catch { /* ignore */ }
      }

      // Intercept responses to server-originated RPCs (e.g. session/list)
      if (pendingServerRpcs.size > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pendingServerRpcs.has(msg.id)) {
            const rpc = pendingServerRpcs.get(msg.id)!;
            pendingServerRpcs.delete(msg.id);
            clearTimeout(rpc.timeout);
            if (msg.error) rpc.reject(new Error(msg.error.message ?? 'RPC error'));
            else rpc.resolve(msg.result);
            return; // Don't forward server-internal responses to client
          }
        } catch { /* ignore */ }
      }

      if (ws.readyState !== WebSocket.OPEN) return;

      // Capture session/new results (for replay buffer + in-memory listing)
      if (pendingSessionNewIds.size > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pendingSessionNewIds.has(msg.id) && msg.result?.sessionId) {
            pendingSessionNewIds.delete(msg.id);
            const newSid = msg.result.sessionId;
            activeSessionId = newSid;
            sessionBuffers.set(newSid, { result: JSON.stringify(msg.result), history: [] });
            // Track in-memory for session listing (CLI won't index until restart)
            recentSessions.set(newSid, {
              id: newSid,
              cwd: resolvedCwd,
              title: null,
              updatedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Not valid JSON — ignore
        }
      }

      // Capture session/load results (for replay buffer)
      if (pendingSessionLoadIds.size > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pendingSessionLoadIds.has(msg.id) && msg.result) {
            pendingSessionLoadIds.delete(msg.id);
            // session/load succeeded — the bridge replayed history as notifications
            // (which we already buffered above). Save the result for future replays.
            if (activeSessionId) {
              const buf = sessionBuffers.get(activeSessionId);
              if (buf) buf.result = JSON.stringify(msg.result);
            }
          }
        } catch { /* ignore */ }
      }

      ws.send(line);
    });

    // WebSocket -> Bridge (with uplink-specific message interception)
    ws.on('message', (message) => {
      const raw = message.toString();
      let parsed: { jsonrpc?: string; id?: number | string; method?: string; params?: { command?: string; model?: string; sessionId?: string; summary?: string } } | undefined;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not valid JSON — forward as-is
      }

      if (parsed?.method === 'uplink/shell') {
        handleShellCommand(ws, parsed.id, parsed.params?.command, resolvedCwd);
        return;
      }

      if (parsed?.method === 'uplink/rename_session') {
        const { sessionId, summary } = parsed.params ?? {};
        if (parsed.id !== undefined && sessionId && summary) {
          // Write summary to CLI's workspace.yaml so it persists across restarts
          const wsYamlPath = path.join(homedir(), '.copilot', 'session-state', sessionId, 'workspace.yaml');
          try {
            if (existsSync(wsYamlPath)) {
              let yaml = readFileSync(wsYamlPath, 'utf8');
              // Replace existing summary line or append one
              if (/^summary:\s/m.test(yaml)) {
                yaml = yaml.replace(/^summary:\s.*$/m, `summary: ${summary}`);
              } else {
                yaml = yaml.trimEnd() + `\nsummary: ${summary}\n`;
              }
              writeFileSync(wsYamlPath, yaml);
            }
          } catch (err) {
            log.session('failed to write workspace.yaml for rename: %O', err);
          }
          // Also update in-memory supplement
          const info = recentSessions.get(sessionId);
          if (info) info.title = summary;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        } else if (parsed.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32602, message: 'Missing sessionId or summary' } }));
        }
        return;
      }

      // Intercept initialize — await eager init result (already done or in-flight)
      if (parsed?.method === 'initialize' && parsed.id != null) {
        const clientId = parsed.id;
        if (cachedInitializeResponse) {
          log.timing('initialize: cached (0ms)');
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, result: JSON.parse(cachedInitializeResponse) }));
        } else if (initializePromise) {
          log.timing('initialize: awaiting eager init...');
          initializePromise.then((cached) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, result: JSON.parse(cached) }));
            }
          }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, error: { code: -32603, message: err.message } }));
            }
          });
        } else {
          // No bridge, no promise — shouldn't happen but handle gracefully
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, error: { code: -32603, message: 'Bridge not available' } }));
        }
        return;
      }

      // Track session/new requests to record the session for history
      if (parsed?.method === 'session/new' && parsed.id != null) {
        pendingSessionNewIds.add(parsed.id);
      }

      // Intercept session/load — replay from buffer if we have one
      if (parsed?.method === 'session/load' && parsed.id != null) {
        const requestedId = parsed.params?.sessionId;
        if (requestedId) {
          const buf = sessionBuffers.get(requestedId);
          if (buf) {
            // We have a buffer for this session — replay it instead of asking the CLI
            log.session('replaying %d buffered updates for session %s', buf.history.length, requestedId);
            activeSessionId = requestedId;
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: JSON.parse(buf.result) }));
            for (const line of buf.history) {
              ws.send(line);
            }
            return; // Don't forward to bridge
          }
          // No buffer — forward to CLI and start tracking
          activeSessionId = requestedId;
          pendingSessionLoadIds.add(parsed.id);
        }
      }

      // Buffer outgoing prompts as user_message_chunk so replay includes user messages
      if (parsed?.method === 'session/prompt' && activeSessionId) {
        const promptParams = parsed.params as { sessionId?: string; prompt?: Array<{ type: string; text?: string }> } | undefined;
        const sid = promptParams?.sessionId;
        const buf = sid ? sessionBuffers.get(sid) : undefined;
        if (buf && promptParams?.prompt) {
          for (const part of promptParams.prompt) {
            if (part.type === 'text' && part.text) {
              buf.history.push(JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: sid,
                  update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: part.text } },
                },
              }));
            }
          }
        }
      }

      if (activeBridge === bridge) {
        bridge.send(raw);
      }
    });

    ws.on('close', () => {
      log.server('client disconnected');
      if (activeSocket === ws) {
        activeSocket = null;
      }
      // Bridge stays alive — don't kill it
    });

    ws.on('error', (err) => {
      log.server('websocket error: %O', err);
    });
  });

  const close = () => {
    if (activeBridge) {
      activeBridge.kill();
      activeBridge = null;
    }

    for (const client of wss.clients) {
      if (
        client.readyState === WebSocket.OPEN ||
        client.readyState === WebSocket.CONNECTING
      ) {
        client.close(1001, 'Server shutting down');
      }
    }

    activeSocket = null;
  };

  return { server, sessionToken, close, initializePromise: initializePromise!.then(() => {}) };
}

