import * as fs from 'node:fs';

import { parseHeadlessMessage } from '../../logging/headless_message_utils.js';
import type { HeadlessMessage, HeadlessServerMessage } from '../../logging/headless_protocol.js';
import {
  getTimSessionDir,
  listSessionInfoFiles,
  removeSessionInfoFile,
  type SessionInfoFile,
} from '$tim/session_server/runtime_dir.js';

import type { SessionManager } from './session_manager.js';

interface DiscoveryLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface SessionDiscoveryClientOptions {
  logger?: DiscoveryLogger;
  watchDebounceMs?: number;
  reconcileIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryMaxAttempts?: number;
}

interface TrackedConnection {
  connectionId: string;
  info: SessionInfoFile;
  ws: WebSocket | null;
  connected: boolean;
  registered: boolean;
  sessionInfoValidated: boolean;
  isReconnect: boolean;
  stopped: boolean;
  retryAttempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pendingMessages: HeadlessMessage[];
}

const DEFAULT_WATCH_DEBOUNCE_MS = 500;
const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 8;
const MAX_PENDING_MESSAGES = 10_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Normalize a bind hostname into a connectable loopback host suitable for URL construction. */
function normalizeHostForConnection(hostname: string | undefined): string | null {
  if (!hostname) {
    return '127.0.0.1';
  }

  // Wildcard bind addresses are not dialable — map to loopback.
  if (hostname === '0.0.0.0') {
    return '127.0.0.1';
  }

  if (hostname === '::') {
    return '[::1]';
  }

  if (hostname === 'localhost') {
    return hostname;
  }

  if (hostname === '::1' || hostname === '[::1]') {
    return '[::1]';
  }

  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname;
  }

  return null;
}

function sendTrackedMessage(ws: WebSocket, outboundMessage: HeadlessServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not open');
  }

  ws.send(JSON.stringify(outboundMessage satisfies HeadlessServerMessage));
}

function bufferPendingMessage(
  tracked: TrackedConnection,
  ws: WebSocket,
  message: HeadlessMessage,
  logger: DiscoveryLogger
): boolean {
  if (tracked.pendingMessages.length >= MAX_PENDING_MESSAGES) {
    logger.warn(
      `[session_discovery] Closing pid ${tracked.info.pid} after buffering more than ${MAX_PENDING_MESSAGES} replay messages without replay_end`
    );
    ws.close();
    return false;
  }

  tracked.pendingMessages.push(message);
  return true;
}

function registerTrackedSession(
  tracked: TrackedConnection,
  ws: WebSocket,
  sessionManager: SessionManager
): void {
  sessionManager.dismissSession(tracked.connectionId);
  sessionManager.handleWebSocketConnect(tracked.connectionId, (outboundMessage) => {
    sendTrackedMessage(ws, outboundMessage);
  });
  tracked.registered = true;
  tracked.connected = true;
}

function flushPendingMessages(tracked: TrackedConnection, sessionManager: SessionManager): void {
  for (const pendingMessage of tracked.pendingMessages) {
    sessionManager.handleWebSocketMessage(tracked.connectionId, pendingMessage);
  }
  tracked.pendingMessages = [];
}

/** Format a rejected hostname for diagnostics. */
function formatRejectedHostname(hostname: string | undefined): string {
  if (!hostname) {
    return '<empty>';
  }

  return hostname;
}

function sessionInfoChanged(previous: SessionInfoFile, next: SessionInfoFile): boolean {
  return (
    previous.sessionId !== next.sessionId ||
    previous.port !== next.port ||
    previous.hostname !== next.hostname ||
    previous.token !== next.token
  );
}

function hasExistingOfflineSession(sessionManager: SessionManager, connectionId: string): boolean {
  return sessionManager
    .getSessionSnapshot()
    .sessions.some(
      (session) => session.connectionId === connectionId && session.status === 'offline'
    );
}

export class SessionDiscoveryClient {
  private readonly logger: DiscoveryLogger;
  private readonly watchDebounceMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryMaxAttempts: number;
  private readonly trackedConnections = new Map<number, TrackedConnection>();
  private readonly tokenWarningPids = new Set<number>();
  private readonly invalidHostWarningPids = new Set<number>();

  private directoryWatcher: fs.FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private reconcileQueued = false;
  private started = false;
  private stopped = false;

  constructor(
    private readonly sessionManager: SessionManager,
    options: SessionDiscoveryClientOptions = {}
  ) {
    this.logger = options.logger ?? console;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryMaxAttempts = options.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopped = false;

    // Install watcher before initial scan so files created during the scan
    // trigger a re-scan rather than being missed until the next poll.
    this.startWatcher();
    await this.reconcileNow();
    this.reconcileTimer = setInterval(() => {
      this.reconcileNow().catch((error) => {
        this.logger.error('[session_discovery] Reconciliation failed', error);
      });
    }, this.reconcileIntervalMs);
  }

  async forceReconcile(): Promise<void> {
    await this.reconcileNow();
  }

  stop(): void {
    if (!this.started || this.stopped) {
      return;
    }

    this.stopped = true;
    this.started = false;

    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.directoryWatcher) {
      this.directoryWatcher.close();
      this.directoryWatcher = null;
    }

    for (const tracked of [...this.trackedConnections.values()]) {
      this.disposeTrackedConnection(tracked, true);
    }
    this.trackedConnections.clear();
    this.tokenWarningPids.clear();
    this.invalidHostWarningPids.clear();
  }

  private startWatcher(): void {
    try {
      const sessionDir = getTimSessionDir();
      this.directoryWatcher = fs.watch(sessionDir, () => {
        this.scheduleReconcile();
      });
      this.directoryWatcher.on('error', (error) => {
        this.logger.warn('[session_discovery] Session directory watch failed', error);
        this.scheduleReconcile();
      });
    } catch (error) {
      this.logger.warn(
        '[session_discovery] Failed to set up directory watcher, falling back to polling only',
        error
      );
    }
  }

  private scheduleReconcile(): void {
    if (this.stopped) {
      return;
    }

    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }

    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.reconcileNow().catch((error) => {
        this.logger.error('[session_discovery] Watch-triggered reconciliation failed', error);
      });
    }, this.watchDebounceMs);
  }

  // Coalesces concurrent calls: if a reconcile is already running, the caller's
  // await resolves when the in-flight run finishes. A single queued re-run follows
  // to pick up any changes that arrived during the previous pass.
  private async reconcileNow(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.reconcilePromise) {
      this.reconcileQueued = true;
      await this.reconcilePromise;
      return;
    }

    this.reconcilePromise = this.performReconcile().finally(() => {
      this.reconcilePromise = null;
    });

    await this.reconcilePromise;

    if (this.reconcileQueued && !this.stopped) {
      this.reconcileQueued = false;
      await this.reconcileNow();
    }
  }

  private async performReconcile(): Promise<void> {
    const sessionInfos = listSessionInfoFiles();
    const infosByPid = new Map(sessionInfos.map((info) => [info.pid, info]));

    for (const info of sessionInfos) {
      await this.reconcileSessionInfo(info);
    }

    // Clean up tracked connections whose PID files have been removed.
    // Liveness checks are already handled by reconcileSessionInfo in the first loop.
    for (const [pid, tracked] of [...this.trackedConnections]) {
      if (!infosByPid.has(pid)) {
        this.disposeTrackedConnection(tracked, true);
        this.trackedConnections.delete(pid);
        this.tokenWarningPids.delete(pid);
        this.invalidHostWarningPids.delete(pid);
      }
    }
  }

  private async reconcileSessionInfo(info: SessionInfoFile): Promise<void> {
    if (!isProcessAlive(info.pid)) {
      this.logger.warn(`[session_discovery] Removing stale session file for dead pid ${info.pid}`);
      const tracked = this.trackedConnections.get(info.pid);
      if (tracked) {
        this.disposeTrackedConnection(tracked, true);
        this.trackedConnections.delete(info.pid);
      }
      this.tokenWarningPids.delete(info.pid);
      this.invalidHostWarningPids.delete(info.pid);
      removeSessionInfoFile(info.pid);
      return;
    }

    if (info.token) {
      // Dispose any existing tracked connection for this PID (e.g. if it
      // transitioned to token-protected after we were already connected).
      const existing = this.trackedConnections.get(info.pid);
      if (existing) {
        this.disposeTrackedConnection(existing, true);
        this.trackedConnections.delete(info.pid);
      }

      if (!this.tokenWarningPids.has(info.pid)) {
        this.tokenWarningPids.add(info.pid);
        this.logger.warn(
          `[session_discovery] Skipping pid ${info.pid} because token-authenticated session discovery is not supported yet`
        );
      }
      this.invalidHostWarningPids.delete(info.pid);
      return;
    }

    this.tokenWarningPids.delete(info.pid);

    if (normalizeHostForConnection(info.hostname) === null) {
      const existing = this.trackedConnections.get(info.pid);
      if (existing) {
        this.disposeTrackedConnection(existing, true);
        this.trackedConnections.delete(info.pid);
      }

      if (!this.invalidHostWarningPids.has(info.pid)) {
        this.invalidHostWarningPids.add(info.pid);
        this.logger.warn(
          `[session_discovery] Skipping pid ${info.pid} because hostname ${formatRejectedHostname(
            info.hostname
          )} is not loopback-only`
        );
      }
      return;
    }

    this.invalidHostWarningPids.delete(info.pid);

    const existing = this.trackedConnections.get(info.pid);
    if (existing) {
      if (!sessionInfoChanged(existing.info, info)) {
        // If the connection is idle (no active ws, not connecting, retries exhausted),
        // reset retry state so reconciliation can attempt a fresh connection.
        if (!existing.ws && !existing.connected && !existing.retryTimer && !existing.stopped) {
          existing.retryAttempts = 0;
          this.openTrackedConnection(existing);
        }
        return;
      }

      this.disposeTrackedConnection(existing, true);
      this.trackedConnections.delete(info.pid);
    }

    this.connectToSession(info);
  }

  private connectToSession(info: SessionInfoFile): void {
    if (this.stopped || this.trackedConnections.has(info.pid)) {
      return;
    }

    const tracked: TrackedConnection = {
      connectionId: info.sessionId,
      info,
      ws: null,
      connected: false,
      registered: false,
      sessionInfoValidated: false,
      isReconnect: hasExistingOfflineSession(this.sessionManager, info.sessionId),
      stopped: false,
      retryAttempts: 0,
      retryTimer: null,
      pendingMessages: [],
    };

    this.trackedConnections.set(info.pid, tracked);
    this.openTrackedConnection(tracked);
  }

  private openTrackedConnection(tracked: TrackedConnection): void {
    if (this.stopped || tracked.stopped) {
      return;
    }
    if (!isProcessAlive(tracked.info.pid)) {
      this.logger.warn(
        `[session_discovery] Removing stale session file for dead pid ${tracked.info.pid}`
      );
      this.disposeTrackedConnection(tracked, true);
      this.trackedConnections.delete(tracked.info.pid);
      removeSessionInfoFile(tracked.info.pid);
      return;
    }

    let ws: WebSocket;
    try {
      const host = normalizeHostForConnection(tracked.info.hostname);
      if (!host) {
        return;
      }
      ws = new WebSocket(`ws://${host}:${tracked.info.port}/tim-agent`);
    } catch (error) {
      this.logger.warn(
        `[session_discovery] Failed to create websocket for pid ${tracked.info.pid}`,
        error
      );
      this.scheduleRetry(tracked);
      return;
    }

    tracked.ws = ws;
    let opened = false;

    ws.addEventListener('open', () => {
      if (this.stopped || tracked.stopped || tracked.ws !== ws) {
        ws.close();
        return;
      }

      opened = true;
      tracked.retryAttempts = 0;
    });

    ws.addEventListener('message', (event) => {
      if (this.stopped || tracked.stopped || tracked.ws !== ws) {
        return;
      }

      const payload =
        typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      const message = parseHeadlessMessage(payload);
      if (!message) {
        this.logger.warn(
          `[session_discovery] Ignoring malformed websocket message for pid ${tracked.info.pid}`
        );
        return;
      }

      try {
        this.handleTrackedMessage(tracked, ws, message);
      } catch (error) {
        this.logger.warn(
          `[session_discovery] Error handling websocket message for pid ${tracked.info.pid}`,
          error
        );
      }
    });

    ws.addEventListener('error', (event) => {
      this.logger.warn(
        `[session_discovery] WebSocket error while connecting to pid ${tracked.info.pid}`,
        event
      );
    });

    ws.addEventListener('close', () => {
      if (tracked.ws !== ws) {
        return;
      }

      tracked.ws = null;

      if (this.stopped || tracked.stopped) {
        return;
      }

      const wasConnected = tracked.connected || opened;
      if (wasConnected) {
        tracked.connected = false;
        if (tracked.registered) {
          tracked.registered = false;
          this.sessionManager.handleWebSocketDisconnect(tracked.connectionId);
        }
      }
      tracked.pendingMessages = [];
      tracked.sessionInfoValidated = false;
      tracked.isReconnect = true;

      this.scheduleRetry(tracked);
    });
  }

  private scheduleRetry(tracked: TrackedConnection): void {
    if (this.stopped || tracked.stopped) {
      return;
    }
    if (tracked.retryTimer) {
      return;
    }
    if (tracked.retryAttempts >= this.retryMaxAttempts) {
      this.logger.warn(
        `[session_discovery] Giving up reconnecting to pid ${tracked.info.pid} after ${tracked.retryAttempts} attempts`
      );
      return;
    }

    const delay = Math.min(
      this.retryBaseDelayMs * 2 ** tracked.retryAttempts,
      this.retryMaxDelayMs
    );
    tracked.retryAttempts += 1;
    tracked.retryTimer = setTimeout(() => {
      tracked.retryTimer = null;
      this.openTrackedConnection(tracked);
    }, delay);
  }

  private handleTrackedMessage(
    tracked: TrackedConnection,
    ws: WebSocket,
    message: HeadlessMessage
  ): void {
    if (message.type === 'session_info' && message.sessionId !== tracked.connectionId) {
      this.logger.warn(
        `[session_discovery] Closing pid ${tracked.info.pid} because session_info sessionId ${message.sessionId} did not match expected ${tracked.connectionId}`
      );

      if (tracked.registered) {
        tracked.connected = false;
        tracked.registered = false;
        this.sessionManager.handleWebSocketDisconnect(tracked.connectionId);
        this.sessionManager.dismissSession(tracked.connectionId);
      }

      tracked.pendingMessages = [];
      tracked.sessionInfoValidated = false;
      tracked.stopped = true;
      ws.close();
      return;
    }

    if (!tracked.registered) {
      if (!bufferPendingMessage(tracked, ws, message, this.logger)) {
        return;
      }

      if (message.type === 'session_info') {
        tracked.sessionInfoValidated = true;

        if (!tracked.isReconnect) {
          registerTrackedSession(tracked, ws, this.sessionManager);
          flushPendingMessages(tracked, this.sessionManager);
        }
        return;
      }

      if (message.type !== 'replay_end') {
        return;
      }

      if (!tracked.sessionInfoValidated) {
        this.logger.warn(
          `[session_discovery] Closing pid ${tracked.info.pid} because replay_end arrived before a valid session_info`
        );
        tracked.pendingMessages = [];
        ws.close();
        return;
      }

      if (tracked.isReconnect) {
        registerTrackedSession(tracked, ws, this.sessionManager);
        flushPendingMessages(tracked, this.sessionManager);
      }
      return;
    }

    this.sessionManager.handleWebSocketMessage(tracked.connectionId, message);
  }

  private disposeTrackedConnection(tracked: TrackedConnection, notifyDisconnect: boolean): void {
    tracked.stopped = true;
    tracked.pendingMessages = [];

    if (tracked.retryTimer) {
      clearTimeout(tracked.retryTimer);
      tracked.retryTimer = null;
    }

    if (notifyDisconnect && tracked.connected) {
      tracked.connected = false;
      if (tracked.registered) {
        tracked.registered = false;
        this.sessionManager.handleWebSocketDisconnect(tracked.connectionId);
      }
    }

    if (tracked.ws) {
      try {
        tracked.ws.close();
      } catch {
        // Ignore close errors during cleanup.
      }
      tracked.ws = null;
    }
  }
}
