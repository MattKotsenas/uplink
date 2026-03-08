import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface UplinkConfig {
  /** Configured directories for multi-dir mode. Empty = single-dir mode. */
  dirs: string[];
}

/**
 * Load directory configuration from (in priority order):
 * 1. --dirs CLI flag (comma-separated)
 * 2. UPLINK_DIRS env var (colon-separated on Unix, semicolon on Windows)
 * 3. uplink.config.json in the given base directory
 *
 * Returns resolved absolute paths. Non-existent directories are filtered out.
 */
export function loadConfig(options: {
  cliDirs?: string;
  cwd: string;
}): UplinkConfig {
  let raw: string[] = [];

  // 1. CLI flag
  if (options.cliDirs) {
    raw = options.cliDirs.split(',').map(d => d.trim()).filter(Boolean);
  }

  // 2. Env var
  if (raw.length === 0 && process.env.UPLINK_DIRS) {
    const sep = process.platform === 'win32' ? ';' : ':';
    raw = process.env.UPLINK_DIRS.split(sep).map(d => d.trim()).filter(Boolean);
  }

  // 3. Config file
  if (raw.length === 0) {
    const configPath = resolve(options.cwd, 'uplink.config.json');
    if (existsSync(configPath)) {
      try {
        const json = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (Array.isArray(json.dirs)) {
          raw = json.dirs.filter((d: unknown) => typeof d === 'string' && d.trim());
        }
      } catch {
        // ignore malformed config
      }
    }
  }

  // Resolve and validate
  const dirs = raw
    .map(d => resolve(d))
    .filter(d => existsSync(d));

  return { dirs };
}
