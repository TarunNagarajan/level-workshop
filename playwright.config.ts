import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4318', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4318/api/bootstrap', reuseExistingServer: false, timeout: 20000, env: { TEST_PORT: '4318', WORKSHOP_ROOT_ENTRY: 'false' } },
    { command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4319/api/bootstrap', reuseExistingServer: false, timeout: 20000, env: { TEST_PORT: '4319', WORKSHOP_ROOT_ENTRY: 'true' } },
    { command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4320/api/bootstrap', reuseExistingServer: false, timeout: 20000, env: { TEST_PORT: '4320', WORKSHOP_ROOT_ENTRY: 'false', TEST_METRICS: 'true' } },
    { command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4321/api/bootstrap', reuseExistingServer: false, timeout: 20000, env: { TEST_PORT: '4321', WORKSHOP_ROOT_ENTRY: 'false', TEST_PASSPORT_REVIEW: 'true', TEST_REVIEW_MODE: 'success' } },
    { command: 'node tests/ui-server.mjs', url: 'http://127.0.0.1:4322/api/bootstrap', reuseExistingServer: false, timeout: 20000, env: { TEST_PORT: '4322', WORKSHOP_ROOT_ENTRY: 'false', TEST_PASSPORT_REVIEW: 'true', TEST_REVIEW_MODE: 'retry-once' } },
  ],
});
