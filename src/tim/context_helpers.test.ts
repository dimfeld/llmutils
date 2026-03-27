import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting } from './db/database.js';
import { clearPlanSyncContext } from './db/plan_sync.js';
import { findSiblingPlans, buildPlanContextPrompt } from './context_helpers.js';
import { writePlanToDb } from './plans.js';
import type { PlanWithFilename } from './utils/hierarchy.js';

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

  test('findSiblingPlans sorts and categorizes siblings from the provided plan map', async () => {
    const allPlans = new Map<number, PlanWithFilename>([
      [
        100,
        {
          id: 100,
          title: 'Parent Plan',
          goal: 'Goal',
          details: 'Details',
          status: 'in_progress',
          tasks: [],
          filename: '/repo/tasks/100-parent.plan.md',
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
          filename: '/repo/tasks/101-current.plan.md',
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
          filename: '/repo/tasks/103-later.plan.md',
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
          filename: '/repo/tasks/102-done.plan.md',
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
          filename: '/repo/tasks/099-earlier.plan.md',
        },
      ],
    ]);

    const result = findSiblingPlans(101, 100, allPlans);

    expect(result.parent?.id).toBe(100);
    expect(result.siblings.completed).toEqual([
      { id: 102, title: 'Done Sibling', filename: '/repo/tasks/102-done.plan.md' },
    ]);
    expect(result.siblings.pending).toEqual([
      { id: 99, title: 'Earlier Pending Sibling', filename: '/repo/tasks/099-earlier.plan.md' },
      { id: 103, title: 'Later Pending Sibling', filename: '/repo/tasks/103-later.plan.md' },
    ]);
  });

  test('buildPlanContextPrompt reads parent and sibling context from DB-backed plans', async () => {
    await writePlanToDb(
      {
        id: 100,
        title: 'Parent Plan',
        goal: 'Ship the feature set',
        details: 'Parent details',
        status: 'in_progress',
        docs: ['https://example.com/parent-doc', 'docs/local.md'],
        tasks: [],
        filename: 'tasks/100-parent.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 101,
        title: 'Current Plan',
        goal: 'Implement the child work',
        details: 'Current details',
        status: 'pending',
        parent: 100,
        tasks: [],
        filename: 'tasks/101-current.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 102,
        title: 'Done Sibling',
        goal: 'Sibling goal',
        details: 'Sibling details',
        status: 'done',
        parent: 100,
        tasks: [],
        filename: 'tasks/102-done.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 103,
        title: 'Pending Sibling',
        goal: 'Sibling goal',
        details: 'Sibling details',
        status: 'pending',
        parent: 100,
        tasks: [],
        filename: 'tasks/103-pending.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

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
      planFilePath: path.join(repoRoot, 'tasks', '101-current.plan.md'),
      baseDir: repoRoot,
    });

    expect(context).toContain('## Current Plan Context');
    expect(context).toContain('**Current Plan File:** ');
    expect(context).toContain('101-current.plan.md');
    expect(context).toContain('**Parent Plan File:** 100-parent.plan.md');
    expect(context).toContain('**Parent Plan:** Parent Plan (ID: 100)');
    expect(context).toContain('**Parent Goal:** Ship the feature set');
    expect(context).toContain('**Parent Documentation URLs:**');
    expect(context).toContain('- https://example.com/parent-doc');
    expect(context).toContain('### Completed Sibling Plans:');
    expect(context).toContain('- **Done Sibling** (File: 102-done.plan.md)');
    expect(context).toContain('### Pending Sibling Plans:');
    expect(context).toContain('- **Pending Sibling** (File: 103-pending.plan.md)');
  });
});
