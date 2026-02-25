import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge, type BridgeOptions } from './bridge.js';
import path from 'node:path';

export interface ServerOptions {
  port: number;                    // default 3000
  staticDir?: string;             // directory to serve static files from
  copilotCommand?: string;        // default: process.env.COPILOT_COMMAND || 'copilot'
  copilotArgs?: string[];         // default: ['--acp', '--stdio']
  cwd?: string;                   // working directory for copilot
}

export function startServer(options: ServerOptions) {
  const app = express();
  const port = options.port || 3000;
  
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

  wss.on('connection', (ws) => {
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
    let command = options.copilotCommand || 'copilot';
    let args = options.copilotArgs || ['--acp', '--stdio'];

    // If copilotCommand option was NOT provided, allow env var override
    if (!options.copilotCommand && process.env.COPILOT_COMMAND) {
      const parts = process.env.COPILOT_COMMAND.split(' ');
      if (parts.length > 0) {
        command = parts[0];
        // Append default args (e.g. --acp --stdio) to any args from env var
        const envArgs = parts.slice(1);
        args = [...envArgs, ...args];
      }
    }

    const bridgeOptions: BridgeOptions = {
      command,
      args,
      cwd: options.cwd || process.cwd(),
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

  return server;
}

