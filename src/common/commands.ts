import { debug } from '../rmfilter/utils.js';

export function handleCommandError(error: any) {
  if (debug) {
    console.error(error);
  } else {
    console.error(error.message || error);
  }
  process.exit(1);
}
