import type { Database } from 'bun:sqlite';
import { prunePlanRefsForTerminalOps } from './queue.js';
import { applyOperationResultTransitions } from './result_transitions.js';
import {
  mergeCanonicalRefresh,
  type CanonicalPlanSnapshot,
  type CanonicalSnapshot,
} from './snapshots.js';
import type { SyncCatchUpInvalidation, SyncOperationResult } from './ws_protocol.js';

export interface ApplyResultsWithSnapshotsOptions {
  db: Database;
  results: SyncOperationResult[];
  fetchSnapshots: (keys: string[]) => Promise<CanonicalSnapshot[]>;
}

export interface ApplyInvalidationsWithSnapshotsOptions {
  db: Database;
  invalidations: SyncCatchUpInvalidation[];
  fetchSnapshots: (keys: string[]) => Promise<CanonicalSnapshot[]>;
}

export async function applyOperationResultsWithSnapshots(
  options: ApplyResultsWithSnapshotsOptions
): Promise<string[]> {
  const snapshots = await options.fetchSnapshots(snapshotKeysFromResults(options.results));
  for (const snapshot of orderCanonicalSnapshotsForMerge(snapshots)) {
    mergeCanonicalRefresh(options.db, snapshot);
  }
  const affectedPlanUuids = applyOperationResultTransitions(options.db, options.results);
  if (hasTerminalOperationResults(options.results)) {
    prunePlanRefsForTerminalOps(options.db);
  }
  return affectedPlanUuids;
}

export async function applyInvalidationsWithSnapshots(
  options: ApplyInvalidationsWithSnapshotsOptions
): Promise<number> {
  const snapshots = await options.fetchSnapshots(
    snapshotKeysFromInvalidations(options.invalidations)
  );
  for (const snapshot of orderCanonicalSnapshotsForMerge(snapshots)) {
    mergeCanonicalRefresh(options.db, snapshot);
  }
  return Math.max(0, ...options.invalidations.map((item) => item.sequenceId));
}

/**
 * Orders a fetched canonical snapshot set so that each snapshot can resolve
 * references against canonical rows introduced by the same response.
 *
 * Project snapshots must be applied before any project-owned state. Plan
 * snapshots are then topologically ordered with referenced plans before their
 * owners. Cycles are broken deterministically by the lexical plan ordering.
 * Project deletions are applied last so no state from the same response can
 * recreate a project after its authoritative deletion.
 */
export function orderCanonicalSnapshotsForMerge(
  snapshots: readonly CanonicalSnapshot[]
): CanonicalSnapshot[] {
  const projectSnapshots = snapshots
    .filter((snapshot) => snapshot.type === 'project')
    .sort(compareCanonicalSnapshots);
  const planSnapshots = snapshots
    .filter((snapshot): snapshot is CanonicalPlanSnapshot => snapshot.type === 'plan')
    .sort(compareCanonicalSnapshots);
  const projectDeletionSnapshots = snapshots
    .filter((snapshot) => snapshot.type === 'project_deleted')
    .sort(compareCanonicalSnapshots);
  const remainingSnapshots = snapshots
    .filter(
      (snapshot) =>
        snapshot.type !== 'project' &&
        snapshot.type !== 'plan' &&
        snapshot.type !== 'project_deleted'
    )
    .sort(compareCanonicalSnapshots);

  return [
    ...projectSnapshots,
    ...orderPlanSnapshotsByReferences(planSnapshots),
    ...remainingSnapshots,
    ...projectDeletionSnapshots,
  ];
}

function orderPlanSnapshotsByReferences(
  snapshots: readonly CanonicalPlanSnapshot[]
): CanonicalPlanSnapshot[] {
  const byPlanKey = new Map<string, CanonicalPlanSnapshot>();
  for (const snapshot of snapshots) {
    byPlanKey.set(scopedPlanKey(snapshot.projectUuid, snapshot.plan.uuid), snapshot);
  }

  const visitState = new Map<CanonicalPlanSnapshot, 'visiting' | 'visited'>();
  const ordered: CanonicalPlanSnapshot[] = [];

  const visit = (snapshot: CanonicalPlanSnapshot): void => {
    const state = visitState.get(snapshot);
    if (state === 'visited' || state === 'visiting') {
      return;
    }
    visitState.set(snapshot, 'visiting');

    const referenceUuids = planReferenceUuids(snapshot).sort((left, right) =>
      left.localeCompare(right)
    );
    for (const referenceUuid of referenceUuids) {
      const referencedSnapshot = byPlanKey.get(scopedPlanKey(snapshot.projectUuid, referenceUuid));
      if (referencedSnapshot) {
        visit(referencedSnapshot);
      }
    }

    visitState.set(snapshot, 'visited');
    ordered.push(snapshot);
  };

  for (const snapshot of snapshots) {
    visit(snapshot);
  }
  return ordered;
}

function planReferenceUuids(snapshot: CanonicalPlanSnapshot): string[] {
  return [
    snapshot.plan.discoveredFrom,
    snapshot.plan.parentUuid,
    snapshot.plan.basePlanUuid ?? null,
    ...snapshot.plan.dependencyUuids,
  ].filter((uuid): uuid is string => uuid !== null);
}

function scopedPlanKey(projectUuid: string, planUuid: string): string {
  return `${projectUuid}:${planUuid}`;
}

function compareCanonicalSnapshots(left: CanonicalSnapshot, right: CanonicalSnapshot): number {
  return canonicalSnapshotSortKey(left).localeCompare(canonicalSnapshotSortKey(right));
}

function canonicalSnapshotSortKey(snapshot: CanonicalSnapshot): string {
  switch (snapshot.type) {
    case 'project':
      return `0:${snapshot.project.uuid}`;
    case 'plan':
      return `1:${snapshot.projectUuid}:${snapshot.plan.uuid}`;
    case 'project_setting':
      return `2:${snapshot.projectUuid}:${snapshot.setting}`;
    case 'plan_deleted':
      return `3:${snapshot.projectUuid}:${snapshot.planUuid}`;
    case 'never_existed':
      return `4:${snapshot.entityKey}`;
    case 'project_deleted':
      return `5:${snapshot.projectUuid}`;
  }
}

function snapshotKeysFromResults(results: SyncOperationResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.invalidations ?? []))];
}

function snapshotKeysFromInvalidations(invalidations: SyncCatchUpInvalidation[]): string[] {
  return [...new Set(invalidations.flatMap((invalidation) => invalidation.entityKeys))];
}

function hasTerminalOperationResults(results: SyncOperationResult[]): boolean {
  return results.some(
    (result) =>
      result.status === 'applied' || result.status === 'conflict' || result.status === 'rejected'
  );
}
