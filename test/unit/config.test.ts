import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadConfig', () => {
  let tempDir: string;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'uplink-config-test-'));
    dirA = join(tempDir, 'project-a');
    dirB = join(tempDir, 'project-b');
    mkdirSync(dirA);
    mkdirSync(dirB);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.UPLINK_DIRS;
  });

  it('returns empty dirs when nothing is configured', () => {
    const config = loadConfig({ cwd: tempDir });
    expect(config.dirs).toEqual([]);
  });

  it('reads --dirs CLI flag (comma-separated)', () => {
    const config = loadConfig({ cliDirs: `${dirA},${dirB}`, cwd: tempDir });
    expect(config.dirs).toEqual([dirA, dirB]);
  });

  it('filters out non-existent directories from CLI flag', () => {
    const config = loadConfig({ cliDirs: `${dirA},/nonexistent/path`, cwd: tempDir });
    expect(config.dirs).toEqual([dirA]);
  });

  it('reads UPLINK_DIRS env var', () => {
    process.env.UPLINK_DIRS = `${dirA}${delimiter}${dirB}`;
    const config = loadConfig({ cwd: tempDir });
    expect(config.dirs).toEqual([dirA, dirB]);
  });

  it('CLI flag takes priority over env var', () => {
    process.env.UPLINK_DIRS = dirB;
    const config = loadConfig({ cliDirs: dirA, cwd: tempDir });
    expect(config.dirs).toEqual([dirA]);
  });

  it('reads uplink.config.json when no CLI or env', () => {
    writeFileSync(join(tempDir, 'uplink.config.json'), JSON.stringify({ dirs: [dirA, dirB] }));
    const config = loadConfig({ cwd: tempDir });
    expect(config.dirs).toEqual([dirA, dirB]);
  });

  it('CLI flag takes priority over config file', () => {
    writeFileSync(join(tempDir, 'uplink.config.json'), JSON.stringify({ dirs: [dirB] }));
    const config = loadConfig({ cliDirs: dirA, cwd: tempDir });
    expect(config.dirs).toEqual([dirA]);
  });

  it('handles malformed config file gracefully', () => {
    writeFileSync(join(tempDir, 'uplink.config.json'), 'not json');
    const config = loadConfig({ cwd: tempDir });
    expect(config.dirs).toEqual([]);
  });
});
