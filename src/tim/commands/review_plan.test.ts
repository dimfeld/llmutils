import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => true),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async ({ callback }: { callback: () => Promise<void> }) =>
    callback()
  ),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../executors/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../executors/index.js')>('../executors/index.js');
  return {
    ...actual,
    buildExecutorAndLog: vi.fn(),
  };
});

vi.mock('../workspace/workspace_setup.js', async () => {
  const actual = await vi.importActual<typeof import('../workspace/workspace_setup.js')>(
    '../workspace/workspace_setup.js'
  );
  return {
    ...actual,
    setupWorkspace: vi.fn(),
  };
});

import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { getReviewIssues, getReviewsByPlanUuid } from '../db/review.js';
import { nonSyncedUpsertPlan } from '../db/plan.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { buildPlanMetadata, handlePlanReviewGuideCommand } from './review_plan.js';
import { warn } from '../../logging.js';

const PLAN_UUID = '11111111-1111-4111-8111-111111111111';

const mockBuildExecutorAndLog = vi.mocked(buildExecutorAndLog);
const mockSetupWorkspace = vi.mocked(setupWorkspace);

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeCommand(config?: string) {
  return {
    parent: {
      opts: () => ({ config }),
    },
  } as any;
}

async function writePlanFile(repoDir: string, planId: number): Promise<string> {
  const planDir = path.join(repoDir, '.tim', 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planPath = path.join(planDir, `${planId}.plan.md`);
  await fs.writeFile(
    planPath,
    stringifyPlanWithFrontmatter({
      id: planId,
      uuid: PLAN_UUID,
      title: 'Plan-only review guides',
      goal: 'Generate review guides without requiring a PR.',
      status: 'in_progress',
      tasks: [
        {
          title: 'Implement CLI command',
          description: 'Add the plan review guide command.',
          done: false,
        },
      ],
      details: 'Reuse the PR review-guide workflow for plan-only work.',
    }),
    'utf8'
  );
  return planPath;
}

async function createRepository(options: {
  tempDir: string;
  localMainChange?: string;
  dirtyChange?: string;
  committedFeatureChange?: string;
  withoutOrigin?: boolean;
}): Promise<{ repoDir: string; originDir: string }> {
  const repoDir = path.join(options.tempDir, 'repo');
  const originDir = path.join(options.tempDir, 'origin.git');
  await fs.mkdir(repoDir, { recursive: true });
  runGit(repoDir, ['init', '--initial-branch=main']);
  runGit(repoDir, ['config', 'user.email', 'test@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Test User']);
  if (options.withoutOrigin !== true) {
    await fs.mkdir(originDir, { recursive: true });
    runGit(originDir, ['init', '--bare', '--initial-branch=main']);
    runGit(repoDir, ['remote', 'add', 'origin', originDir]);
  }

  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
  await writePlanFile(repoDir, 348);
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'initial']);
  if (options.withoutOrigin !== true) {
    runGit(repoDir, ['push', '-u', 'origin', 'main']);
  }

  if (options.localMainChange) {
    await fs.writeFile(path.join(repoDir, 'src', 'base.ts'), options.localMainChange, 'utf8');
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'local main change']);
  }

  if (options.withoutOrigin !== true) {
    runGit(repoDir, ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git']);
  }
  runGit(repoDir, ['checkout', '-b', 'feature/plan-review-guide']);

  if (options.committedFeatureChange) {
    await fs.writeFile(path.join(repoDir, 'src', 'feature.ts'), options.committedFeatureChange);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', 'feature change']);
  }

  if (options.dirtyChange) {
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), options.dirtyChange, 'utf8');
  }

  return { repoDir, originDir };
}

async function cloneCleanWorkspace(sourceRepoDir: string, workspaceDir: string): Promise<void> {
  execFileSync('git', ['clone', sourceRepoDir, workspaceDir], { encoding: 'utf8' });
  try {
    runGit(workspaceDir, ['branch', 'main', 'origin/main']);
  } catch {
    // The local main branch may already exist depending on the Git version.
  }
  runGit(workspaceDir, ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git']);
  runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
  runGit(workspaceDir, ['config', 'user.name', 'Test User']);
}

async function seedPlan(repoDir: string): Promise<number> {
  const db = getDatabase();
  const repository = await getRepositoryIdentity({ cwd: repoDir });
  const project = getOrCreateProject(db, repository.repositoryId, {
    remoteUrl: repository.remoteUrl,
    lastGitRoot: repository.gitRoot,
  });
  nonSyncedUpsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 348,
    title: 'Plan-only review guides',
    goal: 'Generate review guides without requiring a PR.',
    details: 'Reuse the PR review-guide workflow for plan-only work.',
    status: 'in_progress',
    tasks: [
      {
        title: 'Implement CLI command',
        description: 'Add the plan review guide command.',
        done: false,
      },
    ],
  });
  return project.id;
}

function installExecutorMock(capturedGuidePrompts: string[]): void {
  mockBuildExecutorAndLog.mockReturnValue({
    execute: vi.fn(async (prompt: string, planInfo: { executionMode: string }) => {
      if (planInfo.executionMode === 'bare') {
        capturedGuidePrompts.push(prompt);
        const guidePathMatch = prompt.match(/`([^`]+review-guide\.md)`/);
        if (!guidePathMatch?.[1]) {
          throw new Error('Guide prompt did not include a review-guide.md output path.');
        }
        await fs.mkdir(path.dirname(guidePathMatch[1]), { recursive: true });
        await fs.writeFile(guidePathMatch[1], '# Stub Plan Review Guide\n', 'utf8');
        return 'wrote guide';
      }

      if (prompt.includes('simplification review')) {
        return JSON.stringify({ issues: [], recommendations: [], actionItems: [] });
      }

      return JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'The implementation has a real issue.',
            file: 'src/app.ts',
            line: '1',
            suggestion: 'Fix the issue.',
          },
        ],
        recommendations: [],
        actionItems: [],
      });
    }),
  } as any);
}

describe('handlePlanReviewGuideCommand', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalXdgConfigHome: string | undefined;
  let capturedGuidePrompts: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    clearAllTimCaches();
    closeDatabaseForTesting();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-plan-test-'));
    originalCwd = process.cwd();
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    capturedGuidePrompts = [];
    installExecutorMock(capturedGuidePrompts);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    closeDatabaseForTesting();
    clearAllTimCaches();
    vi.restoreAllMocks();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('creates a completed plan-only review with guide and issues', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      dirtyChange: 'export const value = 2;\n',
    });
    process.chdir(repoDir);
    await seedPlan(repoDir);

    await handlePlanReviewGuideCommand('348', { executor: 'claude-code' }, makeCommand());

    const reviewedSha = runGit(repoDir, ['rev-parse', 'HEAD']);
    const reviews = getReviewsByPlanUuid(getDatabase(), PLAN_UUID);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({
        plan_uuid: PLAN_UUID,
        pr_url: null,
        branch: null,
        status: 'complete',
        review_guide: expect.stringContaining('Stub Plan Review Guide'),
      })
    );
    const issues = getReviewIssues(getDatabase(), reviews[0].id);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        review_id: reviews[0].id,
        severity: 'major',
        category: 'bug',
        file: 'src/app.ts',
      })
    );
    expect(capturedGuidePrompts[0]).toContain('## Plan Metadata');
    expect(capturedGuidePrompts[0]).toContain(`- Head Ref: ${reviewedSha}`);
    expect(capturedGuidePrompts[0]).toContain('Plan-only review guides');
    expect(capturedGuidePrompts[0]).toContain('src/app.ts#');
    expect(capturedGuidePrompts[0]).toContain('+export const value = 2;');
    expect(capturedGuidePrompts[0]).not.toContain('## PR Metadata');
  });

  test('creates a completed codex-only plan review with guide and issues', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      dirtyChange: 'export const value = 2;\n',
    });
    process.chdir(repoDir);
    await seedPlan(repoDir);

    await handlePlanReviewGuideCommand('348', { executor: 'codex-cli' }, makeCommand());

    const reviews = getReviewsByPlanUuid(getDatabase(), PLAN_UUID);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({
        plan_uuid: PLAN_UUID,
        pr_url: null,
        status: 'complete',
        review_guide: expect.stringContaining('Stub Plan Review Guide'),
      })
    );

    const issues = getReviewIssues(getDatabase(), reviews[0].id);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        review_id: reviews[0].id,
        severity: 'major',
        category: 'bug',
        source: 'codex-cli',
      })
    );
    expect(capturedGuidePrompts).toHaveLength(1);
    expect(capturedGuidePrompts[0]).toContain('Plan-only review guides');
    expect(mockBuildExecutorAndLog.mock.calls.map((call) => call[0])).toEqual([
      'codex-cli',
      'codex-cli',
      'codex-cli',
    ]);
  });

  test('completes in a repository without an origin remote', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      withoutOrigin: true,
      dirtyChange: 'export const value = 2;\n',
    });
    process.chdir(repoDir);
    await seedPlan(repoDir);

    await handlePlanReviewGuideCommand('348', { executor: 'claude-code' }, makeCommand());

    const reviews = getReviewsByPlanUuid(getDatabase(), PLAN_UUID);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(
      expect.objectContaining({
        plan_uuid: PLAN_UUID,
        pr_url: null,
        status: 'complete',
      })
    );
    expect(capturedGuidePrompts[0]).toContain("git merge-base 'main' HEAD");
    expect(capturedGuidePrompts[0]).not.toContain('origin/');
    expect(capturedGuidePrompts[0]).not.toContain('@origin');
  });

  test('throws a clear error when the plan is missing', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      dirtyChange: 'export const value = 2;\n',
    });
    process.chdir(repoDir);

    await expect(
      handlePlanReviewGuideCommand('999', { executor: 'claude-code' }, makeCommand())
    ).rejects.toThrow('Plan 999 was not found in the current project.');
  });

  test('exits without creating a review when no changes are detected', async () => {
    const { repoDir } = await createRepository({ tempDir });
    process.chdir(repoDir);
    await seedPlan(repoDir);

    await handlePlanReviewGuideCommand('348', { executor: 'claude-code' }, makeCommand());

    expect(getReviewsByPlanUuid(getDatabase(), PLAN_UUID)).toEqual([]);
    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('uses setupWorkspace only for auto-workspace and excludes dirty cwd changes there', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      committedFeatureChange: 'export const feature = true;\n',
      dirtyChange: 'export const value = 3;\n',
    });
    const workspaceDir = path.join(tempDir, 'workspace');
    await cloneCleanWorkspace(repoDir, workspaceDir);
    process.chdir(repoDir);
    await seedPlan(repoDir);

    await handlePlanReviewGuideCommand('348', { executor: 'claude-code' }, makeCommand());
    expect(mockSetupWorkspace).not.toHaveBeenCalled();
    expect(capturedGuidePrompts[0]).toContain('+export const value = 3;');

    capturedGuidePrompts = [];
    installExecutorMock(capturedGuidePrompts);
    mockSetupWorkspace.mockResolvedValue({
      baseDir: workspaceDir,
      planFile: path.join(workspaceDir, '.tim', 'plans', '348.plan.md'),
      workspaceTaskId: 'workspace-task',
      isNewWorkspace: false,
      branchCreatedDuringSetup: false,
    } as any);

    await handlePlanReviewGuideCommand(
      '348',
      { executor: 'claude-code', autoWorkspace: true, nonInteractive: true },
      makeCommand()
    );

    const realRepoDir = await fs.realpath(repoDir);
    expect(mockSetupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        autoWorkspace: true,
        planId: 348,
        planUuid: PLAN_UUID,
        allowPrimaryWorkspaceWhenLocked: true,
      }),
      realRepoDir,
      expect.stringContaining('348.plan.md'),
      expect.any(Object),
      'tim review-guide generate'
    );
    expect(capturedGuidePrompts[0]).toContain('src/feature.ts#');
    expect(capturedGuidePrompts[0]).not.toContain('+export const value = 3;');
  });

  test('uses the gathered local merge base for the managed-workspace diff catalog', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      localMainChange: 'export const localBase = true;\n',
      committedFeatureChange: 'export const feature = true;\n',
    });
    process.chdir(repoDir);
    await seedPlan(repoDir);
    mockSetupWorkspace.mockResolvedValue({
      baseDir: repoDir,
      planFile: path.join(repoDir, '.tim', 'plans', '348.plan.md'),
      workspaceTaskId: 'workspace-task',
      isNewWorkspace: false,
      branchCreatedDuringSetup: false,
    } as any);

    await handlePlanReviewGuideCommand(
      '348',
      { executor: 'claude-code', autoWorkspace: true, nonInteractive: true },
      makeCommand()
    );

    expect(capturedGuidePrompts[0]).toContain('src/feature.ts#');
    expect(capturedGuidePrompts[0]).toContain('+export const feature = true;');
    expect(capturedGuidePrompts[0]).not.toContain('src/base.ts#');
    expect(capturedGuidePrompts[0]).not.toContain('+export const localBase = true;');
  });

  test('passes command: "review-guide" to runWithHeadlessAdapterIfEnabled', async () => {
    const { repoDir } = await createRepository({
      tempDir,
      dirtyChange: 'export const value = 2;\n',
    });
    process.chdir(repoDir);
    await seedPlan(repoDir);

    const isTunnelActiveMock = vi.mocked(
      (await import('../../logging/tunnel_client.js')).isTunnelActive
    );
    isTunnelActiveMock.mockReturnValueOnce(false);

    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handlePlanReviewGuideCommand('348', { executor: 'claude-code' }, makeCommand());

    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'review-guide', enabled: true })
    );
  });
});

describe('buildPlanMetadata', () => {
  test('warns and drops parent/child entries with non-numeric ids', () => {
    const mockWarn = vi.mocked(warn);
    mockWarn.mockClear();

    const context = {
      planData: {
        id: 100,
        uuid: '22222222-2222-4222-8222-222222222222',
        title: 'Test Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'in_progress',
        tasks: [{ title: 'Task 1', done: false, description: '' }],
        dependencies: [],
        issue: [],
      },
      parentChain: [
        {
          id: NaN as unknown as number,
          title: 'Invalid Parent',
          status: 'pending',
          tasks: [],
          dependencies: [],
          issue: [],
        },
        {
          id: 99,
          title: 'Valid Parent',
          status: 'pending',
          tasks: [],
          dependencies: [],
          issue: [],
        },
      ],
      completedChildren: [
        {
          id: NaN as unknown as number,
          title: 'Invalid Child',
          status: 'done',
          tasks: [],
          dependencies: [],
          issue: [],
        },
      ],
      diffResult: {
        baseBranch: 'main',
        hasChanges: true,
        changedFiles: [],
        diffContent: '',
        mergeBaseCommit: null,
      },
      noChangesDetected: false,
      repoRoot: '/some/path',
      gitRoot: '/some/path',
      incrementalSummary: null,
    } as any;

    const result = buildPlanMetadata(
      100,
      '22222222-2222-4222-8222-222222222222',
      context,
      'abc123'
    );

    expect(result.parentChain).toEqual([{ planId: 99, title: 'Valid Parent' }]);
    expect(result.completedChildren).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('non-numeric id'));
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('parent plan'));
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('completed child plan'));
  });
});
