import { getSessionManager } from '$lib/server/session_context.js';

const LAUNCH_LOCK_TIMEOUT_MS = 30_000;

const launchLockKey = Symbol.for('tim.web.launchLock');

interface LaunchLockState {
  launchingPlans: Map<string, ReturnType<typeof setTimeout>>;
  unsubscribeSessionManager?: () => void;
}

function getState(): LaunchLockState {
  const globalState = globalThis as typeof globalThis & {
    [launchLockKey]?: LaunchLockState;
  };

  globalState[launchLockKey] ??= {
    launchingPlans: new Map(),
  };

  return globalState[launchLockKey];
}

let sessionListenerInstalled = false;

function installSessionListener(): void {
  const state = getState();
  if (sessionListenerInstalled) return;
  state.unsubscribeSessionManager?.();
  sessionListenerInstalled = true;
  try {
    const manager = getSessionManager();
    state.unsubscribeSessionManager = manager.subscribe('session:update', ({ session }) => {
      if (session.sessionInfo.planUuid != null) {
        clearLaunchLock(session.sessionInfo.planUuid);
      }
    });
  } catch {
    // If session manager is not available (e.g. in tests), fall back to timeout-only cleanup.
    sessionListenerInstalled = false;
  }
}

export function isPlanLaunching(planUuid: string): boolean {
  return getState().launchingPlans.has(planUuid);
}

export function setLaunchLock(planUuid: string): void {
  installSessionListener();
  clearLaunchLock(planUuid);
  const state = getState();
  const timeout = setTimeout(() => {
    state.launchingPlans.delete(planUuid);
  }, LAUNCH_LOCK_TIMEOUT_MS);
  timeout.unref?.();
  state.launchingPlans.set(planUuid, timeout);
}

export function clearLaunchLock(planUuid: string): void {
  const state = getState();
  const timeout = state.launchingPlans.get(planUuid);
  if (timeout) {
    clearTimeout(timeout);
    state.launchingPlans.delete(planUuid);
  }
}

export function clearAllLaunchLocks(): void {
  const state = getState();
  for (const [key, timeout] of state.launchingPlans) {
    clearTimeout(timeout);
    state.launchingPlans.delete(key);
  }
}

/** Reset module state for testing. */
export function resetLaunchLockState(): void {
  clearAllLaunchLocks();
  getState().unsubscribeSessionManager?.();
  sessionListenerInstalled = false;
}
