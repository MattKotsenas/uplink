import { describe, it, expect, afterEach } from 'vitest';
import { getRecentSessions, recordSession, renameSession } from '../../src/server/sessions.js';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('getRecentSessions', () => {
  const tmpFiles: string[] = [];

  function createTestDb(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-test-'));
    const dbPath = path.join(tmpDir, 'session-store.db');
    tmpFiles.push(dbPath, tmpDir);

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        branch TEXT,
        summary TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    return dbPath;
  }

  afterEach(() => {
    for (const f of tmpFiles.reverse()) {
      try {
        if (fs.statSync(f).isDirectory()) {
          fs.rmSync(f, { recursive: true });
        } else {
          fs.unlinkSync(f);
        }
      } catch {
        // ignore
      }
    }
    tmpFiles.length = 0;
  });

  it('returns empty array when DB does not exist', async () => {
    const result = await getRecentSessions('/some/cwd', 20, '/nonexistent/path.db');
    expect(result).toEqual([]);
  });

  it('returns sessions matching the cwd', async () => {
    const dbPath = createTestDb();
    const db = new Database(dbPath);
    db.prepare(
      'INSERT INTO sessions (id, cwd, branch, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s1', '/projects/a', 'main', 'First session', '2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z');
    db.prepare(
      'INSERT INTO sessions (id, cwd, branch, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s2', '/projects/a', 'dev', 'Second session', '2024-01-02T00:00:00Z', '2024-01-02T01:00:00Z');
    db.prepare(
      'INSERT INTO sessions (id, cwd, branch, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s3', '/projects/b', 'main', 'Other project', '2024-01-03T00:00:00Z', '2024-01-03T01:00:00Z');
    db.close();

    const result = await getRecentSessions('/projects/a', 20, dbPath);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('s2');
    expect(result[1].id).toBe('s1');
    expect(result[0]).toEqual({
      id: 's2',
      cwd: '/projects/a',
      branch: 'dev',
      summary: 'Second session',
      createdAt: '2024-01-02T00:00:00Z',
      updatedAt: '2024-01-02T01:00:00Z',
    });
  });

  it('respects the limit parameter', async () => {
    const dbPath = createTestDb();
    const db = new Database(dbPath);
    for (let i = 0; i < 5; i++) {
      db.prepare(
        'INSERT INTO sessions (id, cwd, branch, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(`s${i}`, '/projects/a', 'main', `Session ${i}`, `2024-01-0${i + 1}T00:00:00Z`, `2024-01-0${i + 1}T01:00:00Z`);
    }
    db.close();

    const result = await getRecentSessions('/projects/a', 2, dbPath);
    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0].id).toBe('s4');
    expect(result[1].id).toBe('s3');
  });

  it('returns empty array for cwd with no sessions', async () => {
    const dbPath = createTestDb();
    const result = await getRecentSessions('/no/sessions/here', 20, dbPath);
    expect(result).toEqual([]);
  });
});

describe('recordSession', () => {
  const tmpFiles: string[] = [];

  function createTestDb(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-test-'));
    const dbPath = path.join(tmpDir, 'session-store.db');
    tmpFiles.push(dbPath, tmpDir);

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        branch TEXT,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.close();
    return dbPath;
  }

  afterEach(() => {
    for (const f of tmpFiles.reverse()) {
      try {
        if (fs.statSync(f).isDirectory()) {
          fs.rmSync(f, { recursive: true });
        } else {
          fs.unlinkSync(f);
        }
      } catch {
        // ignore
      }
    }
    tmpFiles.length = 0;
  });

  it('inserts a new session row', async () => {
    const dbPath = createTestDb();
    recordSession('/projects/a', 'new-session-1', dbPath);

    const result = await getRecentSessions('/projects/a', 20, dbPath);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('new-session-1');
    expect(result[0].cwd).toBe('/projects/a');
  });

  it('does not overwrite existing session', async () => {
    const dbPath = createTestDb();
    const db = new Database(dbPath);
    db.prepare(
      'INSERT INTO sessions (id, cwd, summary) VALUES (?, ?, ?)',
    ).run('existing-1', '/projects/a', 'Already here');
    db.close();

    recordSession('/projects/a', 'existing-1', dbPath);

    const result = await getRecentSessions('/projects/a', 20, dbPath);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Already here');
  });

  it('does not throw for nonexistent DB path', () => {
    expect(() => recordSession('/x', 's1', '/nonexistent/path.db')).not.toThrow();
  });
});

describe('renameSession', () => {
  const tmpFiles: string[] = [];

  function createTestDb(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-test-'));
    const dbPath = path.join(tmpDir, 'session-store.db');
    tmpFiles.push(dbPath, tmpDir);

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        branch TEXT,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.close();
    return dbPath;
  }

  afterEach(() => {
    for (const f of tmpFiles.reverse()) {
      try {
        if (fs.statSync(f).isDirectory()) {
          fs.rmSync(f, { recursive: true });
        } else {
          fs.unlinkSync(f);
        }
      } catch {
        // ignore
      }
    }
    tmpFiles.length = 0;
  });

  it('updates the summary of an existing session', async () => {
    const dbPath = createTestDb();
    recordSession('/projects/a', 'sess-1', dbPath);

    renameSession('sess-1', 'My Cool Session', dbPath);

    const result = await getRecentSessions('/projects/a', 20, dbPath);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('My Cool Session');
  });

  it('does nothing for a nonexistent session', () => {
    const dbPath = createTestDb();
    expect(() => renameSession('no-such-id', 'Name', dbPath)).not.toThrow();
  });

  it('does not throw for nonexistent DB path', () => {
    expect(() => renameSession('s1', 'Name', '/nonexistent/path.db')).not.toThrow();
  });
});
