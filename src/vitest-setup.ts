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
  'TIM_CODEX_APP_SERVER_SOCKET',
  'TIM_DEBUG_STDIN',
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

// Bun.spawn and Bun.spawnSync without `env` use the environment from process start. They do not
// see the changes above, so jj and git child processes would read and write the real user config
// (for example, `jj config set --repo` writes into ~/.config/jj/repos). Default `env` to the
// current process.env. A caller that passes `env` keeps its own value.
function withCurrentEnv<T extends object>(options: T | undefined): T {
  const resolved = (options ?? {}) as T & { env?: Record<string, string | undefined> };
  return resolved.env ? resolved : { ...resolved, env: process.env };
}

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;
// Bun.spawn accepts either (cmd, options) or a single options object that includes `cmd`.
(Bun as { spawn: unknown }).spawn = (first: unknown, second?: object) =>
  Array.isArray(first)
    ? originalSpawn(first, withCurrentEnv(second as Parameters<typeof originalSpawn>[1]))
    : originalSpawn(withCurrentEnv(first as Parameters<typeof originalSpawn>[0]));
(Bun as { spawnSync: unknown }).spawnSync = (first: unknown, second?: object) =>
  Array.isArray(first)
    ? originalSpawnSync(first, withCurrentEnv(second as Parameters<typeof originalSpawnSync>[1]))
    : originalSpawnSync(withCurrentEnv(first as Parameters<typeof originalSpawnSync>[0]));
afterEach(() => {
  closeDatabaseForTesting();
});

afterAll(async () => {
  await fs.rm(tmpPath, { recursive: true, force: true });
});
