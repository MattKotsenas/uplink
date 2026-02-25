import { ChildProcess, spawn } from 'node:child_process';

const URL_REGEX = /(https:\/\/[^\s,]+devtunnels\.ms[^\s,]*)/i;
const BUFFER_LIMIT = 4096;
const URL_TIMEOUT_MS = 30_000;
const DEV_TUNNEL_NOT_FOUND_MESSAGE =
  'devtunnel CLI not found. Install: winget install Microsoft.devtunnel';

export interface TunnelOptions {
  port: number;
  tunnelId?: string;
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

  if (!tunnelId) {
    args.push('--allow-anonymous');
  }

  let child: ChildProcess;

  try {
    child = spawn('devtunnel', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(DEV_TUNNEL_NOT_FOUND_MESSAGE);
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

      rejectWith(new Error(message));
    };

    const handleError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'ENOENT') {
        rejectWith(new Error(DEV_TUNNEL_NOT_FOUND_MESSAGE));
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

  if (proc.killed) {
    return;
  }

  try {
    const graceful = proc.kill('SIGINT');

    if (!graceful) {
      proc.kill();
    }
  } catch {
    // ignore
  }
}
