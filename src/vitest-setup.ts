// Preload run before Vitest tests.

import { afterAll, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { closeDatabaseForTesting } from './tim/db/database.ts';
import { setGhFallbackDisabled } from './common/github/token.ts';

// ensure tests never make accidental network calls via API keys.
// We explicitly unset Google keys that trigger auto-marking logic in CodexCliExecutor.
const KEYS_TO_UNSET = [
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

for (const key of KEYS_TO_UNSET) {
  if (process.env[key]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key as keyof typeof process.env];
  }
}

setGhFallbackDisabled(true);
process.env.TIM_DATABASE_FILENAME = 'tim.test.db';
process.env.TIM_NOTIFY_SUPPRESS = '1';
process.env.TIM_NOTIFY_SUPPRESS_INNER = '1';
process.env.TIM_LOAD_GLOBAL_CONFIG = '0';

// Do not let a test process inherit execution state from the tim agent that
// started it. Tests that cover these variables set them explicitly.
const AGENT_ENV_VARS_TO_UNSET = [
  'CLAUDE_CODE_MCP',
  'CODEX_OUTPUT_TIMEOUT_MS',
  'CODEX_USE_APP_SERVER',
  'TIM_CODEX_APP_SERVER_SOCKET',
  'TIM_DEBUG_STDIN',
  'TIM_ENABLE_OPEN_IN_EDITOR',
  'TIM_EXECUTOR',
  'TIM_HEADLESS_URL',
  'TIM_HIDE_PLAN_DETAILS',
  'TIM_INTERACTIVE',
  'TIM_NO_SERVER',
  'TIM_NONINTERACTIVE',
  'TIM_OUTPUT_SOCKET',
  'TIM_SESSION_ID',
  'TIM_PROCESS_ID',
  'TIM_PARENT_PROCESS_ID',
  'TIM_OWNER_PROCESS_ID',
  'TIM_PATH',
  'TIM_SERVER_HOSTNAME',
  'TIM_SERVER_PORT',
  'TIM_SKIP_AUTO_CLAIM',
  'TIM_SUMMARY_ENABLED',
  'TIM_USER',
  'TIM_WEBHOOK_POLL_INTERVAL',
  'TIM_WEBHOOK_SERVER_URL',
  'TIM_WS_BEARER_TOKEN',
  'TIM_WS_PORT',
] as const;

for (const key of AGENT_ENV_VARS_TO_UNSET) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete process.env[key];
}

const tmpPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
process.env.XDG_CONFIG_HOME = tmpPath;
process.env.XDG_DATA_HOME = path.join(tmpPath, 'data');
process.env.XDG_CACHE_HOME = path.join(tmpPath, 'cache');
afterEach(() => {
  closeDatabaseForTesting();
});

afterAll(async () => {
  await fs.rm(tmpPath, { recursive: true, force: true });
});
