import type { Database } from 'bun:sqlite';

import type { SyncNodeRole, TimConfig } from '$tim/configSchema.js';
import { ensureNodeId, resolveSyncConfig } from '$tim/sync/config.js';
import {
  createSyncRunner,
  startSyncSequenceRetentionRunner,
  type SyncRunnerStatus,
} from '$tim/sync/runner.js';
import { startSyncServer } from '$tim/sync/server.js';

export type SyncServiceHandle =
  | { role: 'main'; port: number; hostname: string; stop(): void }
  | { role: 'persistent'; getStatus(): SyncRunnerStatus; stop(): void };

export function isSyncServiceEnabled(config: TimConfig): boolean {
  return resolveSyncConfig(config).enabled;
}

/**
 * Whether the lifecycle should currently have a sync service running.
 * Tighter than `isSyncServiceEnabled` because a persistent node with
 * `sync.offline: true` is "enabled" but must NOT have its transport running.
 */
export function shouldRunSyncService(config: TimConfig): boolean {
  const resolved = resolveSyncConfig(config);
  if (!resolved.enabled) return false;
  if (resolved.role === 'persistent' && resolved.offline) return false;
  return true;
}

export async function startSyncService(
  db: Database,
  config: TimConfig
): Promise<SyncServiceHandle | null> {
  const resolved = resolveSyncConfig(config);
  if (!resolved.enabled) {
    if (resolved.validationErrors.length > 0) {
      console.warn(`[sync] disabled: ${resolved.validationErrors.join('; ')}`);
    } else {
      console.info('[sync] disabled');
    }
    return null;
  }

  if (resolved.role === 'persistent' && resolved.offline) {
    console.info('[sync] offline mode (persistent runner not started)');
    return null;
  }

  const nodeId = await ensureNodeId(config);

  try {
    switch (resolved.role) {
      case 'main': {
        const hostname = resolved.serverHost ?? '127.0.0.1';
        const requireSecureTransport = resolved.requireSecureTransport ?? !isLoopbackHost(hostname);
        const serverHandle = startSyncServer({
          db,
          mainNodeId: nodeId,
          allowedNodes: resolved.allowedNodes,
          port: resolved.serverPort,
          hostname,
          requireSecureTransport,
        });
        const retentionRunner = startSyncSequenceRetentionRunner({
          db,
          retentionMaxAgeMs: resolved.sequenceRetentionDays * 24 * 60 * 60 * 1000,
        });
        if (resolved.serverPort === undefined || resolved.serverPort === 0) {
          console.warn(
            '[sync] WARNING: main sync server bound to ephemeral port; persistent peers cannot use a stable mainUrl'
          );
        }
        console.info(
          `[sync] Started main sync service (node=${nodeId}) on ${serverHandle.hostname}:${serverHandle.port}`
        );
        return {
          ...idempotentStopHandle('main', () => {
            retentionRunner.stop();
            serverHandle.stop();
            console.info('[sync] Stopped sync service');
          }),
          port: serverHandle.port,
          hostname: serverHandle.hostname,
        };
      }

      case 'persistent': {
        const runner = createSyncRunner({
          db,
          serverUrl: resolved.mainUrl!,
          nodeId,
          token: resolved.nodeToken!,
          reconnect: true,
        });
        runner.start();
        console.info(
          `[sync] Started persistent sync service (node=${nodeId}) for ${resolved.mainUrl}`
        );
        return {
          ...idempotentStopHandle('persistent', () => {
            runner.stop();
            console.info('[sync] Stopped sync service');
          }),
          getStatus: () => runner.getStatus(),
        };
      }

      case 'ephemeral':
      default:
        return null;
    }
  } catch (error) {
    console.error('[sync] Failed to start sync service', error);
    throw error;
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return true;
  }
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function idempotentStopHandle<Role extends Extract<SyncNodeRole, 'main' | 'persistent'>>(
  role: Role,
  stop: () => void
): { role: Role; stop(): void } {
  let stopped = false;
  return {
    role,
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      stop();
    },
  };
}
