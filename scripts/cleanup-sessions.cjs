#!/usr/bin/env node
/**
 * One-off cleanup script for accumulated test/empty sessions.
 *
 * What it cleans:
 *   1. DB: mock-* rows in ~/.copilot/session-store.db
 *   2. Filesystem: session-state dirs with no events.jsonl (empty sessions)
 *   3. Filesystem: session-state dirs with test-like summaries
 *   4. Filesystem: stray .jsonl/_result.json files in session-state/
 *
 * Safety:
 *   - Dry-run by default (pass --apply to actually delete)
 *   - Skips any session with events.jsonl unless it matches test patterns
 *   - Never touches dirs that aren't UUID-formatted
 *
 * Usage:
 *   node scripts/cleanup-sessions.cjs          # dry run
 *   node scripts/cleanup-sessions.cjs --apply  # actually delete
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const dryRun = !process.argv.includes('--apply');
const ssDir = path.join(os.homedir(), '.copilot', 'session-state');
const dbPath = path.join(os.homedir(), '.copilot', 'session-store.db');

if (dryRun) {
  console.log('DRY RUN — pass --apply to actually delete\n');
}

// ─── Test-like summary patterns ───────────────────────────────────────

function isTestLikeSummary(summary) {
  const lc = summary.toLowerCase().trim();
  return (
    lc.includes('say exactly') ||
    lc.includes('msg_') ||
    lc === 'hello' ||
    lc === 'hi' ||
    lc === 'test' ||
    lc.startsWith('say "') ||
    lc.startsWith("say '")
  );
}

// ─── 1. DB cleanup ───────────────────────────────────────────────────

let dbCleaned = 0;
if (fs.existsSync(dbPath)) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const count = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE id LIKE 'mock-%'").get().c;
    if (count > 0) {
      if (dryRun) {
        console.log(`DB: would delete ${count} mock-* rows`);
      } else {
        const result = db.prepare("DELETE FROM sessions WHERE id LIKE 'mock-%'").run();
        dbCleaned = result.changes;
        console.log(`DB: deleted ${dbCleaned} mock-* rows`);
      }
    } else {
      console.log('DB: no mock-* rows to clean');
    }
    db.close();
  } catch (err) {
    console.log(`DB: skipped (${err.message})`);
    console.log('   Install better-sqlite3 to clean DB: npm install better-sqlite3');
  }
} else {
  console.log('DB: session-store.db not found, skipping');
}

// ─── 2 & 3. Filesystem cleanup ───────────────────────────────────────

if (!fs.existsSync(ssDir)) {
  console.log('\nFilesystem: session-state dir not found');
  process.exit(0);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const entries = fs.readdirSync(ssDir, { withFileTypes: true });

let dirsDeleted = 0;
let filesDeleted = 0;
let dirsSkipped = 0;

for (const entry of entries) {
  const fullPath = path.join(ssDir, entry.name);

  // Stray files (not dirs)
  if (entry.isFile()) {
    if (dryRun) {
      filesDeleted++;
    } else {
      fs.unlinkSync(fullPath);
      filesDeleted++;
    }
    continue;
  }

  if (!entry.isDirectory()) continue;
  if (!UUID_RE.test(entry.name)) continue;

  const eventsPath = path.join(fullPath, 'events.jsonl');
  const wsPath = path.join(fullPath, 'workspace.yaml');
  const hasEvents = fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > 0;

  // Empty sessions (no events.jsonl)
  if (!hasEvents) {
    if (dryRun) {
      dirsDeleted++;
    } else {
      fs.rmSync(fullPath, { recursive: true, force: true });
      dirsDeleted++;
    }
    continue;
  }

  // Test-like sessions (has events but summary is obviously a test)
  if (fs.existsSync(wsPath)) {
    const yaml = fs.readFileSync(wsPath, 'utf8');
    const match = yaml.match(/^summary:\s*['"]?(.*?)['"]?\s*$/m);
    const summary = match ? match[1] : '';
    if (summary && isTestLikeSummary(summary)) {
      if (dryRun) {
        dirsDeleted++;
      } else {
        fs.rmSync(fullPath, { recursive: true, force: true });
        dirsDeleted++;
      }
      continue;
    }
  }

  dirsSkipped++;
}

console.log(`\nFilesystem: ${dryRun ? 'would delete' : 'deleted'} ${dirsDeleted} session dirs`);
console.log(`Filesystem: ${dryRun ? 'would delete' : 'deleted'} ${filesDeleted} stray files`);
console.log(`Filesystem: kept ${dirsSkipped} real session dirs`);

if (dryRun) {
  console.log('\nRe-run with --apply to execute cleanup');
}
