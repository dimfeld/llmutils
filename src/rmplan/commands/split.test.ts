import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import yaml from 'yaml';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';
import { handleSplitCommand, parseTaskSpecifier } from './split.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('rmplan split - manual', () => {
  let testDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'rmplan-split-test-'));
    tasksDir = testDir;

    clearPlanCache();

    // Mock config and environment
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({ paths: { tasks: tasksDir } }),
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

  test('parseTaskSpecifier parses ranges and lists', () => {
    expect(parseTaskSpecifier('1-3,5', 10)).toEqual([0, 1, 2, 4]);
    expect(parseTaskSpecifier('3', 5)).toEqual([2]);
    expect(parseTaskSpecifier('2-2', 3)).toEqual([1]);
    expect(parseTaskSpecifier('5-3', 6)).toEqual([2, 3, 4]);
  });

  test('manual split of single task uses task title and description', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      details: 'Parent details',
      tasks: [
        { title: 'Task 1', description: 'Description 1' },
        { title: 'Task 2', description: 'Description 2' },
        { title: 'Task 3', description: 'Description 3' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;

    await handleSplitCommand(parentFile, { tasks: '2' }, command);

    // Parent updated
    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks.map((t) => t.title)).toEqual(['Task 1', 'Task 3']);
    expect(updatedParent.dependencies).toEqual([2]);
    expect(updatedParent.container).toBeFalsy();

    // Child created with id 2
    const childFile = join(testDir, '2-task-2.plan.md');
    const child = await readPlanFile(childFile);
    expect(child.id).toBe(2);
    expect(child.parent).toBe(1);
    expect(child.tasks?.length).toBe(0);
    expect(child.title).toBe('Task 2');
    expect(child.details).toContain('Description 2');
  });

  test('manual split of multiple tasks combines details and generates title via LLM', async () => {
    // Mock ai.generateText to avoid real network
    await moduleMocker.mock('ai', () => ({
      generateText: mock(async () => ({ text: 'Combined Child Title' })),
    }));

    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      tasks: [
        { title: 'Init', description: 'Set up base' },
        { title: 'Feature', description: 'Implement feature' },
        { title: 'Docs', description: 'Write docs' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleSplitCommand(parentFile, { tasks: '1-2' }, command);

    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks.map((t) => t.title)).toEqual(['Docs']);
    expect(updatedParent.dependencies).toEqual([2]);

    const childFile = join(testDir, '2-combined-child-title.plan.md');
    const child = await readPlanFile(childFile);
    expect(child.id).toBe(2);
    expect(child.title).toBe('Combined Child Title');
    expect(child.details).toContain('## Init');
    expect(child.details).toContain('Set up base');
    expect(child.details).toContain('## Feature');
    expect(child.details).toContain('Implement feature');
  });
});

