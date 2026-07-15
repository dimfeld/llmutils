/**
 * Resolves the tim executable used when tim launches another tim process.
 *
 * TIM_PATH supports installations where the executable is not on PATH, such
 * as the web server and parallel agent child processes.
 */
export function resolveTimExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.TIM_PATH?.trim() || 'tim';
}
