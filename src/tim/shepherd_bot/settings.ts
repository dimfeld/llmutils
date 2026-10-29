import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getTimDataDir } from '../../common/config_paths.js';
import type { TimConfig } from '../configSchema.js';

export const DEFAULT_SHEPHERD_BOT_EXECUTOR = 'codex-cli';
export const DEFAULT_SHEPHERD_BOT_MODEL = 'gpt-6-luna';
export const DEFAULT_SHEPHERD_BOT_MAX_RUNS_PER_HOUR = 60;

export interface ShepherdBotSettings {
  executor: 'codex-cli' | 'claude-code';
  model: string;
  maxRunsPerHour: number;
}

export function resolveShepherdBotSettings(
  config: Pick<TimConfig, 'shepherdBot'>
): ShepherdBotSettings {
  return {
    executor: config.shepherdBot?.executor ?? DEFAULT_SHEPHERD_BOT_EXECUTOR,
    model: config.shepherdBot?.model ?? DEFAULT_SHEPHERD_BOT_MODEL,
    maxRunsPerHour: config.shepherdBot?.maxRunsPerHour ?? DEFAULT_SHEPHERD_BOT_MAX_RUNS_PER_HOUR,
  };
}

export interface ShepherdBotStatePaths {
  dir: string;
  markdown: string;
  json: string;
}

export function getShepherdBotStatePaths(projectId: number): ShepherdBotStatePaths {
  const dir = path.join(getTimDataDir(), 'shepherd-bot', `project-${projectId}`);
  return {
    dir,
    markdown: path.join(dir, 'state.md'),
    json: path.join(dir, 'state.json'),
  };
}

export interface ShepherdBotState {
  markdown: string;
  json: string;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

export async function readShepherdBotState(projectId: number): Promise<ShepherdBotState> {
  const paths = getShepherdBotStatePaths(projectId);
  const [markdown, json] = await Promise.all([
    readOptionalFile(paths.markdown),
    readOptionalFile(paths.json),
  ]);
  return { markdown, json };
}

/** Write both state files. Each file is replaced with a rename, so a reader never sees half. */
export async function writeShepherdBotState(
  projectId: number,
  state: { markdown: string; json: unknown }
): Promise<void> {
  const paths = getShepherdBotStatePaths(projectId);
  await fs.mkdir(paths.dir, { recursive: true });
  const write = async (filePath: string, content: string): Promise<void> => {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
  };
  await write(paths.markdown, state.markdown);
  await write(paths.json, `${JSON.stringify(state.json ?? {}, null, 2)}\n`);
}
