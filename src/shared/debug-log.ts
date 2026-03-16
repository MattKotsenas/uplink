/**
 * Structured debug log with a fixed-size ring buffer.
 *
 * Shared by client and server. Each side creates its own instance.
 * Entries are kept in memory and exported on demand via `/debug`.
 */

// ─── Types ────────────────────────────────────────────────────────────

export type DebugCategory = 'conn' | 'proto' | 'ui';

export interface DebugEntry {
  /** High-resolution relative timestamp (performance.now / process.hrtime). */
  t: number;
  /** Wall-clock timestamp for cross-side correlation. */
  wall: number;
  /** Event category. */
  cat: DebugCategory;
  /** Event name, e.g. 'state_change', 'ws_send'. */
  evt: string;
  /** Optional event-specific payload. Keep small. */
  data?: unknown;
}

export interface DebugSnapshot {
  connectionState?: string;
  messageCount?: number;
  toolCallCount?: number;
  timelineLength?: number;
  pendingPermissions?: number;
  reconnectAttempts?: number;
  localStorage?: Record<string, string>;
  [key: string]: unknown;
}

export interface DebugLogExport {
  version: 1;
  exportedAt: string;
  sessionId: string | null;
  userAgent: string;
  uptime: number;
  client: {
    entries: DebugEntry[];
    snapshot: DebugSnapshot;
  };
  server: {
    entries: DebugEntry[];
    snapshot?: ServerSnapshot;
  };
}

export interface ServerSnapshot {
  activeSessionId: string | null;
  /** Per-session buffer summary: session ID → history length. */
  sessionBuffers: Record<string, { historyLength: number; hasActivePrompt: boolean }>;
  recentSessionCount: number;
  bridgeAlive: boolean;
  hasCachedInit: boolean;
}

// ─── Ring Buffer ──────────────────────────────────────────────────────

const DEFAULT_CAPACITY = 5_000;

export class DebugLog {
  private readonly buf: (DebugEntry | undefined)[];
  private writePos = 0;
  private count = 0;
  private readonly getNow: () => number;

  constructor(
    capacity = DEFAULT_CAPACITY,
    /** Injectable clock for testing. Defaults to performance.now or Date.now. */
    getNow?: () => number,
  ) {
    this.buf = new Array(capacity);
    this.getNow = getNow ?? (typeof performance !== 'undefined'
      ? () => performance.now()
      : () => Date.now());
  }

  get capacity(): number {
    return this.buf.length;
  }

  get size(): number {
    return this.count;
  }

  append(cat: DebugCategory, evt: string, data?: unknown): void {
    const entry: DebugEntry = {
      t: this.getNow(),
      wall: Date.now(),
      cat,
      evt,
    };
    if (data !== undefined) {
      entry.data = data;
    }
    this.buf[this.writePos] = entry;
    this.writePos = (this.writePos + 1) % this.buf.length;
    if (this.count < this.buf.length) {
      this.count++;
    }
  }

  /** Return entries in chronological order. */
  entries(): DebugEntry[] {
    if (this.count < this.buf.length) {
      // Buffer hasn't wrapped yet - entries are 0..count-1
      return this.buf.slice(0, this.count) as DebugEntry[];
    }
    // Buffer has wrapped - oldest entry is at writePos
    return [
      ...this.buf.slice(this.writePos),
      ...this.buf.slice(0, this.writePos),
    ] as DebugEntry[];
  }

  /** Return entries filtered by category. */
  entriesByCategory(cat: DebugCategory): DebugEntry[] {
    return this.entries().filter(e => e.cat === cat);
  }

  clear(): void {
    this.buf.fill(undefined);
    this.writePos = 0;
    this.count = 0;
  }
}
