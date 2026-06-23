import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { resolvePlanByNumericId, readPlanFile, writePlanToDb } from '../plans.js';
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

    const storedPlan = await readPlanFile(result.filePath);
    expect(storedPlan.title).toBe('Reviewed Plan - Cleanup');

    const updatedParent = (await resolvePlanByNumericId(10, repoRoot)).plan;
    expect(updatedParent.status).toBe('in_progress');
    expect(updatedParent.dependencies).toContain(result.planId);
  });

  test('createCleanupPlan reopens needs_review parents to in_progress', async () => {
    await writePlanToDb(
      {
        id: 20,
        title: 'Needs Review Parent',
        goal: 'Return to active work when cleanup is needed',
        details: 'Parent details',
        status: 'needs_review',
        changedFiles: ['src/parent.ts'],
        tasks: [],
        filename: '20-parent.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

    const result = await createCleanupPlan(20, [
      {
        id: 'issue-1',
        severity: 'major',
        category: 'bug',
        content: 'Follow up after review',
        file: 'src/parent.ts',
      },
    ]);

    const updatedParent = (await resolvePlanByNumericId(20, repoRoot)).plan;
    expect(updatedParent.status).toBe('in_progress');
    expect(updatedParent.dependencies).toContain(result.planId);
  });

  test('createCleanupPlan reopens reviewed parents to in_progress', async () => {
    await writePlanToDb(
      {
        id: 21,
        title: 'Reviewed Parent',
        goal: 'Return reviewed work to active status when cleanup is needed',
        details: 'Parent details',
        status: 'reviewed',
        changedFiles: ['src/reviewed-parent.ts'],
        tasks: [],
        filename: '21-parent.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

    const result = await createCleanupPlan(21, [
      {
        id: 'issue-1',
        severity: 'major',
        category: 'bug',
        content: 'Follow up after reviewed parent review',
        file: 'src/reviewed-parent.ts',
      },
    ]);

    const updatedParent = (await resolvePlanByNumericId(21, repoRoot)).plan;
    expect(updatedParent.status).toBe('in_progress');
    expect(updatedParent.dependencies).toContain(result.planId);
  });

  test('createCleanupPlan excludes note severity annotations from cleanup tasks', async () => {
    await writePlanToDb(
      {
        id: 30,
        title: 'Notes Parent',
        goal: 'Only actionable issues should become cleanup work',
        details: 'Parent details',
        status: 'done',
        changedFiles: ['src/actionable.ts'],
        tasks: [],
        filename: '30-parent.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

    const issues = [
      {
        id: 'issue-1',
        severity: 'major',
        category: 'bug',
        content: 'Fix the actionable issue',
        file: 'src/actionable.ts',
      },
      {
        id: 'issue-note',
        severity: 'note',
        category: 'other',
        content: 'Descriptive annotation only',
        file: 'src/note.ts',
      },
    ] as ReviewIssue[];

    const result = await createCleanupPlan(30, issues);

    expect(result.plan.goal).toContain('Address 1 code review issue (1 major)');
    expect(result.plan.details).toContain('Fix the actionable issue');
    expect(result.plan.details).not.toContain('Descriptive annotation only');
  });

  test('createCleanupPlan rejects all-note review issues', async () => {
    await writePlanToDb(
      {
        id: 40,
        title: 'Only Notes Parent',
        goal: 'Notes should not produce cleanup work',
        details: 'Parent details',
        status: 'done',
        changedFiles: ['src/parent.ts'],
        tasks: [],
        filename: '40-parent.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

    const issues = [
      {
        id: 'issue-note',
        severity: 'note',
        category: 'other',
        content: 'Descriptive annotation only',
        file: 'src/note.ts',
      },
    ] as ReviewIssue[];

    await expect(createCleanupPlan(40, issues)).rejects.toThrow(
      'No actionable review issues available for cleanup plan'
    );
  });
});
