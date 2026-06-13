import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return {
    ...actual,
    getUsingJj: vi.fn(),
    getCurrentBranchName: vi.fn(),
    getTrunkBranch: vi.fn(),
    remoteBranchExists: vi.fn(),
    getGitRoot: vi.fn(),
  };
});

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude-code',
}));

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: vi.fn(),
  };
});

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRoot: vi.fn(),
}));

vi.mock('../executors/codex_cli/app_server_mode.js', () => ({
  isCodexAppServerEnabled: vi.fn(),
}));

vi.mock('../environment_options.js', () => ({
  buildTimWorkspaceCommandEnvironmentOptionsForPath: vi.fn(),
  getWorkspaceInfoByPathIfAvailable: vi.fn(),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../db/database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/database.js')>();
  return {
    ...actual,
    getDatabase: vi.fn(),
  };
});

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(),
  runPreExecutionWorkspaceSync: vi.fn(),
  runPostExecutionWorkspaceSync: vi.fn(),
  materializePlansForExecution: vi.fn(),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  touchWorkspaceInfo: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => ({
  startup: vi.fn(),
  shutdown: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  LifecycleManager: vi.fn(function (this: unknown, ...args: unknown[]) {
    lifecycleMocks.ctor(...args);
    return {
      startup: lifecycleMocks.startup,
      shutdown: lifecycleMocks.shutdown,
    };
  }),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

vi.mock('../utils/pr_context_gathering.js', () => ({
  gatherPrContext: vi.fn(),
}));

import {
  buildAutoreviewPrompt,
  handleAutoreviewCommand,
  type AutoreviewCommandOptions,
  type AutoreviewLinkedPr,
} from './autoreview.js';
import type {
  PlanReviewTarget,
  CurrentWorktreeReviewTarget,
  BranchReviewTarget,
  PullRequestReviewTarget,
} from './review_target.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { isCodexAppServerEnabled } from '../executors/codex_cli/app_server_mode.js';
import {
  getUsingJj,
  getCurrentBranchName,
  getTrunkBranch,
  remoteBranchExists,
} from '../../common/git.js';
import { resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { LifecycleManager } from '../lifecycle.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { touchWorkspaceInfo } from '../workspace/workspace_info.js';
import { gatherPrContext } from '../utils/pr_context_gathering.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { DATABASE_FILENAME, getDatabase, openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { nonSyncedUpsertPlan } from '../db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '../db/pr_status.js';

// ─── buildAutoreviewPrompt unit tests ───────────────────────────────────────

describe('buildAutoreviewPrompt', () => {
  const planTarget: PlanReviewTarget = {
    kind: 'plan',
    planId: 376,
    planPath: '/repo/.tim/plans/376.plan.md',
    plan: { id: 376, title: 'autoreview command', uuid: 'uuid-376' } as any,
    repoRoot: '/repo',
  };

  const currentTarget: CurrentWorktreeReviewTarget = {
    kind: 'current',
    repoRoot: '/repo',
    currentBranch: 'feature/my-branch',
    baseBranch: 'main',
    worktreePath: '/repo',
  };

  const branchTarget: BranchReviewTarget = {
    kind: 'branch',
    repoRoot: '/repo',
    requestedBranch: 'feature/some-branch',
    baseBranch: 'main',
  };

  const prTarget: PullRequestReviewTarget = {
    kind: 'pr',
    repoRoot: '/repo',
    canonicalPrUrl: 'https://github.com/org/repo/pull/42',
    prNumber: 42,
    title: 'My PR',
    owner: 'org',
    repo: 'repo',
    baseBranch: 'main',
    headBranch: 'feature/my-branch',
    headSha: 'abc1234',
    prStatus: {} as any,
  };

  test('plan-backed target includes correct review command with planId', () => {
    const prompt = buildAutoreviewPrompt({ target: planTarget });
    expect(prompt).toContain('tim review 376 --print');
  });

  test('plan-backed target mentions tim subagent implementer with planId', () => {
    const prompt = buildAutoreviewPrompt({ target: planTarget });
    expect(prompt).toContain('tim subagent implementer 376');
  });

  test('planless current target includes --current review command', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('tim review --current --print');
  });

  test('planless current target does not mention tim subagent implementer', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).not.toContain('tim subagent implementer');
  });

  test('branch target includes --branch review command with branch name', () => {
    const prompt = buildAutoreviewPrompt({ target: branchTarget });
    expect(prompt).toContain('tim review --branch feature/some-branch --print');
  });

  test('branch target does not mention tim subagent implementer', () => {
    const prompt = buildAutoreviewPrompt({ target: branchTarget });
    expect(prompt).not.toContain('tim subagent implementer');
  });

  test('PR target includes --pr review command with PR number', () => {
    const prompt = buildAutoreviewPrompt({ target: prTarget });
    expect(prompt).toContain('tim review --pr 42 --print');
  });

  test('PR target does not mention tim subagent implementer', () => {
    const prompt = buildAutoreviewPrompt({ target: prTarget });
    expect(prompt).not.toContain('tim subagent implementer');
  });

  test('includes skip/dedup guidance to remember skipped issues', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('remember every issue the user declines or asks to skip');
    expect(prompt).toContain('Do not re-raise skipped issues in later iterations');
  });

  test('instructs display output to include complete issue contents and suggestions', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('include the complete issue content from the review JSON');
    expect(prompt).toContain('Do not summarize, truncate, or omit suggestions');
    expect(prompt).toContain('decide whether and how each issue should be fixed');
  });

  test('instructs display output to combine duplicate issues from multiple sources', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('duplicate reports of the same underlying issue');
    expect(prompt).toContain('issues can come from multiple sources');
    expect(prompt).toContain('Combine duplicates into one displayed issue');
  });

  test('includes guidance to suppress re-reported issues that match skipped ones', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('Never nag the user about issues they explicitly skipped');
  });

  test('includes subagent delegation line for planless target', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('non-conflicting, independent fixes');
    expect(prompt).toContain('your own subagent capability');
  });

  test('includes subagent delegation line for plan-backed target', () => {
    const prompt = buildAutoreviewPrompt({ target: planTarget });
    expect(prompt).toContain('non-conflicting, independent fixes');
    expect(prompt).toContain('your own subagent capability');
  });

  test('includes loop and stop guidance', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('no un-skipped issues remain');
  });

  test('useJj: true includes jj commit and push guidance', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, useJj: true });
    expect(prompt).toContain('commit and push the changes');
    expect(prompt).toContain('appears to use Jujutsu (jj)');
  });

  test('useJj: false includes git commit and push guidance', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, useJj: false });
    expect(prompt).toContain('commit and push the changes');
    expect(prompt).toContain('appears to use git');
  });

  test('useJj: undefined (default) includes git commit and push guidance', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('commit and push the changes');
    expect(prompt).toContain('appears to use git');
  });

  test('prompt does not include executor details', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).not.toContain('executor');
  });

  test('includes end-of-session summary instruction', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('summary');
  });

  test('warns that tim review may take a long time without output', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('will likely take a long time to run');
    expect(prompt).toContain('do not expect any output for a while');
  });

  test('plan target prompt includes plan title in description when available', () => {
    const prompt = buildAutoreviewPrompt({ target: planTarget });
    expect(prompt).toContain('autoreview command');
  });

  test('current target with branch name includes branch in description', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('feature/my-branch');
  });

  test('PR target includes PR number and title in description', () => {
    const prompt = buildAutoreviewPrompt({ target: prTarget });
    expect(prompt).toContain('#42');
    expect(prompt).toContain('My PR');
  });

  // ── --base option ─────────────────────────────────────────────────────────

  test('current target with base appends --base to review command', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, base: 'develop' });
    expect(prompt).toContain('tim review --current --base develop --print');
  });

  test('branch target with base appends --base to review command', () => {
    const prompt = buildAutoreviewPrompt({ target: branchTarget, base: 'develop' });
    expect(prompt).toContain('tim review --branch feature/some-branch --base develop --print');
  });

  test('pr target with base appends --base to review command', () => {
    const prompt = buildAutoreviewPrompt({ target: prTarget, base: 'develop' });
    expect(prompt).toContain('tim review --pr 42 --base develop --print');
  });

  test('plan target with base does not append --base to review command', () => {
    const prompt = buildAutoreviewPrompt({ target: planTarget, base: 'develop' });
    expect(prompt).toContain('tim review 376 --print');
    expect(prompt).not.toContain('--base');
  });

  test('current target without base has no --base in review command', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).toContain('tim review --current --print');
    expect(prompt).not.toContain('--base');
  });

  // ── PR Review Trail section ────────────────────────────────────────────────

  const linkedPr: AutoreviewLinkedPr = {
    prNumber: 123,
    owner: 'acme',
    repo: 'widgets',
    url: 'https://github.com/acme/widgets/pull/123',
    title: 'My PR',
  };

  test('with linkedPr: PR Review Trail heading appears', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('## PR Review Trail');
  });

  test('with linkedPr: PR number and owner/repo are interpolated', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('#123');
    expect(prompt).toContain('acme/widgets');
  });

  test('with linkedPr: ignored-issue-resolve-immediately instruction is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    // Bind ignored issues, immediate reply, user reasoning, and resolution together so the
    // assertion fails if any part of the protocol is dropped.
    expect(prompt).toContain(
      "For ignored issues that have an inline thread, immediately reply with the user's stated reason for ignoring the issue and resolve the thread"
    );
    // Body-only ignored issues have no thread, so the initial body-only description carries
    // the ignore reason and no separate follow-up is needed.
    expect(prompt).toContain(
      "For ignored issues that are body-only (un-anchorable, so there is no thread), include the user's stated ignore reason in the initial body-only description"
    );
    expect(prompt).toContain(
      'Do not add a separate follow-up comment for ignored body-only issues'
    );
  });

  test('with linkedPr: reply-and-resolve-after-commit instruction is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('After fixes are committed');
    expect(prompt).toContain('push the commits to the PR branch before resolving');
    expect(prompt).toContain('Do not mark addressed threads resolved until the push succeeds');
    expect(prompt).toContain(
      'reply to each addressed inline thread confirming the fix and resolve it'
    );
  });

  test('with linkedPr: un-anchorable body-fallback instruction is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('put it in the review body instead of an inline thread');
    expect(prompt).toContain(
      'The review `body` should contain a short summary of the comments addressed or ignored in this review'
    );
    expect(prompt).toContain('Short summary of comments addressed or ignored in this review');
    expect(prompt).toContain('If there are no body-only issues, omit that topic entirely');
    expect(prompt).toContain('do not write boilerplate like "No body-only issues."');
    expect(prompt).toContain(
      'include that file/line in the follow-up comment so someone viewing the PR can link the response back to the original finding'
    );
    expect(prompt).toContain(
      "for ignored body-only issues include the user's ignore reason in this initial description"
    );
    expect(prompt).toContain(
      'Addressed the body-only autoreview issue at src/example.ts:42 in <commit>.'
    );
  });

  test('with linkedPr: act-on-only instruction is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('create PR review threads only for issues the user acts on');
  });

  test('with linkedPr: reply-on-existing-thread instruction is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('reply on the existing thread instead of opening a duplicate');
  });

  test('with linkedPr: temporary scratch/tracking-file instruction is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('temporary scratch file');
  });

  test('with linkedPr: subagent encouragement is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    // Should encourage delegating GitHub mechanics to a subagent
    expect(prompt).toContain('delegate to your own subagent capability');
  });

  test('with linkedPr: gh api graphql recipe is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('gh api graphql');
  });

  test('with linkedPr: resolveReviewThread mutation is present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    expect(prompt).toContain('resolveReviewThread');
  });

  test('with linkedPr: all required gh api recipe endpoints and review payload fields are present', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr });
    // Create-review endpoint plus the inline-comment payload fields.
    expect(prompt).toContain('repos/acme/widgets/pulls/123/reviews');
    expect(prompt).toContain('commit_id');
    expect(prompt).toContain('"event"');
    expect(prompt).toContain('"comments"');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"line"');
    expect(prompt).toContain('"side"');
    expect(prompt).toContain('"body"');
    expect(prompt).toContain('start_line');
    expect(prompt).toContain('start_side');
    // Reply-to-thread-comment endpoint.
    expect(prompt).toContain('comments/{commentDatabaseId}/replies');
    // Body-only follow-up (issue comment) endpoint.
    expect(prompt).toContain('repos/acme/widgets/issues/123/comments');
  });

  test('without linkedPr: PR Review Trail heading is absent', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    expect(prompt).not.toContain('## PR Review Trail');
  });

  test('without linkedPr: existing prompt content is unchanged', () => {
    const prompt = buildAutoreviewPrompt({ target: currentTarget });
    // Assert the critical existing surface so a regression that removes or alters the no-PR
    // instructions is caught, not just the section headings.
    expect(prompt).toContain('# Autoreview Orchestrator');
    expect(prompt).toContain('## Available Commands');
    expect(prompt).toContain('## Workflow');
    expect(prompt).toContain('## Guardrails');
    expect(prompt).toContain('1. **Review**');
    expect(prompt).toContain('2. **Display and Ask**');
    expect(prompt).toContain('3. **Remember Skips**');
    expect(prompt).toContain('4. **Fix**');
    expect(prompt).toContain('5. **Commit**');
    expect(prompt).toContain('6. **Loop**');
    expect(prompt).toContain(
      'Never nag the user about issues they explicitly skipped during this session.'
    );
    expect(prompt).toContain(
      'If a review command fails or returns invalid JSON, explain the failure and ask the user how to proceed.'
    );
    // The trailing Guardrails content must be the end of the prompt — no stray empty section leaks in.
    expect(prompt.trimEnd()).toMatch(/ask the user how to proceed\.$/);
  });

  test('with linkedPr on plan target: PR Review Trail section is also present', () => {
    const prompt = buildAutoreviewPrompt({ target: planTarget, linkedPr });
    expect(prompt).toContain('## PR Review Trail');
    expect(prompt).toContain('#123');
    expect(prompt).toContain('acme/widgets');
  });

  test('with linkedPr including headSha: headSha is interpolated into the recipes', () => {
    const prWithSha: AutoreviewLinkedPr = { ...linkedPr, headSha: 'abc1234def5678' };
    const prompt = buildAutoreviewPrompt({ target: currentTarget, linkedPr: prWithSha });
    expect(prompt).toContain('abc1234def5678');
  });
});

// ─── handleAutoreviewCommand tests ──────────────────────────────────────────

describe('handleAutoreviewCommand', () => {
  const mockExecutorExecute = vi.fn(async () => {});
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };
  const emptyPrStatusDb = {
    prepare: () => ({
      all: () => [],
      get: () => null,
    }),
  };

  const originalStdinIsTTY = process.stdin.isTTY;
  const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: undefined,
      terminalInput: true,
    } as any);
    lifecycleMocks.startup.mockResolvedValue(undefined);
    lifecycleMocks.shutdown.mockResolvedValue(undefined);

    vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(isCodexAppServerEnabled).mockReturnValue(false);
    vi.mocked(getUsingJj).mockResolvedValue(false);
    vi.mocked(getDatabase).mockReturnValue(emptyPrStatusDb as any);
    vi.mocked(getCurrentBranchName).mockResolvedValue('main');
    vi.mocked(getTrunkBranch).mockResolvedValue('main');
    vi.mocked(resolveRepoRoot).mockResolvedValue('/repo-root');
    vi.mocked(buildTimWorkspaceCommandEnvironmentOptionsForPath).mockReturnValue({} as any);
    vi.mocked(runWithHeadlessAdapterIfEnabled).mockImplementation(async (options: any) =>
      options.callback()
    );
    vi.mocked(isTunnelActive).mockReturnValue(false);
    vi.mocked(setupWorkspace).mockResolvedValue({
      baseDir: '/repo-root/workspaces/autoreview',
      planFile: '/repo-root/workspaces/autoreview/.tim/plans/376.plan.md',
      workspaceTaskId: 'autoreview',
      branchCreatedDuringSetup: false,
    });
    vi.mocked(prepareWorkspaceRoundTrip).mockResolvedValue(null as any);
    vi.mocked(materializePlansForExecution).mockResolvedValue(null);
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: 'github.com__myorg__myrepo',
      remoteUrl: 'https://github.com/myorg/myrepo',
      gitRoot: '/repo-root',
    });
    vi.mocked(resolvePlanByNumericId).mockResolvedValue({
      plan: {
        id: 376,
        uuid: 'plan-uuid-376',
        title: 'autoreview command',
        status: 'in_progress',
        priority: 'medium',
        tasks: [],
      } as any,
      planPath: '/repo-root/.tim/plans/376.plan.md',
    });

    delete process.env.CODEX_USE_APP_SERVER;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalCodexUseAppServer == null) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalCodexUseAppServer;
    }
  });

  // ── Target resolution ─────────────────────────────────────────────────────

  test('--current resolves to a planless current target and prompt contains tim review --current --print', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim review --current --print');
    expect(prompt).not.toContain('tim subagent implementer');
  });

  test('planId resolves to a plan target and prompt contains tim review <planId> --print', async () => {
    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim review 376 --print');
    expect(prompt).toContain('tim subagent implementer 376');
  });

  test('combining planId with --current is rejected', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await expect(handleAutoreviewCommand(376, options, {})).rejects.toThrow(
      /Cannot combine a plan ID with --current/
    );

    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
    expect(mockExecutorExecute).not.toHaveBeenCalled();
  });

  test('combining --current with --branch is rejected', async () => {
    const options: AutoreviewCommandOptions = {
      current: true,
      branch: 'feature/foo',
      nonInteractive: true,
    };
    await expect(handleAutoreviewCommand(undefined, options, {})).rejects.toThrow(
      /Conflicting review target selectors/
    );

    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
    expect(mockExecutorExecute).not.toHaveBeenCalled();
  });

  test('combining --branch with --pr is rejected', async () => {
    const options: AutoreviewCommandOptions = {
      branch: 'feature/foo',
      pr: '42',
      nonInteractive: true,
    };
    await expect(handleAutoreviewCommand(undefined, options, {})).rejects.toThrow(
      /Conflicting review target selectors/
    );

    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
    expect(mockExecutorExecute).not.toHaveBeenCalled();
  });

  // ── Prompt construction ───────────────────────────────────────────────────

  test('prompt for --current contains skip/dedup guidance', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('remember every issue the user declines or asks to skip');
    expect(prompt).toContain('Do not re-raise skipped issues in later iterations');
  });

  test('prompt for --current contains subagent delegation line', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('non-conflicting, independent fixes');
  });

  test('prompt for --current contains commit guidance', async () => {
    vi.mocked(getUsingJj).mockResolvedValue(false);
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('commit and push the changes');
    expect(prompt).toContain('appears to use git');
  });

  test('prompt for jj repo contains jj commit guidance', async () => {
    vi.mocked(getUsingJj).mockResolvedValue(true);
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('commit and push the changes');
    expect(prompt).toContain('appears to use Jujutsu (jj)');
  });

  test('plan-backed prompt additionally mentions tim subagent implementer', async () => {
    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent implementer 376');
  });

  test('--current with --base produces prompt containing --base <value>', async () => {
    const options: AutoreviewCommandOptions = {
      current: true,
      base: 'develop',
      nonInteractive: true,
    };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('--base develop');
  });

  // ── Executor invocation ───────────────────────────────────────────────────

  test('execute is called exactly once with executionMode: bare', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const executeOpts = mockExecutorExecute.mock.calls[0][1];
    expect(executeOpts).toMatchObject({ executionMode: 'bare' });
  });

  test('execute call includes interactiveSession: true', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const executeOpts = mockExecutorExecute.mock.calls[0][1];
    expect(executeOpts).toMatchObject({ interactiveSession: true });
  });

  test('executor is built with closeTerminalInputOnResult: false and disableInactivityTimeout: true', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts).toMatchObject({
      closeTerminalInputOnResult: false,
      disableInactivityTimeout: true,
    });
  });

  test('terminalInput is enabled for claude-code when stdin is a TTY and not nonInteractive', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const options: AutoreviewCommandOptions = { current: true };
    await handleAutoreviewCommand(undefined, options, {});

    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts.terminalInput).toBe(true);
  });

  test('terminalInput is disabled when nonInteractive is true', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts.terminalInput).toBe(false);
  });

  test('terminalInput is disabled when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const options: AutoreviewCommandOptions = { current: true };
    await handleAutoreviewCommand(undefined, options, {});

    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts.terminalInput).toBe(false);
  });

  test('defaults to claude-code executor', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('claude-code');
  });

  test('passes --model through to executor options', async () => {
    const options: AutoreviewCommandOptions = {
      current: true,
      nonInteractive: true,
      model: 'sonnet',
    };
    await handleAutoreviewCommand(undefined, options, {});

    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts).toMatchObject({ model: 'sonnet' });
  });

  test('uses configured autoreview executor, model, and effort when CLI options are omitted', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
      terminalInput: true,
      executors: {
        'codex-cli': {
          reasoning: {
            applyPatch: 'medium',
          },
        },
      },
      autoreview: {
        executor: 'codex-cli',
        model: 'gpt-5-codex',
        effort: 'xhigh',
      },
    } as any);

    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        model: 'gpt-5-codex',
      }),
      expect.any(Object),
      expect.objectContaining({
        reasoning: expect.objectContaining({
          applyPatch: 'medium',
          default: 'xhigh',
        }),
      })
    );
  });

  test('CLI executor, model, and effort override configured autoreview values', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      terminalInput: true,
      autoreview: {
        executor: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
    } as any);

    const options: AutoreviewCommandOptions = {
      current: true,
      nonInteractive: true,
      executor: 'codex-cli',
      model: 'gpt-5-codex',
      effort: 'xhigh',
    };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        model: 'gpt-5-codex',
      }),
      expect.any(Object),
      expect.objectContaining({
        reasoning: expect.objectContaining({ default: 'xhigh' }),
      })
    );
  });

  test('plan-backed execute call includes planId and planTitle', async () => {
    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    const executeOpts = mockExecutorExecute.mock.calls[0][1];
    expect(executeOpts).toMatchObject({
      planId: '376',
      planTitle: 'autoreview command',
    });
  });

  test('wraps execution in a headless autoreview session', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'autoreview',
      interactive: false,
    });
  });

  test('passes plan metadata to headless autoreview session', async () => {
    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      command: 'autoreview',
      plan: {
        id: 376,
        uuid: 'plan-uuid-376',
        title: 'autoreview command',
      },
    });
  });

  test('passes linked PR metadata to headless autoreview session', async () => {
    vi.mocked(getDatabase).mockReturnValue({} as any);
    vi.mocked(gatherPrContext).mockResolvedValue({
      prStatus: { id: 1, title: 'My PR', state: 'open' } as any,
      baseBranch: 'main',
      headBranch: 'feature/my-pr',
      headSha: 'deadbeef1234',
      owner: 'myorg',
      repo: 'myrepo',
      prNumber: 42,
      prUrl: 'https://github.com/myorg/myrepo/pull/42',
    });

    const options: AutoreviewCommandOptions = { pr: '42', nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      command: 'autoreview',
      sessionInfo: {
        linkedPrUrl: 'https://github.com/myorg/myrepo/pull/42',
        linkedPrNumber: 42,
        linkedPrTitle: 'My PR',
      },
    });
  });

  test('plan-backed autoreview uses an auto workspace by default', async () => {
    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    expect(vi.mocked(setupWorkspace)).toHaveBeenCalledWith(
      expect.objectContaining({
        autoWorkspace: true,
        planId: 376,
        planUuid: 'plan-uuid-376',
      }),
      '/repo-root',
      '/repo-root/.tim/plans/376.plan.md',
      expect.any(Object),
      'tim autoreview'
    );
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      baseDir: '/repo-root/workspaces/autoreview',
    });
  });

  test('current autoreview stays in the current repo unless workspace is requested', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(setupWorkspace)).not.toHaveBeenCalled();
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      baseDir: '/repo-root',
    });
  });

  test('runs workspace roundtrip hooks around managed workspace execution', async () => {
    const roundTripContext = {
      executionWorkspacePath: '/repo-root/workspaces/autoreview',
      primaryWorkspacePath: '/repo-root',
      refName: 'feature/autoreview',
      branchCreatedDuringSetup: false,
    };
    vi.mocked(prepareWorkspaceRoundTrip).mockResolvedValueOnce(roundTripContext as any);
    vi.mocked(materializePlansForExecution).mockResolvedValueOnce(
      '/repo-root/workspaces/autoreview/.tim/plans/376.materialized.md'
    );

    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    expect(vi.mocked(prepareWorkspaceRoundTrip)).toHaveBeenCalledWith({
      workspacePath: '/repo-root/workspaces/autoreview',
      workspaceSyncEnabled: true,
      branchCreatedDuringSetup: false,
    });
    expect(vi.mocked(runPreExecutionWorkspaceSync)).toHaveBeenCalledWith(roundTripContext);
    expect(vi.mocked(materializePlansForExecution)).toHaveBeenCalledWith(
      '/repo-root/workspaces/autoreview',
      376
    );
    expect(vi.mocked(runPostExecutionWorkspaceSync)).toHaveBeenCalledWith(
      roundTripContext,
      'autoreview session'
    );
    expect(vi.mocked(touchWorkspaceInfo)).toHaveBeenCalledWith('/repo-root/workspaces/autoreview');
    expect(mockExecutorExecute.mock.calls[0][1]).toMatchObject({
      planFilePath: '/repo-root/workspaces/autoreview/.tim/plans/376.materialized.md',
    });
  });

  test('runs lifecycle hooks in autoreview context after workspace setup', async () => {
    const lifecycleCommands = [
      {
        title: 'Autoreview prep',
        command: 'pnpm install',
        runIn: ['autoreview'],
      },
    ];
    const timEnvironment = { context: { workspacePath: '/repo-root/workspaces/autoreview' } };
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: undefined,
      terminalInput: true,
      lifecycle: {
        commands: lifecycleCommands,
      },
    } as any);
    vi.mocked(buildTimWorkspaceCommandEnvironmentOptionsForPath).mockReturnValue(
      timEnvironment as any
    );

    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    expect(LifecycleManager).toHaveBeenCalledWith(
      lifecycleCommands,
      '/repo-root/workspaces/autoreview',
      undefined,
      'autoreview',
      undefined,
      {
        timEnvironment,
      }
    );
    expect(lifecycleMocks.startup).toHaveBeenCalledBefore(mockExecutorExecute);
    expect(lifecycleMocks.shutdown).toHaveBeenCalledTimes(1);
  });

  test('planless execute call uses autoreview sentinel planId', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const executeOpts = mockExecutorExecute.mock.calls[0][1];
    expect(executeOpts).toMatchObject({
      planId: 'autoreview',
      planTitle: 'Autoreview Session',
    });
  });

  test('executor environment marks child tim review commands as running under autoreview', async () => {
    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const sharedOptions = vi.mocked(buildExecutorAndLog).mock.calls[0]?.[1];
    expect(sharedOptions?.timEnvironment?.environment).toMatchObject({
      TIM_AUTOREVIEW: {
        value: '1',
        precedence: 'override-dotenv',
      },
    });
  });

  // ── dry-run ────────────────────────────────────────────────────────────────

  test('--dry-run prints the prompt and does not invoke the executor', async () => {
    const originalLog = console.log;
    const consoleSpy = vi.fn();
    console.log = consoleSpy;

    try {
      const options: AutoreviewCommandOptions = { current: true, dryRun: true };
      await handleAutoreviewCommand(undefined, options, {});
    } finally {
      console.log = originalLog;
    }

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const printed = consoleSpy.mock.calls[0][0] as string;
    expect(printed).toContain('tim review --current --print');
    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
    expect(mockExecutorExecute).not.toHaveBeenCalled();
  });

  test('--dry-run for plan-backed prints correct review command', async () => {
    const originalLog = console.log;
    const consoleSpy = vi.fn();
    console.log = consoleSpy;

    try {
      const options: AutoreviewCommandOptions = { dryRun: true };
      await handleAutoreviewCommand(376, options, {});
    } finally {
      console.log = originalLog;
    }

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const printed = consoleSpy.mock.calls[0][0] as string;
    expect(printed).toContain('tim review 376 --print');
    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
  });

  test('--dry-run with a --pr target includes PR Review Trail section in printed prompt', async () => {
    // This test verifies that the resolved linkedPr is passed through to buildAutoreviewPrompt.
    // A --pr target is the simplest resolvable path: resolveAutoreviewLinkedPr for kind='pr'
    // reads directly from the target fields without touching the DB.
    // resolvePrTarget still opens the DB to build the target, so return a non-null value.
    vi.mocked(getDatabase).mockReturnValue({} as any);
    vi.mocked(gatherPrContext).mockResolvedValue({
      prStatus: { id: 1, title: 'My PR', state: 'open' } as any,
      baseBranch: 'main',
      headBranch: 'feature/my-pr',
      headSha: 'deadbeef1234',
      owner: 'myorg',
      repo: 'myrepo',
      prNumber: 42,
      prUrl: 'https://github.com/myorg/myrepo/pull/42',
    });
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: 'github.com__myorg__myrepo',
      remoteUrl: 'https://github.com/myorg/myrepo',
      gitRoot: '/repo-root',
    });

    const originalLog = console.log;
    const consoleSpy = vi.fn();
    console.log = consoleSpy;

    try {
      const options: AutoreviewCommandOptions = { pr: '42', dryRun: true };
      await handleAutoreviewCommand(undefined, options, {});
    } finally {
      console.log = originalLog;
      vi.mocked(getDatabase).mockReturnValue(emptyPrStatusDb as any);
    }

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const printed = consoleSpy.mock.calls[0][0] as string;
    expect(printed).toContain('## PR Review Trail');
    expect(printed).toContain('#42');
    expect(printed).toContain('myorg/myrepo');
    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
  });

  test('--dry-run for plan-backed target with linked PR includes PR Review Trail section', async () => {
    // This test verifies that handleAutoreviewCommand resolves the linked PR from planData and
    // wires it into buildAutoreviewPrompt. It must fail if planContext.planData is not passed
    // into resolveAutoreviewLinkedPr.
    const planPrUrl = 'https://github.com/planorg/planrepo/pull/55';

    // Make resolvePlanByNumericId return a plan with a pullRequest URL.
    vi.mocked(resolvePlanByNumericId).mockResolvedValue({
      plan: {
        id: 376,
        uuid: 'plan-uuid-376',
        title: 'autoreview command',
        status: 'in_progress',
        priority: 'medium',
        tasks: [],
        pullRequest: [planPrUrl],
      } as any,
      planPath: '/repo-root/.tim/plans/376.plan.md',
    });

    // Seed a real SQLite DB with the plan linked to PR #55.
    const tempDir = await mkdtemp(join(tmpdir(), 'autoreview-plan-pr-handler-'));
    let realDb: ReturnType<typeof openDatabase> | undefined;
    try {
      realDb = openDatabase(join(tempDir, DATABASE_FILENAME));
      const projectId = getOrCreateProject(realDb, 'github.com__planorg__planrepo').id;
      nonSyncedUpsertPlan(realDb, projectId, {
        uuid: 'plan-uuid-376',
        planId: 376,
        title: 'autoreview command',
        filename: '376.plan.md',
      });
      const prResult = upsertPrStatus(realDb, {
        prUrl: planPrUrl,
        owner: 'planorg',
        repo: 'planrepo',
        prNumber: 55,
        title: 'PR #55',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
        headBranch: 'feature-55',
        baseBranch: 'main',
        headSha: 'sha-55',
      });
      linkPlanToPr(realDb, 'plan-uuid-376', prResult.status.id, 'explicit');

      vi.mocked(getDatabase).mockReturnValue(realDb as any);

      const originalLog = console.log;
      const consoleSpy = vi.fn();
      console.log = consoleSpy;

      try {
        const options: AutoreviewCommandOptions = { dryRun: true };
        await handleAutoreviewCommand(376, options, {});
      } finally {
        console.log = originalLog;
      }

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const printed = consoleSpy.mock.calls[0][0] as string;
      expect(printed).toContain('## PR Review Trail');
      expect(printed).toContain('#55');
      expect(printed).toContain('planorg/planrepo');
    } finally {
      realDb?.close(false);
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      vi.mocked(getDatabase).mockReturnValue(emptyPrStatusDb as any);
    }
  });

  test('--dry-run for --current target with matching open PR includes PR Review Trail section', async () => {
    // Verifies that the current/branch resolver path is wired through to the prompt.
    vi.mocked(getCurrentBranchName).mockResolvedValue('feature-current-pr');
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: 'github.com__currorg__currrepo',
      remoteUrl: 'https://github.com/currorg/currrepo',
      gitRoot: '/repo-root',
    });

    const tempDir = await mkdtemp(join(tmpdir(), 'autoreview-current-pr-handler-'));
    let realDb: ReturnType<typeof openDatabase> | undefined;
    try {
      realDb = openDatabase(join(tempDir, DATABASE_FILENAME));
      upsertPrStatus(realDb, {
        prUrl: 'https://github.com/currorg/currrepo/pull/77',
        owner: 'currorg',
        repo: 'currrepo',
        prNumber: 77,
        title: 'PR #77',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
        headBranch: 'feature-current-pr',
        baseBranch: 'main',
        headSha: 'sha-77',
      });

      vi.mocked(getDatabase).mockReturnValue(realDb as any);

      const originalLog = console.log;
      const consoleSpy = vi.fn();
      console.log = consoleSpy;

      try {
        const options: AutoreviewCommandOptions = { current: true, dryRun: true };
        await handleAutoreviewCommand(undefined, options, {});
      } finally {
        console.log = originalLog;
      }

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const printed = consoleSpy.mock.calls[0][0] as string;
      expect(printed).toContain('## PR Review Trail');
      expect(printed).toContain('#77');
      expect(printed).toContain('currorg/currrepo');
    } finally {
      realDb?.close(false);
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      vi.mocked(getDatabase).mockReturnValue(emptyPrStatusDb as any);
    }
  });

  test('--dry-run --pr emits PR Review Trail without a second resolver DB open', async () => {
    // The only DB access for this path should be resolvePrTarget building the target. The
    // linked-PR resolver must return from the --pr target fields before opening the DB.
    let getDatabaseCallCount = 0;
    vi.mocked(getDatabase).mockImplementation((() => {
      getDatabaseCallCount += 1;
      if (getDatabaseCallCount === 1) {
        return {} as any;
      }
      throw new Error('database open failed');
    }) as any);
    vi.mocked(gatherPrContext).mockResolvedValue({
      prStatus: { id: 1, title: 'My PR', state: 'open' } as any,
      baseBranch: 'main',
      headBranch: 'feature/my-pr',
      headSha: 'deadbeef1234',
      owner: 'myorg',
      repo: 'myrepo',
      prNumber: 42,
      prUrl: 'https://github.com/myorg/myrepo/pull/42',
    });

    const originalLog = console.log;
    const consoleSpy = vi.fn();
    console.log = consoleSpy;

    try {
      const options: AutoreviewCommandOptions = { pr: '42', dryRun: true };
      await handleAutoreviewCommand(undefined, options, {});
    } finally {
      console.log = originalLog;
      vi.mocked(getDatabase).mockReturnValue(emptyPrStatusDb as any);
    }

    expect(getDatabaseCallCount).toBe(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const printed = consoleSpy.mock.calls[0][0] as string;
    expect(printed).toContain('## PR Review Trail');
    expect(printed).toContain('#42');
    expect(printed).toContain('myorg/myrepo');
  });

  // ── codex executor selection ───────────────────────────────────────────────

  test('codex-cli with app server disabled (isCodexAppServerEnabled: false) disables terminal input', async () => {
    vi.mocked(isCodexAppServerEnabled).mockReturnValue(false);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const options: AutoreviewCommandOptions = { current: true, executor: 'codex-cli' };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts.terminalInput).toBe(false);
  });

  test('codex alias resolves to codex-cli executor', async () => {
    const options: AutoreviewCommandOptions = {
      current: true,
      executor: 'codex',
      nonInteractive: true,
    };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
  });

  test('codex-cli with app server enabled keeps terminal input based on TTY', async () => {
    vi.mocked(isCodexAppServerEnabled).mockReturnValue(true);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const options: AutoreviewCommandOptions = { current: true, executor: 'codex-cli' };
    await handleAutoreviewCommand(undefined, options, {});

    const buildOpts = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildOpts.terminalInput).toBe(true);
  });

  test('throws when --executor is an incompatible executor', async () => {
    const options: AutoreviewCommandOptions = { current: true, executor: 'copy-only' };
    await expect(handleAutoreviewCommand(undefined, options, {})).rejects.toThrow(
      "Executor 'copy-only' is not supported by 'tim autoreview'"
    );

    expect(vi.mocked(buildExecutorAndLog)).not.toHaveBeenCalled();
  });

  test('falls back to claude-code with warning when config defaultExecutor is incompatible', async () => {
    const consolewarnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'copy-only',
      terminalInput: true,
    } as any);

    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('claude-code');
    expect(consolewarnSpy).toHaveBeenCalledTimes(1);
    expect(consolewarnSpy.mock.calls[0][0]).toContain(
      "defaultExecutor 'copy-only' is not supported"
    );

    consolewarnSpy.mockRestore();
  });

  test('uses configured defaultExecutor from config when no --executor flag', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
      terminalInput: true,
    } as any);

    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
  });
});

// ─── Target resolution with real git repo ────────────────────────────────────

describe('handleAutoreviewCommand - target resolution with real git', () => {
  const mockExecutorExecute = vi.fn(async () => {});
  const mockExecutor = { execute: mockExecutorExecute, filePathPrefix: '' };
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = await mkdtemp(join(tmpdir(), 'autoreview-real-git-'));
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git config user.email "test@test.com"`.cwd(tempDir).quiet();
    await Bun.$`git config user.name "Test"`.cwd(tempDir).quiet();
    await Bun.$`git checkout -b main`.cwd(tempDir).quiet();
    await Bun.$`touch README.md`.cwd(tempDir).quiet();
    await Bun.$`git add .`.cwd(tempDir).quiet();
    await Bun.$`git commit -m "init"`.cwd(tempDir).quiet();

    vi.mocked(resolveRepoRoot).mockResolvedValue(tempDir);
    vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: undefined,
      terminalInput: true,
    } as any);
    vi.mocked(buildTimWorkspaceCommandEnvironmentOptionsForPath).mockReturnValue({} as any);
    vi.mocked(isCodexAppServerEnabled).mockReturnValue(false);
    vi.mocked(resolvePlanByNumericId).mockResolvedValue({
      plan: {
        id: 376,
        uuid: 'plan-uuid-376',
        title: 'autoreview command',
        status: 'in_progress',
        priority: 'medium',
        tasks: [],
      } as any,
      planPath: join(tempDir, '.tim/plans/376.plan.md'),
    });

    // Use real git implementations so resolveReviewTarget exercises real git state.
    const realGit =
      await vi.importActual<typeof import('../../common/git.js')>('../../common/git.js');
    vi.mocked(getCurrentBranchName).mockImplementation(realGit.getCurrentBranchName);
    vi.mocked(getTrunkBranch).mockImplementation(realGit.getTrunkBranch);
    vi.mocked(getUsingJj).mockResolvedValue(false);
    vi.mocked(remoteBranchExists).mockResolvedValue(false);

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('--current resolves the real current branch name from git', async () => {
    await Bun.$`git checkout -b feature/real-branch`.cwd(tempDir).quiet();

    const options: AutoreviewCommandOptions = { current: true, nonInteractive: true };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim review --current --print');
    // The target description includes the real branch name
    expect(prompt).toContain('feature/real-branch');
  });

  test('--current with --base uses provided base in the review command', async () => {
    const options: AutoreviewCommandOptions = {
      current: true,
      base: 'develop',
      nonInteractive: true,
    };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim review --current --base develop --print');
  });

  test('--branch resolves successfully when the branch exists locally in the real repo', async () => {
    await Bun.$`git checkout -b feature/local-branch`.cwd(tempDir).quiet();
    await Bun.$`git checkout main`.cwd(tempDir).quiet();

    const options: AutoreviewCommandOptions = {
      branch: 'feature/local-branch',
      nonInteractive: true,
    };
    await handleAutoreviewCommand(undefined, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim review --branch feature/local-branch --print');
  });

  test('planId resolves to plan target and executor sees the resolved repo root', async () => {
    const options: AutoreviewCommandOptions = { nonInteractive: true };
    await handleAutoreviewCommand(376, options, {});

    const prompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(prompt).toContain('tim review 376 --print');
    // Plan target must not append --base
    expect(prompt).not.toContain('--base');

    // Executor was built with the managed workspace as baseDir
    const buildArgs = vi.mocked(buildExecutorAndLog).mock.calls[0][1];
    expect(buildArgs.baseDir).toBe('/repo-root/workspaces/autoreview');
  });
});
