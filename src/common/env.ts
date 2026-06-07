import fs from 'node:fs/promises';
import path from 'node:path';
import { findUp } from 'find-up-simple';
import * as dotenv from 'dotenv';
import {
  normalizeTimEnvironmentConfigEntry,
  renderBuiltInTimEnvironment,
  renderTimEnvironmentTemplate,
  type TimEnvironmentConfigEntry,
  type TimEnvironmentTemplateContext,
} from '../tim/environment_templates.js';

export interface TimWorkspaceCommandEnvironmentOptions {
  environment?: Record<string, TimEnvironmentConfigEntry>;
  context: TimEnvironmentTemplateContext;
}

export interface BuildWorkspaceCommandEnvOptions {
  inheritedEnv?: Record<string, string | undefined>;
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
}

export async function loadEnv() {
  const envPath = await findUp('.env');
  if (envPath) {
    dotenv.config({
      path: envPath,
    });
  }
}

export async function readDotEnvFromDirectory(
  directory: string
): Promise<Record<string, string> | null> {
  const envPath = path.join(directory, '.env');
  let contents: string;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }

  return dotenv.parse(contents);
}

/**
 * Filter "bun-node" shim paths from a PATH string to avoid conflicts with the
 * real Node.js binary when spawning child processes.
 */
export function filterBunNodeFromPath(pathEnv: string | undefined): string | undefined {
  if (!pathEnv) return pathEnv;
  const filtered = pathEnv
    .split(':')
    .filter((p) => !p.includes('bun-node'))
    .join(':');
  return filtered;
}

/**
 * Build a child-process environment using:
 * process.env -> workspace .env -> explicit overrides.
 *
 * When timEnvironment is provided, project environment variables are rendered
 * between inherited env and workspace .env by default. Entries with
 * precedence: override-dotenv are rendered above workspace .env. Reserved
 * built-ins are rendered above inherited env, project env, and workspace .env.
 */
export async function buildWorkspaceCommandEnv(
  cwd: string | undefined,
  overrides?: Record<string, string>,
  options?: BuildWorkspaceCommandEnvOptions
): Promise<Record<string, string>> {
  const workspaceEnv = cwd ? await readDotEnvFromDirectory(cwd) : null;
  const inheritedEnv = options?.inheritedEnv ?? process.env;

  if (!options?.timEnvironment) {
    const env = {
      ...inheritedEnv,
      ...workspaceEnv,
      ...overrides,
    } as Record<string, string>;
    env.PATH = filterBunNodeFromPath(env.PATH) ?? env.PATH;
    return env;
  }

  const renderedProjectEnv = renderProjectTimEnvironment(options.timEnvironment);
  const env = {
    ...inheritedEnv,
    ...renderedProjectEnv.normal,
    ...workspaceEnv,
    ...renderedProjectEnv.overrideDotenv,
    ...renderedProjectEnv.builtIns,
    ...overrides,
  } as Record<string, string>;
  env.PATH = filterBunNodeFromPath(env.PATH) ?? env.PATH;
  return env;
}

function renderProjectTimEnvironment(options: TimWorkspaceCommandEnvironmentOptions): {
  normal: Record<string, string>;
  overrideDotenv: Record<string, string>;
  builtIns: Record<string, string>;
} {
  const normal: Record<string, string> = {};
  const overrideDotenv: Record<string, string> = {};

  for (const [variableName, entry] of Object.entries(options.environment ?? {})) {
    const normalized = normalizeTimEnvironmentConfigEntry(entry);
    const renderedValue = renderTimEnvironmentTemplate(
      normalized.value,
      options.context,
      variableName
    );

    if (normalized.precedence === 'override-dotenv') {
      overrideDotenv[variableName] = renderedValue;
    } else {
      normal[variableName] = renderedValue;
    }
  }

  return {
    normal,
    overrideDotenv,
    builtIns: renderBuiltInTimEnvironment(options.context),
  };
}
