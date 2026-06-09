import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

const PORT = 7790;
const ISOLATED_STORAGE = join(tmpdir(), `nr-ai-e2e-${process.pid}`);

export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{projectName}{ext}',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node dist/index.js --local`,
    port: PORT,
    env: {
      NR_AI_DASHBOARD_PORT: String(PORT),
      NEW_RELIC_AI_MCP_STORAGE_PATH: ISOLATED_STORAGE,
    },
    reuseExistingServer: !process.env.CI,
  },
});
