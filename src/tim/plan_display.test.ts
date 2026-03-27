import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'yaml';

import type { PlanSchema } from './planSchema.js';
import { buildPlanContext, formatExistingTasks, resolvePlan } from './plan_display.js';
import { clearConfigCache } from './configLoader.js';
import { getMaterializedPlanPath } from './plan_materialize.js';
import { readPlanFile, writePlanFile } from './plans.js';

function createPlan(overrides: Partial<PlanSchema> & { id: PlanSchema['id'] }): PlanSchema {
  return {
    id: overrides.id,
    title: overrides.title ?? `Plan ${overrides.id}`,
    goal: overrides.goal,
    details: overrides.details,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    dependencies: overrides.dependencies ?? [],
    tasks: overrides.tasks ?? [
      {
        title: 'Default task',
        description: 'Complete the initial work',
        done: false,
      },
    ],
    parent: overrides.parent,
    assignedTo: overrides.assignedTo,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    uuid: overrides.uuid,
    epic: overrides.epic,
    temp: overrides.temp,
    discoveredFrom: overrides.discoveredFrom,
    issue: overrides.issue,
    pullRequest: overrides.pullRequest,
    docs: overrides.docs,
    planGeneratedAt: overrides.planGeneratedAt,
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

  it('summarizes tasks', () => {
    const plan = createPlan({
      id: 1,
      tasks: [
        {
          title: 'Initial setup',
          description: 'Prepare repository',
          done: false,
        },
        {
          title: '',
          description: 'Write feature',
          done: false,
        },
      ],
    });

    const summary = formatExistingTasks(plan);
    expect(summary).toContain('### Existing Tasks');
    expect(summary).toContain('- Initial setup');
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

    const context = buildPlanContext(
      plan,
      planPath,
      { gitRoot },
      {
        includeGoal: false,
        includeIssues: false,
        includeDocs: false,
        includeTasks: false,
        includeDetails: false,
      }
    );
    expect(context).not.toContain('Goal:');
    expect(context).not.toContain('Linked issues:');
    expect(context).not.toContain('Documentation references:');
    expect(context).not.toContain('### Existing Tasks');
    expect(context).not.toContain('Details:');
  });

  it('falls back to the plan ID when no path is available', () => {
    const plan = createPlan({
      id: 125,
      goal: 'Fallback goal',
      details: 'Fallback details',
    });

    const context = buildPlanContext(plan, null, { gitRoot: '/repo' });
    expect(context).toContain('Plan file: Plan 125');
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
    await writePlanFile(
      planPath,
      {
        id: 1,
        title: 'Sample plan',
        status: 'pending',
        priority: 'medium',
        tasks: [
          {
            title: 'Prepare environment',
            description: 'Set up tooling',
            done: false,
          },
        ],
      },
      { skipUpdatedAt: true, cwdForIdentity: tempDir }
    );

    const { plan, planPath: resolvedPath } = await resolvePlan(planPath, {
      gitRoot: tempDir,
    });

    expect(resolvedPath).toBe(planPath);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Sample plan');
    expect(plan.tasks).toHaveLength(1);
  });

  it('resolves plans by numeric ID using configuration paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'plan-display-config-test-'));
    temporaryDirectories.push(tempDir);
    const tasksDir = join(tempDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });
    const planPath = join(tasksDir, '0300.plan.md');
    await writePlanFile(
      planPath,
      {
        id: 300,
        title: 'Configured plan',
        status: 'pending',
        priority: 'medium',
        tasks: [
          {
            title: 'Verify config loading',
            description: 'Ensure resolvePlan finds plans by ID',
            done: false,
          },
        ],
      },
      { skipUpdatedAt: true, cwdForIdentity: tasksDir }
    );

    const configPath = join(tempDir, 'tim.yml');
    const configData = {
      paths: {
        tasks: tasksDir,
      },
    };
    await writeFile(configPath, yaml.stringify(configData), 'utf8');

    clearConfigCache();
    const { plan, planPath: resolvedPath } = await resolvePlan('300', {
      gitRoot: tasksDir,
      configPath,
    });

    expect(resolvedPath).toBe(planPath);
    expect(plan.id).toBe(300);
    expect(plan.title).toBe('Configured plan');
  });

  it('resolves plans by UUID and returns the existing materialized path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'plan-display-uuid-test-'));
    temporaryDirectories.push(tempDir);
    const sourcePath = join(tempDir, '301.plan.md');
    const materializedPath = getMaterializedPlanPath(tempDir, 301);

    await writePlanFile(
      sourcePath,
      {
        id: 301,
        uuid: '30130130-1111-4111-8111-111111111111',
        title: 'UUID-resolved plan',
        status: 'pending',
        priority: 'medium',
        details: 'Resolve from DB by UUID.',
        tasks: [
          {
            title: 'Check UUID lookup',
            description: 'Ensure resolvePlan uses DB records',
            done: false,
          },
        ],
      },
      { skipUpdatedAt: true, cwdForIdentity: tempDir }
    );

    await writePlanFile(materializedPath, await readPlanFile(sourcePath), {
      skipDb: true,
      skipUpdatedAt: true,
    });

    const { plan, planPath } = await resolvePlan('30130130-1111-4111-8111-111111111111', {
      gitRoot: tempDir,
    });

    expect(plan.id).toBe(301);
    expect(plan.title).toBe('UUID-resolved plan');
    expect(planPath).toBe(materializedPath);
  });
});
