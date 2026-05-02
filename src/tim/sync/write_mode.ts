import type { TimConfig } from '../configSchema.js';
import { resolveSyncConfig } from './config.js';

/**
 * WriteMode separates local persistence semantics from sync networking state.
 *
 * - local-operation: ordinary local writes route through the operation engine
 *   without enabling sync networking.
 * - sync-main: a configured main node applies operations canonically.
 * - sync-persistent: a configured persistent node queues operations for main.
 * - legacy-direct: explicit SQL escape hatch, selected by callers only.
 *
 * legacy-direct sites are intentionally narrow:
 * - applyRenumberDbState in src/tim/commands/renumber.ts for bulk numeric ID rewrites.
 * - updatePlanBaseTrackingLocalOnly in src/tim/plans.ts and
 *   src/tim/plan_materialize.ts for machine-local baseCommit/baseChangeId state.
 * - alignTaskOrderWithMaterializedFileLocalOnly in src/tim/plan_materialize.ts
 *   for shadow-missing materialized recovery until task reorder ops exist.
 *
 * Role checks outside this module should be limited to sync networking/config
 * behavior. Plan ID allocation should go through usesPlanIdReserve().
 */
export type WriteMode = 'local-operation' | 'sync-main' | 'sync-persistent' | 'legacy-direct';

export function resolveWriteMode(config: TimConfig | undefined): WriteMode {
  if (config?.sync?.role === 'main') {
    return 'sync-main';
  }

  if (config?.sync?.role === 'persistent' && resolveSyncConfig(config).enabled) {
    return 'sync-persistent';
  }

  return 'local-operation';
}

export function isOperationRouted(mode: WriteMode): boolean {
  return mode !== 'legacy-direct';
}

export function usesPlanIdReserve(mode: WriteMode): boolean {
  return mode === 'local-operation' || mode === 'sync-persistent';
}
