import path from 'node:path';

import { getUsingJj } from '../../common/git.js';
import { resolveGitHubToken } from '../../common/github/token.js';
import { warn } from '../../logging.js';
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

export function buildPrRebasePrompt(target: PullRequestFixTarget, usingJj: boolean): string {
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
      '5. Run type checking, linting, and tests appropriate to the changed files to make sure that the rebased branch works. Fix any problems that the rebase caused.',
      `6. Make sure that the \`${target.headBranch}\` bookmark points to the rebased head commit, then push with \`jj git push --bookmark ${target.headBranch}\`.`
    );
  } else {
    prompt.push(
      `1. Rebase the branch onto the latest remote base branch: \`git rebase origin/${target.baseBranch}\`.`,
      '2. Run `git status` and `git diff` to see the conflicts. Make a todo list of the conflicts to fix.',
      '3. For each conflicting file, examine the conflict markers and the git log for both branches, to understand the context of each change.',
      '4. Resolve each conflict. Keep the intent of both changes. Do not discard either side without examining it. Run `git add <file>` to mark each file as resolved, then run `git rebase --continue`. More than one commit can have conflicts, so repeat until the rebase is complete.',
      '5. Run type checking, linting, and tests appropriate to the changed files to make sure that the rebased branch works. Fix any problems that the rebase caused.',
      `6. Push the rebased branch with \`git push --force-with-lease origin ${target.headBranch}\`. A force push is necessary because the rebase rewrote the branch history.`
    );
  }

  prompt.push(
    '',
    'As you make edits, describe your reasoning. If it is not clear how to resolve a conflict, stop and ask the user what to do.',
    ''
  );

  return prompt.join('\n');
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

    const rebasePrompt = buildPrRebasePrompt(prTarget, await getUsingJj(currentBaseDir));
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
        await runPostExecutionWorkspaceSync(roundTripContext, 'PR rebase');
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
