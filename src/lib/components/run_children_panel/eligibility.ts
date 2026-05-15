export interface RunChildrenPlanChild {
  uuid: string;
  status: string;
  taskCount: number;
  doneTaskCount: number;
  dependencies: string[];
  basePlanUuid?: string;
}

export type DirectBlockReason = 'external' | 'ineligible';
export type BlockReason = DirectBlockReason | 'transitive';

export interface TransitiveBlockInfo {
  /** The directly-blocked ancestor that causes this child to be blocked. */
  blockerUuid: string;
  /** Why the ancestor itself is blocked. */
  reason: DirectBlockReason;
}

export interface SelectionGraph<T extends RunChildrenPlanChild = RunChildrenPlanChild> {
  predsByUuid: Map<string, Set<string>>;
  depsByUuid: Map<string, Set<string>>;
  externalBlockedByUuid: Map<string, string[]>;
  ineligibleByUuid: Set<string>;
  /**
   * Children that are not themselves directly-blocked but have an in-list transitive
   * predecessor that IS directly-blocked (external dep or ineligible). Selecting them
   * is impossible because the closure would require selecting an unselectable child.
   */
  transitivelyBlockedByUuid: Map<string, TransitiveBlockInfo>;
  childrenByUuid: Map<string, T>;
}

const FINISHED_STATUSES = new Set(['done', 'cancelled', 'needs_review']);
const INELIGIBLE_STATUSES = new Set([
  'done',
  'cancelled',
  'needs_review',
  'deferred',
  'recently_done',
]);

export function isFinishedStatus(status: string): boolean {
  // Keep in sync with isWorkCompleteStatus in src/tim/plans/plan_state_utils.ts.
  return FINISHED_STATUSES.has(status);
}

export function isAgentEligibleChild(child: RunChildrenPlanChild): boolean {
  return !INELIGIBLE_STATUSES.has(child.status) && child.doneTaskCount < child.taskCount;
}

export function buildSelectionGraph<T extends RunChildrenPlanChild>(
  children: T[],
  externalPlanStatusByUuid: Record<string, string | undefined>
): SelectionGraph<T> {
  const childUuids = new Set(children.map((child) => child.uuid));
  const childrenByUuid = new Map<string, T>(children.map((c) => [c.uuid, c]));
  const predsByUuid = new Map<string, Set<string>>();
  const depsByUuid = new Map<string, Set<string>>();
  const externalBlockedByUuid = new Map<string, string[]>();
  const ineligibleByUuid = new Set<string>();
  const transitivelyBlockedByUuid = new Map<string, TransitiveBlockInfo>();

  for (const child of children) {
    const predecessors = new Set<string>();
    const blockedExternalDeps: string[] = [];

    for (const dependencyUuid of getDependencyUuids(child)) {
      if (childUuids.has(dependencyUuid)) {
        predecessors.add(dependencyUuid);
        const dependents = depsByUuid.get(dependencyUuid) ?? new Set<string>();
        dependents.add(child.uuid);
        depsByUuid.set(dependencyUuid, dependents);
        continue;
      }

      const externalStatus = externalPlanStatusByUuid[dependencyUuid];
      // Missing external status is treated as blocking because the UI cannot prove the
      // dependency is complete; the remote command performs the authoritative check.
      if (!externalStatus || !isFinishedStatus(externalStatus)) {
        blockedExternalDeps.push(dependencyUuid);
      }
    }

    predsByUuid.set(child.uuid, predecessors);
    if (!depsByUuid.has(child.uuid)) {
      depsByUuid.set(child.uuid, new Set());
    }
    if (blockedExternalDeps.length > 0) {
      externalBlockedByUuid.set(child.uuid, blockedExternalDeps);
    }
    if (!isAgentEligibleChild(child)) {
      ineligibleByUuid.add(child.uuid);
    }
  }

  // Compute transitive blocking: a child is transitively-blocked if any of its in-list
  // predecessors (reachable through the predecessor graph, skipping finished ones since
  // those don't need to be selected) is directly-blocked.
  for (const child of children) {
    if (externalBlockedByUuid.has(child.uuid) || ineligibleByUuid.has(child.uuid)) {
      continue;
    }

    const blockInfo = findBlockingAncestor(
      child.uuid,
      predsByUuid,
      childrenByUuid,
      externalBlockedByUuid,
      ineligibleByUuid
    );
    if (blockInfo) {
      transitivelyBlockedByUuid.set(child.uuid, blockInfo);
    }
  }

  return {
    predsByUuid,
    depsByUuid,
    externalBlockedByUuid,
    ineligibleByUuid,
    transitivelyBlockedByUuid,
    childrenByUuid,
  };
}

function findBlockingAncestor<T extends RunChildrenPlanChild>(
  startUuid: string,
  predsByUuid: Map<string, Set<string>>,
  childrenByUuid: Map<string, T>,
  externalBlockedByUuid: Map<string, string[]>,
  ineligibleByUuid: Set<string>
): TransitiveBlockInfo | null {
  const queue: string[] = [];
  const visited = new Set<string>();

  for (const pred of predsByUuid.get(startUuid) ?? []) {
    queue.push(pred);
  }

  while (queue.length > 0) {
    const currentUuid = queue.shift()!;
    if (visited.has(currentUuid)) continue;
    visited.add(currentUuid);

    const current = childrenByUuid.get(currentUuid);
    if (!current) continue;
    // Finished predecessors don't need to be selected and don't propagate blocking.
    if (isFinishedStatus(current.status)) continue;

    if (externalBlockedByUuid.has(currentUuid)) {
      return { blockerUuid: currentUuid, reason: 'external' };
    }
    if (ineligibleByUuid.has(currentUuid)) {
      return { blockerUuid: currentUuid, reason: 'ineligible' };
    }

    for (const pred of predsByUuid.get(currentUuid) ?? []) {
      queue.push(pred);
    }
  }

  return null;
}

export function expandSelectionWithPredecessors(
  selected: Set<string>,
  child: RunChildrenPlanChild,
  graph: SelectionGraph
): Set<string> {
  // Guard: never auto-select a child that is itself unselectable.
  if (
    graph.externalBlockedByUuid.has(child.uuid) ||
    graph.ineligibleByUuid.has(child.uuid) ||
    graph.transitivelyBlockedByUuid.has(child.uuid)
  ) {
    return selected;
  }

  const queue = [child.uuid];
  const visited = new Set<string>();

  selected.add(child.uuid);

  while (queue.length > 0) {
    const currentUuid = queue.shift();
    if (!currentUuid || visited.has(currentUuid)) {
      continue;
    }

    visited.add(currentUuid);

    for (const predecessorUuid of graph.predsByUuid.get(currentUuid) ?? []) {
      const predecessor = graph.childrenByUuid.get(predecessorUuid);
      if (!predecessor || isFinishedStatus(predecessor.status)) {
        continue;
      }
      // Defense-in-depth: an unselectable predecessor shouldn't be auto-added.
      // The row of any child whose closure requires this predecessor is itself
      // marked transitively-blocked and disabled, so we shouldn't reach here in
      // normal use — but bail gracefully if we do.
      if (
        graph.externalBlockedByUuid.has(predecessorUuid) ||
        graph.ineligibleByUuid.has(predecessorUuid) ||
        graph.transitivelyBlockedByUuid.has(predecessorUuid)
      ) {
        continue;
      }

      selected.add(predecessorUuid);
      queue.push(predecessorUuid);
    }
  }

  return selected;
}

export function shrinkSelectionRemovingDependents(
  selected: Set<string>,
  removed: string,
  depsByUuid: Map<string, Set<string>>
): Set<string> {
  const queue = [removed];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentUuid = queue.shift();
    if (!currentUuid || visited.has(currentUuid)) {
      continue;
    }

    visited.add(currentUuid);
    selected.delete(currentUuid);

    for (const dependentUuid of depsByUuid.get(currentUuid) ?? []) {
      queue.push(dependentUuid);
    }
  }

  return selected;
}

function getDependencyUuids(child: RunChildrenPlanChild): Set<string> {
  const dependencyUuids = new Set(child.dependencies);
  if (child.basePlanUuid) {
    dependencyUuids.add(child.basePlanUuid);
  }
  return dependencyUuids;
}
