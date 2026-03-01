import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30000,
  retries: 0,
  workers: 1, // tests share a single mock-agent bridge; parallelism causes interleaving
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      name: 'mobile-android',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-ios',
      use: { ...devices['iPhone 14'] },
    },
  ],
  webServer: {
    command: 'npm run build && node dist/bin/cli.js --port 3000',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    env: { COPILOT_COMMAND: 'node --import tsx src/mock/mock-agent.ts --acp --stdio' },
  },
});
