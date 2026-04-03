import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { markTaskDone, markStepDone } from '../../plans/mark_done.js';
import { checkAndMarkParentDone as agentCheckAndMarkParentDone } from './parent_plans.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile } from '../../plans.js';
import type { PlanSchema, PlanSchemaInput } from '../../planSchema.js';
import type { TimConfig } from '../../configSchema.js';
import { closeDatabaseForTesting } from '../../db/database.js';
import { clearPlanSyncContext } from '../../db/plan_sync.js';

const { removeAssignmentSpy, getRepositoryIdentitySpy } = vi.hoisted(() => ({
  removeAssignmentSpy: vi.fn(() => true),
  getRepositoryIdentitySpy: vi.fn(async () => ({
    repositoryId: 'test-repo',
    remoteUrl: null,
    gitRoot: '',
  })),
}));

vi.mock('../../db/assignment.js', () => ({
  removeAssignment: removeAssignmentSpy,
}));

vi.mock('../../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: getRepositoryIdentitySpy,
}));

describe('Parent Plan Completion', () => {
  let tempDir: string;
  let tasksDir: string;
  let config: TimConfig;
  let originalEnv: Partial<Record<string, string>>;
  let originalCwd: string;

  async function writeDbBackedPlan(planPath: string, plan: PlanSchema | PlanSchemaInput) {
    await writePlanFile(planPath, plan, {
      cwdForIdentity: tempDir,
    });
  }

  async function readDbPlan(planId: number): Promise<PlanSchema> {
    return (await resolvePlanFromDb(planId, tempDir)).plan;
  }

  beforeEach(async () => {
    // Clear plan cache
    clearPlanSyncContext();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-parent-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/agent-test.git`.cwd(tempDir).quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
    originalCwd = process.cwd();
    process.chdir(tempDir);

    config = {
      paths: {
        tasks: tasksDir,
      },
    };

    removeAssignmentSpy.mockClear();
    getRepositoryIdentitySpy.mockClear();
    getRepositoryIdentitySpy.mockResolvedValue({
      repositoryId: 'test-repo',
      remoteUrl: null,
      gitRoot: tempDir,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearPlanSyncContext();
    closeDatabaseForTesting();
    process.chdir(originalCwd);
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks parent plan as needs_review when all children complete', async () => {
    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    // Create child plans
    const child1: PlanSchemaInput = {
      id: 2,
      title: 'Child Plan 1',
      goal: 'Child 1 goal',
      details: 'Child 1 details',
      status: 'in_progress',
      parent: 1,
      tasks: [
        {
          title: 'Child 1 Task',
          description: 'Task description',
          files: [],
        },
      ],
      changedFiles: ['file1.ts', 'file2.ts'],
      updatedAt: new Date().toISOString(),
    };
    const child1Path = path.join(tasksDir, '2.yaml');
    await writeDbBackedPlan(child1Path, child1);

    const child2: PlanSchemaInput = {
      id: 3,
      title: 'Child Plan 2',
      goal: 'Child 2 goal',
      details: 'Child 2 details',
      status: 'in_progress',
      parent: 1,
      tasks: [
        {
          title: 'Child 2 Task',
          description: 'Task description',
          files: [],
          steps: [
            { prompt: 'Step 1', done: false },
            { prompt: 'Step 2', done: false },
          ],
        },
      ],
      changedFiles: ['file3.ts'],
      updatedAt: new Date().toISOString(),
    };
    const child2Path = path.join(tasksDir, '3.yaml');
    await writeDbBackedPlan(child2Path, child2);

    // Mark child 1 task as done (simple task without steps)
    await markTaskDone(child1Path, 0, { commit: false }, tempDir, config);

    // Parent should still be in_progress
    let parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('in_progress');

    // Mark child 2 steps as done
    await markStepDone(child2Path, { steps: 2 }, { taskIndex: 0, stepIndex: 0 }, tempDir, config);

    // Parent should now be needs_review
    parent = await readDbPlan(1);
    expect(parent.status).toBe('needs_review');
    expect(parent.changedFiles).toContain('file1.ts');
    expect(parent.changedFiles).toContain('file2.ts');
    expect(parent.changedFiles).toContain('file3.ts');
  });

  test('keeps parent assignment when agent check completes epic plan into needs_review', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, 'parent.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    const childPlan: PlanSchemaInput = {
      id: 2,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'done',
      parent: 1,
      tasks: [
        {
          title: 'Child Task',
          description: 'Task description',
          files: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const childPath = path.join(tasksDir, 'child.yaml');
    await writeDbBackedPlan(childPath, childPlan);

    removeAssignmentSpy.mockClear();

    await agentCheckAndMarkParentDone(1, config, tempDir);

    const parent = await readDbPlan(1);
    expect(parent.status).toBe('needs_review');
    expect(removeAssignmentSpy).not.toHaveBeenCalled();
  });

  test('agent check treats cancelled children as complete for parent completion', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, 'parent-cancelled.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    const doneChild: PlanSchemaInput = {
      id: 2,
      title: 'Done Child',
      goal: 'Done child goal',
      details: 'Done child details',
      status: 'done',
      parent: 1,
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
    await writeDbBackedPlan(path.join(tasksDir, 'done-child.yaml'), doneChild);

    const cancelledChild: PlanSchemaInput = {
      id: 3,
      title: 'Cancelled Child',
      goal: 'Cancelled child goal',
      details: 'Cancelled child details',
      status: 'cancelled',
      parent: 1,
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
    await writeDbBackedPlan(path.join(tasksDir, 'cancelled-child.yaml'), cancelledChild);

    removeAssignmentSpy.mockClear();

    await agentCheckAndMarkParentDone(1, config, tempDir);

    const parent = await readDbPlan(1);
    expect(parent.status).toBe('needs_review');
    expect(removeAssignmentSpy).not.toHaveBeenCalled();
  });

  test('agent check keeps cancelled parent cancelled when all children are complete', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Cancelled Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'cancelled',
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, 'cancelled-parent.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    const doneChild: PlanSchemaInput = {
      id: 2,
      title: 'Done Child',
      goal: 'Done child goal',
      details: 'Done child details',
      status: 'done',
      parent: 1,
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
    await writeDbBackedPlan(path.join(tasksDir, 'done-child-cancelled-parent.yaml'), doneChild);

    const cancelledChild: PlanSchemaInput = {
      id: 3,
      title: 'Cancelled Child',
      goal: 'Cancelled child goal',
      details: 'Cancelled child details',
      status: 'cancelled',
      parent: 1,
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
    await writeDbBackedPlan(
      path.join(tasksDir, 'cancelled-child-cancelled-parent.yaml'),
      cancelledChild
    );

    removeAssignmentSpy.mockClear();

    await agentCheckAndMarkParentDone(1, config, tempDir);

    const parent = await readDbPlan(1);
    expect(parent.status).toBe('cancelled');
    expect(removeAssignmentSpy).not.toHaveBeenCalled();
  });

  test('does not mark non-epic parent as done even when children complete', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      epic: false,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    const childPlan: PlanSchemaInput = {
      id: 2,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'in_progress',
      parent: 1,
      tasks: [
        {
          title: 'Child Task',
          description: 'Task description',
          files: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const childPath = path.join(tasksDir, '2.yaml');
    await writeDbBackedPlan(childPath, childPlan);

    await markTaskDone(childPath, 0, { commit: false }, tempDir, config);

    const parent = await readDbPlan(1);
    expect(parent.status).toBe('in_progress');
  });

  test('handles nested parent completion into needs_review', async () => {
    // Create grandparent plan
    const grandparentPlan: PlanSchema = {
      id: 1,
      title: 'Grandparent Plan',
      goal: 'Grandparent goal',
      details: 'Grandparent details',
      status: 'in_progress',
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const grandparentPath = path.join(tasksDir, '1.yaml');
    await writeDbBackedPlan(grandparentPath, grandparentPlan);

    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 2,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      parent: 1,
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '2.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    // Create child plan
    const childPlan: PlanSchemaInput = {
      id: 3,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'in_progress',
      parent: 2,
      tasks: [
        {
          title: 'Child Task',
          description: 'Task description',
          files: [],
        },
      ],
      changedFiles: ['file1.ts'],
      updatedAt: new Date().toISOString(),
    };
    const childPath = path.join(tasksDir, '3.yaml');
    await writeDbBackedPlan(childPath, childPlan);

    // Mark child task as done
    await markTaskDone(childPath, 0, { commit: false }, tempDir, config);

    // Both parent and grandparent should be needs_review
    const parent = await readDbPlan(2);
    expect(parent.status).toBe('needs_review');

    const grandparent = await readDbPlan(1);
    expect(grandparent.status).toBe('needs_review');
    expect(grandparent.changedFiles).toContain('file1.ts');
  });

  test('does not mark parent as done if parent has unfinished tasks even when all children are complete', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Parent Task',
          description: 'Unfinished task on the parent',
          files: [],
          done: false,
        },
      ],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    const childPlan: PlanSchemaInput = {
      id: 2,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'in_progress',
      parent: 1,
      tasks: [
        {
          title: 'Child Task',
          description: 'Task description',
          files: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const childPath = path.join(tasksDir, '2.yaml');
    await writeDbBackedPlan(childPath, childPlan);

    // Mark child as done — all children complete, but parent has an unfinished task
    await markTaskDone(childPath, 0, { commit: false }, tempDir, config);

    // Parent should still be in_progress because it has an unfinished task
    const parent = await readDbPlan(1);
    expect(parent.status).toBe('in_progress');
  });

  test('does not mark parent as done if some children are incomplete', async () => {
    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      epic: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writeDbBackedPlan(parentPath, parentPlan);

    // Create two child plans
    const child1: PlanSchemaInput = {
      id: 2,
      title: 'Child Plan 1',
      goal: 'Child 1 goal',
      details: 'Child 1 details',
      status: 'in_progress',
      parent: 1,
      tasks: [
        {
          title: 'Child 1 Task',
          description: 'Task description',
          files: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const child1Path = path.join(tasksDir, '2.yaml');
    await writeDbBackedPlan(child1Path, child1);

    const child2: PlanSchemaInput = {
      id: 3,
      title: 'Child Plan 2',
      goal: 'Child 2 goal',
      details: 'Child 2 details',
      status: 'in_progress',
      parent: 1,
      tasks: [
        {
          title: 'Child 2 Task',
          description: 'Task description',
          files: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    const child2Path = path.join(tasksDir, '3.yaml');
    await writeDbBackedPlan(child2Path, child2);

    // Mark only child 1 as done
    await markTaskDone(child1Path, 0, { commit: false }, tempDir, config);

    // Parent should still be in_progress
    const parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('in_progress');
  });
});
