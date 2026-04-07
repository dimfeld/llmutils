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
 * Build a child-process environment using:
 * process.env -> workspace .env -> explicit overrides.
 */
export async function buildWorkspaceCommandEnv(
  cwd: string | undefined,
  overrides?: Record<string, string>
): Promise<Record<string, string>> {
  const workspaceEnv = cwd ? await readDotEnvFromDirectory(cwd) : null;
  return {
    ...process.env,
    ...(workspaceEnv ?? {}),
    ...(overrides ?? {}),
  } as Record<string, string>;
}
