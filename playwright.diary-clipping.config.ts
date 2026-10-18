import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: '**/diary-clipping.spec.ts', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4398', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: [{ command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4398/api/bootstrap', reuseExistingServer: false, timeout: 30000, env: { TEST_PORT: '4398', WORKSHOP_ROOT_ENTRY: 'false' } }],
});
