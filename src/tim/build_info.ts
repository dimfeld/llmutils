import { realpathSync } from 'node:fs';

/** Build-time constants injected via Bun.build's `define` option in build.ts.
 * Undefined when running from source (bun run src/tim/tim.ts) rather than a compiled binary. */
declare const __TIM_BUILD_SHA__: string | undefined;
declare const __TIM_BUILD_TIME__: string | undefined;

export function getBuildSha(): string {
  return typeof __TIM_BUILD_SHA__ !== 'undefined' ? __TIM_BUILD_SHA__ : 'dev';
}

export function getBuildTime(): string | undefined {
  return typeof __TIM_BUILD_TIME__ !== 'undefined' ? __TIM_BUILD_TIME__ : undefined;
}

export function getVersionString(): string {
  const sha = getBuildSha();
  const time = getBuildTime();
  return time ? `${sha} (built ${time})` : sha;
}

/**
 * Resolves the real (symlink-free) filesystem path of the running `tim` binary.
 * In a compiled build this is `process.execPath` (the standalone executable
 * itself); when running from source via `bun run`, `process.execPath` is the
 * bun runtime, so we resolve the invoked script path instead.
 */
export function getBinaryRealPath(): string | null {
  const target = getBuildTime() !== undefined ? process.execPath : (process.argv[1] ?? null);
  if (!target) {
    return null;
  }
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
