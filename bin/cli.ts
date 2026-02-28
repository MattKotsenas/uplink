#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { startServer } from '../src/server/index.js';
import { hashCwd, getTunnelInfo, createTunnel, updateTunnelPort, startTunnel, stopTunnel, type TunnelResult } from '../src/server/tunnel.js';
import { resolvePort } from '../src/server/resolve-port.js';
import { isPortAvailable } from '../src/server/is-port-available.js';

const require = createRequire(import.meta.url);

function findPackageJson(): { version: string } {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf-8'));
    }
    dir = dirname(dir);
  }
  return { version: '0.0.0' };
}

const { version } = findPackageJson();
const qrcode: {
  generate: (
    text: string,
    options?: { small?: boolean },
    callback?: (qrcode: string) => void,
  ) => void;
} = require('qrcode-terminal');

const program = new Command()
  .name('uplink')
  .description('Remote control for GitHub Copilot CLI')
  .version(version)
  .option('--port <n>', 'port for bridge server (default: random)')
  .option('--tunnel', 'start a devtunnel for remote access')
  .option('--no-tunnel', "don't start a devtunnel")
  .option('--tunnel-id <name>', 'use a pre-created devtunnel (no auto-setup)')
  .option('--allow-anonymous', 'allow anonymous tunnel access (no GitHub auth)')
  .option('--cwd <path>', 'working directory for Copilot', process.cwd())
  .option('--verbose', 'enable debug logging (DEBUG=uplink:*)')
  .parse();

const opts = program.opts<{
  port?: string;
  tunnel: boolean;
  tunnelId?: string;
  allowAnonymous?: boolean;
  cwd: string;
  verbose?: boolean;
}>();

// Set DEBUG env before any debug() loggers are created
if (opts.verbose && !process.env.DEBUG) {
  process.env.DEBUG = 'uplink:*';
}

const explicitPort = opts.port != null ? parseInt(opts.port, 10) : undefined;
const useTunnel = opts.tunnel || !!opts.tunnelId;

function resolveStaticDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, '../client'), resolve(moduleDir, '../dist/client')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function listenOrThrow(server: ReturnType<typeof startServer>['server'], desiredPort: number): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const handleError = (error: Error) => {
      server.off('error', handleError);
      rejectPromise(error);
    };
    server.once('error', handleError);
    server.listen(desiredPort, () => {
      server.off('error', handleError);
      resolvePromise();
    });
  });
}

// ─── Startup checklist helpers ────────────────────────────────────────

const DONE  = '✔';
const SKIP  = '⊘';
const FAIL  = '✗';
const WAIT  = '⋯';

/** Print a checklist step inline (no trailing newline so we can update it). */
function stepStart(label: string, detail = '') {
  process.stdout.write(`  ${WAIT} ${label.padEnd(14)}${detail}`);
}

/** Finish a checklist step: overwrite the current line. */
function stepDone(label: string, detail: string, icon = DONE) {
  process.stdout.write(`\r  ${icon} ${label.padEnd(14)}${detail}\n`);
}

async function main() {
  console.log();
  console.log('  🛰  Copilot Uplink');
  console.log();

  const staticDir = resolveStaticDir();
  const cwd = resolve(opts.cwd);
  const { port: desiredPort, tunnelName } = resolvePort({
    cwd,
    explicitPort,
    tunnel: useTunnel,
    tunnelId: opts.tunnelId,
  });

  // Only do EADDRINUSE fallback in auto-tunnel mode (saved port might be stale).
  // For explicit --port or non-tunnel, let EADDRINUSE crash normally.
  const canFallback = tunnelName != null && explicitPort == null;

  let listenPort = desiredPort;

  if (canFallback && desiredPort !== 0) {
    const available = await isPortAvailable(desiredPort);
    if (!available) {
      listenPort = 0;
    }
  }

  // ── Step 1: Server ──────────────────────────────────────────────────
  stepStart('Server');
  const result = startServer({ port: listenPort, staticDir, cwd });
  await listenOrThrow(result.server, listenPort);

  const { server, close, initializePromise } = result;
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Unable to determine server port');
  }

  const actualPort = addr.port;
  stepDone('Server', `http://localhost:${actualPort}`);

  // ── Step 2: Tunnel ──────────────────────────────────────────────────
  let tunnel: TunnelResult | null = null;
  if (useTunnel) {
    if (opts.allowAnonymous) {
      console.log(`  ⚠ Anonymous tunnel access — anyone with the URL can control Copilot.`);
    }
    stepStart('Tunnel');
    try {
      let tunnelId = opts.tunnelId;

      // Auto-persistent tunnel: ensure it exists with the right port
      if (tunnelName && !tunnelId) {
        const info = getTunnelInfo(tunnelName);
        if (!info.exists) {
          createTunnel(tunnelName, actualPort);
        } else if (info.port !== actualPort) {
          updateTunnelPort(tunnelName, info.port ?? 0, actualPort);
        }
        tunnelId = tunnelName;
      }

      tunnel = await startTunnel({ port: actualPort, tunnelId, allowAnonymous: opts.allowAnonymous });
      stepDone('Tunnel', tunnel.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepDone('Tunnel', `failed — ${message}`, FAIL);
    }
  } else {
    stepDone('Tunnel', 'skipped (use --tunnel to enable)', SKIP);
  }

  // ── Step 3: Copilot CLI ─────────────────────────────────────────────
  stepStart('Copilot CLI', 'initializing...');
  const initStart = Date.now();
  try {
    await initializePromise;
    const elapsed = ((Date.now() - initStart) / 1000).toFixed(1);
    stepDone('Copilot CLI', `ready (${elapsed}s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stepDone('Copilot CLI', `failed — ${message}`, FAIL);
  }

  // ── QR code (if tunnel) ─────────────────────────────────────────────
  if (tunnel) {
    console.log();
    console.log('  Scan to connect:');
    qrcode.generate(tunnel.url, { small: true }, (code) => {
      console.log(code);
    });
  }

  console.log();
  console.log('  Press Ctrl+C to stop');

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\nShutting down...');
    if (tunnel) stopTunnel(tunnel);
    close();

    server.close((err) => {
      if (err) {
        console.error('Error while closing server:', err);
      }
      console.log('Goodbye!');
      process.exit(err ? 1 : 0);
    });

    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', () => {
    shutdown();
    // Exit after synchronous cleanup to avoid "Terminate batch job?" on Windows.
    // The shutdown() call above synchronously kills child processes and sends
    // WS close frames; the async server.close() callback is best-effort.
    setImmediate(() => process.exit(0));
  });
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Fatal:', message);
  process.exit(1);
});
