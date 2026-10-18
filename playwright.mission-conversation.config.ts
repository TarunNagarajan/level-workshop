import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'mission-conversation.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120000,
  use: { baseURL: 'http://127.0.0.1:4325', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: [{
    command: 'node tests/ui-server.mjs',
    url: 'http://127.0.0.1:4325/api/bootstrap',
    reuseExistingServer: false,
    timeout: 20000,
    env: { TEST_PORT: '4325', WORKSHOP_ROOT_ENTRY: 'false', TEST_PASSPORT_REVIEW: 'true', TEST_MISSION_CONVERSATION: 'true', TEST_METRICS: 'true' },
  }],
});
