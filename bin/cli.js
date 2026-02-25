#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index.js';
import { startTunnel, stopTunnel } from '../src/server/tunnel.js';
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1)
        return undefined;
    return args[idx + 1];
}
function hasFlag(name) {
    return args.includes(`--${name}`);
}
const port = parseInt(getArg('port') ?? '3000', 10);
const tunnelId = getArg('tunnel-id');
const useTunnel = hasFlag('tunnel') || !!tunnelId;
const noTunnel = hasFlag('no-tunnel');
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
  --cwd <path>        Working directory for Copilot
  --help              Show this help
`);
    process.exit(0);
}
function resolveStaticDir() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [resolve(moduleDir, '../client'), resolve(moduleDir, '../dist/client')];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
async function listen(server, desiredPort) {
    await new Promise((resolvePromise, rejectPromise) => {
        const handleError = (error) => {
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
    const server = startServer({
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
    let tunnel = null;
    if (useTunnel && !noTunnel) {
        try {
            tunnel = await startTunnel({ port: actualPort, tunnelId });
            console.log(`  Tunnel: ${tunnel.url}`);
            console.log();
            console.log('  Scan QR code on your phone to connect:');
            // TODO: generate QR code with qrcode-terminal
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`  Tunnel failed: ${message}`);
            console.log('  (Continuing without tunnel)');
        }
    }
    console.log();
    console.log('  Press Ctrl+C to stop');
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log('\nShutting down...');
        if (tunnel)
            stopTunnel(tunnel);
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
