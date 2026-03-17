import { hashCwd, getTunnelInfo } from './tunnel.js';

export interface ResolvePortOptions {
  cwd: string;
  explicitPort?: number;
  tunnel: boolean;
  tunnelId?: string;
}

export interface ResolvePortResult {
  port: number;
  tunnelName?: string;
}

export function resolvePort(opts: ResolvePortOptions): ResolvePortResult {
  // --tunnel-id: user-managed tunnel — read its port, never modify it
  if (opts.tunnelId) {
    if (opts.explicitPort != null) {
      return { port: opts.explicitPort };
    }

    const info = getTunnelInfo(opts.tunnelId);
    if (info.exists && info.port) {
      return { port: info.port };
    }

    return { port: 0 };
  }

  // --tunnel without --tunnel-id: auto-persistent
  if (opts.tunnel) {
    const tunnelName = hashCwd(opts.cwd);

    if (opts.explicitPort != null) {
      return { port: opts.explicitPort, tunnelName };
    }

    // Try to reuse the port from the existing tunnel
    const info = getTunnelInfo(tunnelName);
    if (info.exists && info.port) {
      return { port: info.port, tunnelName };
    }

    return { port: 0, tunnelName };
  }

  // Local only
  return { port: opts.explicitPort ?? 0 };
}
