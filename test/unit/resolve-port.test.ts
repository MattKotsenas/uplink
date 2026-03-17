import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolvePort } from '../../src/server/resolve-port.js';
import * as tunnel from '../../src/server/tunnel.js';

vi.mock('../../src/server/tunnel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof tunnel>();
  return {
    ...actual,
    hashCwd: vi.fn((cwd: string) => `uplink-${cwd.replace(/\W/g, '').slice(0, 8)}`),
    getTunnelInfo: vi.fn(),
  };
});

const mockGetTunnelInfo = vi.mocked(tunnel.getTunnelInfo);

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolvePort', () => {
  // ─── Local only (no tunnel flags) ──────────────────────────────

  it('returns random port when no flags are set', () => {
    const result = resolvePort({ cwd: '/project', tunnel: false });
    expect(result).toEqual({ port: 0 });
  });

  it('returns explicit port when --port is set without tunnel', () => {
    const result = resolvePort({ cwd: '/project', tunnel: false, explicitPort: 9005 });
    expect(result).toEqual({ port: 9005 });
  });

  // ─── --tunnel-id (user-managed) ─────────────────────────────────

  it('reads tunnel port for --tunnel-id without --port', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: true, port: 55618 });
    const result = resolvePort({ cwd: '/project', tunnel: true, tunnelId: 'my-tunnel' });
    expect(result.port).toBe(55618);
    expect(result.tunnelName).toBeUndefined();
    expect(mockGetTunnelInfo).toHaveBeenCalledWith('my-tunnel');
  });

  it('returns random port for --tunnel-id when tunnel has no port', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: true, port: undefined });
    const result = resolvePort({ cwd: '/project', tunnel: true, tunnelId: 'my-tunnel' });
    expect(result.port).toBe(0);
  });

  it('returns random port for --tunnel-id when tunnel does not exist', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: false });
    const result = resolvePort({ cwd: '/project', tunnel: true, tunnelId: 'my-tunnel' });
    expect(result.port).toBe(0);
  });

  it('uses explicit --port over tunnel config for --tunnel-id', () => {
    // --port overrides the tunnel's saved port (session-only, no mutation)
    mockGetTunnelInfo.mockReturnValue({ exists: true, port: 55618 });
    const result = resolvePort({ cwd: '/project', tunnel: true, tunnelId: 'my-tunnel', explicitPort: 9000 });
    expect(result.port).toBe(9000);
    expect(result.tunnelName).toBeUndefined();
  });

  it('skips getTunnelInfo for --tunnel-id when --port is explicit', () => {
    const result = resolvePort({ cwd: '/project', tunnel: true, tunnelId: 'my-tunnel', explicitPort: 9000 });
    expect(result.port).toBe(9000);
    expect(mockGetTunnelInfo).not.toHaveBeenCalled();
  });

  // ─── --tunnel (auto-persistent) ────────────────────────────────

  it('reuses saved port from existing tunnel', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: true, port: 3000 });
    const result = resolvePort({ cwd: '/project', tunnel: true });
    expect(result.port).toBe(3000);
    expect(result.tunnelName).toBeDefined();
  });

  it('returns random port when tunnel exists but has no port', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: true, port: undefined });
    const result = resolvePort({ cwd: '/project', tunnel: true });
    expect(result.port).toBe(0);
    expect(result.tunnelName).toBeDefined();
  });

  it('returns random port when tunnel does not exist', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: false });
    const result = resolvePort({ cwd: '/project', tunnel: true });
    expect(result.port).toBe(0);
    expect(result.tunnelName).toBeDefined();
  });

  it('returns explicit port with tunnelName for --tunnel + --port', () => {
    const result = resolvePort({ cwd: '/project', tunnel: true, explicitPort: 5000 });
    expect(result.port).toBe(5000);
    expect(result.tunnelName).toBeDefined();
    // Should NOT call getTunnelInfo when port is explicit
    expect(mockGetTunnelInfo).not.toHaveBeenCalled();
  });

  it('produces consistent tunnelName for the same cwd', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: false });
    const a = resolvePort({ cwd: '/project', tunnel: true });
    const b = resolvePort({ cwd: '/project', tunnel: true });
    expect(a.tunnelName).toBe(b.tunnelName);
  });

  it('produces different tunnelName for different cwds', () => {
    mockGetTunnelInfo.mockReturnValue({ exists: false });
    const a = resolvePort({ cwd: '/project-a', tunnel: true });
    const b = resolvePort({ cwd: '/project-b', tunnel: true });
    expect(a.tunnelName).not.toBe(b.tunnelName);
  });
});
