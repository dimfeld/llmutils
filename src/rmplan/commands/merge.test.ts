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
      tasks: [
        {
          title: 'Parent task 1',
          description: 'Parent task 1 description',
        },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

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
});
