import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from '../../common/git.js';
import { clearGitRootCache, resetGitRepositoryCache } from '../../common/git.js';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: vi.fn(),
  };
});

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'mock-executor',
}));

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRoot: vi.fn(),
}));

const runWithHeadlessAdapterIfEnabledMock = vi.fn(
  async ({ callback }: { callback: () => Promise<void> }) => {
    return callback();
  }
);

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: (opts: unknown) =>
    runWithHeadlessAdapterIfEnabledMock(opts as never),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(() => null), all: vi.fn(() => []), run: vi.fn() })),
  })),
}));

vi.mock('../db/plan.js', () => ({
  clearPlanBaseTracking: vi.fn(),
  setPlanBaseTracking: vi.fn(),
}));

vi.mock('../db/project_settings.js', () => ({
  getProjectSetting: vi.fn().mockReturnValue(null),
  getProjectSettings: vi.fn().mockReturnValue({}),
}));

vi.mock('../plan_materialize.js', () => ({
  materializePlan: vi.fn(),
  resolveProjectContext: vi.fn().mockResolvedValue({ projectId: 1 }),
}));

import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanByNumericId } from '../plans.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { handleRebaseCommand } from './rebase.js';
import { clearPlanBaseTracking, setPlanBaseTracking } from '../db/plan.js';

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TestRepo {
  tempRoot: string;
  originDir: string;
  upstreamDir: string;
  workDir: string;
  featureBranch: string;
}

async function isJjAvailable(): Promise<boolean> {
  const proc = Bun.spawn(['jj', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  return (await proc.exited) === 0;
}

async function runGit(
  cwd: string,
  args: string[],
  options?: { allowFailure?: boolean }
): Promise<GitCommandResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);

  if (!options?.allowFailure && exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }

  return { exitCode, stdout, stderr };
}

async function runJj(
  cwd: string,
  args: string[],
  options?: { allowFailure?: boolean }
): Promise<GitCommandResult> {
  const proc = Bun.spawn(['jj', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);

  if (!options?.allowFailure && exitCode !== 0) {
    throw new Error(`jj ${args.join(' ')} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }

  return { exitCode, stdout, stderr };
}

async function runJjOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runJj(cwd, args);
  return result.stdout.trim();
}

async function configureGitUser(cwd: string): Promise<void> {
  await runGit(cwd, ['config', 'user.email', 'test@example.com']);
  await runGit(cwd, ['config', 'user.name', 'Test User']);
}

async function initJjColocatedRepository(cwd: string): Promise<void> {
  await runJj(cwd, ['git', 'init', '--colocate']);
  await runJj(cwd, ['config', 'set', '--repo', 'user.email', 'test@example.com']);
  await runJj(cwd, ['config', 'set', '--repo', 'user.name', 'Test User']);
}

async function configureJjUser(cwd: string): Promise<void> {
  await runJj(cwd, ['config', 'set', '--repo', 'user.email', 'test@example.com']);
  await runJj(cwd, ['config', 'set', '--repo', 'user.name', 'Test User']);
}

async function writeTrackedFile(cwd: string, fileName: string, content: string): Promise<void> {
  await fs.writeFile(path.join(cwd, fileName), content);
  await runGit(cwd, ['add', fileName]);
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await runGit(cwd, ['commit', '-m', message]);
}

async function getLocalHead(cwd: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
}

async function getRemoteRef(originDir: string, refName: string): Promise<string | null> {
  const result = await runGit(originDir, ['rev-parse', `refs/heads/${refName}`], {
    allowFailure: true,
  });

  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function fetchOrigin(cwd: string): Promise<void> {
  await runGit(cwd, ['fetch', 'origin']);
}

async function isAncestor(
  cwd: string,
  ancestorRef: string,
  descendantRef: string
): Promise<boolean> {
  const result = await runGit(cwd, ['merge-base', '--is-ancestor', ancestorRef, descendantRef], {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function isRebaseInProgress(cwd: string): Promise<boolean> {
  const gitDir = (await runGit(cwd, ['rev-parse', '--git-path', 'rebase-merge'])).stdout.trim();
  const rebaseMergePath = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);
  try {
    await fs.access(rebaseMergePath);
    return true;
  } catch {
    const applyDir = (await runGit(cwd, ['rev-parse', '--git-path', 'rebase-apply'])).stdout.trim();
    const rebaseApplyPath = path.isAbsolute(applyDir) ? applyDir : path.join(cwd, applyDir);
    try {
      await fs.access(rebaseApplyPath);
      return true;
    } catch {
      return false;
    }
  }
}

async function createTestRepo(options?: {
  featureBranch?: string;
  pushFeature?: boolean;
  advanceMain?: 'none' | 'safe' | 'conflict';
}): Promise<TestRepo> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-rebase-test-'));
  const originDir = path.join(tempRoot, 'origin.git');
  const upstreamDir = path.join(tempRoot, 'upstream');
  const workDir = path.join(tempRoot, 'work');
  const featureBranch = options?.featureBranch ?? 'feature/rebase-test';
  const advanceMain = options?.advanceMain ?? 'safe';

  await runGit(tempRoot, ['init', '--bare', originDir]);
  await runGit(tempRoot, ['clone', originDir, upstreamDir]);
  await configureGitUser(upstreamDir);

  await writeTrackedFile(upstreamDir, 'shared.txt', 'base\n');
  await commitAll(upstreamDir, 'initial commit');
  await runGit(upstreamDir, ['push', '-u', 'origin', 'main'], { allowFailure: true });
  await runGit(upstreamDir, ['branch', '--set-upstream-to=origin/main', 'main'], {
    allowFailure: true,
  });
  await runGit(upstreamDir, ['push', '-u', 'origin', 'main']);

  await runGit(tempRoot, ['clone', originDir, workDir]);
  await configureGitUser(workDir);

  await runGit(workDir, ['checkout', '-b', featureBranch]);
  if (advanceMain === 'conflict') {
    await writeTrackedFile(workDir, 'shared.txt', 'feature change\n');
  } else {
    await writeTrackedFile(workDir, 'feature.txt', 'feature branch\n');
  }
  await commitAll(workDir, 'feature commit');

  if (options?.pushFeature !== false) {
    await runGit(workDir, ['push', '-u', 'origin', featureBranch]);
  }

  if (advanceMain !== 'none') {
    await runGit(upstreamDir, ['checkout', 'main']);
    if (advanceMain === 'conflict') {
      await writeTrackedFile(upstreamDir, 'shared.txt', 'main change\n');
    } else {
      await writeTrackedFile(upstreamDir, 'main.txt', 'main branch change\n');
    }
    await commitAll(upstreamDir, 'main update');
    await runGit(upstreamDir, ['push', 'origin', 'main']);
  }

  return { tempRoot, originDir, upstreamDir, workDir, featureBranch };
}

interface StackedTestRepo extends TestRepo {
  baseBranch: string;
}

async function createJjStackedTestRepo(options?: {
  childBranch?: string;
  baseBranch?: string;
  deleteBaseFromRemote?: boolean;
}): Promise<StackedTestRepo> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-rebase-jj-stacked-'));
  const originDir = path.join(tempRoot, 'origin.git');
  const upstreamDir = path.join(tempRoot, 'upstream');
  const workDir = path.join(tempRoot, 'work');
  const baseBranch = options?.baseBranch ?? 'feature/base-pr';
  const childBranch = options?.childBranch ?? 'feature/child-pr';

  await fs.mkdir(upstreamDir, { recursive: true });
  await runGit(tempRoot, ['init', '--bare', originDir]);
  await initJjColocatedRepository(upstreamDir);
  await runJj(upstreamDir, ['git', 'remote', 'add', 'origin', originDir]);

  // Create and push main bookmark.
  await fs.writeFile(path.join(upstreamDir, 'shared.txt'), 'base content\n');
  await runJj(upstreamDir, ['commit', '-m', 'initial commit']);
  await runJj(upstreamDir, ['bookmark', 'set', '-r', '@-', 'main']);
  await runJj(upstreamDir, ['git', 'push', '--bookmark', 'main']);

  // Create and push base bookmark.
  await runJj(upstreamDir, ['new', 'main']);
  await fs.writeFile(path.join(upstreamDir, 'base.txt'), 'base branch feature\n');
  await runJj(upstreamDir, ['commit', '-m', 'base branch commit']);
  await runJj(upstreamDir, ['bookmark', 'set', '-r', '@-', baseBranch]);
  await runJj(upstreamDir, ['git', 'push', '--bookmark', baseBranch]);

  // Clone the JJ repo and create/push child bookmark from base.
  await runJj(tempRoot, ['git', 'clone', originDir, workDir]);
  await configureJjUser(workDir);
  await runJj(workDir, ['bookmark', 'track', baseBranch, '--remote', 'origin']);
  await runJj(workDir, ['new', `${baseBranch}@origin`]);
  await fs.writeFile(path.join(workDir, 'child.txt'), 'child branch feature\n');
  await runJj(workDir, ['commit', '-m', 'child branch commit']);
  await runJj(workDir, ['bookmark', 'set', '-r', '@-', childBranch]);
  await runJj(workDir, ['git', 'push', '--bookmark', childBranch]);

  // Advance main after the stack is created.
  await runJj(upstreamDir, ['new', 'main']);
  await fs.writeFile(path.join(upstreamDir, 'main.txt'), 'main update\n');
  await runJj(upstreamDir, ['commit', '-m', 'advance main']);
  await runJj(upstreamDir, ['bookmark', 'set', '-r', '@-', 'main']);
  await runJj(upstreamDir, ['git', 'push', '--bookmark', 'main']);

  if (options?.deleteBaseFromRemote) {
    await runGit(upstreamDir, ['push', 'origin', '--delete', baseBranch]);
  }

  return { tempRoot, originDir, upstreamDir, workDir, featureBranch: childBranch, baseBranch };
}

async function createStackedTestRepo(options?: {
  childBranch?: string;
  baseBranch?: string;
  deleteBaseFromRemote?: boolean;
}): Promise<StackedTestRepo> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-rebase-stacked-'));
  const originDir = path.join(tempRoot, 'origin.git');
  const upstreamDir = path.join(tempRoot, 'upstream');
  const workDir = path.join(tempRoot, 'work');
  const baseBranch = options?.baseBranch ?? 'feature/base-pr';
  const childBranch = options?.childBranch ?? 'feature/child-pr';

  // Initialize bare origin and upstream clone
  await runGit(tempRoot, ['init', '--bare', originDir]);
  await runGit(tempRoot, ['clone', originDir, upstreamDir]);
  await configureGitUser(upstreamDir);

  // Create initial commit on main
  await writeTrackedFile(upstreamDir, 'shared.txt', 'base content\n');
  await commitAll(upstreamDir, 'initial commit');
  await runGit(upstreamDir, ['push', '-u', 'origin', 'main'], { allowFailure: true });
  await runGit(upstreamDir, ['push', '-u', 'origin', 'main']);

  // Create base branch from main and push it
  await runGit(upstreamDir, ['checkout', '-b', baseBranch]);
  await writeTrackedFile(upstreamDir, 'base.txt', 'base branch feature\n');
  await commitAll(upstreamDir, 'base branch commit');
  await runGit(upstreamDir, ['push', '-u', 'origin', baseBranch]);

  // Clone into work dir
  await runGit(tempRoot, ['clone', originDir, workDir]);
  await configureGitUser(workDir);

  // Create child branch from base branch in work dir
  await runGit(workDir, ['checkout', '-b', baseBranch, `origin/${baseBranch}`]);
  await runGit(workDir, ['checkout', '-b', childBranch]);
  await writeTrackedFile(workDir, 'child.txt', 'child branch feature\n');
  await commitAll(workDir, 'child branch commit');
  await runGit(workDir, ['push', '-u', 'origin', childBranch]);

  // Advance main past where it was when we forked
  await runGit(upstreamDir, ['checkout', 'main']);
  await writeTrackedFile(upstreamDir, 'main.txt', 'main update\n');
  await commitAll(upstreamDir, 'advance main');
  await runGit(upstreamDir, ['push', 'origin', 'main']);

  if (options?.deleteBaseFromRemote) {
    await runGit(upstreamDir, ['push', 'origin', '--delete', baseBranch]);
  }

  return { tempRoot, originDir, upstreamDir, workDir, featureBranch: childBranch, baseBranch };
}

function buildPlan(overrides?: Record<string, unknown>) {
  return {
    id: 263,
    uuid: 'plan-263',
    title: 'Update a plan branch to latest main',
    goal: 'Keep the plan branch current',
    status: 'in_progress',
    tasks: [],
    ...overrides,
  };
}

function mockPlanForRepo(
  repoDir: string,
  plan: Record<string, unknown>,
  configOverrides?: Record<string, unknown>
): void {
  vi.mocked(loadEffectiveConfig).mockResolvedValue({
    defaultExecutor: 'mock-executor',
    terminalInput: false,
    ...configOverrides,
  } as any);
  vi.mocked(resolveRepoRoot).mockResolvedValue(repoDir);
  vi.mocked(resolvePlanByNumericId).mockResolvedValue({
    plan,
    planPath: path.join(repoDir, '.tim', 'plans', `${String(plan.id ?? 'plan')}.plan.md`),
  } as any);
}

describe('handleRebaseCommand', () => {
  let originalCwd: string;
  let tempDirs: string[];
  const executorExecute = vi.fn();

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDirs = [];
    executorExecute.mockReset();
    vi.clearAllMocks();
    vi.mocked(buildExecutorAndLog).mockReturnValue({
      execute: executorExecute,
    } as any);
    clearGitRootCache();
    resetGitRepositoryCache();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    clearGitRootCache();
    resetGitRepositoryCache();
    vi.clearAllMocks();

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('rebases a plan branch with an explicit branch name and pushes the updated history', async () => {
    const repo = await createTestRepo({ featureBranch: 'custom-topic', advanceMain: 'safe' });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: 'custom-topic',
        title: 'A title whose generated branch would not match',
      })
    );

    process.chdir(repo.workDir);
    const beforeRemoteFeature = await getRemoteRef(repo.originDir, 'custom-topic');

    await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

    await fetchOrigin(repo.workDir);
    const afterRemoteFeature = await getRemoteRef(repo.originDir, 'custom-topic');
    expect(afterRemoteFeature).not.toBe(beforeRemoteFeature);
    expect(await isAncestor(repo.workDir, 'origin/main', 'custom-topic')).toBe(true);
    expect(buildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('uses the generated branch name when the plan does not specify one', async () => {
    const plan = buildPlan({
      title: 'Update a plan branch to latest main',
    });
    const repo = await createTestRepo({
      featureBranch: '263-update-a-plan-branch-to-latest-main',
      advanceMain: 'safe',
    });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(repo.workDir, plan);

    process.chdir(repo.workDir);
    const beforeRemoteFeature = await getRemoteRef(
      repo.originDir,
      '263-update-a-plan-branch-to-latest-main'
    );

    await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

    const afterRemoteFeature = await getRemoteRef(
      repo.originDir,
      '263-update-a-plan-branch-to-latest-main'
    );
    expect(afterRemoteFeature).not.toBe(beforeRemoteFeature);
    expect(buildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('uses branchPrefix from config when generating branch name for plans without explicit branch', async () => {
    const plan = buildPlan({
      title: 'Update a plan branch to latest main',
    });
    const repo = await createTestRepo({
      featureBranch: 'di/263-update-a-plan-branch-to-latest-main',
      advanceMain: 'safe',
    });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(repo.workDir, plan, { branchPrefix: 'di/' });

    process.chdir(repo.workDir);
    const beforeRemoteFeature = await getRemoteRef(
      repo.originDir,
      'di/263-update-a-plan-branch-to-latest-main'
    );

    await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

    const afterRemoteFeature = await getRemoteRef(
      repo.originDir,
      'di/263-update-a-plan-branch-to-latest-main'
    );
    expect(afterRemoteFeature).not.toBe(beforeRemoteFeature);
    expect(buildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('reloads config from target repo when rebasing with cross-repo config', async () => {
    const plan = buildPlan({
      title: 'Update a plan branch to latest main',
    });
    const repo = await createTestRepo({
      featureBranch: 'di/263-update-a-plan-branch-to-latest-main',
      advanceMain: 'safe',
    });
    tempDirs.push(repo.tempRoot);
    const callerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-rebase-caller-'));
    tempDirs.push(callerDir);

    vi.mocked(loadEffectiveConfig).mockImplementation(async (_overridePath, options) => {
      if (options?.cwd === repo.workDir) {
        return {
          defaultExecutor: 'mock-executor',
          terminalInput: false,
          branchPrefix: 'di/',
        } as any;
      }

      return {
        defaultExecutor: 'mock-executor',
        terminalInput: false,
      } as any;
    });
    vi.mocked(resolveRepoRoot).mockResolvedValue(repo.workDir);
    vi.mocked(resolvePlanByNumericId).mockResolvedValue({
      plan,
      planPath: path.join(repo.workDir, '.tim', 'plans', '263.plan.md'),
    } as any);

    process.chdir(callerDir);
    const beforeRemoteFeature = await getRemoteRef(
      repo.originDir,
      'di/263-update-a-plan-branch-to-latest-main'
    );

    await handleRebaseCommand('263', {}, {
      parent: { opts: () => ({}) },
    } as any);

    const afterRemoteFeature = await getRemoteRef(
      repo.originDir,
      'di/263-update-a-plan-branch-to-latest-main'
    );
    expect(afterRemoteFeature).not.toBe(beforeRemoteFeature);
    expect(loadEffectiveConfig).toHaveBeenCalledWith(undefined, { cwd: repo.workDir });
  });

  test('returns without pushing when the branch is already based on the latest main', async () => {
    const repo = await createTestRepo({ advanceMain: 'none' });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: repo.featureBranch,
      })
    );

    process.chdir(repo.workDir);
    const beforeLocalHead = await getLocalHead(repo.workDir);
    const beforeRemoteFeature = await getRemoteRef(repo.originDir, repo.featureBranch);

    await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

    expect(await getLocalHead(repo.workDir)).toBe(beforeLocalHead);
    expect(await getRemoteRef(repo.originDir, repo.featureBranch)).toBe(beforeRemoteFeature);
    expect(buildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('rebases locally but skips pushing when --no-push is provided', async () => {
    const repo = await createTestRepo({ advanceMain: 'safe' });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: repo.featureBranch,
      })
    );

    process.chdir(repo.workDir);
    const beforeLocalHead = await getLocalHead(repo.workDir);
    const beforeRemoteFeature = await getRemoteRef(repo.originDir, repo.featureBranch);

    await handleRebaseCommand('263', { push: false }, { parent: { opts: () => ({}) } } as any);

    const afterLocalHead = await getLocalHead(repo.workDir);
    const afterRemoteFeature = await getRemoteRef(repo.originDir, repo.featureBranch);
    expect(afterLocalHead).not.toBe(beforeLocalHead);
    expect(afterRemoteFeature).toBe(beforeRemoteFeature);
    expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
  });

  test('aborts an in-progress git rebase when the conflict-resolution executor fails', async () => {
    const repo = await createTestRepo({ advanceMain: 'conflict' });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: repo.featureBranch,
      })
    );
    executorExecute.mockRejectedValueOnce(new Error('executor failed'));

    process.chdir(repo.workDir);
    const beforeLocalHead = await getLocalHead(repo.workDir);

    await expect(
      handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any)
    ).rejects.toThrow('executor failed');

    expect(buildExecutorAndLog).toHaveBeenCalledTimes(1);
    expect(await isRebaseInProgress(repo.workDir)).toBe(false);
    expect(await getLocalHead(repo.workDir)).toBe(beforeLocalHead);
  });

  test('errors when conflicts remain after the executor session finishes', async () => {
    const repo = await createTestRepo({ advanceMain: 'conflict' });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: repo.featureBranch,
      })
    );
    executorExecute.mockResolvedValueOnce(undefined);

    process.chdir(repo.workDir);

    await expect(
      handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any)
    ).rejects.toThrow('Conflicts remain after the executor session finished');

    expect(buildExecutorAndLog).toHaveBeenCalledTimes(1);
    expect(executorExecute).toHaveBeenCalledWith(
      expect.stringContaining('git rebase --continue'),
      expect.objectContaining({
        executionMode: 'bare',
      })
    );
    expect(await isRebaseInProgress(repo.workDir)).toBe(true);
  });

  test('pushes a local-only branch even when rebasing onto the latest main is a no-op', async () => {
    const repo = await createTestRepo({ advanceMain: 'none', pushFeature: false });
    tempDirs.push(repo.tempRoot);
    const localOnlyBranch = 'local-only-noop-branch';

    await runGit(repo.workDir, ['checkout', 'main']);
    await runGit(repo.workDir, ['checkout', '-b', localOnlyBranch]);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: localOnlyBranch,
      })
    );

    process.chdir(repo.workDir);
    const beforeLocalHead = await getLocalHead(repo.workDir);
    expect(await getRemoteRef(repo.originDir, localOnlyBranch)).toBeNull();

    await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

    expect(await getLocalHead(repo.workDir)).toBe(beforeLocalHead);
    expect(await getRemoteRef(repo.originDir, localOnlyBranch)).toBe(beforeLocalHead);
    expect(buildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('throws when the plan branch does not exist locally or on origin', async () => {
    const repo = await createTestRepo({ pushFeature: false, advanceMain: 'none' });
    tempDirs.push(repo.tempRoot);
    mockPlanForRepo(
      repo.workDir,
      buildPlan({
        branch: 'missing-branch',
      })
    );

    process.chdir(repo.workDir);

    await expect(
      handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any)
    ).rejects.toThrow('Branch "missing-branch" does not exist locally or on origin.');
  });

  test('throws when no plan selector is provided', async () => {
    const repo = await createTestRepo({ advanceMain: 'none' });
    tempDirs.push(repo.tempRoot);
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'mock-executor',
      terminalInput: false,
    } as any);
    vi.mocked(resolveRepoRoot).mockResolvedValue(repo.workDir);

    process.chdir(repo.workDir);

    await expect(
      handleRebaseCommand(undefined, {}, { parent: { opts: () => ({}) } } as any)
    ).rejects.toThrow('Please provide a numeric plan ID or use --next/--current to find a plan.');
  });

  test('wraps execution in runWithHeadlessAdapterIfEnabled with plan metadata', async () => {
    const repo = await createTestRepo({ advanceMain: 'safe' });
    tempDirs.push(repo.tempRoot);
    const plan = buildPlan({
      branch: repo.featureBranch,
    });
    mockPlanForRepo(repo.workDir, plan);

    process.chdir(repo.workDir);

    await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledTimes(1);
    const callArgs = runWithHeadlessAdapterIfEnabledMock.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      command: 'rebase',
      plan: {
        id: 263,
        uuid: 'plan-263',
        title: 'Update a plan branch to latest main',
      },
    });
    expect(typeof callArgs.callback).toBe('function');
  });

  describe('base branch tracking', () => {
    test('rebases onto baseBranch when it exists on remote', async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      // Verify that after rebase, child is now based on base branch (not trunk)
      await fetchOrigin(repo.workDir);
      // The child branch should be based on the base branch tip
      expect(await isAncestor(repo.workDir, `origin/${repo.baseBranch}`, repo.featureBranch)).toBe(
        true
      );
      // clearPlanBaseTracking should NOT have been called (base branch still exists)
      expect(vi.mocked(clearPlanBaseTracking)).not.toHaveBeenCalled();
      // setPlanBaseTracking should have been called to update baseCommit with an actual hash
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263',
        expect.objectContaining({ baseCommit: expect.any(String) })
      );
    });

    test('falls back to trunk and clears base fields when baseBranch is deleted from remote', async () => {
      const repo = await createStackedTestRepo({ deleteBaseFromRemote: true });
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      await fetchOrigin(repo.workDir);
      // The child branch should now be based on main/trunk
      expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
      // clearPlanBaseTracking should have been called since base branch is gone
      expect(vi.mocked(clearPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263'
      );
      // setPlanBaseTracking should NOT have been called with baseCommit (we're on trunk)
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();
    });

    test('--base overrides plan baseBranch and persists the new base', async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: 'some-other-branch',
        })
      );

      process.chdir(repo.workDir);

      // Use --base to explicitly target repo.baseBranch
      await handleRebaseCommand('263', { base: repo.baseBranch }, {
        parent: { opts: () => ({}) },
      } as any);

      await fetchOrigin(repo.workDir);
      // Verify the child is now based on the explicitly provided base branch
      expect(await isAncestor(repo.workDir, `origin/${repo.baseBranch}`, repo.featureBranch)).toBe(
        true
      );
      // setPlanBaseTracking should have been called to persist baseBranch and baseCommit
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263',
        expect.objectContaining({ baseBranch: repo.baseBranch, baseCommit: expect.any(String) })
      );
    });

    test('--base <trunk> rebases onto trunk and clears base fields', async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      // --base main explicitly targets trunk
      await handleRebaseCommand('263', { base: 'main' }, { parent: { opts: () => ({}) } } as any);

      await fetchOrigin(repo.workDir);
      // Verify the child is now based on main
      expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
      // clearPlanBaseTracking should have been called
      expect(vi.mocked(clearPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263'
      );
      // setPlanBaseTracking should NOT have been called
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();
    });

    test('--base with a non-existent branch throws an error', async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
        })
      );

      process.chdir(repo.workDir);

      await expect(
        handleRebaseCommand('263', { base: 'nonexistent-branch' }, {
          parent: { opts: () => ({}) },
        } as any)
      ).rejects.toThrow('Base branch "nonexistent-branch" does not exist on remote.');
    });

    test("--base with plan's own branch name throws an error", async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      await expect(
        handleRebaseCommand('263', { base: repo.featureBranch }, {
          parent: { opts: () => ({}) },
        } as any)
      ).rejects.toThrow(
        `Base branch "${repo.featureBranch}" is the same as the plan's own branch. A plan cannot use its own branch as its base.`
      );
    });

    test('no baseBranch rebases onto trunk without touching base tracking', async () => {
      const repo = await createTestRepo({ advanceMain: 'safe' });
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          // no baseBranch set
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      await fetchOrigin(repo.workDir);
      // Should be based on trunk
      expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
      // No base tracking calls since no baseBranch was set
      expect(vi.mocked(clearPlanBaseTracking)).not.toHaveBeenCalled();
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();
    });

    test('baseBranch equal to trunk is treated as no baseBranch (no base tracking)', async () => {
      const repo = await createTestRepo({ advanceMain: 'safe' });
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: 'main', // same as trunk
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      await fetchOrigin(repo.workDir);
      expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
      // baseBranch === trunk means no base tracking update needed
      expect(vi.mocked(clearPlanBaseTracking)).not.toHaveBeenCalled();
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();
    });

    test('transport error when checking baseBranch remote existence aborts rebase (does not fall back to trunk)', async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      // Simulate a transport failure (not "branch missing" — a real network/auth error)
      const remoteExistsSpy = vi
        .spyOn(git, 'remoteBranchExists')
        .mockRejectedValue(new Error('fatal: unable to connect to remote: connection refused'));

      // handleRebaseCommand must reject — it must NOT silently fall back to trunk
      try {
        await expect(
          handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any)
        ).rejects.toThrow();

        // Tracking was NOT cleared — we don't know the base branch is gone
        expect(vi.mocked(clearPlanBaseTracking)).not.toHaveBeenCalled();
      } finally {
        remoteExistsSpy.mockRestore();
      }
    });

    test('plan.baseBranch matching own branch falls back to trunk with warning', async () => {
      const repo = await createStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.featureBranch,
        })
      );

      process.chdir(repo.workDir);

      const remoteExistsSpy = vi.spyOn(git, 'remoteBranchExists');
      try {
        await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);
        expect(remoteExistsSpy).not.toHaveBeenCalled();
      } finally {
        remoteExistsSpy.mockRestore();
      }

      await fetchOrigin(repo.workDir);
      expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
      expect(vi.mocked(clearPlanBaseTracking)).toHaveBeenCalledWith(
        expect.objectContaining({}),
        expect.anything(),
        'plan-263'
      );
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();
    });
  });

  describe('JJ base branch tracking', () => {
    test('JJ: rebases onto baseBranch bookmark when it exists on remote', async () => {
      if (!(await isJjAvailable())) {
        return;
      }
      const repo = await createJjStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      await fetchOrigin(repo.workDir);
      expect(await isAncestor(repo.workDir, `origin/${repo.baseBranch}`, repo.featureBranch)).toBe(
        true
      );
      expect(vi.mocked(clearPlanBaseTracking)).not.toHaveBeenCalled();
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263',
        expect.objectContaining({
          baseCommit: expect.any(String),
          baseChangeId: expect.any(String),
        })
      );
    });

    test('JJ: falls back to trunk when baseBranch bookmark is deleted', async () => {
      if (!(await isJjAvailable())) {
        return;
      }
      const repo = await createJjStackedTestRepo({ deleteBaseFromRemote: true });
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      await fetchOrigin(repo.workDir);
      expect(await isAncestor(repo.workDir, 'origin/main', repo.featureBranch)).toBe(true);
      expect(vi.mocked(clearPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263'
      );
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();
    });

    test('JJ: --base overrides plan baseBranch and persists it', async () => {
      if (!(await isJjAvailable())) {
        return;
      }
      const repo = await createJjStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: 'some-other-base',
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', { base: repo.baseBranch }, {
        parent: { opts: () => ({}) },
      } as any);

      await fetchOrigin(repo.workDir);
      expect(await isAncestor(repo.workDir, `origin/${repo.baseBranch}`, repo.featureBranch)).toBe(
        true
      );
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263',
        expect.objectContaining({
          baseBranch: repo.baseBranch,
          baseCommit: expect.any(String),
          baseChangeId: expect.any(String),
        })
      );
    });

    test('JJ: tracks merge-base commit and change id after rebase', async () => {
      if (!(await isJjAvailable())) {
        return;
      }
      const repo = await createJjStackedTestRepo();
      tempDirs.push(repo.tempRoot);

      mockPlanForRepo(
        repo.workDir,
        buildPlan({
          branch: repo.featureBranch,
          baseBranch: repo.baseBranch,
        })
      );

      process.chdir(repo.workDir);

      await handleRebaseCommand('263', {}, { parent: { opts: () => ({}) } } as any);

      const mergeBaseCommit = await runJjOutput(repo.workDir, [
        'log',
        '-r',
        `heads(::${repo.featureBranch} & ::${repo.baseBranch})`,
        '--no-graph',
        '-T',
        'commit_id',
        '--limit',
        '1',
      ]);
      const mergeBaseChangeId = await runJjOutput(repo.workDir, [
        'log',
        '-r',
        mergeBaseCommit,
        '--no-graph',
        '-T',
        'change_id',
        '--limit',
        '1',
      ]);

      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'plan-263',
        expect.objectContaining({
          baseCommit: mergeBaseCommit,
          baseChangeId: mergeBaseChangeId,
        })
      );
    });
  });
});
