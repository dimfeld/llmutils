import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting } from './db/database.js';
import { clearPlanSyncContext } from './db/plan_sync.js';
import { findSiblingPlans, buildPlanContextPrompt } from './context_helpers.js';
import { getMaterializedPlanPath } from './plan_materialize.js';
import { writePlanFile } from './plans.js';
import type { PlanSchema } from './planSchema.js';

describe('context_helpers', () => {
  let tempDir: string;
  let repoRoot: string;
  let originalCwd: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-context-helpers-test-'));
    repoRoot = path.join(tempDir, 'repo');
    await fs.mkdir(path.join(repoRoot, 'tasks'), { recursive: true });
    await Bun.$`git init`.cwd(repoRoot).quiet();
    await Bun.$`git remote add origin https://example.com/acme/context-helpers.git`
      .cwd(repoRoot)
      .quiet();
    process.chdir(repoRoot);

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    closeDatabaseForTesting();
    clearPlanSyncContext();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    closeDatabaseForTesting();
    clearPlanSyncContext();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeMaterializedPlan(plan: PlanSchema): Promise<string> {
    const planPath = getMaterializedPlanPath(repoRoot, plan.id);
    await writePlanFile(planPath, plan, { cwdForIdentity: repoRoot });
    return planPath;
  }

  test('findSiblingPlans sorts, categorizes, and resolves sibling files from materialized plans', async () => {
    const allPlans = new Map<number, PlanSchema>([
      [
        100,
        {
          id: 100,
          title: 'Parent Plan',
          goal: 'Goal',
          details: 'Details',
          status: 'in_progress',
          tasks: [],
        },
      ],
      [
        101,
        {
          id: 101,
          title: 'Current Plan',
          goal: 'Goal',
          details: 'Details',
          status: 'pending',
          parent: 100,
          tasks: [],
        },
      ],
      [
        103,
        {
          id: 103,
          title: 'Later Pending Sibling',
          goal: 'Goal',
          details: 'Details',
          status: 'pending',
          parent: 100,
          tasks: [],
        },
      ],
      [
        102,
        {
          id: 102,
          title: 'Done Sibling',
          goal: 'Goal',
          details: 'Details',
          status: 'done',
          parent: 100,
          tasks: [],
        },
      ],
      [
        99,
        {
          id: 99,
          title: 'Earlier Pending Sibling',
          goal: 'Goal',
          details: 'Details',
          status: 'in_progress',
          parent: 100,
          tasks: [],
        },
      ],
    ]);

    await writeMaterializedPlan(allPlans.get(100)!);
    await writeMaterializedPlan(allPlans.get(101)!);
    await writeMaterializedPlan(allPlans.get(102)!);
    await writeMaterializedPlan(allPlans.get(103)!);
    await writeMaterializedPlan(allPlans.get(99)!);

    const result = findSiblingPlans(101, 100, allPlans, repoRoot, repoRoot);

    expect(result.parent?.id).toBe(100);
    expect(result.siblings.completed).toEqual([
      { id: 102, title: 'Done Sibling', file: '.tim/plans/102.plan.md' },
    ]);
    expect(result.siblings.pending).toEqual([
      { id: 99, title: 'Earlier Pending Sibling', file: '.tim/plans/99.plan.md' },
      { id: 103, title: 'Later Pending Sibling', file: '.tim/plans/103.plan.md' },
    ]);
  });

  test('buildPlanContextPrompt reads parent and sibling context from DB-backed plans', async () => {
    await writeMaterializedPlan({
      id: 100,
      title: 'Parent Plan',
      goal: 'Ship the feature set',
      details: 'Parent details',
      status: 'in_progress',
      docs: ['https://example.com/parent-doc', 'docs/local.md'],
      tasks: [],
    });
    const currentPlanPath = await writeMaterializedPlan({
      id: 101,
      title: 'Current Plan',
      goal: 'Implement the child work',
      details: 'Current details',
      status: 'pending',
      parent: 100,
      tasks: [],
    });
    await writeMaterializedPlan({
      id: 102,
      title: 'Done Sibling',
      goal: 'Sibling goal',
      details: 'Sibling details',
      status: 'done',
      parent: 100,
      tasks: [],
    });
    await writeMaterializedPlan({
      id: 103,
      title: 'Pending Sibling',
      goal: 'Sibling goal',
      details: 'Sibling details',
      status: 'pending',
      parent: 100,
      tasks: [],
    });

    const context = await buildPlanContextPrompt({
      planData: {
        id: 101,
        title: 'Current Plan',
        goal: 'Implement the child work',
        details: 'Current details',
        status: 'pending',
        parent: 100,
        tasks: [],
      },
      planFilePath: currentPlanPath,
      baseDir: repoRoot,
    });

    expect(context).toContain('## Current Plan Context');
    expect(context).toContain('**Current Plan File:** ');
    expect(context).toContain('.tim/plans/101.plan.md');
    expect(context).toContain('**Parent Plan File:** 100.plan.md');
    expect(context).toContain('**Parent Plan:** Parent Plan (ID: 100)');
    expect(context).toContain('**Parent Goal:** Ship the feature set');
    expect(context).toContain('**Parent Documentation URLs:**');
    expect(context).toContain('- https://example.com/parent-doc');
    expect(context).toContain('### Completed Sibling Plans:');
    expect(context).toContain('- **Done Sibling** (File: 102.plan.md)');
    expect(context).toContain('### Pending Sibling Plans:');
    expect(context).toContain('- **Pending Sibling** (File: 103.plan.md)');
  });

  test('findSiblingPlans treats needs_review siblings as completed', async () => {
    const allPlans = new Map<number, PlanSchema>([
      [
        100,
        {
          id: 100,
          title: 'Parent Plan',
          goal: 'Goal',
          details: 'Details',
          status: 'in_progress',
          tasks: [],
        },
      ],
      [
        101,
        {
          id: 101,
          title: 'Current Plan',
          goal: 'Goal',
          details: 'Details',
          status: 'pending',
          parent: 100,
          tasks: [],
        },
      ],
      [
        102,
        {
          id: 102,
          title: 'Needs Review Sibling',
          goal: 'Goal',
          details: 'Details',
          status: 'needs_review',
          parent: 100,
          tasks: [],
        },
      ],
      [
        103,
        {
          id: 103,
          title: 'Pending Sibling',
          goal: 'Goal',
          details: 'Details',
          status: 'pending',
          parent: 100,
          tasks: [],
        },
      ],
    ]);

    await writeMaterializedPlan(allPlans.get(100)!);
    await writeMaterializedPlan(allPlans.get(101)!);
    await writeMaterializedPlan(allPlans.get(102)!);
    await writeMaterializedPlan(allPlans.get(103)!);

    const result = findSiblingPlans(101, 100, allPlans, repoRoot, repoRoot);

    expect(result.siblings.completed).toEqual([
      { id: 102, title: 'Needs Review Sibling', file: '.tim/plans/102.plan.md' },
    ]);
    expect(result.siblings.pending).toEqual([
      { id: 103, title: 'Pending Sibling', file: '.tim/plans/103.plan.md' },
    ]);
  });
});
