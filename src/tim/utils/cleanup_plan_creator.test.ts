import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { resolvePlanFromDb, readPlanFile, writePlanToDb } from '../plans.js';
import type { ReviewIssue } from '../formatters/review_formatter.js';
import { createCleanupPlan } from './cleanup_plan_creator.js';

describe('cleanup_plan_creator', () => {
  let tempDir: string;
  let repoRoot: string;
  let originalCwd: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-cleanup-plan-test-'));
    repoRoot = path.join(tempDir, 'repo');
    await fs.mkdir(path.join(repoRoot, '.rmfilter', 'config'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, '.tim', 'plans'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.rmfilter', 'config', 'tim.yml'),
      ['paths:', '  tasks: tasks', ''].join('\n')
    );
    await Bun.$`git init`.cwd(repoRoot).quiet();
    await Bun.$`git remote add origin https://example.com/acme/cleanup-plan.git`
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

  test('createCleanupPlan uses DB-backed plans for changed files and parent updates', async () => {
    await writePlanToDb(
      {
        id: 10,
        title: 'Reviewed Plan',
        goal: 'Ship the reviewed work',
        details: 'Reviewed details',
        status: 'done',
        changedFiles: ['src/reviewed.ts', 'src/shared.ts'],
        tasks: [],
        filename: '10-reviewed.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 11,
        title: 'Completed Child',
        goal: 'Child goal',
        details: 'Child details',
        status: 'done',
        parent: 10,
        changedFiles: ['src/child.ts', 'src/shared.ts'],
        tasks: [],
        filename: '11-child.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

    const issues: ReviewIssue[] = [
      {
        id: 'issue-1',
        severity: 'major',
        category: 'bug',
        content: 'Fix the cleanup issue',
        file: 'src/from-review.ts',
      },
    ];

    const result = await createCleanupPlan(10, issues);

    expect(result.planId).toBeGreaterThan(11);
    expect(result.filePath).toMatch(/\/\d+-reviewed-plan-cleanup\.plan\.md$/);
    expect(result.plan.parent).toBe(10);
    expect(result.plan.rmfilter).toEqual([
      'src/child.ts',
      'src/from-review.ts',
      'src/reviewed.ts',
      'src/shared.ts',
    ]);

    const storedPlan = await readPlanFile(result.filePath);
    expect(storedPlan.title).toBe('Reviewed Plan - Cleanup');
    expect(storedPlan.rmfilter).toBeUndefined();

    const updatedParent = (await resolvePlanFromDb('10', repoRoot)).plan;
    expect(updatedParent.status).toBe('in_progress');
    expect(updatedParent.dependencies).toContain(result.planId);
  });
});
