#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index.js';
import { startTunnel, stopTunnel, type TunnelResult } from '../src/server/tunnel.js';

const require = createRequire(import.meta.url);
const qrcode: {
  generate: (
    text: string,
    options?: { small?: boolean },
    callback?: (qrcode: string) => void,
  ) => void;
} = require('qrcode-terminal');

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const port = parseInt(getArg('port') ?? '3000', 10);
const tunnelId = getArg('tunnel-id');
const useTunnel = hasFlag('tunnel') || !!tunnelId;
const noTunnel = hasFlag('no-tunnel');
const allowAnonymous = hasFlag('allow-anonymous');
const cwd = getArg('cwd') ?? process.cwd();

if (hasFlag('help')) {
  console.log(`
Copilot Uplink — Remote control for GitHub Copilot CLI

Usage: copilot-uplink [options]

Options:
  --port <n>          Port for bridge server (default: 3000)
  --tunnel            Start a devtunnel for remote access
  --no-tunnel         Don't start a devtunnel
  --tunnel-id <name>  Use a persistent devtunnel
  --allow-anonymous   Allow anonymous tunnel access (no GitHub auth)
  --cwd <path>        Working directory for Copilot
  --help              Show this help
`);
  process.exit(0);
}

function resolveStaticDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, '../client'), resolve(moduleDir, '../dist/client')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function listen(server: ReturnType<typeof startServer>['server'], desiredPort: number) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
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

async function main() {
  console.log('⬆ Copilot Uplink starting...');
  console.log();

  const staticDir = resolveStaticDir();

  const { server, close } = startServer({
    port,
    staticDir,
    cwd: resolve(cwd),
  });

  await listen(server, port);

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Unable to determine server port');
  }

  const actualPort = addr.port;

  console.log(`  Local:  http://localhost:${actualPort}`);

  let tunnel: TunnelResult | null = null;
  if (useTunnel && !noTunnel) {
    if (allowAnonymous) {
      console.warn('⚠️  WARNING: Anonymous tunnel access enabled!');
      console.warn('   Anyone with the URL can control your Copilot session.');
    }
    try {
      tunnel = await startTunnel({ port: actualPort, tunnelId, allowAnonymous });
      console.log(`  Tunnel: ${tunnel.url}`);
      console.log();
      console.log('  Scan QR code on your phone to connect:');
      qrcode.generate(tunnel.url, { small: true }, (code) => {
        console.log(code);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Tunnel failed: ${message}`);
      console.log('  (Continuing without tunnel)');
    }
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

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Fatal:', message);
  process.exit(1);
});
