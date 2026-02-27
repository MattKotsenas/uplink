import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const URL_REGEX = /(https:\/\/[^\s,]+devtunnels\.ms[^\s,]*)/i;
const BUFFER_LIMIT = 4096;
const URL_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 5_000;

// ─── Tunnel name hashing ──────────────────────────────────────────────

export function hashCwd(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return `uplink-${hash}`;
}

// ─── devtunnel CLI helpers ────────────────────────────────────────────

interface TunnelInfo {
  exists: boolean;
  port?: number;
}

export function getTunnelInfo(tunnelName: string): TunnelInfo {
  try {
    const output = execFileSync('devtunnel', ['show', tunnelName, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const data = JSON.parse(output);
    const port = data?.tunnel?.ports?.[0]?.portNumber as number | undefined;
    return { exists: true, port };
  } catch {
    return { exists: false };
  }
}

export function createTunnel(tunnelName: string, port: number): void {
  execFileSync('devtunnel', ['create', tunnelName], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  execFileSync('devtunnel', ['port', 'create', tunnelName, '-p', String(port)], {
    stdio: 'ignore',
    timeout: 10_000,
  });
}

export function updateTunnelPort(tunnelName: string, oldPort: number, newPort: number): void {
  try {
    execFileSync('devtunnel', ['port', 'delete', tunnelName, '-p', String(oldPort)], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch {
    // Port may not exist — ignore
  }
  execFileSync('devtunnel', ['port', 'create', tunnelName, '-p', String(newPort)], {
    stdio: 'ignore',
    timeout: 10_000,
  });
}
export function getDevTunnelNotFoundMessage(): string {
  switch (process.platform) {
    case 'darwin':
      return 'devtunnel CLI not found. Install: brew install --cask devtunnel';
    case 'linux':
      return 'devtunnel CLI not found. Install: curl -sL https://aka.ms/DevTunnelCliInstall | bash';
    case 'win32':
      return 'devtunnel CLI not found. Install: winget install Microsoft.devtunnel';
    default:
      return 'devtunnel CLI not found. See https://aka.ms/DevTunnelCliInstall';
  }
}

export interface TunnelOptions {
  port: number;
  tunnelId?: string;
  allowAnonymous?: boolean;
}

export interface TunnelResult {
  url: string;
  process: ChildProcess;
}

export async function startTunnel(options: TunnelOptions): Promise<TunnelResult> {
  const { port, tunnelId } = options;
  const args = ['host'];

  if (tunnelId) {
    args.push(tunnelId);
  }

  args.push('-p', String(port));

  if (options.allowAnonymous) {
    args.push('--allow-anonymous');
  }

  let child: ChildProcess;

  try {
    child = spawn('devtunnel', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(getDevTunnelNotFoundMessage());
    }

    throw error;
  }

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  return new Promise<TunnelResult>((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stderrLog = '';
    let settled = false;

    const cleanup = (): void => {
      child.stdout?.off('data', handleStdout);
      child.stderr?.off('data', handleStderr);
      child.off('exit', handleExit);
      child.off('error', handleError);
      clearTimeout(timeoutId);
    };

    const resolveWith = (url: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({ url, process: child });
    };

    const rejectWith = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      try {
        child.kill();
      } catch {
        // ignore
      }

      reject(error);
    };

    const checkForUrl = (buffer: string): string | undefined => {
      const match = buffer.match(URL_REGEX);
      return match?.[1];
    };

    const trimBuffer = (value: string): string => {
      if (value.length <= BUFFER_LIMIT) {
        return value;
      }

      return value.slice(-BUFFER_LIMIT);
    };

    const handleStdout = (chunk: string): void => {
      stdoutBuffer = trimBuffer(stdoutBuffer + chunk);
      const url = checkForUrl(stdoutBuffer);

      if (url) {
        resolveWith(url);
      }
    };

    const handleStderr = (chunk: string): void => {
      stderrLog += chunk;
      stderrBuffer = trimBuffer(stderrBuffer + chunk);
      const url = checkForUrl(stderrBuffer);

      if (url) {
        resolveWith(url);
      }
    };

    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      let message = 'devtunnel exited before providing a public URL.';

      if (code !== null) {
        message = `devtunnel exited with code ${code}.`;
      } else if (signal) {
        message = `devtunnel was terminated by signal ${signal}.`;
      }

      if (stderrLog.trim().length > 0) {
        message += `\n${stderrLog.trim()}`;
      }

      // Surface actionable hints for common errors
      if (/unauthorized|not permitted|does not have.*access/i.test(stderrLog)) {
        message += '\n\nFix: run `devtunnel user login` to authenticate.';
      }

      rejectWith(new Error(message));
    };

    const handleError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'ENOENT') {
        rejectWith(new Error(getDevTunnelNotFoundMessage()));
        return;
      }

      rejectWith(error);
    };

    const timeoutId = setTimeout(() => {
      rejectWith(new Error('Timed out waiting for devtunnel URL (30s).'));
    }, URL_TIMEOUT_MS);

    child.stdout?.on('data', handleStdout);
    child.stderr?.on('data', handleStderr);
    child.once('exit', handleExit);
    child.once('error', handleError);
  });
}

export function stopTunnel(tunnel: TunnelResult): void {
  const proc = tunnel.process;

  if (proc.killed || proc.exitCode !== null) {
    return;
  }

  const forceKill = (): void => {
    try {
      if (!proc.kill('SIGKILL')) {
        proc.kill();
      }
    } catch {
      // ignore
    }
  };

  let timeout: NodeJS.Timeout | undefined;

  try {
    const graceful = proc.kill('SIGINT');

    if (!graceful) {
      forceKill();
      return;
    }
  } catch {
    forceKill();
    return;
  }

  timeout = setTimeout(() => {
    if (!proc.killed && proc.exitCode === null) {
      forceKill();
    }
  }, FORCE_KILL_DELAY_MS);

  proc.once('exit', () => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}
