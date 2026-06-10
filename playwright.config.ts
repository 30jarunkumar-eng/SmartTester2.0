import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir:   './work/runs',
  testMatch: '**/*.spec.js',
  timeout:   30000,
  retries:   1,
  reporter:  [['html', { outputFolder: 'playwright-report', open: 'never' }], ['line']],
  use: {
    headless:      true,
    screenshot:    'only-on-failure',
    video:         'off',
    actionTimeout: 10000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  outputDir: 'test-results',
});
