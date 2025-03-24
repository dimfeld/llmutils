import type { SpawnOptions } from 'bun';

let debug = false;
export function setDebug(value: boolean) {
  debug = value;
}

// Helper function to log and execute commands
export function logSpawn<
  T extends SpawnOptions.OptionsObject<
    SpawnOptions.Writable,
    SpawnOptions.Readable,
    SpawnOptions.Readable
  >,
>(cmd: string[], options?: T) {
  if (debug) {
    console.log(`[DEBUG] Executing: ${cmd.join(' ')}`);
    if (options?.cwd) {
      console.log(`[DEBUG] cwd: ${options.cwd}`);
    }
  }
  return Bun.spawn(cmd, options);
}
