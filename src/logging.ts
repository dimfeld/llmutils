import { debug } from './rmfilter/utils.js';

export function debugLog(...args: any[]) {
  if (debug) {
    console.log('[DEBUG]', ...args);
  }
}
