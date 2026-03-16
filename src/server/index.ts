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
import { DebugLog } from '../shared/debug-log.js';
import { SessionBuffer } from './session-buffer.js';
import { routeBridgeMessage, routeClientMessage } from './message-router.js';
import createDebug from 'debug';

/** Server-side debug log singleton. */
export const serverDebugLog = new DebugLog();

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

  app.get('/api/debug', (_req, res) => {
    const bufSnapshot = sessionBuffer.snapshot();
    res.json({
      entries: serverDebugLog.entries(),
      snapshot: {
        activeSessionId: bufSnapshot.activeSessionId,
        sessionBuffers: bufSnapshot.buffers,
        recentSessionCount: bufSnapshot.recentSessionCount,
        bridgeAlive: activeBridge?.isAlive() ?? false,
        hasCachedInit: cachedInitializeResponse != null,
      },
    });
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
    const supplement = sessionBuffer.listSessions(cwd)
      .filter(s => !cliIds.has(s.id));

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
    app.get('/{*path}', (req, res) => {
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
  const sessionBuffer = new SessionBuffer(resolvedCwd);

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
    serverDebugLog.append('conn', 'bridge_spawn', { spawnMs: Date.now() - spawnStart });

    // When bridge dies on its own, clean up
    bridge.onClose((code) => {
      log.bridge('closed with code %d', code);
      serverDebugLog.append('conn', 'bridge_close', { code });
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
        sessionBuffer.reset();
      }
    });

    bridge.onError((err) => {
      log.bridge('error: %O', err);
      serverDebugLog.append('conn', 'bridge_error', { error: String(err) });
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
      serverDebugLog.append('conn', 'ws_rejected', { reason: 'bad_token' });
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Enforce single connection (close old socket, but DON'T kill bridge)
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      log.server('new connection replacing existing one');
      serverDebugLog.append('conn', 'ws_replaced');
      activeSocket.close();
    }

    log.server('client connected');
    serverDebugLog.append('conn', 'ws_connected');
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
      // Route through pure decision function
      const action = routeBridgeMessage(line, {
        eagerInitId: resolveEagerInit ? EAGER_INIT_ID : null,
        pendingServerRpcIds: new Set(pendingServerRpcs.keys()),
        wsOpen: ws.readyState === WebSocket.OPEN,
      });

      switch (action.type) {
        case 'eager_init_resolved':
          cachedInitializeResponse = action.response;
          log.timing('eager initialize complete');
          resolveEagerInit?.(action.response);
          resolveEagerInit = null;
          rejectEagerInit = null;
          return;
        case 'eager_init_rejected':
          rejectEagerInit?.(new Error(action.error));
          resolveEagerInit = null;
          rejectEagerInit = null;
          return;
        case 'server_rpc_resolved': {
          const rpc = pendingServerRpcs.get(action.id)!;
          pendingServerRpcs.delete(action.id);
          clearTimeout(rpc.timeout);
          rpc.resolve(action.result);
          return;
        }
        case 'server_rpc_rejected': {
          const rpc = pendingServerRpcs.get(action.id)!;
          pendingServerRpcs.delete(action.id);
          clearTimeout(rpc.timeout);
          rpc.reject(new Error(action.error));
          return;
        }
        case 'drop':
          // Buffer + track even when WS is closed
          sessionBuffer.bufferUpdate(line);
          sessionBuffer.trackPromptCompletion(line);
          return;
        case 'forward':
          // Buffer session/update notifications for replay on reconnect
          sessionBuffer.bufferUpdate(line);
          // Track prompt completion before forwarding
          sessionBuffer.trackPromptCompletion(line);

          // Capture session/new results (for replay buffer + in-memory listing)
          if (pendingSessionNewIds.size > 0) {
            try {
              const msg = JSON.parse(line);
              if (msg.id != null && pendingSessionNewIds.has(msg.id)) {
                if (sessionBuffer.captureNewSession(msg.id, line, resolvedCwd)) {
                  pendingSessionNewIds.delete(msg.id);
                }
              }
            } catch {
              // Not valid JSON — ignore
            }
          }

          // Capture session/load results (for replay buffer)
          if (pendingSessionLoadIds.size > 0) {
            try {
              const msg = JSON.parse(line);
              if (msg.id != null && pendingSessionLoadIds.has(msg.id)) {
                if (sessionBuffer.captureLoadSession(msg.id, line)) {
                  pendingSessionLoadIds.delete(msg.id);
                }
              }
            } catch { /* Not valid JSON - ignore malformed session/load response */ }
          }

          ws.send(line);
          return;
      }
    });

    // WebSocket -> Bridge (with uplink-specific message interception)
    ws.on('message', (message) => {
      const raw = message.toString();
      const action = routeClientMessage(raw, {
        cachedInitializeResponse,
        hasInitializePromise: !!initializePromise,
        sessionBuffer,
        cwd: resolvedCwd,
      });

      switch (action.type) {
        case 'shell':
          handleShellCommand(ws, action.id, action.command, resolvedCwd);
          return;

        case 'clear_history':
          sessionBuffer.clearHistory(action.sessionId);
          if (action.id !== undefined) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, result: { ok: true } }));
          }
          return;

        case 'rename_session': {
          const wsYamlPath = path.join(homedir(), '.copilot', 'session-state', action.sessionId, 'workspace.yaml');
          try {
            if (existsSync(wsYamlPath)) {
              let yaml = readFileSync(wsYamlPath, 'utf8');
              if (/^summary:\s/m.test(yaml)) {
                yaml = yaml.replace(/^summary:\s.*$/m, `summary: ${action.summary}`);
              } else {
                yaml = yaml.trimEnd() + `\nsummary: ${action.summary}\n`;
              }
              writeFileSync(wsYamlPath, yaml);
            }
          } catch (err) {
            log.session('failed to write workspace.yaml for rename: %O', err);
          }
          sessionBuffer.updateSessionTitle(action.sessionId, action.summary);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, result: { ok: true } }));
          return;
        }

        case 'rename_session_error':
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, error: { code: -32602, message: action.message } }));
          return;

        case 'initialize_cached':
          log.timing('initialize: cached (0ms)');
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, result: JSON.parse(action.response) }));
          return;

        case 'initialize_pending':
          log.timing('initialize: awaiting eager init...');
          initializePromise!.then((cached) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, result: JSON.parse(cached) }));
            }
          }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, error: { code: -32603, message: err.message } }));
            }
          });
          return;

        case 'initialize_error':
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, error: { code: -32603, message: action.message } }));
          return;

        case 'session_load_replay': {
          const replay = sessionBuffer.replaySession(action.sessionId);
          if (!replay) {
            // Race: buffer disappeared between route and execute - forward instead
            serverDebugLog.append('proto', 'session_load_forwarded', { sessionId: action.sessionId });
            sessionBuffer.activeSessionId = action.sessionId;
            pendingSessionLoadIds.add(action.id);
            if (activeBridge === bridge) {
              bridge.send(raw);
            }
            return;
          }
          const replayResult = JSON.parse(replay.result);
          if (replay.promptInProgress) {
            replayResult.promptInProgress = true;
          }
          let skipReplay = false;
          try {
            const parsed = JSON.parse(raw);
            skipReplay = !!parsed.params?.skipReplay;
          } catch { /* ignore */ }
          serverDebugLog.append('proto', 'session_load_intercepted', {
            sessionId: action.sessionId,
            skipReplay,
            historyLength: replay.history.length,
            promptInProgress: replay.promptInProgress,
          });
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: action.id, result: replayResult }));
          if (!skipReplay) {
            for (const line of replay.history) {
              ws.send(line);
            }
          }
          return;
        }

        case 'session_load_forward':
          serverDebugLog.append('proto', 'session_load_forwarded', { sessionId: action.sessionId });
          sessionBuffer.activeSessionId = action.sessionId;
          pendingSessionLoadIds.add(action.id);
          if (activeBridge === bridge) {
            bridge.send(raw);
          }
          return;

        case 'forward':
          if (action.trackSessionNew != null) {
            pendingSessionNewIds.add(action.trackSessionNew);
          }
          if (action.trackPrompt) {
            sessionBuffer.trackPrompt(action.trackPrompt.id, action.trackPrompt.sessionId, action.trackPrompt.prompt);
          }
          if (activeBridge === bridge) {
            bridge.send(raw);
          }
          return;

        case 'noop':
          return;
      }
    });

    ws.on('close', () => {
      log.server('client disconnected');
      serverDebugLog.append('conn', 'ws_disconnected');
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

  const exposedInit = initializePromise!.then(() => {});
  exposedInit.catch(() => {}); // prevent unhandled rejection if caller doesn't await
  return { server, sessionToken, close, initializePromise: exposedInit };
}

