import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge, type BridgeOptions } from './bridge.js';
import path from 'node:path';
import { homedir } from 'node:os';

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

export function startServer(options: ServerOptions): ServerResult {
  const app = express();
  const port = options.port || 3000;
  const sessionToken = randomBytes(32).toString('hex');

  const resolvedCwd = options.cwd || process.cwd();

  // Token endpoint (must be before SPA fallback)
  app.get('/api/token', (_req, res) => {
    res.json({ token: sessionToken, cwd: resolvedCwd });
  });
  
  // Serve static files if configured
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
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

  // Track the active bridge and socket
  let activeBridge: Bridge | null = null;
  let activeSocket: WebSocket | null = null;

  wss.on('connection', (ws, request) => {
    // Validate session token
    const url = new URL(request.url!, `http://localhost`);
    const token = url.searchParams.get('token');
    if (token !== sessionToken) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Enforce single connection
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      console.log('New connection replacing existing one');
      activeSocket.close();
      if (activeBridge) {
        activeBridge.kill();
        activeBridge = null;
      }
    }

    console.log('Client connected');
    activeSocket = ws;

    // Determine command and args
    let command: string;
    let args: string[];

    const envCommand = !options.copilotCommand ? process.env.COPILOT_COMMAND : undefined;
    if (envCommand) {
      const parts = envCommand.split(' ');
      command = parts[0];
      args = parts.slice(1);
    } else {
      command = options.copilotCommand ?? 'copilot';
      args = options.copilotArgs ?? ['--acp', '--stdio'];
    }

    // Discover plugin skills for copilot ACP mode
    const bridgeEnv: Record<string, string | undefined> = {};
    const skillsDirs = process.env.COPILOT_SKILLS_DIRS ?? discoverPluginSkillsDirs();
    if (skillsDirs) {
      bridgeEnv.COPILOT_SKILLS_DIRS = skillsDirs;
    }

    const bridgeOptions: BridgeOptions = {
      command,
      args,
      cwd: resolvedCwd,
      env: Object.keys(bridgeEnv).length > 0 ? bridgeEnv : undefined,
    };

    console.log(`Spawning bridge: ${bridgeOptions.command} ${bridgeOptions.args.join(' ')}`);

    const bridge = new Bridge(bridgeOptions);
    activeBridge = bridge;

    try {
      bridge.spawn();
    } catch (err) {
      console.error('Failed to spawn bridge:', err);
      ws.close(1011, 'Failed to spawn bridge');
      return;
    }

    // Bridge -> WebSocket
    bridge.onMessage((line) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(line);
      }
    });

    bridge.onError((err) => {
      console.error('Bridge error:', err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Bridge error');
      }
    });

    bridge.onClose((code) => {
      console.log(`Bridge closed with code ${code}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Bridge closed');
      }
      if (activeBridge === bridge) {
        activeBridge = null;
      }
    });

    // WebSocket -> Bridge
    ws.on('message', (message) => {
      if (activeBridge === bridge) {
        bridge.send(message.toString());
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      if (activeSocket === ws) {
        activeSocket = null;
      }
      bridge.kill();
      if (activeBridge === bridge) {
        activeBridge = null;
      }
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

