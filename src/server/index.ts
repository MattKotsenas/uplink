import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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

/**
 * Split a command string into argv tokens, keeping quoted segments together.
 * This intentionally supports simple quoting only (single/double quotes).
 */
function splitCommandString(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
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

// ─── Per-Directory Bridge Context ───────────────────────────────────────

interface BridgeContext {
  cwd: string;
  bridge: Bridge | null;
  cachedInitializeResponse: string | null;
  initializePromise: Promise<string> | null;
  activeSessionId: string | null;
  sessionBuffers: Map<string, { result: string; history: string[] }>;
  recentSessions: Map<string, SessionInfo>;
  pendingServerRpcs: Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  resolveEagerInit: ((cached: string) => void) | null;
  rejectEagerInit: ((err: Error) => void) | null;
}

function createBridgeContext(cwd: string): BridgeContext {
  return {
    cwd,
    bridge: null,
    cachedInitializeResponse: null,
    initializePromise: null,
    activeSessionId: null,
    sessionBuffers: new Map(),
    recentSessions: new Map(),
    pendingServerRpcs: new Map(),
    resolveEagerInit: null,
    rejectEagerInit: null,
  };
}

export function startServer(options: ServerOptions): ServerResult {
  const app = express();
  const port = options.port || 3000;
  const sessionToken = randomBytes(32).toString('hex');

  const resolvedCwd = options.cwd || process.cwd();

  function isExistingDirectory(cwd: string): boolean {
    try {
      return existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      return false;
    }
  }

  function resolveRequestedCwd(requested: string, base?: string): string {
    return path.resolve(base ? path.resolve(base) : resolvedCwd, requested);
  }

  function splitPathPrefix(prefix: string): { dirPrefix: string; fragment: string } {
    const normalized = prefix.replace(/\\/g, '/');
    if (normalized.length === 0) return { dirPrefix: '', fragment: '' };
    if (normalized.endsWith('/')) return { dirPrefix: normalized, fragment: '' };

    const slashIdx = normalized.lastIndexOf('/');
    if (slashIdx === -1) return { dirPrefix: '', fragment: normalized };
    return {
      dirPrefix: normalized.slice(0, slashIdx + 1),
      fragment: normalized.slice(slashIdx + 1),
    };
  }

  // Token endpoint (must be before SPA fallback)
  app.get('/api/token', (_req, res) => {
    res.json({ token: sessionToken, cwd: resolvedCwd });
  });

  app.get('/api/resolve-path', (req, res) => {
    const requestedPath = (req.query.path as string | undefined)?.trim();
    if (!requestedPath) {
      res.status(400).json({ error: 'Missing required query parameter: path' });
      return;
    }

    const base = (req.query.base as string | undefined) ?? resolvedCwd;
    const cwd = resolveRequestedCwd(requestedPath, base);
    if (!isExistingDirectory(cwd)) {
      res.status(404).json({ error: 'Directory not found' });
      return;
    }

    res.json({ cwd });
  });

  app.get('/api/path-completions', (req, res) => {
    const rawPrefix = (req.query.prefix as string | undefined) ?? '';
    const base = (req.query.base as string | undefined) ?? resolvedCwd;
    const { dirPrefix, fragment } = splitPathPrefix(rawPrefix);

    const listRoot = resolveRequestedCwd(dirPrefix || '.', base);
    if (!isExistingDirectory(listRoot)) {
      res.json({ completions: [] });
      return;
    }

    const fragmentLower = fragment.toLowerCase();
    const completions = readdirSync(listRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name.toLowerCase().startsWith(fragmentLower))
      .map((entry) => {
        const cwd = path.join(listRoot, entry.name);
        if (!isExistingDirectory(cwd)) return null;
        return {
          path: `${dirPrefix}${entry.name}/`,
          cwd,
        };
      })
      .filter((entry): entry is { path: string; cwd: string } => entry !== null)
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 100)
      .map((entry) => ({
        path: entry.path.replace(/\\/g, '/'),
        cwd: entry.cwd,
      }));

    res.json({ completions });
  });

  // Config endpoint
  app.get('/api/config', (_req, res) => {
    res.json({ cwd: resolvedCwd });
  });

  // Sessions endpoint — forwards session/list to the CLI bridge and merges
  // with in-memory supplement for sessions created during this bridge lifetime.
  app.get('/api/sessions', async (req, res) => {
    const requestedCwd = req.query.cwd as string | undefined;
    const base = req.query.base as string | undefined;
    const cwd = requestedCwd ? resolveRequestedCwd(requestedCwd, base) : resolvedCwd;
    if (!isExistingDirectory(cwd)) {
      res.json({ sessions: [] });
      return;
    }

    const ctx = bridgeContexts.get(cwd);

    // Collect sessions from CLI via session/list RPC (if bridge is alive)
    let cliSessions: SessionInfo[] = [];
    if (ctx?.bridge?.isAlive()) {
      try {
        cliSessions = await listSessionsViaBridge(ctx, cwd);
      } catch (err) {
        log.session('session/list RPC failed: %O', err);
      }
    }

    // Merge with in-memory supplement (sessions created this bridge lifetime)
    const cliIds = new Set(cliSessions.map(s => s.id));
    const supplement = ctx
      ? [...ctx.recentSessions.values()].filter(s => s.cwd === cwd && !cliIds.has(s.id))
      : [];

    const merged = [...cliSessions, ...supplement]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    res.json({ sessions: merged });
  });

  // Close a session: kill the bridge and clean up for a given cwd
  app.post('/api/session/close', express.json(), (req, res) => {
    const cwd = req.body?.cwd as string | undefined;
    if (!cwd) {
      res.status(400).json({ error: 'cwd is required' });
      return;
    }
    const ctx = bridgeContexts.get(cwd);
    if (ctx) {
      if (ctx.bridge) {
        ctx.bridge.kill();
        ctx.bridge = null;
      }
      bridgeContexts.delete(cwd);
    }
    const sock = activeSockets.get(cwd);
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.close(1000, 'Session closed');
    }
    activeSockets.delete(cwd);
    log.session('session closed for %s', cwd);
    res.json({ ok: true });
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

  // Track active sockets per cwd (one per directory)
  const activeSockets = new Map<string, WebSocket>();

  /** Internal request ID counter for server-originated RPC calls. */
  let serverRpcId = 100_000;

  // Bridge contexts: one per directory. Keyed by resolved absolute path.
  const bridgeContexts = new Map<string, BridgeContext>();

  // Resolve bridge command and args once (same for all directories)
  let bridgeCommand: string;
  let bridgeArgs: string[];
  const launchCwd = process.cwd();
  const absolutizeCommandPart = (part: string): string => {
    if (!part || path.isAbsolute(part)) return part;
    const looksLikePath =
      part.startsWith('./') || part.startsWith('../') || part.includes('/') || part.includes('\\');
    if (!looksLikePath) return part;
    const candidate = path.resolve(launchCwd, part);
    return existsSync(candidate) ? candidate : part;
  };

  const envCommand = !options.copilotCommand ? process.env.COPILOT_COMMAND : undefined;
  if (envCommand) {
    const parts = splitCommandString(envCommand);
    bridgeCommand = parts[0] ?? 'copilot';
    bridgeArgs = parts.slice(1);
  } else {
    bridgeCommand = options.copilotCommand ?? 'copilot';
    bridgeArgs = options.copilotArgs ?? ['--acp', '--stdio'];
  }
  bridgeCommand = absolutizeCommandPart(bridgeCommand);
  bridgeArgs = bridgeArgs.map(absolutizeCommandPart);
  const bridgeEnvObj: Record<string, string | undefined> = {};
  const skillsDirs = process.env.COPILOT_SKILLS_DIRS ?? discoverPluginSkillsDirs();
  if (skillsDirs) {
    bridgeEnvObj.COPILOT_SKILLS_DIRS = skillsDirs;
  }

  function makeBridgeOptions(cwd: string): BridgeOptions {
    return {
      command: bridgeCommand,
      args: bridgeArgs,
      cwd,
      env: Object.keys(bridgeEnvObj).length > 0 ? bridgeEnvObj : undefined,
    };
  }

  const MAX_BRIDGE_CONTEXTS = 20;

  function getOrCreateContext(cwd: string): BridgeContext {
    let ctx = bridgeContexts.get(cwd);
    if (!ctx) {
      if (bridgeContexts.size >= MAX_BRIDGE_CONTEXTS) {
        throw new Error(`Session limit reached (max ${MAX_BRIDGE_CONTEXTS}). Close an existing session first.`);
      }
      ctx = createBridgeContext(cwd);
      bridgeContexts.set(cwd, ctx);
    }
    return ctx;
  }

  function ensureBridge(ctx: BridgeContext): Bridge {
    if (ctx.bridge?.isAlive()) {
      log.bridge('reusing existing bridge for %s', ctx.cwd);
      return ctx.bridge;
    }

    // Clean up dead bridge state
    ctx.cachedInitializeResponse = null;
    ctx.initializePromise = null;

    const opts = makeBridgeOptions(ctx.cwd);
    log.bridge('spawning: %s %o (cwd: %s)', opts.command, opts.args, ctx.cwd);
    const spawnStart = Date.now();
    const bridge = new Bridge(opts);
    ctx.bridge = bridge;

    bridge.spawn();
    log.timing('bridge spawn: %dms', Date.now() - spawnStart);

    // When bridge dies on its own, clean up
    bridge.onClose((code) => {
      log.bridge('closed with code %d (cwd: %s)', code, ctx.cwd);
      const sock = activeSockets.get(ctx.cwd);
      if (sock?.readyState === WebSocket.OPEN) {
        sock.close(1000, 'Bridge closed');
      }
      if (ctx.bridge === bridge) {
        ctx.bridge = null;
        ctx.cachedInitializeResponse = null;
        ctx.initializePromise = null;
        ctx.rejectEagerInit?.(new Error('Bridge closed during eager initialize'));
        ctx.resolveEagerInit = null;
        ctx.rejectEagerInit = null;
        ctx.activeSessionId = null;
        ctx.sessionBuffers.clear();
        ctx.recentSessions.clear();
      }
    });

    bridge.onError((err) => {
      log.bridge('error: %O', err);
      const sock = activeSockets.get(ctx.cwd);
      if (sock?.readyState === WebSocket.OPEN) {
        sock.close(1011, 'Bridge error');
      }
    });

    return bridge;
  }

  /**
   * Send a JSON-RPC request from the server to the bridge and await the result.
   */
  function sendBridgeRpc<T>(ctx: BridgeContext, method: string, params: unknown): Promise<T> {
    const id = ++serverRpcId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ctx.pendingServerRpcs.delete(id);
        reject(new Error(`Bridge RPC timeout: ${method}`));
      }, 10_000);

      ctx.pendingServerRpcs.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      ctx.bridge?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /**
   * Send session/list RPC to the bridge and collect all pages.
   */
  async function listSessionsViaBridge(ctx: BridgeContext, cwd: string): Promise<SessionInfo[]> {
    if (!ctx.bridge?.isAlive()) return [];

    const all: SessionInfo[] = [];
    let cursor: string | undefined;
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = { cwd };
      if (cursor) params.cursor = cursor;

      const result = await sendBridgeRpc<{
        sessions: Array<{ sessionId: string; cwd: string; title?: string; updatedAt: string }>;
        nextCursor?: string;
      }>(ctx, 'session/list', params);

      for (const s of result.sessions ?? []) {
        all.push({ id: s.sessionId, cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt });
      }

      if (!result.nextCursor || result.sessions.length === 0) break;
      cursor = result.nextCursor;
    }

    return all;
  }

  // Eagerly start bridge and send initialize before any client connects.
  const EAGER_INIT_ID = '__eager_init__';

  function eagerInitialize(ctx: BridgeContext): void {
    const bridge = ensureBridge(ctx);

    ctx.initializePromise = new Promise<string>((resolve, reject) => {
      ctx.resolveEagerInit = resolve;
      ctx.rejectEagerInit = reject;
    });
    ctx.initializePromise.catch(() => {});

    bridge.onMessage((line) => {
      handleEagerInitResponse(ctx, line);
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

    log.session('eager initialize sent for %s', ctx.cwd);
  }

  function handleEagerInitResponse(ctx: BridgeContext, line: string): boolean {
    if (!ctx.resolveEagerInit) return false;
    try {
      const msg = JSON.parse(line);
      if (msg.id === EAGER_INIT_ID && msg.result) {
        ctx.cachedInitializeResponse = JSON.stringify(msg.result);
        log.timing('eager initialize complete for %s', ctx.cwd);
        ctx.resolveEagerInit(ctx.cachedInitializeResponse);
        ctx.resolveEagerInit = null;
        ctx.rejectEagerInit = null;
        return true;
      } else if (msg.id === EAGER_INIT_ID && msg.error) {
        ctx.rejectEagerInit!(new Error(msg.error.message ?? 'Eager initialize failed'));
        ctx.resolveEagerInit = null;
        ctx.rejectEagerInit = null;
        return true;
      }
    } catch {
      // Not valid JSON — ignore
    }
    return false;
  }

  // Eager-init the primary cwd
  const primaryCtx = getOrCreateContext(resolvedCwd);
  eagerInitialize(primaryCtx);

  wss.on('connection', (ws, request) => {
    // Validate session token
    const url = new URL(request.url!, `http://localhost`);
    const token = url.searchParams.get('token');
    if (token !== sessionToken) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Determine the cwd for this connection
    const requestedCwdParam = url.searchParams.get('cwd');
    const baseCwdParam = url.searchParams.get('base');
    const requestedCwd = requestedCwdParam
      ? resolveRequestedCwd(requestedCwdParam, baseCwdParam ?? resolvedCwd)
      : resolvedCwd;
    if (!isExistingDirectory(requestedCwd)) {
      ws.close(4003, 'Directory not found');
      return;
    }

    // Enforce single connection per cwd (close old socket for same dir, DON'T touch others)
    const existingSocket = activeSockets.get(requestedCwd);
    if (existingSocket && existingSocket.readyState === WebSocket.OPEN) {
      log.server('new connection replacing existing one for %s', requestedCwd);
      existingSocket.close();
    }

    log.server('client connected (cwd: %s)', requestedCwd);
    activeSockets.set(requestedCwd, ws);

    // Get or create the bridge context for this directory
    let ctx: BridgeContext;
    try {
      ctx = getOrCreateContext(requestedCwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Session limit reached';
      log.server('session limit: %s', msg);
      ws.close(4008, msg);
      return;
    }

    let bridge: Bridge;
    try {
      bridge = ensureBridge(ctx);
    } catch (err) {
      log.server('failed to spawn bridge: %O', err);
      ws.close(1011, 'Failed to spawn bridge');
      return;
    }

    // If this context hasn't been initialized yet, do it now
    if (!ctx.initializePromise) {
      eagerInitialize(ctx);
    }

    // Track pending session/new request IDs for session recording
    const pendingSessionNewIds = new Set<number | string>();
    // Track pending session/load request IDs for capturing the result
    const pendingSessionLoadIds = new Set<number | string>();

    // Bridge -> WebSocket (forward messages, intercept session/new and eager init)
    bridge.onMessage((line) => {
      // Check if this is the eager init response (arrives here if client
      // connected before bridge responded to the eager initialize)
      if (handleEagerInitResponse(ctx, line)) return;

      // Buffer session/update notifications for replay on reconnect
      if (ctx.activeSessionId && line.includes('"session/update"')) {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'session/update') {
            const sid = msg.params?.sessionId;
            const buf = sid ? ctx.sessionBuffers.get(sid) : undefined;
            if (buf) buf.history.push(line);
          }
        } catch { /* ignore */ }
      }

      // Intercept responses to server-originated RPCs (e.g. session/list)
      if (ctx.pendingServerRpcs.size > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && ctx.pendingServerRpcs.has(msg.id)) {
            const rpc = ctx.pendingServerRpcs.get(msg.id)!;
            ctx.pendingServerRpcs.delete(msg.id);
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
            ctx.activeSessionId = newSid;
            ctx.sessionBuffers.set(newSid, { result: JSON.stringify(msg.result), history: [] });
            ctx.recentSessions.set(newSid, {
              id: newSid,
              cwd: requestedCwd,
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
            if (ctx.activeSessionId) {
              const buf = ctx.sessionBuffers.get(ctx.activeSessionId);
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
        handleShellCommand(ws, parsed.id, parsed.params?.command, requestedCwd);
        return;
      }

      if (parsed?.method === 'uplink/clear_history') {
        const sid = parsed.params?.sessionId;
        if (sid) {
          const buf = ctx.sessionBuffers.get(sid);
          if (buf) buf.history = [];
        }
        if (parsed.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        }
        return;
      }

      if (parsed?.method === 'uplink/rename_session') {
        const { sessionId, summary } = parsed.params ?? {};
        if (parsed.id !== undefined && sessionId && summary) {
          const wsYamlPath = path.join(homedir(), '.copilot', 'session-state', sessionId, 'workspace.yaml');
          try {
            if (existsSync(wsYamlPath)) {
              let yaml = readFileSync(wsYamlPath, 'utf8');
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
          const info = ctx.recentSessions.get(sessionId);
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
        if (ctx.cachedInitializeResponse) {
          log.timing('initialize: cached (0ms)');
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, result: JSON.parse(ctx.cachedInitializeResponse) }));
        } else if (ctx.initializePromise) {
          log.timing('initialize: awaiting eager init...');
          ctx.initializePromise.then((cached) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, result: JSON.parse(cached) }));
            }
          }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: clientId, error: { code: -32603, message: err.message } }));
            }
          });
        } else {
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
          const buf = ctx.sessionBuffers.get(requestedId);
          if (buf) {
            log.session('replaying %d buffered updates for session %s', buf.history.length, requestedId);
            ctx.activeSessionId = requestedId;
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: JSON.parse(buf.result) }));
            for (const line of buf.history) {
              ws.send(line);
            }
            return; // Don't forward to bridge
          }
          ctx.activeSessionId = requestedId;
          pendingSessionLoadIds.add(parsed.id);
        }
      }

      // Buffer outgoing prompts as user_message_chunk so replay includes user messages
      if (parsed?.method === 'session/prompt' && ctx.activeSessionId) {
        const promptParams = parsed.params as { sessionId?: string; prompt?: Array<{ type: string; text?: string }> } | undefined;
        const sid = promptParams?.sessionId;
        const buf = sid ? ctx.sessionBuffers.get(sid) : undefined;
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

      if (ctx.bridge === bridge) {
        bridge.send(raw);
      }
    });

    ws.on('close', () => {
      log.server('client disconnected (cwd: %s)', requestedCwd);
      if (activeSockets.get(requestedCwd) === ws) {
        activeSockets.delete(requestedCwd);
      }
      // Bridge stays alive — don't kill it
    });

    ws.on('error', (err) => {
      log.server('websocket error: %O', err);
    });
  });

  const close = () => {
    for (const ctx of bridgeContexts.values()) {
      if (ctx.bridge) {
        ctx.bridge.kill();
        ctx.bridge = null;
      }
    }

    for (const client of wss.clients) {
      if (
        client.readyState === WebSocket.OPEN ||
        client.readyState === WebSocket.CONNECTING
      ) {
        client.close(1001, 'Server shutting down');
      }
    }

    activeSockets.clear();
  };

  const exposedInit = primaryCtx.initializePromise!.then(() => {});
  exposedInit.catch(() => {}); // prevent unhandled rejection if caller doesn't await
  return { server, sessionToken, close, initializePromise: exposedInit };
}
