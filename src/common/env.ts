import fs from 'node:fs/promises';
import path from 'node:path';
import { findUp } from 'find-up';
import * as dotenv from 'dotenv';

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
 */
export async function buildWorkspaceCommandEnv(
  cwd: string | undefined,
  overrides?: Record<string, string>
): Promise<Record<string, string>> {
  const workspaceEnv = cwd ? await readDotEnvFromDirectory(cwd) : null;
  const env = {
    ...process.env,
    ...(workspaceEnv ?? {}),
    ...(overrides ?? {}),
  } as Record<string, string>;
  env.PATH = filterBunNodeFromPath(env.PATH) ?? env.PATH;
  return env;
}
