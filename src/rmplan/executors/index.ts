import { directCallExecutor } from './direct-call';
import type { Executor } from './types';

/**
 * A map of available executors, keyed by their names.
 */
export const executors = new Map<string, Executor<any>>([
  [directCallExecutor.name, directCallExecutor],
  // Future executors can be added here
]);

// Optionally, export individual executors if they need to be imported directly elsewhere.
export { directCallExecutor };
