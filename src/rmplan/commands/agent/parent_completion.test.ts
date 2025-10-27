import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { markTaskDone, markStepDone } from '../../plans/mark_done.js';
import { checkAndMarkParentDone as agentCheckAndMarkParentDone } from './parent_plans.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../../plans.js';
import type { PlanSchema, PlanSchemaInput } from '../../planSchema.js';
import type { RmplanConfig } from '../../configSchema.js';
import { ModuleMocker } from '../../../testing.js';

describe('Parent Plan Completion', () => {
  let tempDir: string;
  let tasksDir: string;
  let config: RmplanConfig;
  const moduleMocker = new ModuleMocker(import.meta);
  const removeAssignmentSpy = mock(async () => true);
  const getRepositoryIdentitySpy = mock(async () => ({
    repositoryId: 'test-repo',
    remoteUrl: null,
    gitRoot: '',
  }));

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-parent-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

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

    await moduleMocker.mock('../../assignments/assignments_io.js', () => ({
      removeAssignment: removeAssignmentSpy,
    }));

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: getRepositoryIdentitySpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks parent plan as done when all children complete', async () => {
    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      container: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writePlanFile(parentPath, parentPlan);

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
    await writePlanFile(child1Path, child1);

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
    await writePlanFile(child2Path, child2);

    // Mark child 1 task as done (simple task without steps)
    await markTaskDone(child1Path, 0, { commit: false }, tempDir, config);

    // Parent should still be in_progress
    let parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('in_progress');

    // Mark child 2 steps as done
    await markStepDone(child2Path, { steps: 2 }, { taskIndex: 0, stepIndex: 0 }, tempDir, config);

    // Parent should now be done
    parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('done');
    expect(parent.changedFiles).toContain('file1.ts');
    expect(parent.changedFiles).toContain('file2.ts');
    expect(parent.changedFiles).toContain('file3.ts');
  });

  test('removes parent assignment when agent check completes container plan', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      container: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, 'parent.yaml');
    await writePlanFile(parentPath, parentPlan);

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
    await writePlanFile(childPath, childPlan);

    removeAssignmentSpy.mockClear();

    await agentCheckAndMarkParentDone(1, config, tempDir);

    const parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('done');

    const removalUuids = removeAssignmentSpy.mock.calls.map(([args]) => args.uuid);
    expect(removalUuids).toContain(parent.uuid);
  });

  test('does not mark non-container parent as done even when children complete', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      tasks: [],
      container: false,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writePlanFile(parentPath, parentPlan);

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
    await writePlanFile(childPath, childPlan);

    await markTaskDone(childPath, 0, { commit: false }, tempDir, config);

    const parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('in_progress');
  });

  test('handles nested parent completion', async () => {
    // Create grandparent plan
    const grandparentPlan: PlanSchema = {
      id: 1,
      title: 'Grandparent Plan',
      goal: 'Grandparent goal',
      details: 'Grandparent details',
      status: 'in_progress',
      tasks: [],
      container: true,
      updatedAt: new Date().toISOString(),
    };
    const grandparentPath = path.join(tasksDir, '1.yaml');
    await writePlanFile(grandparentPath, grandparentPlan);

    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 2,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      parent: 1,
      tasks: [],
      container: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '2.yaml');
    await writePlanFile(parentPath, parentPlan);

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
    await writePlanFile(childPath, childPlan);

    // Mark child task as done
    await markTaskDone(childPath, 0, { commit: false }, tempDir, config);

    // Both parent and grandparent should be done
    const parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('done');

    const grandparent = await readPlanFile(grandparentPath);
    expect(grandparent.status).toBe('done');
    expect(grandparent.changedFiles).toContain('file1.ts');
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
      container: true,
      updatedAt: new Date().toISOString(),
    };
    const parentPath = path.join(tasksDir, '1.yaml');
    await writePlanFile(parentPath, parentPlan);

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
    await writePlanFile(child1Path, child1);

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
    await writePlanFile(child2Path, child2);

    // Mark only child 1 as done
    await markTaskDone(child1Path, 0, { commit: false }, tempDir, config);

    // Parent should still be in_progress
    const parent = await readPlanFile(parentPath);
    expect(parent.status).toBe('in_progress');
  });
});
