import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import { clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';

vi.mock('../../logging.js', () => ({
  debugLog: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../db/assignment.js', () => ({
  removeAssignment: vi.fn(() => true),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => ({
    repositoryId: 'test-repo',
    remoteUrl: null,
    gitRoot: '',
  })),
}));

import { readPlanFile, resolvePlanByNumericId, writePlanFile } from '../plans.js';
import { handleSetCommand } from './set.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import { materializePlan } from '../plan_materialize.js';
import { log, warn, error } from '../../logging.js';
import { removeAssignment } from '../db/assignment.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getDatabase } from '../db/database.js';
import { getPlanByPlanId } from '../db/plan.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { setApplyBatchOperationHookForTesting } from '../sync/apply.js';

const logSpy = vi.mocked(log);
const warnSpy = vi.mocked(warn);
const errorSpy = vi.mocked(error);
const removeAssignmentSpy = vi.mocked(removeAssignment);
const getRepositoryIdentitySpy = vi.mocked(getRepositoryIdentity);

describe('tim set command', () => {
  let tempDir: string;
  let tasksDir: string;
  let globalOpts: any;
  let configPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);

    tempDir = await mkdtemp(path.join(tmpdir(), 'tim-set-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    let config: TimConfig = {
      paths: {
        tasks: tasksDir,
      },
    };
    await mkdir(tasksDir, { recursive: true });
    configPath = path.join(tempDir, '.tim.yml');
    await Bun.file(configPath).write(yaml.stringify(config));
    globalOpts = {
      config: configPath,
    };

    getRepositoryIdentitySpy.mockResolvedValue({
      repositoryId: tempDir,
      remoteUrl: null,
      gitRoot: tempDir,
    });

    removeAssignmentSpy.mockReturnValue(true);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const createTestPlan = async (id: number, overrides?: Partial<PlanSchema>) => {
    const planPath = path.join(tasksDir, `${id}.yml`);
    const plan: PlanSchema = {
      id,
      goal: `Test plan ${id}`,
      note: `Note for test plan ${id}`,
      details: `Details for test plan ${id}`,
      priority: 'medium',
      status: 'pending',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (overrides) {
      Object.assign(plan, overrides);
    }
    await writePlanFile(planPath, plan, { skipUpdatedAt: true, cwdForIdentity: tempDir });
    return planPath;
  };

  test('should update priority', async () => {
    const planPath = await createTestPlan(10);

    await handleSetCommand(
      10,
      {
        priority: 'high',
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(10, tempDir)).plan;
    expect(updatedPlan.priority).toBe('high');
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('should update note', async () => {
    const planPath = await createTestPlan(101);

    await handleSetCommand(
      101,
      {
        note: 'Updated note text',
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(101, tempDir)).plan;
    expect(updatedPlan.note).toBe('Updated note text');
  });

  test('should update status', async () => {
    const planPath = await createTestPlan(11);

    await handleSetCommand(
      11,
      {
        status: 'in_progress',
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(11, tempDir)).plan;
    expect(updatedPlan.status).toBe('in_progress');
    expect(removeAssignmentSpy).not.toHaveBeenCalled();
  });

  test('removes assignments when status set to done', async () => {
    const planPath = await createTestPlan(111);

    await handleSetCommand(
      111,
      {
        status: 'done',
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(111, tempDir)).plan;
    expect(updatedPlan.status).toBe('done');
    expect(removeAssignmentSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = removeAssignmentSpy.mock.calls;
    expect(callArgs[2]).toBe(updatedPlan.uuid);
  });

  test('removes assignments when status set to cancelled', async () => {
    const planPath = await createTestPlan(112);

    await handleSetCommand(
      112,
      {
        status: 'cancelled',
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(112, tempDir)).plan;
    expect(updatedPlan.status).toBe('cancelled');
    expect(removeAssignmentSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = removeAssignmentSpy.mock.calls;
    expect(callArgs[2]).toBe(updatedPlan.uuid);
  });

  test('removes assignments when status set to needs_review', async () => {
    const planPath = await createTestPlan(117);

    await handleSetCommand(
      117,
      {
        status: 'needs_review',
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(117, tempDir)).plan;
    expect(updatedPlan.status).toBe('needs_review');
    expect(removeAssignmentSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = removeAssignmentSpy.mock.calls;
    expect(callArgs[2]).toBe(updatedPlan.uuid);
  });

  test('logs warning when assignment removal fails', async () => {
    const planPath = await createTestPlan(113);
    removeAssignmentSpy.mockImplementationOnce(() => {
      throw new Error('lock failure');
    });

    await handleSetCommand(
      113,
      {
        status: 'done',
      },
      globalOpts
    );

    const warnings = warnSpy.mock.calls.map((args) => args[0]);
    expect(
      warnings.some((message) =>
        message.includes('Failed to remove assignment for plan 113: lock failure')
      )
    ).toBe(true);
  });

  test('marks epic parent done when last incomplete child is set to cancelled', async () => {
    const parentPlanPath = await createTestPlan(114, {
      epic: true,
      status: 'in_progress',
    });
    const doneChildPath = await createTestPlan(115, {
      parent: 114,
      status: 'done',
    });
    const lastChildPath = await createTestPlan(116, {
      parent: 114,
      status: 'in_progress',
    });

    await handleSetCommand(
      116,
      {
        status: 'cancelled',
      },
      globalOpts
    );

    const updatedLastChild = (await resolvePlanByNumericId(116, tempDir)).plan;
    const updatedParent = (await resolvePlanByNumericId(114, tempDir)).plan;
    const doneChild = (await resolvePlanByNumericId(115, tempDir)).plan;

    expect(updatedLastChild.status).toBe('cancelled');
    expect(doneChild.status).toBe('done');
    expect(updatedParent.status).toBe('needs_review');
  });

  test('should add dependencies', async () => {
    // Create dependency plans so validation passes
    await createTestPlan(10);
    await createTestPlan(11);
    const planPath = await createTestPlan(12);

    await handleSetCommand(
      12,
      {
        dependsOn: [10, 11],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(12, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([10, 11]);
  });

  test('should not duplicate dependencies', async () => {
    // Create dependency plans so validation passes
    await createTestPlan(10);
    await createTestPlan(11);
    const planPath = await createTestPlan(13);

    // First add
    await handleSetCommand(
      13,
      {
        dependsOn: [10],
      },
      globalOpts
    );

    // Try to add again with overlap
    await handleSetCommand(
      13,
      {
        dependsOn: [10, 11],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(13, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([10, 11]);
  });

  test('should remove dependencies', async () => {
    // Create dependency plans so validation passes
    await createTestPlan(10);
    await createTestPlan(11);
    await createTestPlan(12);
    const planPath = await createTestPlan(14);

    // First add dependencies
    await handleSetCommand(
      14,
      {
        dependsOn: [10, 11, 12],
      },
      globalOpts
    );

    // Remove some
    await handleSetCommand(
      14,
      {
        noDependsOn: [10, 12],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(14, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([11]);
  });

  test('should ignore rmfilter updates because the field is no longer persisted', async () => {
    const planPath = await createTestPlan(15);

    await handleSetCommand(
      15,
      {
        rmfilter: ['src/**/*.ts', 'tests/**/*.test.ts'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(15, tempDir)).plan;
    expect(updatedPlan.rmfilter).toBeUndefined();
  });

  test('should update multiple fields at once', async () => {
    // Create dependency plans so validation passes
    await createTestPlan(10);
    await createTestPlan(11);
    const planPath = await createTestPlan(16);

    await handleSetCommand(
      16,
      {
        priority: 'urgent',
        status: 'in_progress',
        dependsOn: [10, 11],
        rmfilter: ['src/**/*.ts'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(16, tempDir)).plan;
    expect(updatedPlan.priority).toBe('urgent');
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.dependencies).toEqual([10, 11]);
    expect(updatedPlan.rmfilter).toBeUndefined();
  });

  test('should not update if no changes made', async () => {
    const planPath = await createTestPlan(17);
    const originalPlan = await readPlanFile(planPath);
    const originalContent = await readFile(planPath, 'utf-8');

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    await handleSetCommand(17, {}, globalOpts);

    const unchangedPlan = await readPlanFile(planPath);
    // Check that the file content hasn't changed
    const newContent = await readFile(planPath, 'utf-8');
    expect(newContent).toBe(originalContent);

    // The timestamp should be close (within 5ms) if no real changes were made
    const originalTime = new Date(originalPlan.updatedAt!).getTime();
    const newTime = new Date(unchangedPlan.updatedAt!).getTime();
    expect(Math.abs(newTime - originalTime)).toBeLessThan(5);
  });

  test('should add issue URLs', async () => {
    const planPath = await createTestPlan(18);

    await handleSetCommand(
      18,
      {
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
        ],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(18, tempDir)).plan;
    expect(updatedPlan.issue).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/124',
    ]);
  });

  test('should not duplicate issue URLs', async () => {
    const planPath = await createTestPlan(19);

    // First add
    await handleSetCommand(
      19,
      {
        issue: ['https://github.com/owner/repo/issues/123'],
      },
      globalOpts
    );

    // Try to add again with overlap
    await handleSetCommand(
      19,
      {
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
        ],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(19, tempDir)).plan;
    expect(updatedPlan.issue).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://github.com/owner/repo/issues/124',
    ]);
  });

  test('should remove issue URLs', async () => {
    const planPath = await createTestPlan(20);

    // First add issue URLs
    await handleSetCommand(
      20,
      {
        issue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/124',
          'https://github.com/owner/repo/issues/125',
        ],
      },
      globalOpts
    );

    // Remove some
    await handleSetCommand(
      20,
      {
        noIssue: [
          'https://github.com/owner/repo/issues/123',
          'https://github.com/owner/repo/issues/125',
        ],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(20, tempDir)).plan;
    expect(updatedPlan.issue).toEqual(['https://github.com/owner/repo/issues/124']);
  });

  test('should handle plans without existing dependencies', async () => {
    const planPath = await createTestPlan(21);

    // Remove dependencies
    await handleSetCommand(
      21,
      {
        noDependsOn: [10, 11],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(21, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([]);
  });

  test('should handle plans without existing issue URLs', async () => {
    const planPath = await createTestPlan(22);

    // Remove issue URLs
    await handleSetCommand(
      22,
      {
        noIssue: ['https://github.com/owner/repo/issues/123'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(22, tempDir)).plan;
    expect(updatedPlan.issue).toEqual([]);
  });

  test('should add documentation paths', async () => {
    const planPath = await createTestPlan(23);

    await handleSetCommand(
      23,
      {
        doc: ['docs/setup.md', 'docs/api.md'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(23, tempDir)).plan;
    expect(updatedPlan.docs).toEqual(['docs/setup.md', 'docs/api.md']);
  });

  test('should not duplicate documentation paths', async () => {
    const planPath = await createTestPlan(24);

    // First add
    await handleSetCommand(
      24,
      {
        doc: ['docs/setup.md'],
      },
      globalOpts
    );

    // Try to add again with overlap
    await handleSetCommand(
      24,
      {
        doc: ['docs/setup.md', 'docs/api.md'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(24, tempDir)).plan;
    expect(updatedPlan.docs).toEqual(['docs/setup.md', 'docs/api.md']);
  });

  test('should remove documentation paths', async () => {
    const planPath = await createTestPlan(25);

    // First add documentation paths
    await handleSetCommand(
      25,
      {
        doc: ['docs/setup.md', 'docs/api.md', 'docs/guide.md'],
      },
      globalOpts
    );

    // Remove some
    await handleSetCommand(
      25,
      {
        noDoc: ['docs/setup.md', 'docs/guide.md'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(25, tempDir)).plan;
    expect(updatedPlan.docs).toEqual(['docs/api.md']);
  });

  test('should handle plans without existing documentation paths', async () => {
    const planPath = await createTestPlan(26);

    // Remove documentation paths from plan without any
    await handleSetCommand(
      26,
      {
        noDoc: ['docs/setup.md'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(26, tempDir)).plan;
    expect(updatedPlan.docs).toEqual([]);
  });

  test('should handle adding and removing documentation paths in same command', async () => {
    const planPath = await createTestPlan(27);

    // First add some docs
    await handleSetCommand(
      27,
      {
        doc: ['docs/old1.md', 'docs/old2.md', 'docs/keep.md'],
      },
      globalOpts
    );

    // Add new and remove old in same command
    await handleSetCommand(
      27,
      {
        doc: ['docs/new1.md', 'docs/new2.md'],
        noDoc: ['docs/old1.md', 'docs/old2.md'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(27, tempDir)).plan;
    expect(updatedPlan.docs).toEqual(['docs/keep.md', 'docs/new1.md', 'docs/new2.md']);
  });

  test('should set parent plan', async () => {
    // Create both parent and child plans
    const parentPlanPath = await createTestPlan(15);
    const planPath = await createTestPlan(30);

    await handleSetCommand(
      30,
      {
        parent: 15,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(30, tempDir)).plan;
    expect(updatedPlan.parent).toBe(15);
  });

  test('should remove parent plan', async () => {
    // Create both parent and child plans
    const parentPlanPath = await createTestPlan(20);
    const planPath = await createTestPlan(31);

    // First set a parent
    await handleSetCommand(
      31,
      {
        parent: 20,
      },
      globalOpts
    );

    let updatedPlan = (await resolvePlanByNumericId(31, tempDir)).plan;
    expect(updatedPlan.parent).toBe(20);

    // Then remove it
    await handleSetCommand(
      31,
      {
        noParent: true,
      },
      globalOpts
    );

    updatedPlan = (await resolvePlanByNumericId(31, tempDir)).plan;
    expect(updatedPlan.parent).toBeUndefined();
  });

  test('should handle removing parent when none exists', async () => {
    const planPath = await createTestPlan(32);

    await handleSetCommand(
      32,
      {
        noParent: true,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(32, tempDir)).plan;
    expect(updatedPlan.parent).toBeUndefined();
  });

  test('should throw error when setting non-existent parent', async () => {
    const planPath = await createTestPlan(33);

    await expect(
      handleSetCommand(
        33,
        {
          parent: 999, // Non-existent parent ID
        },
        globalOpts
      )
    ).rejects.toThrow('Parent plan with ID 999 not found');
  });

  test('should allow setting existing parent', async () => {
    // Create a parent plan first
    const parentPlanPath = await createTestPlan(100);
    const childPlanPath = await createTestPlan(101);

    // Set parent to the existing plan
    await handleSetCommand(
      101,
      {
        parent: 100,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(101, tempDir)).plan;
    expect(updatedPlan.parent).toBe(100);
  });

  test('should update parent plan dependencies when setting parent', async () => {
    // Create both parent and child plans
    await createTestPlan(200);
    const childPlanPath = await createTestPlan(201);

    await handleSetCommand(
      201,
      {
        parent: 200,
      },
      globalOpts
    );

    // Verify child has parent field set
    const updatedChild = (await resolvePlanByNumericId(201, tempDir)).plan;
    expect(updatedChild.parent).toBe(200);

    // Verify parent has child in dependencies array
    const updatedParent = (await resolvePlanByNumericId(200, tempDir)).plan;
    expect(updatedParent.dependencies).toEqual([201]);
    expect(updatedParent.updatedAt).toBeDefined();
  });

  test('should remove child from parent dependencies when removing parent', async () => {
    // Create both parent and child plans
    await createTestPlan(202);
    const childPlanPath = await createTestPlan(203);

    // First set parent relationship
    await handleSetCommand(
      203,
      {
        parent: 202,
      },
      globalOpts
    );

    // Verify relationship is established
    let updatedChild = (await resolvePlanByNumericId(203, tempDir)).plan;
    let updatedParent = (await resolvePlanByNumericId(202, tempDir)).plan;
    expect(updatedChild.parent).toBe(202);
    expect(updatedParent.dependencies).toEqual([203]);

    // Remove parent relationship
    await handleSetCommand(
      203,
      {
        noParent: true,
      },
      globalOpts
    );

    // Verify child parent field is removed
    updatedChild = (await resolvePlanByNumericId(203, tempDir)).plan;
    expect(updatedChild.parent).toBeUndefined();

    // Verify parent dependencies array is updated
    updatedParent = (await resolvePlanByNumericId(202, tempDir)).plan;
    expect(updatedParent.dependencies).toEqual([]);
  });

  test('should update both old and new parent when changing parent', async () => {
    // Create child, old parent, and new parent plans
    const childPlanPath = await createTestPlan(204);
    await createTestPlan(205);
    await createTestPlan(206);

    // Establish initial relationship with old parent
    await handleSetCommand(
      204,
      {
        parent: 205,
      },
      globalOpts
    );

    // Verify initial relationship
    let updatedChild = (await resolvePlanByNumericId(204, tempDir)).plan;
    let oldParent = (await resolvePlanByNumericId(205, tempDir)).plan;
    expect(updatedChild.parent).toBe(205);
    expect(oldParent.dependencies).toEqual([204]);

    // Change to new parent
    await handleSetCommand(
      204,
      {
        parent: 206,
      },
      globalOpts
    );

    // Verify child has new parent
    updatedChild = (await resolvePlanByNumericId(204, tempDir)).plan;
    expect(updatedChild.parent).toBe(206);

    // Verify old parent no longer has child in dependencies
    oldParent = (await resolvePlanByNumericId(205, tempDir)).plan;
    expect(oldParent.dependencies).toEqual([]);

    // Verify new parent has child in dependencies
    const newParent = (await resolvePlanByNumericId(206, tempDir)).plan;
    expect(newParent.dependencies).toEqual([204]);
  });

  test('rolls back child and parent changes when parent-change batch fails', async () => {
    await createTestPlan(212, {
      status: 'pending',
      dependencies: [],
    });
    await createTestPlan(213, {
      status: 'done',
      dependencies: [],
    });
    await createTestPlan(214, {
      parent: 212,
    });

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 1) {
        throw new Error('injected set parent batch failure');
      }
    });

    await expect(
      handleSetCommand(214, { status: 'in_progress', parent: 213 }, globalOpts)
    ).rejects.toThrow('injected set parent batch failure');

    setApplyBatchOperationHookForTesting(null);
    const child = (await resolvePlanByNumericId(214, tempDir)).plan;
    const oldParent = (await resolvePlanByNumericId(212, tempDir)).plan;
    const newParent = (await resolvePlanByNumericId(213, tempDir)).plan;
    expect(child.parent).toBe(212);
    expect(child.status).toBe('pending');
    expect(oldParent.dependencies).toEqual([214]);
    expect(newParent.status).toBe('done');
    expect(newParent.dependencies ?? []).toEqual([]);

    const projectContext = await resolveProjectContext(tempDir);
    expect(getPlanByPlanId(getDatabase(), projectContext.projectId, 214)).not.toBeNull();
  });

  test('should prevent circular dependencies when setting parent', async () => {
    const planAPath = await createTestPlan(207);
    const planBPath = await createTestPlan(208);
    const planCPath = await createTestPlan(209);

    await handleSetCommand(
      209,
      {
        parent: 207,
      },
      globalOpts
    );

    await handleSetCommand(
      208,
      {
        parent: 209,
      },
      globalOpts
    );

    const planB = (await resolvePlanByNumericId(208, tempDir)).plan;
    const planC = (await resolvePlanByNumericId(209, tempDir)).plan;
    expect(planB.parent).toBe(209);
    expect(planC.parent).toBe(207);

    await expect(
      handleSetCommand(
        207,
        {
          parent: 208,
        },
        globalOpts
      )
    ).rejects.toThrow('Setting parent 208 would create a circular dependency');

    const updatedPlanA = (await resolvePlanByNumericId(207, tempDir)).plan;
    expect(updatedPlanA.parent).toBeUndefined();
  });

  test('should detect parent cycles introduced by unsynced materialized parent files', async () => {
    const childPlanPath = await createTestPlan(560);
    await createTestPlan(561);

    const materializedParentPath = await materializePlan(561, tempDir);
    const materializedParent = await readPlanFile(materializedParentPath);
    materializedParent.parent = 560;
    await writePlanFile(materializedParentPath, materializedParent, {
      skipDb: true,
      skipUpdatedAt: true,
    });

    await expect(
      handleSetCommand(
        560,
        {
          parent: 561,
        },
        globalOpts
      )
    ).rejects.toThrow('Setting parent 561 would create a circular dependency');

    const updatedChild = (await resolvePlanByNumericId(560, tempDir)).plan;
    expect(updatedChild.parent).toBeUndefined();
  });

  test('should handle setting parent to same value without duplicating dependencies', async () => {
    // Create parent and child plans
    const parentPlanPath = await createTestPlan(210);
    const childPlanPath = await createTestPlan(211);

    // Set parent first time
    await handleSetCommand(
      211,
      {
        parent: 210,
      },
      globalOpts
    );

    // Verify initial relationship
    let updatedChild = (await resolvePlanByNumericId(211, tempDir)).plan;
    let updatedParent = (await resolvePlanByNumericId(210, tempDir)).plan;
    expect(updatedChild.parent).toBe(210);
    expect(updatedParent.dependencies).toEqual([211]);

    // Set same parent again
    await handleSetCommand(
      211,
      {
        parent: 210,
      },
      globalOpts
    );

    // Verify no duplicate dependencies
    updatedChild = (await resolvePlanByNumericId(211, tempDir)).plan;
    updatedParent = (await resolvePlanByNumericId(210, tempDir)).plan;
    expect(updatedChild.parent).toBe(210);
    expect(updatedParent.dependencies).toEqual([211]); // Should still be [211], not [211, 211]
  });

  test('should set discoveredFrom field', async () => {
    await createTestPlan(38);
    const planPath = await createTestPlan(40);

    await handleSetCommand(
      40,
      {
        discoveredFrom: 38,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(40, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBe(38);
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('should remove discoveredFrom field', async () => {
    await createTestPlan(38);
    const planPath = await createTestPlan(41);

    // First set discoveredFrom
    await handleSetCommand(
      41,
      {
        discoveredFrom: 38,
      },
      globalOpts
    );

    let updatedPlan = (await resolvePlanByNumericId(41, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBe(38);

    // Then remove it
    await handleSetCommand(
      41,
      {
        noDiscoveredFrom: true,
      },
      globalOpts
    );

    updatedPlan = (await resolvePlanByNumericId(41, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBeUndefined();
  });

  test('should handle removing discoveredFrom when none exists', async () => {
    const planPath = await createTestPlan(42);

    await handleSetCommand(
      42,
      {
        noDiscoveredFrom: true,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(42, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBeUndefined();
  });

  test('should allow changing discoveredFrom value', async () => {
    await createTestPlan(38);
    await createTestPlan(39);
    const planPath = await createTestPlan(43);

    // First set discoveredFrom to 38
    await handleSetCommand(
      43,
      {
        discoveredFrom: 38,
      },
      globalOpts
    );

    let updatedPlan = (await resolvePlanByNumericId(43, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBe(38);

    // Change it to 39
    await handleSetCommand(
      43,
      {
        discoveredFrom: 39,
      },
      globalOpts
    );

    updatedPlan = (await resolvePlanByNumericId(43, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBe(39);
  });

  test('adds tags with normalization and deduplication', async () => {
    const planPath = await createTestPlan(200);

    await handleSetCommand(
      200,
      {
        tag: ['Frontend', 'frontend', 'Urgent', ''],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(200, tempDir)).plan;
    expect(updatedPlan.tags).toEqual(['frontend', 'urgent']);
  });

  test('removes specified tags', async () => {
    const planPath = await createTestPlan(201, { tags: ['frontend', 'bug', 'urgent'] });

    await handleSetCommand(
      201,
      {
        noTag: ['BUG'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(201, tempDir)).plan;
    expect(updatedPlan.tags).toEqual(['frontend', 'urgent']);
  });

  test('supports adding and removing tags in one command', async () => {
    const planPath = await createTestPlan(202, { tags: ['frontend'] });

    await handleSetCommand(
      202,
      {
        tag: ['Bug'],
        noTag: ['frontend'],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(202, tempDir)).plan;
    expect(updatedPlan.tags).toEqual(['bug']);
  });

  test('rejects tags not in allowlist', async () => {
    await Bun.file(configPath).write(
      yaml.stringify({
        paths: { tasks: tasksDir },
        tags: { allowed: ['frontend', 'backend'] },
      })
    );
    clearAllTimCaches();

    const planPath = await createTestPlan(203);

    await expect(
      handleSetCommand(
        203,
        {
          tag: ['urgent'],
        },
        globalOpts
      )
    ).rejects.toThrow(/Invalid tag/);
  });

  test('should set epic to true', async () => {
    const planPath = await createTestPlan(300);

    await handleSetCommand(
      300,
      {
        epic: true,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(300, tempDir)).plan;
    expect(updatedPlan.epic).toBe(true);
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('should set epic to false using --no-epic', async () => {
    const planPath = await createTestPlan(301, { epic: true });

    await handleSetCommand(
      301,
      {
        noEpic: true,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(301, tempDir)).plan;
    expect(updatedPlan.epic).toBeFalsy();
  });

  test('should handle noEpic when epic is already false', async () => {
    const planPath = await createTestPlan(302, { epic: false });

    await handleSetCommand(
      302,
      {
        noEpic: true,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(302, tempDir)).plan;
    expect(updatedPlan.epic).toBeFalsy();
  });

  test('should set simple to true', async () => {
    const planPath = await createTestPlan(304);

    await handleSetCommand(
      304,
      {
        simple: true,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(304, tempDir)).plan;
    expect(updatedPlan.simple).toBe(true);
  });

  test('should set simple to false using --no-simple', async () => {
    const planPath = await createTestPlan(305, { simple: true });

    await handleSetCommand(
      305,
      {
        simple: false,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(305, tempDir)).plan;
    expect(updatedPlan.simple).toBeUndefined();
  });

  test('should change epic value', async () => {
    const planPath = await createTestPlan(303, { epic: false });

    // First set to true
    await handleSetCommand(
      303,
      {
        epic: true,
      },
      globalOpts
    );

    let updatedPlan = (await resolvePlanByNumericId(303, tempDir)).plan;
    expect(updatedPlan.epic).toBe(true);

    // Then set back to false explicitly
    await handleSetCommand(
      303,
      {
        epic: false,
      },
      globalOpts
    );

    updatedPlan = (await resolvePlanByNumericId(303, tempDir)).plan;
    expect(updatedPlan.epic).toBeFalsy();
  });

  test('should preserve dependencies when adding dependsOn', async () => {
    await createTestPlan(400);
    const planPath = await createTestPlan(401);

    await handleSetCommand(
      401,
      {
        dependsOn: [400],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(401, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([400]);
  });

  test('should preserve discoveredFrom when setting it', async () => {
    await createTestPlan(410);
    const planPath = await createTestPlan(411);

    await handleSetCommand(
      411,
      {
        discoveredFrom: 410,
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(411, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBe(410);
  });

  test('should preserve remaining dependencies when removing one', async () => {
    await createTestPlan(420);
    await createTestPlan(421);
    const planPath = await createTestPlan(422);

    // Add two dependencies
    await handleSetCommand(
      422,
      {
        dependsOn: [420, 421],
      },
      globalOpts
    );

    // Remove one dependency
    await handleSetCommand(
      422,
      {
        noDependsOn: [420],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(422, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([421]);
  });

  test('should remove parent without leaving the child attached', async () => {
    await createTestPlan(430);
    const childPlanPath = await createTestPlan(431);

    // Set parent
    await handleSetCommand(
      431,
      {
        parent: 430,
      },
      globalOpts
    );

    let updatedChild = (await resolvePlanByNumericId(431, tempDir)).plan;
    expect(updatedChild.parent).toBe(430);

    // Remove parent
    await handleSetCommand(
      431,
      {
        noParent: true,
      },
      globalOpts
    );

    updatedChild = (await resolvePlanByNumericId(431, tempDir)).plan;
    expect(updatedChild.parent).toBeUndefined();
  });

  test('should remove discoveredFrom cleanly', async () => {
    await createTestPlan(440);
    const planPath = await createTestPlan(441);

    // Set discoveredFrom
    await handleSetCommand(
      441,
      {
        discoveredFrom: 440,
      },
      globalOpts
    );

    let updatedPlan = (await resolvePlanByNumericId(441, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBe(440);

    // Remove discoveredFrom
    await handleSetCommand(
      441,
      {
        noDiscoveredFrom: true,
      },
      globalOpts
    );

    updatedPlan = (await resolvePlanByNumericId(441, tempDir)).plan;
    expect(updatedPlan.discoveredFrom).toBeUndefined();
  });

  test('should preserve existing UUID when adding a dependency', async () => {
    const existingUuid = crypto.randomUUID();
    await createTestPlan(450, { uuid: existingUuid });
    const planPath = await createTestPlan(451);

    await handleSetCommand(
      451,
      {
        dependsOn: [450],
      },
      globalOpts
    );

    const updatedPlan = (await resolvePlanByNumericId(451, tempDir)).plan;
    expect(updatedPlan.dependencies).toEqual([450]);

    // The dependency plan's UUID should not have changed
    const depPlan = (await resolvePlanByNumericId(450, tempDir)).plan;
    expect(depPlan.uuid).toBe(existingUuid);
  });

  describe('base field options', () => {
    test('--base-branch sets baseBranch on the plan', async () => {
      const planPath = await createTestPlan(500);

      await handleSetCommand(
        500,
        {
          baseBranch: 'feature/parent-branch',
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(500, tempDir)).plan;
      expect(updatedPlan.baseBranch).toBe('feature/parent-branch');
    });

    test("--base-branch matching plan's own branch throws error", async () => {
      const planPath = await createTestPlan(512, {
        branch: 'feature/self-branch',
      });

      await expect(
        handleSetCommand(
          512,
          {
            baseBranch: 'feature/self-branch',
          },
          globalOpts
        )
      ).rejects.toThrow(
        `Base branch "feature/self-branch" is the same as the plan's own branch. A plan cannot use its own branch as its base.`
      );
    });

    test("--base-branch matching plan's generated branch name throws error", async () => {
      // Plan 513 has no explicit branch, so generateBranchNameFromPlan derives "513-test-plan-513"
      const planPath = await createTestPlan(513);

      await expect(
        handleSetCommand(
          513,
          {
            baseBranch: '513-test-plan-513',
          },
          globalOpts
        )
      ).rejects.toThrow(
        `Base branch "513-test-plan-513" is the same as the plan's own branch. A plan cannot use its own branch as its base.`
      );
    });

    test('--no-base-branch clears baseBranch, baseCommit, and baseChangeId (cascade)', async () => {
      const planPath = await createTestPlan(501, {
        baseBranch: 'feature/parent-branch',
        baseCommit: 'abc123def456',
        baseChangeId: 'zyxwvu987654',
      });

      await handleSetCommand(
        501,
        {
          noBaseBranch: true,
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(501, tempDir)).plan;
      expect(updatedPlan.baseBranch).toBeUndefined();
      expect(updatedPlan.baseCommit).toBeUndefined();
      expect(updatedPlan.baseChangeId).toBeUndefined();
    });

    test('--no-base-branch logs message when no baseBranch to remove', async () => {
      const planPath = await createTestPlan(502);

      await handleSetCommand(
        502,
        {
          noBaseBranch: true,
        },
        globalOpts
      );

      const logs = logSpy.mock.calls.map((args) => args[0]);
      expect(logs.some((msg) => msg === 'No baseBranch to remove')).toBe(true);

      // Plan should be unchanged
      const plan = (await resolvePlanByNumericId(502, tempDir)).plan;
      expect(plan.baseBranch).toBeUndefined();
    });

    test('--no-base-branch clears all fields even if only some are set', async () => {
      // Only baseCommit set, no baseBranch
      const planPath = await createTestPlan(503, {
        baseCommit: 'abc123def456',
      });

      await handleSetCommand(
        503,
        {
          noBaseBranch: true,
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(503, tempDir)).plan;
      expect(updatedPlan.baseCommit).toBeUndefined();
      expect(updatedPlan.baseChangeId).toBeUndefined();
    });

    test('--base-commit sets baseCommit on the plan', async () => {
      const planPath = await createTestPlan(504);

      await handleSetCommand(
        504,
        {
          baseCommit: 'deadbeef1234567890',
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(504, tempDir)).plan;
      expect(updatedPlan.baseCommit).toBe('deadbeef1234567890');
    });

    test('--no-base-commit clears only baseCommit, preserving other base fields', async () => {
      const planPath = await createTestPlan(505, {
        baseBranch: 'feature/parent-branch',
        baseCommit: 'abc123def456',
        baseChangeId: 'zyxwvu987654',
      });

      await handleSetCommand(
        505,
        {
          noBaseCommit: true,
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(505, tempDir)).plan;
      expect(updatedPlan.baseCommit).toBeUndefined();
      expect(updatedPlan.baseBranch).toBe('feature/parent-branch');
      expect(updatedPlan.baseChangeId).toBe('zyxwvu987654');
    });

    test('--no-base-commit logs message when no baseCommit to remove', async () => {
      const planPath = await createTestPlan(506);

      await handleSetCommand(
        506,
        {
          noBaseCommit: true,
        },
        globalOpts
      );

      const logs = logSpy.mock.calls.map((args) => args[0]);
      expect(logs.some((msg) => msg === 'No baseCommit to remove')).toBe(true);
    });

    test('--base-change-id sets baseChangeId on the plan', async () => {
      const planPath = await createTestPlan(507);

      await handleSetCommand(
        507,
        {
          baseChangeId: 'qrstuvwxyz1234567890',
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(507, tempDir)).plan;
      expect(updatedPlan.baseChangeId).toBe('qrstuvwxyz1234567890');
    });

    test('--no-base-change-id clears only baseChangeId, preserving other base fields', async () => {
      const planPath = await createTestPlan(508, {
        baseBranch: 'feature/parent-branch',
        baseCommit: 'abc123def456',
        baseChangeId: 'zyxwvu987654',
      });

      await handleSetCommand(
        508,
        {
          noBaseChangeId: true,
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(508, tempDir)).plan;
      expect(updatedPlan.baseChangeId).toBeUndefined();
      expect(updatedPlan.baseBranch).toBe('feature/parent-branch');
      expect(updatedPlan.baseCommit).toBe('abc123def456');
    });

    test('--no-base-change-id logs message when no baseChangeId to remove', async () => {
      const planPath = await createTestPlan(509);

      await handleSetCommand(
        509,
        {
          noBaseChangeId: true,
        },
        globalOpts
      );

      const logs = logSpy.mock.calls.map((args) => args[0]);
      expect(logs.some((msg) => msg === 'No baseChangeId to remove')).toBe(true);
    });

    test('can set all base fields at once', async () => {
      const planPath = await createTestPlan(510);

      await handleSetCommand(
        510,
        {
          baseBranch: 'feature/parent-branch',
          baseCommit: 'abc123def456',
          baseChangeId: 'zyxwvu987654',
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(510, tempDir)).plan;
      expect(updatedPlan.baseBranch).toBe('feature/parent-branch');
      expect(updatedPlan.baseCommit).toBe('abc123def456');
      expect(updatedPlan.baseChangeId).toBe('zyxwvu987654');
    });

    test('changing baseBranch clears stale baseCommit and baseChangeId', async () => {
      const planPath = await createTestPlan(511, {
        baseBranch: 'old-branch',
        baseCommit: 'abc123def456',
        baseChangeId: 'zyxwvu987654',
      });

      await handleSetCommand(
        511,
        {
          baseBranch: 'new-branch',
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(511, tempDir)).plan;
      expect(updatedPlan.baseBranch).toBe('new-branch');
      // baseCommit and baseChangeId should be cleared since they refer to old branch
      expect(updatedPlan.baseCommit).toBeUndefined();
      expect(updatedPlan.baseChangeId).toBeUndefined();
    });

    test('setting baseBranch to same value preserves baseCommit and baseChangeId', async () => {
      const planPath = await createTestPlan(512, {
        baseBranch: 'same-branch',
        baseCommit: 'abc123def456',
        baseChangeId: 'zyxwvu987654',
      });

      await handleSetCommand(
        512,
        {
          baseBranch: 'same-branch',
        },
        globalOpts
      );

      const updatedPlan = (await resolvePlanByNumericId(512, tempDir)).plan;
      expect(updatedPlan.baseBranch).toBe('same-branch');
      expect(updatedPlan.baseCommit).toBe('abc123def456');
      expect(updatedPlan.baseChangeId).toBe('zyxwvu987654');
    });
  });
});
