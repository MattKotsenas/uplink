import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run build && node dist/bin/cli.js --port 3000',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    env: { COPILOT_COMMAND: 'node --import tsx src/mock/mock-agent.ts --acp --stdio' },
  },
});
