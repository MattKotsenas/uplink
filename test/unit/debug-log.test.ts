import { describe, it, expect, beforeEach } from 'vitest';
import { DebugLog, type DebugEntry } from '../../src/shared/debug-log';

describe('DebugLog', () => {
  let log: DebugLog;
  let tick: number;
  const fakeClock = () => tick++;

  beforeEach(() => {
    tick = 0;
    log = new DebugLog(5, fakeClock);
  });

  // ── Basic append and retrieval ─────────────────────────────────────

  it('starts empty', () => {
    expect(log.size).toBe(0);
    expect(log.entries()).toEqual([]);
  });

  it('appends entries in order', () => {
    log.append('conn', 'state_change', { from: 'a', to: 'b' });
    log.append('proto', 'ws_send', { method: 'initialize' });

    expect(log.size).toBe(2);
    const entries = log.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].cat).toBe('conn');
    expect(entries[0].evt).toBe('state_change');
    expect(entries[0].data).toEqual({ from: 'a', to: 'b' });
    expect(entries[1].cat).toBe('proto');
  });

  it('sets t from injected clock and wall from Date.now', () => {
    log.append('ui', 'msg_append');
    const entry = log.entries()[0];
    expect(entry.t).toBe(0); // first tick
    expect(entry.wall).toBeTypeOf('number');
    expect(entry.wall).toBeGreaterThan(0);
  });

  it('omits data field when undefined', () => {
    log.append('conn', 'ws_open');
    const entry = log.entries()[0];
    expect(Object.keys(entry)).not.toContain('data');
  });

  // ── Ring buffer wrap-around ────────────────────────────────────────

  it('wraps around when capacity exceeded', () => {
    // Capacity is 5
    for (let i = 0; i < 7; i++) {
      log.append('conn', `event-${i}`);
    }

    expect(log.size).toBe(5);
    const entries = log.entries();
    expect(entries).toHaveLength(5);
    // Oldest entries (0, 1) should be gone; entries 2-6 remain in order
    expect(entries[0].evt).toBe('event-2');
    expect(entries[1].evt).toBe('event-3');
    expect(entries[2].evt).toBe('event-4');
    expect(entries[3].evt).toBe('event-5');
    expect(entries[4].evt).toBe('event-6');
  });

  it('maintains chronological order after multiple wraps', () => {
    for (let i = 0; i < 13; i++) {
      log.append('proto', `e-${i}`);
    }

    const entries = log.entries();
    expect(entries).toHaveLength(5);
    // Should be e-8 through e-12
    expect(entries.map(e => e.evt)).toEqual([
      'e-8', 'e-9', 'e-10', 'e-11', 'e-12',
    ]);
  });

  // ── Category filtering ─────────────────────────────────────────────

  it('filters entries by category', () => {
    log.append('conn', 'a');
    log.append('proto', 'b');
    log.append('ui', 'c');
    log.append('conn', 'd');

    expect(log.entriesByCategory('conn').map(e => e.evt)).toEqual(['a', 'd']);
    expect(log.entriesByCategory('proto').map(e => e.evt)).toEqual(['b']);
    expect(log.entriesByCategory('ui').map(e => e.evt)).toEqual(['c']);
  });

  // ── Clear ──────────────────────────────────────────────────────────

  it('clears all entries', () => {
    log.append('conn', 'a');
    log.append('proto', 'b');
    log.clear();

    expect(log.size).toBe(0);
    expect(log.entries()).toEqual([]);
  });

  it('works correctly after clear and re-append', () => {
    log.append('conn', 'before');
    log.clear();
    log.append('ui', 'after');

    expect(log.size).toBe(1);
    expect(log.entries()[0].evt).toBe('after');
  });

  // ── Capacity ───────────────────────────────────────────────────────

  it('respects custom capacity', () => {
    const small = new DebugLog(3, fakeClock);
    for (let i = 0; i < 5; i++) {
      small.append('conn', `e-${i}`);
    }
    expect(small.capacity).toBe(3);
    expect(small.size).toBe(3);
    expect(small.entries().map(e => e.evt)).toEqual(['e-2', 'e-3', 'e-4']);
  });

  it('uses default capacity when none specified', () => {
    const defaultLog = new DebugLog();
    expect(defaultLog.capacity).toBe(5_000);
  });

  // ── entries() returns copies ───────────────────────────────────────

  it('returns a new array on each call to entries()', () => {
    log.append('conn', 'a');
    const a = log.entries();
    const b = log.entries();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
