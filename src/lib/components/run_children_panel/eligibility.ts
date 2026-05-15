export interface RunChildrenPlanChild {
  uuid: string;
  status: string;
  taskCount: number;
  doneTaskCount: number;
  dependencies: string[];
  basePlanUuid?: string;
}

export interface SelectionGraph {
  predsByUuid: Map<string, Set<string>>;
  depsByUuid: Map<string, Set<string>>;
  externalBlockedByUuid: Map<string, string[]>;
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

export function buildSelectionGraph(
  children: RunChildrenPlanChild[],
  externalPlanStatusByUuid: Record<string, string | undefined>
): SelectionGraph {
  const childUuids = new Set(children.map((child) => child.uuid));
  const predsByUuid = new Map<string, Set<string>>();
  const depsByUuid = new Map<string, Set<string>>();
  const externalBlockedByUuid = new Map<string, string[]>();

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
  }

  return { predsByUuid, depsByUuid, externalBlockedByUuid };
}

export function expandSelectionWithPredecessors(
  selected: Set<string>,
  child: RunChildrenPlanChild,
  predsByUuid: Map<string, Set<string>>,
  children: RunChildrenPlanChild[]
): Set<string> {
  const childrenByUuid = new Map(children.map((candidate) => [candidate.uuid, candidate]));
  const queue = [child.uuid];
  const visited = new Set<string>();

  selected.add(child.uuid);

  while (queue.length > 0) {
    const currentUuid = queue.shift();
    if (!currentUuid || visited.has(currentUuid)) {
      continue;
    }

    visited.add(currentUuid);

    for (const predecessorUuid of predsByUuid.get(currentUuid) ?? []) {
      const predecessor = childrenByUuid.get(predecessorUuid);
      if (!predecessor || isFinishedStatus(predecessor.status)) {
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
