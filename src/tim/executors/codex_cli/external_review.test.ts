import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '../../configSchema.js';
import { closeDatabaseForTesting } from '../../db/database.js';
import { clearPlanSyncContext } from '../../db/plan_sync.js';
import { writePlanToDb } from '../../plans.js';
import { buildFixInstructions, deriveReviewVerdict, loadReviewHierarchy } from './external_review';
import type { ReviewResult } from '../../formatters/review_formatter';

function buildReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    planId: '1',
    planTitle: 'Test Plan',
    reviewTimestamp: new Date().toISOString(),
    baseBranch: 'main',
    changedFiles: ['src/index.ts'],
    summary: {
      totalIssues: 0,
      criticalCount: 0,
      majorCount: 0,
      minorCount: 0,
      infoCount: 0,
      categoryCounts: {
        security: 0,
        performance: 0,
        bug: 0,
        style: 0,
        compliance: 0,
        testing: 0,
        other: 0,
      },
      filesReviewed: 1,
    },
    issues: [],
    rawOutput: '',
    recommendations: [],
    actionItems: [],
    ...overrides,
  };
}

describe('external_review helpers', () => {
  let tempDir: string;
  let repoRoot: string;
  let originalCwd: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-external-review-test-'));
    repoRoot = path.join(tempDir, 'repo');
    await fs.mkdir(path.join(repoRoot, 'tasks'), { recursive: true });
    await Bun.$`git init`.cwd(repoRoot).quiet();
    await Bun.$`git remote add origin https://example.com/acme/external-review.git`
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

  test('deriveReviewVerdict returns ACCEPTABLE when only info issues', () => {
    const result = buildReviewResult({
      issues: [
        {
          id: 'issue-1',
          severity: 'info',
          category: 'other',
          content: 'Informational note',
        },
      ],
    });

    expect(deriveReviewVerdict(result)).toBe('ACCEPTABLE');
  });

  test('deriveReviewVerdict returns NEEDS_FIXES for non-info issues', () => {
    const result = buildReviewResult({
      issues: [
        {
          id: 'issue-1',
          severity: 'minor',
          category: 'bug',
          content: 'Minor bug',
        },
      ],
    });

    expect(deriveReviewVerdict(result)).toBe('NEEDS_FIXES');
  });

  test('buildFixInstructions formats review issues and extras', () => {
    const result = buildReviewResult({
      issues: [
        {
          id: 'issue-1',
          severity: 'critical',
          category: 'security',
          content: 'Security flaw',
          file: 'src/auth.ts',
          line: 12,
          suggestion: 'Validate input',
        },
      ],
      recommendations: ['Add integration tests'],
      actionItems: ['Fix auth flow before release'],
    });

    const output = buildFixInstructions(result);

    expect(output).toContain('[CRITICAL][security] Security flaw');
    expect(output).toContain('File: src/auth.ts:12');
    expect(output).toContain('Suggestion: Validate input');
    expect(output).toContain('## Recommendations');
    expect(output).toContain('Add integration tests');
    expect(output).toContain('## Action Items');
    expect(output).toContain('Fix auth flow before release');
  });

  test('loadReviewHierarchy reads parent chain and completed children from DB-backed plans', async () => {
    await writePlanToDb(
      {
        id: 1,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: 'Parent details',
        status: 'in_progress',
        tasks: [],
        filename: 'tasks/1-parent.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 2,
        title: 'Reviewed Plan',
        goal: 'Reviewed goal',
        details: 'Reviewed details',
        status: 'pending',
        parent: 1,
        tasks: [],
        filename: 'tasks/2-reviewed.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 3,
        title: 'Completed Child',
        goal: 'Child goal',
        details: 'Child details',
        status: 'done',
        parent: 2,
        tasks: [],
        filename: 'tasks/3-child.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );
    await writePlanToDb(
      {
        id: 4,
        title: 'Pending Child',
        goal: 'Child goal',
        details: 'Child details',
        status: 'pending',
        parent: 2,
        tasks: [],
        filename: 'tasks/4-child.plan.md',
      },
      { cwdForIdentity: repoRoot }
    );

    const hierarchy = await loadReviewHierarchy(
      {
        id: 2,
        title: 'Reviewed Plan',
        goal: 'Reviewed goal',
        details: 'Reviewed details',
        status: 'pending',
        parent: 1,
        tasks: [],
      },
      path.join(repoRoot, 'tasks', '2-reviewed.plan.md'),
      getDefaultConfig()
    );

    expect(hierarchy.parentChain.map((plan) => plan.id)).toEqual([1]);
    expect(hierarchy.completedChildren.map((plan) => plan.id)).toEqual([3]);
  });
});
