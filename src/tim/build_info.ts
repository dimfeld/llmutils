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
