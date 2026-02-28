import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import createDebug from 'debug';

const log = createDebug('uplink:bridge');

export interface BridgeOptions {
  command: string;      // e.g., "copilot" or "npx tsx src/mock/mock-agent.ts"
  args: string[];       // e.g., ["--acp", "--stdio"]
  cwd?: string;         // working directory for the subprocess
  env?: Record<string, string | undefined>;  // environment variables for the subprocess
}

export class Bridge {
  private child: ChildProcess | null = null;
  private messageCallback: ((line: string) => void) | null = null;
  private errorCallback: ((err: Error) => void) | null = null;
  private closeCallback: ((code: number | null) => void) | null = null;

  constructor(private options: BridgeOptions) {}

  spawn(): void {
    if (this.child) {
      throw new Error('Process already spawned');
    }

    // Spawn the child process
    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...process.env, ...this.options.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error('Failed to spawn process with stdin/stdout');
    }

    // Handle process errors
    this.child.on('error', (err) => {
      if (this.errorCallback) this.errorCallback(err);
    });

    // Handle process exit
    this.child.on('close', (code) => {
      // Don't null out child immediately to allow inspection of exitCode if needed
      if (this.closeCallback) this.closeCallback(code);
    });

    // Read stdout line by line
    const rl = createInterface({
      input: this.child.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      if (line.trim() && this.messageCallback) {
        this.messageCallback(line);
      }
    });

    // Log stderr
    this.child.stderr?.on('data', (data) => {
      log('stderr: %s', data);
    });
  }

  send(message: string): void {
    if (!this.child || !this.child.stdin) {
      return;
    }
    
    const payload = message.endsWith('\n') ? message : message + '\n';
    try {
      const ok = this.child.stdin.write(payload);
      if (!ok) {
        log('stdin backpressure detected');
      }
    } catch (err) {
      log('failed to write to stdin: %O', err);
    }
  }

  onMessage(callback: (line: string) => void): void {
    this.messageCallback = callback;
  }

  onError(callback: (err: Error) => void): void {
    this.errorCallback = callback;
  }

  onClose(callback: (code: number | null) => void): void {
    this.closeCallback = callback;
  }

  kill(): void {
    if (!this.child) return;

    // Remove listeners to avoid double-handling
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.child.removeAllListeners();

    // Kill
    this.child.kill(); 
    this.child = null;
  }

  isAlive(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }
}

