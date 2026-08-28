import path from 'node:path';
import { getBinaryRealPath, getBuildTime } from '../tim/build_info.js';

/**
 * Resolves the tim executable used when tim launches another tim process.
 *
 * TIM_PATH supports installations where the executable is not on PATH, such
 * as the web server and parallel agent child processes.
 */
export function resolveTimExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.TIM_PATH?.trim() || 'tim';
}

/**
 * Resolves the tim executable using a project configuration override when one
 * is available, then falls back to the normal environment-based resolution.
 */
export function resolveConfiguredTimExecutable(
  configuredPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  return configuredPath?.trim() || resolveTimExecutable(env);
}

/**
 * Resolves the directory that should be first on PATH for spawned child
 * processes, so anything they run (including a nested `tim` invocation) sees
 * the same tim binary as the current process. Prefers the directory of
 * TIM_PATH when set, otherwise falls back to the directory of the currently
 * running compiled tim binary. Returns null when running from source (e.g.
 * `bun run src/tim/tim.ts` or in tests), since there is no real tim binary
 * to add to PATH in that case.
 */
export function resolveTimBinaryDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const timPath = env.TIM_PATH?.trim();
  if (timPath) {
    return path.dirname(timPath);
  }

  if (getBuildTime() === undefined) {
    return null;
  }

  const binaryPath = getBinaryRealPath();
  return binaryPath ? path.dirname(binaryPath) : null;
}
