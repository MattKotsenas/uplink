import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge, type BridgeOptions } from './bridge.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { getRecentSessions, recordSession, renameSession } from './sessions.js';

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

  // Sessions endpoint
  app.get('/api/sessions', async (req, res) => {
    const cwd = req.query.cwd as string | undefined;
    if (!cwd) {
      res.status(400).json({ error: 'Missing required query parameter: cwd' });
      return;
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const sessions = await getRecentSessions(cwd, limit);
    res.json({ sessions });
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

  // Track the active bridge, socket, and cached initialize response
  let activeBridge: Bridge | null = null;
  let activeSocket: WebSocket | null = null;
  let cachedInitializeResponse: string | null = null;

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
      console.log('Reusing existing bridge');
      return activeBridge;
    }

    // Clean up dead bridge state
    cachedInitializeResponse = null;

    console.log(`Spawning bridge: ${bridgeOptions.command} ${bridgeOptions.args.join(' ')}`);
    const spawnStart = Date.now();
    const bridge = new Bridge(bridgeOptions);
    activeBridge = bridge;

    bridge.spawn();
    console.debug(`[timing] bridge spawn: ${Date.now() - spawnStart}ms`);

    // When bridge dies on its own, clean up
    bridge.onClose((code) => {
      console.log(`Bridge closed with code ${code}`);
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.close(1000, 'Bridge closed');
      }
      if (activeBridge === bridge) {
        activeBridge = null;
        cachedInitializeResponse = null;
      }
    });

    bridge.onError((err) => {
      console.error('Bridge error:', err);
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.close(1011, 'Bridge error');
      }
    });

    return bridge;
  }

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
      console.log('New connection replacing existing one');
      activeSocket.close();
    }

    console.log('Client connected');
    activeSocket = ws;

    let bridge: Bridge;
    try {
      bridge = ensureBridge();
    } catch (err) {
      console.error('Failed to spawn bridge:', err);
      ws.close(1011, 'Failed to spawn bridge');
      return;
    }

    // Track pending initialize and session/new request IDs
    const pendingInitializeIds = new Set<number | string>();
    const pendingSessionNewIds = new Set<number | string>();

    // Bridge -> WebSocket (intercept initialize and session/new responses)
    bridge.onMessage((line) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // Check if this is a response we need to intercept
      if (pendingInitializeIds.size > 0 || pendingSessionNewIds.size > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) {
            if (pendingInitializeIds.has(msg.id) && msg.result) {
              pendingInitializeIds.delete(msg.id);
              cachedInitializeResponse = JSON.stringify(msg.result);
            }
            if (pendingSessionNewIds.has(msg.id) && msg.result?.sessionId) {
              pendingSessionNewIds.delete(msg.id);
              recordSession(resolvedCwd, msg.result.sessionId);
            }
          }
        } catch {
          // Not valid JSON — ignore
        }
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
          renameSession(sessionId, summary);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        } else if (parsed.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32602, message: 'Missing sessionId or summary' } }));
        }
        return;
      }

      // Intercept initialize — replay cached response if bridge is reused
      if (parsed?.method === 'initialize' && parsed.id != null) {
        if (cachedInitializeResponse) {
          console.debug('[timing] initialize: cached (0ms)');
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: JSON.parse(cachedInitializeResponse) }));
          return;
        }
        pendingInitializeIds.add(parsed.id);
      }

      // Track session/new requests to capture the session ID from the response
      if (parsed?.method === 'session/new' && parsed.id != null) {
        pendingSessionNewIds.add(parsed.id);
      }

      if (activeBridge === bridge) {
        bridge.send(raw);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      if (activeSocket === ws) {
        activeSocket = null;
      }
      // Bridge stays alive — don't kill it
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
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

  return { server, sessionToken, close };
}

