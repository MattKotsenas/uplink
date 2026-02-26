import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

export interface SessionInfo {
  id: string;
  cwd: string;
  branch: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  cwd: string;
  branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_STORE_PATH = path.join(homedir(), '.copilot', 'session-store.db');

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
