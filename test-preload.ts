// Preload run before Bun tests.

import { afterAll, afterEach } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { closeDatabaseForTesting } from './src/tim/db/database.ts';

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

process.env.TIM_NOTIFY_SUPPRESS = '1';
process.env.TIM_NOTIFY_SUPPRESS_INNER = '1';
process.env.TIM_LOAD_GLOBAL_CONFIG = '0';
const tmpPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-test-'));
process.env.XDG_CONFIG_HOME = tmpPath;
afterEach(() => {
  closeDatabaseForTesting();
});

afterAll(async () => {
  await fs.rm(tmpPath, { recursive: true, force: true });
});
