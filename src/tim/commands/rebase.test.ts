import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearGitRootCache, resetGitRepositoryCache } from '../../common/git.js';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'mock-executor',
}));

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRootForPlanArg: vi.fn(),
}));

import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { handleRebaseCommand } from './rebase.js';

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

async function configureGitUser(cwd: string): Promise<void> {
  await runGit(cwd, ['config', 'user.email', 'test@example.com']);
  await runGit(cwd, ['config', 'user.name', 'Test User']);
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

function mockPlanForRepo(repoDir: string, plan: Record<string, unknown>): void {
  vi.mocked(loadEffectiveConfig).mockResolvedValue({
    defaultExecutor: 'mock-executor',
    terminalInput: false,
  } as any);
  vi.mocked(resolveRepoRootForPlanArg).mockResolvedValue(repoDir);
  vi.mocked(resolvePlanFromDbOrSyncFile).mockResolvedValue({
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
    vi.mocked(resolveRepoRootForPlanArg).mockResolvedValue(repo.workDir);

    process.chdir(repo.workDir);

    await expect(
      handleRebaseCommand(undefined, {}, { parent: { opts: () => ({}) } } as any)
    ).rejects.toThrow('Please provide a plan file or use --next/--current to find a plan.');
  });
});
