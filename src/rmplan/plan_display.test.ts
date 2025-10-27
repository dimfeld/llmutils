import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { PlanSchema } from './planSchema.js';
import { buildPlanContext, formatExistingTasks, resolvePlan } from './plan_display.js';

function createPlan(overrides: Partial<PlanSchema> & { id: PlanSchema['id'] }): PlanSchema {
  return {
    id: overrides.id,
    title: overrides.title ?? `Plan ${overrides.id}`,
    goal: overrides.goal,
    details: overrides.details,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    dependencies: overrides.dependencies ?? [],
    tasks:
      overrides.tasks ??
      [
        {
          title: 'Default task',
          description: 'Complete the initial work',
          done: false,
          files: [],
          docs: [],
          steps: [],
        },
      ],
    progressNotes: overrides.progressNotes,
    parent: overrides.parent,
    assignedTo: overrides.assignedTo,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    uuid: overrides.uuid,
    generatedBy: overrides.generatedBy,
    statusDescription: overrides.statusDescription,
    container: overrides.container,
    temp: overrides.temp,
    discoveredFrom: overrides.discoveredFrom,
    issue: overrides.issue,
    pullRequest: overrides.pullRequest,
    docs: overrides.docs,
    planGeneratedAt: overrides.planGeneratedAt,
    promptsGeneratedAt: overrides.promptsGeneratedAt,
    project: overrides.project,
    baseBranch: overrides.baseBranch,
    changedFiles: overrides.changedFiles,
    rmfilter: overrides.rmfilter,
  };
}

describe('formatExistingTasks', () => {
  it('returns undefined when there are no tasks or tasks are excluded', () => {
    const plan = createPlan({ id: 1, tasks: [] });
    expect(formatExistingTasks(plan)).toBeUndefined();
    expect(formatExistingTasks(plan, { includeTasks: false })).toBeUndefined();
  });

  it('summarizes tasks with step and file counts', () => {
    const plan = createPlan({
      id: 1,
      tasks: [
        {
          title: 'Initial setup',
          description: 'Prepare repository',
          done: false,
          files: ['src/index.ts'],
          docs: [],
          steps: [{ prompt: 'Clone repo', done: true, examples: [] }],
        },
        {
          title: '',
          description: 'Write feature',
          done: false,
          files: [],
          docs: [],
          steps: [],
        },
      ],
    });

    const summary = formatExistingTasks(plan);
    expect(summary).toContain('### Existing Tasks');
    expect(summary).toContain('- Initial setup (1 step, 1 file)');
    expect(summary).toContain('- Task 2');
  });
});

describe('buildPlanContext', () => {
  it('includes plan metadata and selected sections', () => {
    const gitRoot = '/repo';
    const planPath = '/repo/tasks/123.plan.md';
    const plan = createPlan({
      id: 123,
      title: 'Improve onboarding',
      goal: 'Make onboarding smoother',
      status: 'pending',
      priority: 'high',
      issue: ['https://example.com/issues/1'],
      docs: ['docs/onboarding.md'],
      details: 'Detailed plan information.',
    });

    const context = buildPlanContext(plan, planPath, { gitRoot });
    expect(context).toContain('Plan file: tasks/123.plan.md');
    expect(context).toContain('Plan ID: 123');
    expect(context).toContain('Status: pending');
    expect(context).toContain('Priority: high');
    expect(context).toContain('Title: Improve onboarding');
    expect(context).toContain('Goal:\nMake onboarding smoother');
    expect(context).toContain('Linked issues:\nhttps://example.com/issues/1');
    expect(context).toContain('Documentation references:\ndocs/onboarding.md');
    expect(context).toContain('### Existing Tasks');
    expect(context).toContain('Details:\nDetailed plan information.');
  });

  it('omits optional sections when disabled', () => {
    const gitRoot = '/repo';
    const planPath = '/repo/tasks/124.plan.md';
    const plan = createPlan({
      id: 124,
      goal: 'Hidden goal',
      issue: ['https://example.com/issues/2'],
      docs: ['docs/reference.md'],
      details: 'Confidential details',
    });

    const context = buildPlanContext(plan, planPath, { gitRoot }, { includeGoal: false, includeIssues: false, includeDocs: false, includeTasks: false, includeDetails: false });
    expect(context).not.toContain('Goal:');
    expect(context).not.toContain('Linked issues:');
    expect(context).not.toContain('Documentation references:');
    expect(context).not.toContain('### Existing Tasks');
    expect(context).not.toContain('Details:');
  });
});

describe('resolvePlan', () => {
  const temporaryDirectories: string[] = [];

  afterAll(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('loads the plan and path for an explicit file argument', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'plan-display-test-'));
    temporaryDirectories.push(tempDir);
    const planPath = join(tempDir, '0001.plan.yml');
    const contents = [
      'id: 1',
      'title: Sample plan',
      'status: pending',
      'priority: medium',
      'tasks:',
      '  - title: Prepare environment',
      '    description: Set up tooling',
      '    done: false',
    ].join('\n');
    await writeFile(planPath, contents, 'utf8');

    const { plan, planPath: resolvedPath } = await resolvePlan(planPath, {
      gitRoot: tempDir,
    });

    expect(resolvedPath).toBe(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Sample plan');
    expect(plan.tasks).toHaveLength(1);
  });
});
