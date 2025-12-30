import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import yaml from 'yaml';
import { clearPlanCache, getMaxNumericPlanId, readPlanFile, writePlanFile } from '../plans.js';
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

    // Mock generateNumericPlanId to use local-only ID generation (avoids shared storage)
    await moduleMocker.mock('../id_utils.js', () => ({
      generateNumericPlanId: mock(async (dir: string) => {
        const maxId = await getMaxNumericPlanId(dir);
        return maxId + 1;
      }),
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
    // Range exceeding task count should clamp to available tasks
    expect(parseTaskSpecifier('1-5', 3)).toEqual([0, 1, 2]);
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

  test('child plan inherits parent tags during split', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      tags: ['frontend', 'urgent'],
      tasks: [
        { title: 'Task 1', description: 'Description 1' },
        { title: 'Task 2', description: 'Description 2' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;

    await handleSplitCommand(parentFile, { tasks: '1' }, command);

    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tags).toEqual(['frontend', 'urgent']);

    const childFile = join(testDir, '2-task-1.plan.md');
    const child = await readPlanFile(childFile);
    expect(child.tags).toEqual(['frontend', 'urgent']);
  });

  test('split preserves parent progress notes and does not copy to child', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      details: 'Parent details',
      tasks: [
        { title: 'Task 1', description: 'Description 1' },
        { title: 'Task 2', description: 'Description 2' },
      ],
      progressNotes: [
        { timestamp: new Date('2024-01-01T00:00:00Z').toISOString(), text: 'Parent note' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleSplitCommand(parentFile, { tasks: '2' }, command);

    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.progressNotes?.length).toBe(1);
    expect(updatedParent.progressNotes?.[0].text).toBe('Parent note');

    const childFile = join(testDir, '2-task-2.plan.md');
    const child = await readPlanFile(childFile);
    expect(child.progressNotes === undefined || child.progressNotes.length === 0).toBe(true);
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

  test('interactive selection splits chosen tasks', async () => {
    // Mock checkbox to select tasks 1 and 3 (indices 0 and 2)
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(async () => [0, 2]),
    }));
    // Mock ai.generateText for multi-task title generation
    await moduleMocker.mock('ai', () => ({
      generateText: mock(async () => ({ text: 'Interactive Child Title' })),
    }));

    const parentPlan: PlanSchema = {
      id: 1,
      goal: 'Parent goal',
      title: 'Parent Plan',
      tasks: [
        { title: 'One', description: 'Desc one' },
        { title: 'Two', description: 'Desc two' },
        { title: 'Three', description: 'Desc three' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleSplitCommand(parentFile, { select: true }, command);

    const updatedParent = await readPlanFile(parentFile);
    // Remaining should only be the middle task
    expect(updatedParent.tasks.map((t) => t.title)).toEqual(['Two']);
    expect(updatedParent.dependencies).toEqual([2]);

    const childFile = join(testDir, '2-interactive-child-title.plan.md');
    const child = await readPlanFile(childFile);
    expect(child.id).toBe(2);
    expect(child.parent).toBe(1);
    expect(child.title).toBe('Interactive Child Title');
    expect(child.details).toContain('## One');
    expect(child.details).toContain('Desc one');
    expect(child.details).toContain('## Three');
    expect(child.details).toContain('Desc three');
  });

  test('interactive selection with no tasks selected does nothing', async () => {
    // Mock checkbox to return empty selection
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(async () => []),
    }));

    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Goal',
      tasks: [
        { title: 'A', description: 'A1' },
        { title: 'B', description: 'B1' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleSplitCommand(parentFile, { select: true }, command);

    const updatedParent = await readPlanFile(parentFile);
    // Nothing changed
    expect(updatedParent.tasks?.length).toBe(2);
    expect(updatedParent.dependencies).toEqual([]);
  });

  test('interactive selection canceled gracefully', async () => {
    // Mock checkbox to throw (simulate cancel)
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(async () => {
        throw new Error('Canceled');
      }),
    }));

    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Goal',
      tasks: [
        { title: 'A', description: 'A1' },
        { title: 'B', description: 'B1' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleSplitCommand(parentFile, { select: true }, command);

    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks?.length).toBe(2);
    expect(updatedParent.dependencies).toEqual([]);
  });

  test('splitting all tasks sets container flag and removes all tasks', async () => {
    // Mock ai.generateText to avoid network for multi-task split
    await moduleMocker.mock('ai', () => ({
      generateText: mock(async () => ({ text: 'All Tasks Child' })),
    }));

    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Goal',
      tasks: [
        { title: 'A', description: 'A1' },
        { title: 'B', description: 'B1' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await handleSplitCommand(parentFile, { tasks: '1-2' }, command);

    const updatedParent = await readPlanFile(parentFile);
    expect(updatedParent.tasks?.length).toBe(0);
    expect(updatedParent.container).toBe(true);
    expect(updatedParent.dependencies).toEqual([2]);

    const childFile = join(testDir, '2-all-tasks-child.plan.md');
    const child = await readPlanFile(childFile);
    expect(child.parent).toBe(1);
    expect(child.tasks?.length).toBe(0);
    expect(child.details).toContain('## A');
    expect(child.details).toContain('## B');
  });

  test('invalid task specifier throws helpful errors', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Goal',
      tasks: [
        { title: 'A', description: 'A1' },
        { title: 'B', description: 'B1' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;

    await expect(handleSplitCommand(parentFile, { tasks: '' }, command)).rejects.toThrow(
      /Empty task specifier/
    );
    await expect(
      handleSplitCommand(parentFile, { tasks: '0', select: false }, command)
    ).rejects.toThrow(/Task indices must be positive/);
    await expect(handleSplitCommand(parentFile, { tasks: '3' }, command)).rejects.toThrow(
      /Task index 3 out of range/
    );
    await expect(handleSplitCommand(parentFile, { tasks: 'a-b' }, command)).rejects.toThrow(
      /Invalid task specifier segment/
    );
  });

  test('argument validation: mutually exclusive and missing flags', async () => {
    const parentPlan: PlanSchema = {
      id: 1,
      title: 'Parent Plan',
      goal: 'Goal',
      tasks: [
        { title: 'A', description: 'A1' },
        { title: 'B', description: 'B1' },
      ],
    };
    const parentFile = join(testDir, '1-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;

    await expect(
      handleSplitCommand(parentFile, { tasks: '1', select: true }, command)
    ).rejects.toThrow(/mutually exclusive/);

    await expect(handleSplitCommand(parentFile, {}, command)).rejects.toThrow(
      /No mode specified\. Choose one of: --auto \(LLM-based\), --tasks <specifier> \(manual\), or --select \(interactive\)\./
    );
  });

  test('auto mode flows through with mocked LLM pipeline', async () => {
    // Arrange mocks for LLM pipeline and YAML processing
    await moduleMocker.mock('../prompt.js', () => ({
      generateSplitPlanPrompt: mock(() => 'prompt'),
    }));
    await moduleMocker.mock('../../common/model_factory.js', () => ({
      createModel: mock(async () => ({})),
    }));
    await moduleMocker.mock('../llm_utils/run_and_apply.js', () => ({
      runStreamingPrompt: mock(async () => ({ text: '---\nphases: []' })),
    }));
    await moduleMocker.mock('../process_markdown.js', () => ({
      findYamlStart: mock((t: string) => t),
      saveMultiPhaseYaml: mock(async () => 'Saved OK'),
    }));
    await moduleMocker.mock('../fix_yaml.js', () => ({
      fixYaml: mock(async () => ({ phases: [] })),
    }));
    await moduleMocker.mock('../planSchema.js', () => ({
      multiPhasePlanSchema: { safeParse: mock(() => ({ success: true, data: { phases: [] } })) },
    }));

    const parentPlan: PlanSchema = {
      id: 10,
      title: 'Big Plan',
      goal: 'Goal',
      tasks: [{ title: 'A', description: 'A1' }],
    };
    const parentFile = join(testDir, '10-parent.plan.md');
    await writePlanFile(parentFile, parentPlan);

    const command = { parent: { opts: () => ({}) } } as any;
    await expect(handleSplitCommand(parentFile, { auto: true }, command)).resolves.toBeUndefined();
  });
});
