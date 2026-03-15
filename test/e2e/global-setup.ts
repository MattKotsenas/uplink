/**
 * Playwright global setup: build the project once before any tests run.
 * This avoids rebuilding on every Playwright retry or re-run.
 */
import { execSync } from 'node:child_process';

export default function globalSetup() {
  console.log('[globalSetup] Building project...');
  execSync('npm run build', { stdio: 'inherit', cwd: process.cwd() });
  console.log('[globalSetup] Build complete.');
}
