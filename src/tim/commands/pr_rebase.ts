import path from 'node:path';

import {
  ensureLocalJjBookmark,
  fetchRemoteBranch,
  getUsingJj,
  isBranchBehindRemoteBase,
} from '../../common/git.js';
import { resolveGitHubToken } from '../../common/github/token.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import {
  findOpenStackForPr,
  getStackedBranchesAbovePr,
  type StackedBranch,
} from '../shepherd_bot/stack.js';
import {
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { touchWorkspaceInfo } from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  buildCiFixExecutorOptions,
  getTargetSessionInfo,
  resolveSinglePullRequestTarget,
  updateCiFixHeadlessSessionInfo,
} from './ci_fix.js';
import {
  ensurePrFixHeadBranchPushableOnOrigin,
  fetchPrFixBaseBranch,
  resolvePrFixTarget,
  resolvePrFixTargetIntent,
  type PrFixCommandOptions,
  type PrFixTarget,
  type PullRequestFixTarget,
} from './pr.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

type EffectiveConfig = Awaited<ReturnType<typeof loadEffectiveConfig>>;

export type PrRebaseCommandOptions = PrFixCommandOptions;

const COMMAND_NAME = 'tim pr rebase';

function resolveStringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function formatStackedBranches(stackedBranches: StackedBranch[]): string {
  return stackedBranches
    .map((branch) => `\`${branch.headBranch}\` (based on \`${branch.baseBranch}\`)`)
    .join(', ');
}

export function buildPrRebasePrompt(
  target: PullRequestFixTarget,
  usingJj: boolean,
  stackedBranches: StackedBranch[] = []
): string {
  const hasStack = stackedBranches.length > 0;
  const allBranches = [target.headBranch, ...stackedBranches.map((branch) => branch.headBranch)];
  const prompt = [
    '# Rebase Pull Request and Resolve Conflicts',
    '',
    'The pull request below has merge conflicts with its base branch. Rebase the pull request branch onto the latest base branch from origin, resolve all conflicts, and push the result.',
    '',
    '## Pull Request Context',
    '',
    `**PR URL:** ${target.canonicalPrUrl}`,
    `**PR Number:** ${target.prNumber}`,
    `**Repository:** ${target.owner}/${target.repo}`,
    `**Title:** ${target.title ?? 'No title provided'}`,
  ];

  if (target.author) {
    prompt.push(`**Author:** ${target.author}`);
  }

  prompt.push(
    `**Base Branch:** ${target.baseBranch}`,
    `**Head Branch:** ${target.headBranch}`,
    `**Head SHA:** ${target.headSha}`,
    '',
    'The latest base branch was already fetched from origin.',
    '',
    ...(hasStack
      ? [
          `Other open PRs are stacked on top of this PR. Their branches, each after the branch it is based on: ${formatStackedBranches(stackedBranches)}. These branches were also fetched from origin. You must rebase them too and push them together with this branch, so that the whole stack stays consistent on GitHub. Otherwise GitHub reports merge conflicts for the stacked PRs.`,
          '',
        ]
      : []),
    'Do not edit plan files or change plan tasks, plan status, or plan assignments during this rebase run.',
    '',
    '## Steps',
    ''
  );

  if (usingJj) {
    prompt.push(
      `1. Rebase the branch onto the latest remote base branch: \`jj rebase -b @ -d ${target.baseBranch}@origin\`.`,
      '2. Run `jj status` and `jj log` to find the commits that have conflicts. Make a todo list of the conflicts to fix.',
      '3. For each conflict, examine each side and the commits that changed those lines, to get the context for each change. The conflicting changes from the other side are probably in commits on the base branch.',
      '4. Resolve each conflict. Keep the intent of both changes. Do not discard either side without examining it. When you use `jj squash` as part of this process, do not give it any arguments, because the squash message will overwrite the original commit message.',
      `5. The rebase also moves the branches that are stacked on top of this branch. After you resolve the conflicts in this branch, run \`jj log -r 'conflicts() & descendants(roots(${target.baseBranch}@origin.."${target.headBranch}"))'\` to find conflicts in this branch and in the branches stacked on top of it. If you find any, resolve them too, with the same process. Repeat until that command shows no commits. Conflicts in commits that are not in this branch or in the branches stacked on top of it are out of scope. Do not change them.`,
      '6. Run type checking, linting, and tests appropriate to the changed files to make sure that the rebased branch works. Fix any problems that the rebase caused.',
      ...(hasStack
        ? [
            `7. Run \`jj log -r '${target.baseBranch}@origin::'\` and make sure that each stacked bookmark is on top of the rebased version of the branch it is based on. If a stacked branch is not on top of it (for example, because an earlier rebase did not push it), rebase that branch onto its base bookmark, without the old copies of the base branch commits, and resolve its conflicts with the same process.`,
            `8. Make sure that each of these bookmarks points to the rebased head commit of its branch: ${allBranches.map((branch) => `\`${branch}\``).join(', ')}. Then push all of them with \`jj git push ${allBranches.map((branch) => `--bookmark ${branch}`).join(' ')}\`.`,
          ]
        : [
            `7. Make sure that the \`${target.headBranch}\` bookmark points to the rebased head commit, then push with \`jj git push --bookmark ${target.headBranch}\`.`,
          ])
    );
  } else {
    prompt.push(
      `1. Rebase the branch onto the latest remote base branch: \`git rebase origin/${target.baseBranch}\`.`,
      '2. Run `git status` and `git diff` to see the conflicts. Make a todo list of the conflicts to fix.',
      '3. For each conflicting file, examine the conflict markers and the git log for both branches, to understand the context of each change.',
      '4. Resolve each conflict. Keep the intent of both changes. Do not discard either side without examining it. Run `git add <file>` to mark each file as resolved, then run `git rebase --continue`. More than one commit can have conflicts, so repeat until the rebase is complete.',
      '5. Run type checking, linting, and tests appropriate to the changed files to make sure that the rebased branch works. Fix any problems that the rebase caused.',
      ...(hasStack
        ? [
            `6. Rebase each stacked branch onto the rebased version of its base branch, in the order given above. Do this before you push, while \`origin/<base branch>\` still points to the old version of the base branch. For each stacked branch, run \`git checkout -B <branch> origin/<branch>\`, then \`git rebase --onto <base branch> origin/<base branch> <branch>\`. If a stacked branch is not on top of \`origin/<base branch>\` (for example, because an earlier rebase did not push it), make sure that only its own commits are moved. Resolve conflicts with the same process, and check the result if conflicts occurred.`,
            `7. Push all the rebased branches with \`git push --force-with-lease origin ${allBranches.join(' ')}\`. A force push is necessary because the rebase rewrote the branch history.`,
          ]
        : [
            `6. Push the rebased branch with \`git push --force-with-lease origin ${target.headBranch}\`. A force push is necessary because the rebase rewrote the branch history.`,
          ])
    );
  }

  prompt.push(
    '',
    'As you make edits, describe your reasoning. If it is not clear how to resolve a conflict, stop and ask the user what to do.',
    ''
  );

  return prompt.join('\n');
}

/**
 * Fetch the branches of the PRs stacked on top of the PR, so that the rebase can move and push
 * them too. In jj, also track them so that they have local bookmarks that the rebase moves.
 * A branch that cannot be fetched is left out, together with the branches stacked on it.
 */
async function prepareStackedBranches(
  workspacePath: string,
  stackedBranches: StackedBranch[],
  usingJj: boolean
): Promise<StackedBranch[]> {
  const skipped = new Set<string>();
  const prepared: StackedBranch[] = [];
  for (const branch of stackedBranches) {
    if (skipped.has(branch.baseBranch)) {
      skipped.add(branch.headBranch);
      continue;
    }
    try {
      if (!(await fetchRemoteBranch(workspacePath, branch.headBranch))) {
        throw new Error('fetch failed');
      }
      if (usingJj) {
        await ensureLocalJjBookmark(workspacePath, branch.headBranch);
      }
      prepared.push(branch);
    } catch (err) {
      warn(
        `Could not fetch stacked branch ${branch.headBranch}; it will not be rebased: ${err as Error}`
      );
      skipped.add(branch.headBranch);
    }
  }
  return prepared;
}

export async function handlePrRebaseCommand(
  positionalArg: string | number | undefined,
  options: PrRebaseCommandOptions,
  command: RootCommandLike
): Promise<void> {
  const intent = resolvePrFixTargetIntent(positionalArg, options);

  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR rebase commands');
  }

  const target = await resolvePrFixTarget(intent, command);
  const globalOptions = getRootOptions(command);
  const config = await loadEffectiveConfig(globalOptions.config);
  const noninteractive = options.nonInteractive === true;
  const terminalInputEnabled =
    !noninteractive &&
    process.stdin.isTTY === true &&
    options.terminalInput !== false &&
    config.terminalInput !== false;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'pr-rebase',
    interactive: !noninteractive,
    plan:
      target.kind === 'plan'
        ? {
            id: target.plan.id,
            uuid: target.plan.uuid,
            title: target.plan.title,
          }
        : undefined,
    sessionInfo: getTargetSessionInfo(target),
    callback: async () => {
      await executePrRebaseCommand({
        target,
        options,
        config,
        noninteractive,
        terminalInputEnabled,
      });
    },
  });
}

export async function executePrRebaseCommand({
  target,
  options,
  config,
  noninteractive,
  terminalInputEnabled,
}: {
  target: PrFixTarget;
  options: PrRebaseCommandOptions;
  config: EffectiveConfig;
  noninteractive: boolean;
  terminalInputEnabled: boolean;
}): Promise<void> {
  const prTarget = resolveSinglePullRequestTarget(target, COMMAND_NAME);
  const db = getDatabase();

  await ensurePrFixHeadBranchPushableOnOrigin(prTarget);

  const executorName =
    resolveStringOption(options.executor) ??
    resolveStringOption(options.orchestrator) ??
    config.defaultExecutor ??
    DEFAULT_EXECUTOR;
  const model =
    resolveStringOption(options.model) ??
    config.models?.execution ??
    defaultModelForExecutor(executorName, 'execution');
  const effort = resolveStringOption(options.effort);

  let currentBaseDir = prTarget.repoRoot;
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let executionError: unknown;

  try {
    const workspaceName = resolveStringOption(options.workspace);
    const workspaceResult = await setupWorkspace(
      {
        workspace: workspaceName,
        // The rebase must always run in a managed workspace so it never mutates
        // the user's current checkout.
        autoWorkspace: workspaceName === undefined ? true : options.autoWorkspace === true,
        newWorkspace: options.newWorkspace === true,
        nonInteractive: noninteractive,
        branchName: prTarget.headBranch,
        checkoutBranch: prTarget.headBranch,
        createBranch: false,
        allowPrimaryWorkspaceWhenLocked: true,
      },
      currentBaseDir,
      undefined,
      config,
      COMMAND_NAME
    );

    currentBaseDir = workspaceResult.baseDir;
    touchedWorkspacePath = currentBaseDir;

    await fetchPrFixBaseBranch(currentBaseDir, prTarget.baseBranch);
    updateCiFixHeadlessSessionInfo(db, prTarget, currentBaseDir);

    // A PR can have merge conflicts only when its base branch has commits that the PR does
    // not have. The conflict state on GitHub can be stale, for example during a push of the
    // stack, so check before starting an agent.
    if ((await isBranchBehindRemoteBase(currentBaseDir, prTarget.baseBranch)) === false) {
      log(
        `PR #${prTarget.prNumber} already contains the latest ${prTarget.baseBranch} from origin. There is nothing to rebase.`
      );
      return;
    }

    const usingJj = await getUsingJj(currentBaseDir);
    const stackedBranches = await prepareStackedBranches(
      currentBaseDir,
      getStackedBranchesAbovePr(
        findOpenStackForPr(db, prTarget.prStatus.status),
        prTarget.prNumber
      ),
      usingJj
    );

    if (path.resolve(currentBaseDir) !== path.resolve(prTarget.repoRoot)) {
      roundTripContext = await prepareWorkspaceRoundTrip({
        workspacePath: currentBaseDir,
        workspaceSyncEnabled: options.workspaceSync !== false,
        branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
      });
    }

    if (roundTripContext) {
      await runPreExecutionWorkspaceSync(roundTripContext);
    }

    const rebasePrompt = buildPrRebasePrompt(prTarget, usingJj, stackedBranches);
    const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
      config,
      currentBaseDir,
      null,
      prTarget.repoRoot
    );

    const sharedExecutorOptions: ExecutorCommonOptions = {
      baseDir: currentBaseDir,
      model,
      noninteractive: noninteractive ? true : undefined,
      terminalInput: terminalInputEnabled,
      closeTerminalInputOnResult: false,
      disableInactivityTimeout: true,
      timEnvironment,
    };
    const executor = buildExecutorAndLog(
      executorName,
      sharedExecutorOptions,
      config,
      buildCiFixExecutorOptions(executorName, effort, config)
    );
    await executor.execute(rebasePrompt, {
      planId: `pr-${prTarget.prNumber}-rebase`,
      planTitle: prTarget.title || `PR #${prTarget.prNumber}`,
      executionMode: 'planning',
    });
  } catch (err) {
    executionError = err;
  } finally {
    let roundTripError: unknown;

    if (roundTripContext) {
      try {
        // The agent pushes the rebased branch itself, so do not push again here.
        await runPostExecutionWorkspaceSync(roundTripContext, 'PR rebase', { skipPush: true });
      } catch (err) {
        roundTripError = err;
      }
    }

    if (touchedWorkspacePath) {
      try {
        touchWorkspaceInfo(touchedWorkspacePath);
      } catch (err) {
        warn(`Failed to update workspace last used time: ${err as Error}`);
      }
    }

    if (executionError) {
      if (roundTripError) {
        warn(`Workspace sync failed after PR rebase error: ${roundTripError as Error}`);
      }
      throw executionError;
    }

    if (roundTripError) {
      throw roundTripError;
    }
  }
}
