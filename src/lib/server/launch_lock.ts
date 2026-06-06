import { getSessionManager } from '$lib/server/session_context.js';

const LAUNCH_LOCK_TIMEOUT_MS = 30_000;

const launchLockKey = Symbol.for('tim.web.launchLock');

interface LaunchLockState {
  launchingTargets: Map<string, ReturnType<typeof setTimeout>>;
  unsubscribeSessionManager?: () => void;
}

function getState(): LaunchLockState {
  const globalState = globalThis as typeof globalThis & {
    [launchLockKey]?: LaunchLockState;
  };

  globalState[launchLockKey] ??= {
    launchingTargets: new Map(),
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
      if (session.sessionInfo.linkedPrUrl != null) {
        clearPrLaunchLock(session.sessionInfo.linkedPrUrl);
      }
    });
  } catch {
    // If session manager is not available (e.g. in tests), fall back to timeout-only cleanup.
    sessionListenerInstalled = false;
  }
}

export function planTargetKey(planUuid: string): string {
  return `plan:${planUuid}`;
}

export function prTargetKey(canonicalPrUrl: string): string {
  return `pr:${canonicalPrUrl}`;
}

export function isTargetLaunching(key: string): boolean {
  return getState().launchingTargets.has(key);
}

export function setLaunchLockForTarget(key: string): void {
  installSessionListener();
  clearLaunchLockForTarget(key);
  const state = getState();
  const timeout = setTimeout(() => {
    state.launchingTargets.delete(key);
  }, LAUNCH_LOCK_TIMEOUT_MS);
  timeout.unref?.();
  state.launchingTargets.set(key, timeout);
}

export function clearLaunchLockForTarget(key: string): void {
  const state = getState();
  const timeout = state.launchingTargets.get(key);
  if (timeout) {
    clearTimeout(timeout);
    state.launchingTargets.delete(key);
  }
}

export function isPlanLaunching(planUuid: string): boolean {
  return isTargetLaunching(planTargetKey(planUuid));
}

export function setLaunchLock(planUuid: string): void {
  setLaunchLockForTarget(planTargetKey(planUuid));
}

export function clearLaunchLock(planUuid: string): void {
  clearLaunchLockForTarget(planTargetKey(planUuid));
}

export function isPrLaunching(prUrl: string): boolean {
  return isTargetLaunching(prTargetKey(prUrl));
}

export function setPrLaunchLock(prUrl: string): void {
  setLaunchLockForTarget(prTargetKey(prUrl));
}

export function clearPrLaunchLock(prUrl: string): void {
  clearLaunchLockForTarget(prTargetKey(prUrl));
}

export function clearAllLaunchLocks(): void {
  const state = getState();
  for (const [key, timeout] of state.launchingTargets) {
    clearTimeout(timeout);
    state.launchingTargets.delete(key);
  }
}

/** Reset module state for testing. */
export function resetLaunchLockState(): void {
  clearAllLaunchLocks();
  getState().unsubscribeSessionManager?.();
  sessionListenerInstalled = false;
}
