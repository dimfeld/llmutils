import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { LinkedIssueRef } from '../../../common/issue_tracker/types.js';
import type { PlanSchema } from '../../planSchema.js';
import type { PendingImportedPlanWrite } from './import_helpers.js';

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../db/plan.js', () => ({
  nonSyncedUpsertPlan: vi.fn(),
}));

vi.mock('../../db/plan_sync.js', () => ({
  toPlanUpsertInput: vi.fn(),
}));

vi.mock('../../db/project.js', () => ({
  previewNextPlanId: vi.fn(),
  reserveNextPlanId: vi.fn(),
}));

vi.mock('../../utils/references.js', () => ({
  ensureReferences: vi.fn(),
}));

vi.mock('../../plan_materialize.js', () => ({
  resolveProjectContext: vi.fn(),
}));

vi.mock('../../plans.js', () => ({
  applyPlanWritePostCommitUpdates: vi.fn(),
  routePlanWriteIntoBatch: vi.fn(() => []),
  writePlanFile: vi.fn(),
}));

vi.mock('../../sync/write_router.js', () => ({
  beginSyncBatch: vi.fn(),
}));

import { getDatabase } from '../../db/database.js';
import { nonSyncedUpsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { previewNextPlanId, reserveNextPlanId } from '../../db/project.js';
import { ensureReferences } from '../../utils/references.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getDefaultConfig } from '../../configSchema.js';
import {
  applyPlanWritePostCommitUpdates,
  routePlanWriteIntoBatch,
  writePlanFile,
} from '../../plans.js';
import { beginSyncBatch } from '../../sync/write_router.js';
import {
  applyBlockingIssueDependencies,
  getImportedIssueUrlsFromPlans,
  reserveImportedPlanStartId,
  writeImportedPlansToDbTransactionally,
} from './import_helpers.js';

function makePlan(id: number, overrides?: Partial<PlanSchema>): PlanSchema {
  return {
    id,
    title: `Plan ${id}`,
    goal: `Goal ${id}`,
    details: `Details ${id}`,
    status: 'pending',
    issue: [],
    tasks: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('import_helpers', () => {
  const transactionImmediate = vi.fn();
  const transaction = vi.fn();
  const mockDb = { transaction } as never;
  const batchCommit = vi.fn();
  const mockBatch = { commit: batchCommit };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDatabase).mockReturnValue(mockDb);
    vi.mocked(beginSyncBatch).mockResolvedValue(mockBatch as never);
    vi.mocked(routePlanWriteIntoBatch).mockReturnValue([]);
    vi.mocked(loadEffectiveConfig).mockResolvedValue(getDefaultConfig());

    transaction.mockImplementation((fn: () => void) => {
      transactionImmediate.mockImplementation(() => fn());
      return { immediate: transactionImmediate };
    });

    vi.mocked(resolveProjectContext).mockResolvedValue({
      projectId: 10,
      maxNumericId: 5,
      planIdToUuid: new Map<number, string>([[1, 'uuid-1']]),
      uuidToPlanId: new Map<string, number>([['uuid-1', 1]]),
      rows: [],
      repository: {
        repositoryId: 'repo-id',
        gitRoot: '/tmp/repo',
        remoteUrl: 'https://example.test/repo.git',
      },
    } as never);

    vi.mocked(ensureReferences).mockImplementation((plan: PlanSchema) => ({ updatedPlan: plan }));
    vi.mocked(toPlanUpsertInput).mockImplementation((plan) => ({
      planId: plan.id,
      uuid: plan.uuid ?? `uuid-${plan.id}`,
      filename: `${plan.id}.plan.md`,
      status: plan.status ?? 'pending',
      title: plan.title ?? `Plan ${plan.id}`,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    }));
    vi.mocked(nonSyncedUpsertPlan).mockReturnValue({} as never);
    vi.mocked(reserveNextPlanId).mockReturnValue({ startId: 50 } as never);
  });

  test('writeImportedPlansToDbTransactionally returns empty array for no writes', async () => {
    const result = await writeImportedPlansToDbTransactionally('/tmp/repo', []);

    expect(result).toEqual([]);
    expect(resolveProjectContext).not.toHaveBeenCalled();
    expect(nonSyncedUpsertPlan).not.toHaveBeenCalled();
  });

  test('writeImportedPlansToDbTransactionally resolves uuids, references, and writes transactionally', async () => {
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('uuid-random');
    const pendingWrites: PendingImportedPlanWrite[] = [
      { plan: makePlan(1), filePath: null },
      { plan: makePlan(2), filePath: null },
    ];

    const result = await writeImportedPlansToDbTransactionally('/tmp/repo', pendingWrites);

    expect(result[0]?.plan.uuid).toBe('uuid-1');
    expect(result[1]?.plan.uuid).toBe('uuid-random');
    expect(ensureReferences).toHaveBeenCalledTimes(2);
    expect(beginSyncBatch).toHaveBeenCalledWith(mockDb, expect.any(Object), { atomic: true });
    expect(routePlanWriteIntoBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(routePlanWriteIntoBatch).mock.calls[0]?.[5]).toEqual(
      expect.any(Map<number, string>)
    );
    expect(batchCommit).toHaveBeenCalledTimes(1);
    expect(applyPlanWritePostCommitUpdates).toHaveBeenCalledWith(mockDb, []);
    expect(writePlanFile).not.toHaveBeenCalled();
    expect(nonSyncedUpsertPlan).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(transactionImmediate).not.toHaveBeenCalled();

    randomUuidSpy.mockRestore();
  });

  test('writeImportedPlansToDbTransactionally routes syncOnly writes through the same batch', async () => {
    const pendingWrites: PendingImportedPlanWrite[] = [
      { plan: makePlan(1), filePath: null, syncOnly: true },
      { plan: makePlan(2), filePath: null },
    ];

    const result = await writeImportedPlansToDbTransactionally('/tmp/repo', pendingWrites);

    expect(result.map((entry) => entry.plan.id)).toEqual([2]);
    expect(writePlanFile).not.toHaveBeenCalled();
    expect(routePlanWriteIntoBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(routePlanWriteIntoBatch).mock.calls[0]?.[4]).toMatchObject({ id: 1 });
    expect(vi.mocked(routePlanWriteIntoBatch).mock.calls[1]?.[4]).toMatchObject({ id: 2 });
  });

  test('writeImportedPlansToDbTransactionally throws when an imported plan id is missing', async () => {
    await expect(
      writeImportedPlansToDbTransactionally('/tmp/repo', [
        { plan: { ...makePlan(1), id: undefined } as never, filePath: null },
      ])
    ).rejects.toThrow('Imported plans must have numeric IDs before writing to the database');
  });

  test('reserveImportedPlanStartId computes baseline max id from context and plan map', async () => {
    const plans = new Map<number, PlanSchema>([
      [1, makePlan(1)],
      [25, makePlan(25)],
    ]);

    const startId = await reserveImportedPlanStartId('/tmp/repo', 3, plans);

    expect(reserveNextPlanId).toHaveBeenCalledWith(
      mockDb,
      'repo-id',
      25,
      3,
      'https://example.test/repo.git'
    );
    expect(startId).toBe(50);
  });

  test('reserveImportedPlanStartId propagates reservation errors', async () => {
    vi.mocked(reserveNextPlanId).mockImplementation(() => {
      throw new Error('db down');
    });
    const plans = new Map<number, PlanSchema>([[9, makePlan(9)]]);

    await expect(reserveImportedPlanStartId('/tmp/repo', 1, plans)).rejects.toThrow('db down');
  });

  test('reserveImportedPlanStartId propagates config load errors', async () => {
    vi.mocked(loadEffectiveConfig).mockRejectedValueOnce(new Error('bad config'));

    await expect(reserveImportedPlanStartId('/tmp/repo', 1)).rejects.toThrow('bad config');
  });

  test('getImportedIssueUrlsFromPlans deduplicates issue urls', () => {
    const plans = new Map<number, PlanSchema>([
      [1, makePlan(1, { issue: ['https://issue/1', 'https://issue/2'] })],
      [2, makePlan(2, { issue: ['https://issue/2', 'https://issue/3'] })],
      [3, makePlan(3)],
    ]);

    const urls = getImportedIssueUrlsFromPlans(plans);

    expect([...urls].toSorted()).toEqual(['https://issue/1', 'https://issue/2', 'https://issue/3']);
  });
});

describe('applyBlockingIssueDependencies', () => {
  function blocker(identifier: string, slug = 'title'): LinkedIssueRef {
    return {
      id: `id-${identifier}`,
      identifier,
      title: `Issue ${identifier}`,
      url: `https://linear.app/acme/issue/${identifier}/${slug}`,
    };
  }

  function plansFor(...plans: PlanSchema[]): Map<number, PlanSchema> {
    return new Map(plans.map((plan) => [plan.id, plan]));
  }

  test('does nothing when the issue has no blockers', () => {
    const plan = makePlan(5);

    expect(applyBlockingIssueDependencies(plan, undefined, plansFor(makePlan(1)))).toEqual({
      addedDependencies: [],
    });
    expect(plan.dependencies).toBeUndefined();
    expect(plan.basePlan).toBeUndefined();
  });

  test('ignores blockers that have no plan', () => {
    const plan = makePlan(5);
    const result = applyBlockingIssueDependencies(
      plan,
      [blocker('TEAM-9')],
      plansFor(makePlan(1, { issue: ['https://linear.app/acme/issue/TEAM-1/title'] }))
    );

    expect(result).toEqual({ addedDependencies: [] });
    expect(plan.dependencies).toBeUndefined();
  });

  test('matches plans by Linear issue key when the URL slug differs', () => {
    const plan = makePlan(5);
    const result = applyBlockingIssueDependencies(
      plan,
      [blocker('TEAM-1', 'new-title')],
      plansFor(makePlan(1, { issue: ['https://linear.app/acme/issue/team-1/old-title'] }))
    );

    expect(result).toEqual({ addedDependencies: [1], basePlan: 1 });
    expect(plan.dependencies).toEqual([1]);
    expect(plan.basePlan).toBe(1);
  });

  test('sets the base plan only when exactly one blocking plan is unfinished', () => {
    const allPlans = plansFor(
      makePlan(1, { status: 'done', issue: [blocker('TEAM-1').url] }),
      makePlan(2, { status: 'cancelled', issue: [blocker('TEAM-2').url] }),
      makePlan(3, { status: 'needs_review', issue: [blocker('TEAM-3').url] }),
      makePlan(4, { status: 'in_progress', issue: [blocker('TEAM-4').url] })
    );

    const onePending = makePlan(10);
    applyBlockingIssueDependencies(
      onePending,
      [blocker('TEAM-1'), blocker('TEAM-2'), blocker('TEAM-3')],
      allPlans
    );
    expect(onePending.dependencies).toEqual([1, 2, 3]);
    expect(onePending.basePlan).toBe(3);

    const twoPending = makePlan(11);
    const result = applyBlockingIssueDependencies(
      twoPending,
      [blocker('TEAM-3'), blocker('TEAM-4')],
      allPlans
    );
    expect(result).toEqual({ addedDependencies: [3, 4] });
    expect(twoPending.dependencies).toEqual([3, 4]);
    expect(twoPending.basePlan).toBeUndefined();

    const allDone = makePlan(12);
    applyBlockingIssueDependencies(allDone, [blocker('TEAM-1')], allPlans);
    expect(allDone.dependencies).toEqual([1]);
    expect(allDone.basePlan).toBeUndefined();
  });

  test('keeps existing dependencies and an existing base plan', () => {
    const plan = makePlan(10, { dependencies: [7, 1], basePlan: 7 });
    const result = applyBlockingIssueDependencies(
      plan,
      [blocker('TEAM-1'), blocker('TEAM-2')],
      plansFor(
        makePlan(1, { issue: [blocker('TEAM-1').url] }),
        makePlan(2, { issue: [blocker('TEAM-2').url] })
      )
    );

    expect(result).toEqual({ addedDependencies: [2] });
    expect(plan.dependencies).toEqual([7, 1, 2]);
    expect(plan.basePlan).toBe(7);
  });

  test('skips the plan itself and its parent', () => {
    const plan = makePlan(10, { parent: 1 });
    const result = applyBlockingIssueDependencies(
      plan,
      [blocker('TEAM-1'), blocker('TEAM-10')],
      plansFor(
        makePlan(1, { issue: [blocker('TEAM-1').url] }),
        makePlan(10, { issue: [blocker('TEAM-10').url] })
      )
    );

    expect(result).toEqual({ addedDependencies: [] });
    expect(plan.dependencies).toBeUndefined();
    expect(plan.basePlan).toBeUndefined();
  });
});
