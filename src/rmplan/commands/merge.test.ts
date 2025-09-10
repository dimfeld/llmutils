import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleMergeCommand } from './merge.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('rmplan merge', () => {
  let testDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'rmplan-merge-test-'));
    tasksDir = testDir; // Use testDir as tasksDir for simplicity

    // Clear plan cache
    clearPlanCache();

    // Mock modules
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await rm(testDir, { recursive: true, force: true });
  });

  afterAll(() => {
    moduleMocker.clear();
  });

  test('merges all direct children by default', async () => {
    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      details: 'Parent details',
      container: true,
      tasks: [
        {
          title: 'Parent task 1',
          description: 'Parent task 1 description',
        },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    // Create dependency placeholder plans to validate dependency carry-over
    await writePlanFile(join(testDir, '10-dep.plan.md'), { id: 10, title: 'Dep 10', tasks: [] });
    await writePlanFile(join(testDir, '11-dep.plan.md'), { id: 11, title: 'Dep 11', tasks: [] });
    await writePlanFile(join(testDir, '12-dep.plan.md'), { id: 12, title: 'Dep 12', tasks: [] });

    // Create child plans
    const child1: PlanSchema = {
      id: 2,
      goal: 'Child 1 goal',
      title: 'Child 1',
      details: 'Child 1 details',
      parent: 1,
      tasks: [
        {
          title: 'Child 1 task',
          description: 'Child 1 task description',
        },
      ],
      dependencies: [10, 11],
    };
    await writePlanFile(join(testDir, '2-child1.plan.md'), child1);

    const child2: PlanSchema = {
      id: 3,
      goal: 'Child 2 goal',
      title: 'Child 2',
      details: 'Child 2 details',
      parent: 1,
      tasks: [
        {
          title: 'Child 2 task',
          description: 'Child 2 task description',
        },
      ],
      dependencies: [11, 12],
    };
    await writePlanFile(join(testDir, '3-child2.plan.md'), child2);

    // Create a grandchild that should have its parent updated
    const grandchild: PlanSchema = {
      id: 4,
      goal: 'Grandchild goal',
      title: 'Grandchild',
      parent: 2, // Child 1 is its parent
      tasks: [],
    };
    const grandchildFile = join(testDir, '4-grandchild.plan.md');
    await writePlanFile(grandchildFile, grandchild);

    // Mock command structure
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute merge
    await handleMergeCommand(parentFile, {}, command);

    // Verify parent plan was updated
    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks).toHaveLength(3);
    expect(updatedParent.tasks?.[0].title).toBe('Parent task 1');
    expect(updatedParent.tasks?.[1].title).toBe('Child 1 task');
    expect(updatedParent.tasks?.[2].title).toBe('Child 2 task');

    // Check details were merged
    expect(updatedParent.details).toContain('Parent details');
    expect(updatedParent.details).toContain('Child 1');
    expect(updatedParent.details).toContain('Child 1 details');
    expect(updatedParent.details).toContain('Child 2');
    expect(updatedParent.details).toContain('Child 2 details');

    // Check dependencies were merged (10, 11, 12 with duplicates removed)
    expect(updatedParent.dependencies).toEqual([10, 11, 12]);
    // Container flag should be cleared after merge
    expect(updatedParent.container).toBe(false);

    // Verify grandchild's parent was updated
    const updatedGrandchild = await readPlanFile(grandchildFile);
    expect(updatedGrandchild.parent).toBe(1);

    // Verify child files were deleted
    const child1Exists = await Bun.file(join(testDir, '2-child1.plan.md')).exists();
    const child2Exists = await Bun.file(join(testDir, '3-child2.plan.md')).exists();
    expect(child1Exists).toBe(false);
    expect(child2Exists).toBe(false);
  });

  test('merges specific children when provided', async () => {
    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      tasks: [],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    // Create child plans
    const child1: PlanSchema = {
      id: 2,
      goal: 'Child 1 goal',
      title: 'Child 1',
      parent: 1,
      tasks: [
        {
          title: 'Child 1 task',
          description: 'Child 1 task description',
        },
      ],
    };
    await writePlanFile(join(testDir, '2-child1.plan.md'), child1);

    const child2: PlanSchema = {
      id: 3,
      goal: 'Child 2 goal',
      title: 'Child 2',
      parent: 1,
      tasks: [
        {
          title: 'Child 2 task',
          description: 'Child 2 task description',
        },
      ],
    };
    const child2File = join(testDir, '3-child2.plan.md');
    await writePlanFile(child2File, child2);

    // Mock command structure
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute merge with only child 1
    await handleMergeCommand(parentFile, { children: ['2'] }, command);

    // Verify parent plan was updated
    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks).toHaveLength(1);
    expect(updatedParent.tasks?.[0].title).toBe('Child 1 task');

    // Verify only child 1 was deleted
    const child1Exists = await Bun.file(join(testDir, '2-child1.plan.md')).exists();
    const child2Exists = await Bun.file(child2File).exists();
    expect(child1Exists).toBe(false);
    expect(child2Exists).toBe(true);
  });

  test('handles plan with no children gracefully', async () => {
    // Create parent plan with no children
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      tasks: [],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    // Mock command structure
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute merge - should handle gracefully
    await handleMergeCommand(parentFile, {}, command);

    // Verify parent plan was not modified
    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks).toHaveLength(0);
  });

  test('does not add parent plan ID to its own dependencies', async () => {
    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      tasks: [],
      dependencies: [5],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    // Create a real plan that the child depends on, so it remains after merge
    await writePlanFile(join(testDir, '6-dep.plan.md'), { id: 6, title: 'Dep 6', tasks: [] });

    // Create child with dependency on parent (circular - should be filtered)
    const child: PlanSchema = {
      id: 2,
      goal: 'Child goal',
      title: 'Child',
      parent: 1,
      tasks: [],
      dependencies: [1, 6], // Includes parent ID
    };
    await writePlanFile(join(testDir, '2-child.plan.md'), child);

    // Mock command structure
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute merge
    await handleMergeCommand(parentFile, {}, command);

    // Verify parent doesn't have itself as dependency
    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.dependencies).toEqual([5, 6]);
    expect(updatedParent.dependencies).not.toContain(1);
  });

  test('removes dependencies pointing to merged child plans and keeps only existing deps', async () => {
    // Create a main parent plan that already depends on its children (typical parent/child linkage)
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      tasks: [],
      dependencies: [2, 3, 99], // 2 and 3 are children, 99 is some unrelated existing dep
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    // Create an existing plan that children depend on (should be retained)
    const external: PlanSchema = {
      id: 6,
      title: 'External',
      tasks: [],
    };
    await writePlanFile(join(testDir, '6-external.plan.md'), external);

    // Create another plan that depends on the children; these dependencies should be pruned
    const other: PlanSchema = {
      id: 5,
      title: 'Other',
      tasks: [],
      dependencies: [2, 3, 6],
    };
    const otherFile = join(testDir, '5-other.plan.md');
    await writePlanFile(otherFile, other);

    // Create child plans. child1 also depends on its sibling (3) which should NOT be added to the parent
    const child1: PlanSchema = {
      id: 2,
      title: 'Child 1',
      parent: 1,
      tasks: [],
      dependencies: [3],
    };
    await writePlanFile(join(testDir, '2-child1.plan.md'), child1);

    const child2: PlanSchema = {
      id: 3,
      title: 'Child 2',
      parent: 1,
      tasks: [],
      dependencies: [6], // valid existing plan
    };
    await writePlanFile(join(testDir, '3-child2.plan.md'), child2);

    // Mock command structure
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute merge
    await handleMergeCommand(parentFile, {}, command);

    // Verify parent dependencies: should remove 2 and 3, keep 99, add 6 (from children)
    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.dependencies).toEqual([6, 99]);

    // Verify other plan had dangling deps on 2 and 3 removed, 6 remains
    const updatedOther = await readPlanFile(otherFile);
    expect(updatedOther.dependencies).toEqual([6]);
  });
});
