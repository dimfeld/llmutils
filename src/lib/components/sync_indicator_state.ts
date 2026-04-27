import type { EntitySyncStatus, GlobalSyncStatus } from '$lib/remote/sync_status.remote.js';

export type SyncTone = 'neutral' | 'info' | 'warning' | 'error';

export interface GlobalIndicatorState {
  visible: boolean;
  tone: SyncTone;
  label: string;
  count: number;
}

/**
 * Derive the global header sync indicator state from a `getGlobalSyncStatus()`
 * payload. Pure so the SSR/CSR Svelte component can call it from a `$derived`
 * and tests can exercise every branch directly.
 *
 * Rejected operations are terminal sync write failures and must surface as an
 * error state even when nothing is pending or in conflict, otherwise operators
 * never see permanently-failed writes.
 */
export function getGlobalIndicatorState(
  status: GlobalSyncStatus | null | undefined
): GlobalIndicatorState {
  if (!status || !status.enabled) {
    return { visible: false, tone: 'neutral', label: 'Sync', count: 0 };
  }

  const count =
    status.pending + status.sending + status.failedRetryable + status.conflict + status.rejected;
  const visible = status.hasActivity || status.rejected > 0;

  let tone: SyncTone;
  if (status.rejected > 0 || status.conflict > 0 || status.connectionState === 'sync_error') {
    tone = 'error';
  } else if (status.connectionState === 'offline' || status.failedRetryable > 0) {
    tone = 'warning';
  } else if (status.connectionState === 'syncing' || status.sending > 0 || status.pending > 0) {
    tone = 'info';
  } else {
    tone = 'neutral';
  }

  let label: string;
  if (status.rejected > 0) {
    label = `${status.rejected} rejected${status.conflict > 0 ? `, ${status.conflict} conflict${status.conflict === 1 ? '' : 's'}` : ''}`;
  } else if (status.conflict > 0) {
    label = `${status.conflict} sync conflict${status.conflict === 1 ? '' : 's'}`;
  } else if (status.connectionState === 'offline') {
    const total = status.pending + status.sending + status.failedRetryable;
    label = total > 0 ? `${total} pending, offline` : 'Offline';
  } else if (status.failedRetryable > 0) {
    label = `${status.failedRetryable} retrying`;
  } else if (status.connectionState === 'syncing' || status.sending > 0) {
    label = 'Syncing…';
  } else if (status.pending > 0) {
    label = `${status.pending} pending`;
  } else {
    label = 'Sync';
  }

  return { visible, tone, label, count };
}

export interface EntityBadgeState {
  tone: 'error' | 'info';
  label: string;
  title: string;
}

/**
 * Derive the per-plan sync badge state. Returns null when there is nothing
 * notable to surface. `entityNoun` controls the "N <noun>" wording for the
 * info-tone (queued) badge so this can be reused for non-plan entities.
 */
export function getEntityBadgeState(
  status: EntitySyncStatus | null | undefined,
  entityNoun = 'unsynced'
): EntityBadgeState | null {
  if (!status) return null;
  if (status.rejected > 0) {
    return {
      tone: 'error',
      label: `${status.rejected} rejected`,
      title:
        'Sync writes for this plan were rejected by the main node and will not retry. Run `tim sync status` on the main node.',
    };
  }
  if (status.conflict > 0) {
    return {
      tone: 'error',
      label: `${status.conflict} conflict${status.conflict === 1 ? '' : 's'}`,
      title: 'This plan has unresolved sync conflicts. Run `tim sync conflicts` on the main node.',
    };
  }
  const queued = status.pending + status.sending + status.failedRetryable;
  if (queued > 0) {
    return {
      tone: 'info',
      label: `${queued} ${entityNoun}`,
      title:
        status.failedRetryable > 0
          ? 'Local edits are queued for sync (retrying).'
          : 'Local edits are queued for sync.',
    };
  }
  return null;
}

export interface SettingsBannerState {
  tone: 'error' | 'info';
  text: string;
}

export function getSettingsBannerState(
  status: EntitySyncStatus | null | undefined
): SettingsBannerState | null {
  if (!status) return null;
  if (status.rejected > 0) {
    return {
      tone: 'error',
      text: `${status.rejected} project setting write${status.rejected === 1 ? '' : 's'} were rejected and will not retry. Run \`tim sync status\` on the main node.`,
    };
  }
  if (status.conflict > 0) {
    return {
      tone: 'error',
      text: `${status.conflict} project setting conflict${status.conflict === 1 ? '' : 's'} require resolution. Run \`tim sync conflicts\` on the main node.`,
    };
  }
  const queued = status.pending + status.sending + status.failedRetryable;
  if (queued > 0) {
    return {
      tone: 'info',
      text: `${queued} setting change${queued === 1 ? '' : 's'} queued for sync${status.failedRetryable > 0 ? ' (retrying)' : ''}.`,
    };
  }
  return null;
}
