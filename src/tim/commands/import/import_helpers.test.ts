import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PlanSchema } from '../../planSchema.js';
import type { PendingImportedPlanWrite } from './import_helpers.js';

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../db/plan.js', () => ({
  upsertPlan: vi.fn(),
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
  getPlanWriteLegacyReason: vi.fn(),
  routePlanWriteIntoBatch: vi.fn(() => []),
  writePlanFile: vi.fn(),
  writePlansLegacyDirectTransactionally: vi.fn(),
}));

vi.mock('../../sync/write_router.js', () => ({
  beginSyncBatch: vi.fn(),
}));

import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { previewNextPlanId, reserveNextPlanId } from '../../db/project.js';
import { ensureReferences } from '../../utils/references.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getDefaultConfig } from '../../configSchema.js';
import {
  applyPlanWritePostCommitUpdates,
  getPlanWriteLegacyReason,
  routePlanWriteIntoBatch,
  writePlanFile,
  writePlansLegacyDirectTransactionally,
} from '../../plans.js';
import { beginSyncBatch } from '../../sync/write_router.js';
import {
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
    vi.mocked(getPlanWriteLegacyReason).mockReturnValue(null);
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
    vi.mocked(upsertPlan).mockReturnValue({} as never);
    vi.mocked(reserveNextPlanId).mockReturnValue({ startId: 50 } as never);
  });

  test('writeImportedPlansToDbTransactionally returns empty array for no writes', async () => {
    const result = await writeImportedPlansToDbTransactionally('/tmp/repo', []);

    expect(result).toEqual([]);
    expect(resolveProjectContext).not.toHaveBeenCalled();
    expect(upsertPlan).not.toHaveBeenCalled();
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
    expect(getPlanWriteLegacyReason).toHaveBeenCalledTimes(2);
    expect(beginSyncBatch).toHaveBeenCalledWith(mockDb, expect.any(Object));
    expect(routePlanWriteIntoBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(routePlanWriteIntoBatch).mock.calls[0]?.[5]).toEqual(
      expect.any(Map<number, string>)
    );
    expect(batchCommit).toHaveBeenCalledTimes(1);
    expect(applyPlanWritePostCommitUpdates).toHaveBeenCalledWith(mockDb, []);
    expect(writePlanFile).not.toHaveBeenCalled();
    expect(upsertPlan).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(transactionImmediate).not.toHaveBeenCalled();

    randomUuidSpy.mockRestore();
  });

  test('writeImportedPlansToDbTransactionally uses one legacy transaction for local legacy data', async () => {
    vi.mocked(getPlanWriteLegacyReason).mockReturnValueOnce(
      'existing DB row for plan 1 has no UUID'
    );
    const pendingWrites: PendingImportedPlanWrite[] = [
      { plan: makePlan(1), filePath: null },
      { plan: makePlan(2), filePath: null },
    ];

    const result = await writeImportedPlansToDbTransactionally('/tmp/repo', pendingWrites);

    expect(result).toHaveLength(2);
    expect(writePlansLegacyDirectTransactionally).toHaveBeenCalledWith(
      mockDb,
      10,
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ]),
      expect.any(Map<number, string>),
      []
    );
    expect(beginSyncBatch).not.toHaveBeenCalled();
    expect(routePlanWriteIntoBatch).not.toHaveBeenCalled();
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

  test('reserveImportedPlanStartId falls back to max+1 when reservation throws', async () => {
    vi.mocked(reserveNextPlanId).mockImplementation(() => {
      throw new Error('db down');
    });
    const plans = new Map<number, PlanSchema>([[9, makePlan(9)]]);

    const startId = await reserveImportedPlanStartId('/tmp/repo', 1, plans);

    expect(startId).toBe(10);
  });

  test('reserveImportedPlanStartId propagates config load errors', async () => {
    vi.mocked(loadEffectiveConfig).mockRejectedValueOnce(new Error('bad config'));

    await expect(reserveImportedPlanStartId('/tmp/repo', 1)).rejects.toThrow('bad config');
  });

  test('writeImportedPlansToDbTransactionally stops legacy detection at first match', async () => {
    vi.mocked(getPlanWriteLegacyReason).mockReturnValueOnce('legacy row found');
    const pendingWrites: PendingImportedPlanWrite[] = [
      { plan: makePlan(1), filePath: null },
      { plan: makePlan(2), filePath: null },
    ];

    await writeImportedPlansToDbTransactionally('/tmp/repo', pendingWrites);

    expect(getPlanWriteLegacyReason).toHaveBeenCalledTimes(1);
  });

  test('getImportedIssueUrlsFromPlans deduplicates issue urls', () => {
    const plans = new Map<number, PlanSchema>([
      [1, makePlan(1, { issue: ['https://issue/1', 'https://issue/2'] })],
      [2, makePlan(2, { issue: ['https://issue/2', 'https://issue/3'] })],
      [3, makePlan(3)],
    ]);

    const urls = getImportedIssueUrlsFromPlans(plans);

    expect([...urls].sort()).toEqual(['https://issue/1', 'https://issue/2', 'https://issue/3']);
  });

  test('sync-mode throws before any mutation when legacy data is detected', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      ...getDefaultConfig(),
      sync: {
        role: 'main',
        nodeId: 'test-main-node',
        allowedNodes: [],
      },
    } as never);
    vi.mocked(getPlanWriteLegacyReason).mockReturnValue('existing DB row has no UUID');

    await expect(
      writeImportedPlansToDbTransactionally('/tmp/repo', [
        { plan: makePlan(1), filePath: null },
        { plan: makePlan(2), filePath: null },
      ])
    ).rejects.toThrow('Cannot import plans with sync-routed writes');

    // No DB mutations: batch not started, legacy path not taken
    expect(beginSyncBatch).not.toHaveBeenCalled();
    expect(writePlansLegacyDirectTransactionally).not.toHaveBeenCalled();
    expect(routePlanWriteIntoBatch).not.toHaveBeenCalled();
  });
});
