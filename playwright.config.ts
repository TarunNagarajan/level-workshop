import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4318', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4318/api/bootstrap', reuseExistingServer: false, timeout: 20000 },
});
