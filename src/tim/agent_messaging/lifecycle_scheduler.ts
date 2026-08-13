import type { AgentManagerScheduler } from './agent_manager_types.js';

function monotonicNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

/** Production clock and timer implementation for AgentManager lifecycle work. */
export const DEFAULT_AGENT_MANAGER_SCHEDULER: AgentManagerScheduler = Object.freeze({
  now: monotonicNow,
  setTimeout: (callback: () => void, delayMs: number): unknown =>
    setTimeout(callback, delayMs) as unknown,
  clearTimeout: (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});
