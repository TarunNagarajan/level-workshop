import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'statistics-dashboard.spec.ts',
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4380', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: [{ command: 'node tests/statistics-ui-server.mjs', url: 'http://127.0.0.1:4380/api/bootstrap', reuseExistingServer: false, timeout: 20000, env: { TEST_PORT: '4380' } }],
});
