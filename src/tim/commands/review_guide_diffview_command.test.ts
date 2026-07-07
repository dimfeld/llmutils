import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

const gitMocks = vi.hoisted(() => ({
  getCurrentBranchName: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return {
    ...actual,
    getCurrentBranchName: gitMocks.getCurrentBranchName,
  };
});

const dbMocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
}));

vi.mock('../db/database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/database.js')>();
  return {
    ...actual,
    getDatabase: dbMocks.getDatabase,
  };
});

const reviewWorkflowMocks = vi.hoisted(() => ({
  resolveProjectContextForRepo: vi.fn(),
}));

vi.mock('./review_workflow.js', () => reviewWorkflowMocks);

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { nonSyncedUpsertPlan } from '../db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '../db/pr_status.js';
import { createReview } from '../db/review.js';
import { log } from '../../logging.js';
import { handleReviewGuideDiffviewCommand } from './review_guide_diffview_command.js';

const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const BRANCH = 'feature/diffview-export';
const PR_URL = 'https://github.com/example/repo/pull/9';

const GUIDE_MARKDOWN_NO_H1 = `## Core Logic

Implements the primary transformation logic.

\`\`\`unified-diff
--- a/src/services/foo.ts
+++ b/src/services/foo.ts
@@ -1,1 +1,1 @@
-old
+new
\`\`\`
`;

const GUIDE_MARKDOWN = `# Diffview Export Guide

## Core Logic

Implements the primary transformation logic.

\`\`\`unified-diff
--- a/src/services/foo.ts
+++ b/src/services/foo.ts
@@ -1,1 +1,1 @@
-old
+new
\`\`\`

\`\`\`unified-diff
--- a/src/shared/util.ts
+++ b/src/shared/util.ts
@@ -1,1 +1,1 @@
-old
+new
\`\`\`

## Tests

Adds coverage for the new behavior, including the shared util.

\`\`\`unified-diff
--- a/src/shared/util.ts
+++ b/src/shared/util.ts
@@ -1,1 +1,1 @@
-old
+new
\`\`\`

\`\`\`unified-diff
--- a/tests/foo.test.ts
+++ b/tests/foo.test.ts
@@ -1,1 +1,1 @@
-old
+new
\`\`\`
`;

describe('handleReviewGuideDiffviewCommand', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-guide-diffview-test-'));
    db = openDatabase(path.join(tempDir, 'db.sqlite'));
    projectId = getOrCreateProject(db, constructGitHubRepositoryId('example', 'repo')).id;

    dbMocks.getDatabase.mockReturnValue(db);
    gitMocks.getCurrentBranchName.mockResolvedValue(BRANCH);
    reviewWorkflowMocks.resolveProjectContextForRepo.mockResolvedValue({
      projectId,
      repoRoot: tempDir,
    });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function seedPlanWithGuide(reviewGuide: string | null = GUIDE_MARKDOWN): void {
    nonSyncedUpsertPlan(db, projectId, {
      uuid: PLAN_UUID,
      planId: 321,
      title: 'Diffview export plan',
      branch: BRANCH,
    });

    if (reviewGuide !== null) {
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID,
        reviewGuide,
        status: 'complete',
      });
    }
  }

  function expectedStructureAssertions(json: unknown): void {
    expect(json).toMatchObject({
      title: 'Diffview Export Guide',
      groups: [
        {
          name: 'Core Logic',
          description: 'Implements the primary transformation logic.',
          files: [{ path: 'src/services/foo.ts' }, { path: 'src/shared/util.ts' }],
        },
        {
          name: 'Tests',
          description: 'Adds coverage for the new behavior, including the shared util.',
          files: [{ path: 'tests/foo.test.ts' }],
        },
      ],
    });
  }

  test('resolves by plan ID and writes review-guide.json to the CWD', async () => {
    seedPlanWithGuide();
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await handleReviewGuideDiffviewCommand('321', {});
    } finally {
      process.chdir(originalCwd);
    }

    const outputPath = path.join(tempDir, 'review-guide.json');
    const written = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    expectedStructureAssertions(written);

    expect(log).toHaveBeenCalledWith(expect.stringContaining(outputPath));
  });

  test('resolves by current branch when no target is given', async () => {
    seedPlanWithGuide();
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await handleReviewGuideDiffviewCommand(undefined, {});
    } finally {
      process.chdir(originalCwd);
    }

    const outputPath = path.join(tempDir, 'review-guide.json');
    const written = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    expectedStructureAssertions(written);
  });

  test('honors the --output override, including nested directories', async () => {
    seedPlanWithGuide();
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await handleReviewGuideDiffviewCommand('321', { output: 'sub/dir/out.json' });
    } finally {
      process.chdir(originalCwd);
    }

    const overridePath = path.join(tempDir, 'sub/dir/out.json');
    const written = JSON.parse(await fs.readFile(overridePath, 'utf8'));
    expectedStructureAssertions(written);

    await expect(fs.access(path.join(tempDir, 'review-guide.json'))).rejects.toThrow();
  });

  test('throws a helpful error and writes no file when no stored guide exists', async () => {
    seedPlanWithGuide(null);
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await expect(handleReviewGuideDiffviewCommand('321', {})).rejects.toThrow(
        /No stored review guide found.*tim review-guide generate.*tim pr review-guide/s
      );
    } finally {
      process.chdir(originalCwd);
    }

    await expect(fs.access(path.join(tempDir, 'review-guide.json'))).rejects.toThrow();
  });

  test('throws a clear error on detached HEAD with no target', async () => {
    gitMocks.getCurrentBranchName.mockResolvedValue(null);
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await expect(handleReviewGuideDiffviewCommand(undefined, {})).rejects.toThrow(
        /detached HEAD|no current branch/i
      );
    } finally {
      process.chdir(originalCwd);
    }

    await expect(fs.access(path.join(tempDir, 'review-guide.json'))).rejects.toThrow();
  });

  test('falls back to the plan title when the guide has no H1', async () => {
    nonSyncedUpsertPlan(db, projectId, {
      uuid: PLAN_UUID,
      planId: 321,
      title: 'Diffview export plan',
      branch: BRANCH,
    });
    createReview(db, {
      projectId,
      planUuid: PLAN_UUID,
      reviewGuide: GUIDE_MARKDOWN_NO_H1,
      status: 'complete',
    });

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await handleReviewGuideDiffviewCommand('321', {});
    } finally {
      process.chdir(originalCwd);
    }

    const written = JSON.parse(await fs.readFile(path.join(tempDir, 'review-guide.json'), 'utf8'));
    expect(written.title).toBe('Diffview export plan');
    expect(written.groups).toMatchObject([{ name: 'Core Logic' }]);
  });

  test('falls back to the PR title when resolving a PR target and the guide has no H1', async () => {
    const pr = upsertPrStatus(db, {
      prUrl: PR_URL,
      owner: 'example',
      repo: 'repo',
      prNumber: 9,
      author: 'octocat',
      title: 'PR title from GitHub',
      state: 'open',
      draft: false,
      headBranch: 'feature/pr-diffview',
      baseBranch: 'main',
      lastFetchedAt: new Date().toISOString(),
    });
    nonSyncedUpsertPlan(db, projectId, {
      uuid: PLAN_UUID,
      planId: 322,
      title: 'Unrelated plan title',
      branch: 'feature/pr-diffview',
    });
    linkPlanToPr(db, PLAN_UUID, pr.status.id);
    createReview(db, {
      projectId,
      prStatusId: pr.status.id,
      prUrl: PR_URL,
      branch: 'feature/pr-diffview',
      reviewGuide: GUIDE_MARKDOWN_NO_H1,
      status: 'complete',
    });

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await handleReviewGuideDiffviewCommand(PR_URL, {});
    } finally {
      process.chdir(originalCwd);
    }

    const written = JSON.parse(await fs.readFile(path.join(tempDir, 'review-guide.json'), 'utf8'));
    expect(written.title).toBe('PR title from GitHub');
    expect(written.groups).toMatchObject([{ name: 'Core Logic' }]);
  });
});
