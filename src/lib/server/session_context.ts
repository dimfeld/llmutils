import type { SessionManager } from './session_manager.js';
import type { SessionDiscoveryClient } from './session_discovery.js';
import type { WebSocketServerHandle } from './ws_server.js';

interface SessionContextState {
  manager: SessionManager | null;
  server: WebSocketServerHandle | null;
  discoveryClient: SessionDiscoveryClient | null;
  initPromise: Promise<SessionManager> | null;
}

const sessionContextKey = Symbol.for('tim.web.sessionContext');

function getState(): SessionContextState {
  const globalState = globalThis as typeof globalThis & {
    [sessionContextKey]?: SessionContextState;
  };

  globalState[sessionContextKey] ??= {
    manager: null,
    server: null,
    discoveryClient: null,
    initPromise: null,
  };

  return globalState[sessionContextKey];
}

export function getSessionManager(): SessionManager {
  const manager = getState().manager;
  if (!manager) {
    throw new Error('Session manager has not been initialized');
  }

  return manager;
}

export function setSessionManager(manager: SessionManager | null): void {
  getState().manager = manager;
}

export function getWebSocketServerHandle(): WebSocketServerHandle | null {
  return getState().server;
}

export function setWebSocketServerHandle(server: WebSocketServerHandle | null): void {
  getState().server = server;
}

export function getSessionDiscoveryClient(): SessionDiscoveryClient | null {
  return getState().discoveryClient;
}

export function setSessionDiscoveryClient(discoveryClient: SessionDiscoveryClient | null): void {
  getState().discoveryClient = discoveryClient;
}

export function getSessionInitPromise(): Promise<SessionManager> | null {
  return getState().initPromise;
}

export function setSessionInitPromise(promise: Promise<SessionManager> | null): void {
  getState().initPromise = promise;
}
