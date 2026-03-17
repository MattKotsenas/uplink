import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { getDevTunnelNotFoundMessage, hashCwd, getTunnelInfo, createTunnel, updateTunnelPort, startTunnel } from '../../src/server/tunnel.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFileSync: vi.fn(), spawn: vi.fn() };
});

const mockExecFileSync = vi.mocked(childProcess.execFileSync);
const mockSpawn = vi.mocked(childProcess.spawn);

describe('getDevTunnelNotFoundMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('suggests brew on macOS', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. Install: brew install --cask devtunnel',
    );
  });

  it('suggests curl on Linux', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. Install: curl -sL https://aka.ms/DevTunnelCliInstall | bash',
    );
  });

  it('suggests winget on Windows', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. Install: winget install Microsoft.devtunnel',
    );
  });

  it('returns fallback URL for unknown platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'freebsd' });
    expect(getDevTunnelNotFoundMessage()).toBe(
      'devtunnel CLI not found. See https://aka.ms/DevTunnelCliInstall',
    );
  });
});

describe('hashCwd', () => {
  it('returns a deterministic uplink- prefixed hash', () => {
    const result = hashCwd('/home/user/project');
    expect(result).toMatch(/^uplink-[0-9a-f]{8}$/);
    expect(hashCwd('/home/user/project')).toBe(result);
  });

  it('produces different hashes for different paths', () => {
    expect(hashCwd('/a')).not.toBe(hashCwd('/b'));
  });
});

describe('getTunnelInfo', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns { exists: true, port } when tunnel exists with a port', () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ tunnel: { ports: [{ portNumber: 3000 }] } }),
    );
    expect(getTunnelInfo('uplink-abc12345')).toEqual({ exists: true, port: 3000 });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'devtunnel',
      ['show', 'uplink-abc12345', '--json'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns { exists: true } when tunnel has no ports', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ tunnel: { ports: [] } }));
    expect(getTunnelInfo('test')).toEqual({ exists: true, port: undefined });
  });

  it('returns { exists: false } when devtunnel show fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('Tunnel not found');
    });
    expect(getTunnelInfo('missing')).toEqual({ exists: false });
  });
});

describe('createTunnel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls devtunnel create and port create', () => {
    mockExecFileSync.mockReturnValue('');
    createTunnel('uplink-abc12345', 9005);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'devtunnel', ['create', 'uplink-abc12345'], expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'devtunnel', ['port', 'create', 'uplink-abc12345', '-p', '9005'], expect.any(Object),
    );
  });
});

describe('updateTunnelPort', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('deletes old port and creates new one', () => {
    mockExecFileSync.mockReturnValue('');
    updateTunnelPort('name', 3000, 4000);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'devtunnel', ['port', 'delete', 'name', '-p', '3000'], expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'devtunnel', ['port', 'create', 'name', '-p', '4000'], expect.any(Object),
    );
  });

  it('still creates new port even if delete fails', () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('not found'); })
      .mockReturnValueOnce('');
    updateTunnelPort('name', 3000, 4000);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });
});

// ─── startTunnel ──────────────────────────────────────────────────────

describe('startTunnel', () => {
  function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.exitCode = null;
    child.kill = vi.fn();

    (child.stdout as any).setEncoding = vi.fn();
    (child.stderr as any).setEncoding = vi.fn();

    return child;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes -p <port> for ephemeral tunnel (no tunnelId)', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const promise = startTunnel({ port: 9005 });
    child.stderr.emit('data', 'Connect via browser: https://abc123.usw2.devtunnels.ms\n');

    await promise;
    expect(mockSpawn).toHaveBeenCalledWith(
      'devtunnel',
      ['host', '-p', '9005'],
      expect.any(Object),
    );
  });

  it('passes tunnelId AND -p <port> for named tunnel', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    // port is the server's actual listen port, which may differ from the
    // port pre-configured on the tunnel. Passing -p ensures devtunnel
    // forwards to the right local port regardless of tunnel config.
    const promise = startTunnel({ port: 55618, tunnelId: 'my-tunnel' });
    child.stderr.emit('data', 'Connect via browser: https://xyz789.usw2.devtunnels.ms\n');

    await promise;
    expect(mockSpawn).toHaveBeenCalledWith(
      'devtunnel',
      ['host', 'my-tunnel', '-p', '55618'],
      expect.any(Object),
    );
  });

  it('includes --allow-anonymous when set', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const promise = startTunnel({ port: 3000, tunnelId: 'named', allowAnonymous: true });
    child.stdout.emit('data', 'https://tunnel.usw2.devtunnels.ms');

    await promise;
    expect(mockSpawn).toHaveBeenCalledWith(
      'devtunnel',
      ['host', 'named', '-p', '3000', '--allow-anonymous'],
      expect.any(Object),
    );
  });

  it('resolves with URL from stdout', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const promise = startTunnel({ port: 3000 });
    child.stdout.emit('data', 'Connect via browser: https://abc.usw2.devtunnels.ms\n');

    const result = await promise;
    expect(result.url).toBe('https://abc.usw2.devtunnels.ms');
  });

  it('resolves with URL from stderr', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const promise = startTunnel({ port: 3000 });
    child.stderr.emit('data', 'https://abc.usw2.devtunnels.ms\n');

    const result = await promise;
    expect(result.url).toBe('https://abc.usw2.devtunnels.ms');
  });

  it('rejects when devtunnel exits without a URL', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const promise = startTunnel({ port: 3000 });
    child.emit('exit', 1, null);

    await expect(promise).rejects.toThrow('devtunnel exited with code 1');
  });

  it('rejects with ENOENT hint when devtunnel is not found', async () => {
    const child = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const promise = startTunnel({ port: 3000 });
    const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    child.emit('error', err);

    await expect(promise).rejects.toThrow('devtunnel CLI not found');
  });
});
