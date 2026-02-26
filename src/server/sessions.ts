import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { SessionInfo } from '../shared/acp-types.js';

export type { SessionInfo } from '../shared/acp-types.js';

interface SessionRow {
  id: string;
  cwd: string;
  branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_STORE_PATH = path.join(homedir(), '.copilot', 'session-store.db');

/**
 * Record a session in the session store so it appears in the sessions list.
 * Uses INSERT OR IGNORE to avoid conflicts if the CLI already created the row.
 */
export function recordSession(cwd: string, sessionId: string, dbPath: string = SESSION_STORE_PATH): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.prepare(
      'INSERT OR IGNORE INTO sessions (id, cwd, created_at, updated_at) VALUES (?, ?, datetime(\'now\'), datetime(\'now\'))',
    ).run(sessionId, cwd);
  } catch (err: unknown) {
    console.warn('Failed to record session:', (err as Error).message);
  } finally {
    db?.close();
  }
}

/** Rename a session's summary in the session store. */
export function renameSession(sessionId: string, summary: string, dbPath: string = SESSION_STORE_PATH): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.prepare(
      'UPDATE sessions SET summary = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(summary, sessionId);
  } catch (err: unknown) {
    console.warn('Failed to rename session:', (err as Error).message);
  } finally {
    db?.close();
  }
}

export function getRecentSessions(cwd: string, limit: number = 20, dbPath: string = SESSION_STORE_PATH): Promise<SessionInfo[]> {
  return Promise.resolve(querySessionsSync(cwd, limit, dbPath));
}

function querySessionsSync(cwd: string, limit: number, dbPath: string): SessionInfo[] {
  if (!existsSync(dbPath)) {
    return [];
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      'SELECT id, cwd, branch, summary, created_at, updated_at FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT ?'
    ).all(cwd, limit) as SessionRow[];

    return rows.map(toSessionInfo);
  } catch (err: unknown) {
    if (isSqliteBusy(err)) {
      // Retry once on SQLITE_BUSY
      try {
        db = new Database(dbPath, { readonly: true });
        const rows = db.prepare(
          'SELECT id, cwd, branch, summary, created_at, updated_at FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT ?'
        ).all(cwd, limit) as SessionRow[];
        return rows.map(toSessionInfo);
      } catch {
        return [];
      }
    }
    console.warn('Failed to read session store:', (err as Error).message);
    return [];
  } finally {
    db?.close();
  }
}

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    cwd: row.cwd,
    branch: row.branch,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSqliteBusy(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === 'SQLITE_BUSY';
}
