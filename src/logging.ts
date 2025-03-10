export let debug = false;

export function enableDebug(enabled: boolean) {
  debug = enabled;
  if (debug) {
  console.log('Debug mode enabled');
  }
}

export function debugLog(...args: any[]) {
  if (debug) {
    console.log(...args);
  }
}

