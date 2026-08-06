import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { clearManagedDirectoryContentsSafely } from '../../common/fs.js';
import { getOctokit } from '../../common/github/octokit.js';
import { getRequiredCheckNames } from '../../common/github/required_check_rollup.js';
import { refreshPrCheckStatus } from '../../common/github/pr_status_service.js';
import { selectFailingChecks } from '../../common/github/select_failing_checks.js';
import {
  collectFailingCheckLogs,
  type FailingCheckLogInput,
  type FailingCheckLogManifestEntry,
} from '../../common/github/workflow_logs.js';
import { resolveGitHubToken } from '../../common/github/token.js';
import { CleanupRegistry } from '../../common/cleanup_registry.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { getDatabase } from '../db/database.js';
import { getLinkedPlansByPrUrl } from '../db/pr_status.js';
import { loadEffectiveConfig } from '../configLoader.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import {
  ClaudeCodeExecutorName,
  CodexCliExecutorName,
  type ClaudeCodeReasoningEffort,
  type CodexReasoningLevel,
} from '../executors/schemas.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { LifecycleManager } from '../lifecycle.js';
import { isShuttingDown } from '../shutdown_state.js';
import { TMP_DIR } from '../plan_materialize.js';
import {
  ensurePrFixHeadBranchPushableOnOrigin,
  fetchPrFixBaseBranch,
  resolvePrFixTarget,
  resolvePrFixTargetIntent,
  type PrFixCommandOptions,
  type PrFixTarget,
  type PullRequestFixTarget,
} from './pr.js';
import {
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { getWorkspaceInfoByPath, touchWorkspaceInfo } from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

type EffectiveConfig = Awaited<ReturnType<typeof loadEffectiveConfig>>;
export type { CiFixConfig } from '../configSchema.js';

export type CiFixCommandOptions = PrFixCommandOptions;

export interface CiFixPromptOptions {
  noRequiredConfig?: boolean;
}

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

function getExecutorKey(executorName: string): 'claude' | 'codex' | undefined {
  if (executorName === ClaudeCodeExecutorName || executorName === 'claude') {
    return 'claude';
  }
  if (executorName === CodexCliExecutorName || executorName === 'codex') {
    return 'codex';
  }
  return undefined;
}

export function buildCiFixExecutorOptions(
  executorName: string,
  effort: string | undefined,
  config: EffectiveConfig
): Record<string, unknown> | undefined {
  if (!effort) {
    return undefined;
  }

  const executorKey = getExecutorKey(executorName);
  if (executorKey === 'claude') {
    return { reasoningEffort: effort as ClaudeCodeReasoningEffort };
  }

  if (executorKey === 'codex') {
    const codexExecutorOptions = config.executors?.[CodexCliExecutorName];
    const existingReasoning =
      codexExecutorOptions && 'reasoning' in codexExecutorOptions
        ? codexExecutorOptions.reasoning
        : undefined;
    return {
      reasoning: {
        ...(existingReasoning &&
        typeof existingReasoning === 'object' &&
        !Array.isArray(existingReasoning)
          ? existingReasoning
          : {}),
        default: effort as CodexReasoningLevel,
      },
    };
  }

  return undefined;
}

function getTargetSessionInfo(target: PrFixTarget):
  | {
      linkedPrUrl?: string;
      linkedPrNumber?: number;
      linkedPrTitle?: string;
    }
  | undefined {
  if (target.kind === 'pr') {
    return {
      linkedPrUrl: target.canonicalPrUrl,
      linkedPrNumber: target.prNumber,
      linkedPrTitle: target.title,
    };
  }

  const status = target.prStatuses[0]?.status;
  if (!status) {
    return undefined;
  }

  return {
    linkedPrUrl: status.pr_url,
    linkedPrNumber: status.pr_number,
    linkedPrTitle: status.title ?? undefined,
  };
}

function resolveCiFixPullRequestTarget(target: PrFixTarget): PullRequestFixTarget {
  if (target.kind === 'pr') {
    return target;
  }

  if (target.prStatuses.length === 0) {
    throw new Error(
      `tim pr fix-ci requires one linked pull request for plan ${target.plan.id}, but the plan has no linked pull requests; pass --pr <url-or-number>.`
    );
  }

  if (target.prStatuses.length > 1) {
    throw new Error(
      `tim pr fix-ci requires exactly one linked pull request for plan ${target.plan.id}, but the plan has multiple linked pull requests; pass --pr <url-or-number>.`
    );
  }

  const prStatus = target.prStatuses[0];
  const { status } = prStatus;
  if (!status.base_branch || !status.head_branch || !status.head_sha) {
    throw new Error(`Plan ${target.plan.id} has incomplete pull request branch metadata.`);
  }

  return {
    kind: 'pr',
    repoRoot: target.repoRoot,
    canonicalPrUrl: status.pr_url,
    prNumber: status.pr_number,
    owner: status.owner,
    repo: status.repo,
    title: status.title ?? undefined,
    author: status.author ?? undefined,
    baseBranch: status.base_branch,
    headBranch: status.head_branch,
    headSha: status.head_sha,
    prStatus,
  };
}

function updateCiFixHeadlessSessionInfo(
  db: ReturnType<typeof getDatabase>,
  target: PullRequestFixTarget,
  workspacePath: string
): void {
  const linkedPlan = getLinkedPlansByPrUrl(db, [target.canonicalPrUrl]).get(
    target.canonicalPrUrl
  )?.[0];

  updateHeadlessSessionInfo({
    linkedPrUrl: target.canonicalPrUrl,
    linkedPrNumber: target.prNumber,
    linkedPrTitle: target.title,
    linkedPlanId: linkedPlan?.planId,
    linkedPlanUuid: linkedPlan?.planUuid,
    linkedPlanTitle: linkedPlan?.title ?? undefined,
    workspacePath,
  });
}

function buildCiFixLogDirectory(baseDir: string, prNumber: number, headSha: string): string {
  return path.resolve(baseDir, TMP_DIR, 'ci-fix', `pr-${prNumber}-${headSha.slice(0, 12)}`);
}

async function removeStaleCiFixLogDirectories(baseDir: string, prNumber: number): Promise<void> {
  const logRoot = path.resolve(baseDir, TMP_DIR, 'ci-fix');
  let entries: import('node:fs').Dirent[];

  try {
    entries = await readdir(logRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const directoryPrefix = `pr-${prNumber}-`;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(directoryPrefix)) {
      continue;
    }

    const candidatePath = path.join(logRoot, entry.name);
    await clearManagedDirectoryContentsSafely({
      baseDir,
      relativeDir: path.relative(baseDir, candidatePath),
      label: 'stale CI fix log',
      create: false,
    });
    await rm(candidatePath, { recursive: true, force: true });
  }
}

async function removeCiFixLogDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function buildCiFixPrompt(
  target: PullRequestFixTarget,
  manifest: readonly FailingCheckLogManifestEntry[],
  options: CiFixPromptOptions = {}
): string {
  const prompt = [
    '# Diagnose and Fix Pull Request CI Failures',
    '',
    'You are diagnosing failing CI checks for the pull request below. The complete logs are on disk at the absolute paths listed in the failing-checks section; no log excerpts are included in this prompt.',
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
    'Do not edit plan files or change plan tasks, plan status, or plan assignments during this CI-fix run.',
    '',
    '## Failing Checks',
    ''
  );

  if (options.noRequiredConfig) {
    prompt.push(
      'No required-check configuration was found in branch protection or rulesets; all failing checks are in scope.',
      ''
    );
  }

  if (manifest.length === 0) {
    prompt.push('No failing checks were provided.', '');
  } else {
    manifest.forEach((entry, index) => {
      prompt.push(
        `### ${index + 1}. ${entry.checkName}`,
        '',
        `- Scope: ${entry.required ? 'REQUIRED' : 'not-required'}`,
        `- Conclusion: ${entry.conclusion ?? 'unknown'}`,
        `- Failed steps: ${entry.failedSteps.length > 0 ? entry.failedSteps.join(', ') : 'None reported'}`
      );

      if (entry.logPath) {
        const absoluteLogPath = path.resolve(entry.logPath);
        prompt.push(
          `- Log file: ${absoluteLogPath} (read this file; the tail usually has the error)`
        );
      } else if (entry.detailsUrl) {
        prompt.push(`- No logs available; investigate via ${entry.detailsUrl}`);
      } else {
        prompt.push('- No logs available; no details URL was provided.');
      }

      if (entry.error) {
        prompt.push(`- Log collection note: ${entry.error}`);
      }

      prompt.push('');
    });
  }

  prompt.push(
    '## Responsibilities',
    '',
    '1. Read every available log and diagnose the root cause of every failing check, whether the check is required or not. For checks without logs, investigate using the provided details URL.',
    '2. Present a numbered summary of every failure with its diagnosis and a proposed fix. Ask the user what to do about each one, waiting for direction before making changes.',
    '3. Apply fixes for the REQUIRED failures only. Apply fixes for not-required failures only if the user asks. When a failure is environmental or flaky, propose re-running the check instead of changing code when that is the appropriate action.',
    '4. Run the relevant local checks and tests to verify the fixes.',
    '5. Commit the code changes and push them to the pull request branch. If the repository uses jj, update the current bookmark to the commit you created before pushing, for example `jj bookmark set <current-bookmark> -r @-`.',
    '6. Do not edit plan files in PR mode.',
    ''
  );

  return prompt.join('\n');
}

export async function handleCiFixCommand(
  positionalArg: string | number | undefined,
  options: CiFixCommandOptions,
  command: RootCommandLike
): Promise<void> {
  const intent = resolvePrFixTargetIntent(positionalArg, options);

  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required for CI fix commands');
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
    command: 'ci-fix',
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
      await executeCiFixCommand({
        target,
        options,
        config,
        noninteractive,
        terminalInputEnabled,
      });
    },
  });
}

export async function executeCiFixCommand({
  target,
  options,
  config,
  noninteractive,
  terminalInputEnabled,
}: {
  target: PrFixTarget;
  options: CiFixCommandOptions;
  config: EffectiveConfig;
  noninteractive: boolean;
  terminalInputEnabled: boolean;
}): Promise<void> {
  const prTarget = resolveCiFixPullRequestTarget(target);
  const db = getDatabase();
  const refreshedStatus = await refreshPrCheckStatus(db, prTarget.canonicalPrUrl);
  const requiredCheckNames = getRequiredCheckNames(db, refreshedStatus.status);
  const selectedChecks = selectFailingChecks(refreshedStatus.checks, requiredCheckNames);

  if (selectedChecks.checks.length === 0) {
    log(`No failing checks for PR #${prTarget.prNumber}`);
    return;
  }

  const currentTarget: PullRequestFixTarget = {
    ...prTarget,
    title: refreshedStatus.status.title ?? prTarget.title,
    author: refreshedStatus.status.author ?? prTarget.author,
    headSha: refreshedStatus.status.head_sha ?? prTarget.headSha,
  };

  await ensurePrFixHeadBranchPushableOnOrigin(currentTarget);
  updateHeadlessSessionInfo({
    linkedPrUrl: currentTarget.canonicalPrUrl,
    linkedPrNumber: currentTarget.prNumber,
    linkedPrTitle: currentTarget.title,
  });

  const configuredCiFix = config.ciFix;
  const executorName =
    resolveStringOption(options.executor) ??
    resolveStringOption(options.orchestrator) ??
    configuredCiFix?.executor ??
    config.defaultExecutor ??
    DEFAULT_EXECUTOR;
  const model =
    resolveStringOption(options.model) ??
    configuredCiFix?.model ??
    config.models?.execution ??
    defaultModelForExecutor(executorName, 'execution');
  const effort = resolveStringOption(options.effort) ?? configuredCiFix?.effort;

  let currentBaseDir = currentTarget.repoRoot;
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let lifecycleManager: LifecycleManager | undefined;
  let ciFixLogDirectory: string | undefined;
  let unregisterLogCleanup: (() => void) | undefined;
  let executionError: unknown;

  try {
    const workspaceName = resolveStringOption(options.workspace);
    const workspaceResult = await setupWorkspace(
      {
        workspace: workspaceName,
        // CI fix must always run in a managed workspace so it never mutates the
        // user's current checkout. An explicitly named workspace uses the named
        // workspace path unless --auto-workspace was also supplied.
        autoWorkspace: workspaceName === undefined ? true : options.autoWorkspace === true,
        newWorkspace: options.newWorkspace === true,
        nonInteractive: noninteractive,
        branchName: currentTarget.headBranch,
        checkoutBranch: currentTarget.headBranch,
        createBranch: false,
        allowPrimaryWorkspaceWhenLocked: true,
      },
      currentBaseDir,
      undefined,
      config,
      'tim pr fix-ci'
    );

    currentBaseDir = workspaceResult.baseDir;
    touchedWorkspacePath = currentBaseDir;

    await fetchPrFixBaseBranch(currentBaseDir, currentTarget.baseBranch);
    updateCiFixHeadlessSessionInfo(db, currentTarget, currentBaseDir);

    if (path.resolve(currentBaseDir) !== path.resolve(currentTarget.repoRoot)) {
      roundTripContext = await prepareWorkspaceRoundTrip({
        workspacePath: currentBaseDir,
        workspaceSyncEnabled: options.workspaceSync !== false,
        branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
      });
    }

    if (roundTripContext) {
      await runPreExecutionWorkspaceSync(roundTripContext);
    }

    await removeStaleCiFixLogDirectories(currentBaseDir, currentTarget.prNumber);
    ciFixLogDirectory = buildCiFixLogDirectory(
      currentBaseDir,
      currentTarget.prNumber,
      currentTarget.headSha
    );
    const relativeLogDirectory = path.relative(currentBaseDir, ciFixLogDirectory);
    unregisterLogCleanup = CleanupRegistry.getInstance().register(async () => {
      await removeCiFixLogDirectory(ciFixLogDirectory!);
    });
    await clearManagedDirectoryContentsSafely({
      baseDir: currentBaseDir,
      relativeDir: relativeLogDirectory,
      label: 'CI fix log',
      create: true,
    });

    log(
      `Downloading logs for ${selectedChecks.checks.length} failing check${selectedChecks.checks.length === 1 ? '' : 's'} for PR #${currentTarget.prNumber}.`
    );
    const manifest = await collectFailingCheckLogs({
      octokit: getOctokit(),
      owner: currentTarget.owner,
      repo: currentTarget.repo,
      headSha: currentTarget.headSha,
      failingChecks: selectedChecks.checks.map(
        (check): FailingCheckLogInput => ({
          name: check.name,
          source: check.source,
          conclusion: check.conclusion as FailingCheckLogInput['conclusion'],
          detailsUrl: check.details_url,
          // With no branch protection or rulesets there is no narrower required
          // set, so every failing check is in scope for the prompt.
          required: selectedChecks.noRequiredConfig ? true : check.required,
        })
      ),
      destDir: ciFixLogDirectory,
    });

    const fixPrompt = buildCiFixPrompt(currentTarget, manifest, {
      noRequiredConfig: selectedChecks.noRequiredConfig,
    });
    const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
      config,
      currentBaseDir,
      null,
      currentTarget.repoRoot
    );

    if (config.lifecycle?.commands && config.lifecycle.commands.length > 0 && !isShuttingDown()) {
      const workspaceInfo = getWorkspaceInfoByPath(currentBaseDir);
      lifecycleManager = new LifecycleManager(
        config.lifecycle.commands,
        currentBaseDir,
        workspaceInfo?.workspaceType,
        'ci-fix',
        undefined,
        { timEnvironment }
      );
      await lifecycleManager.startup();
    }

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
    await executor.execute(fixPrompt, {
      planId: `pr-${currentTarget.prNumber}-ci`,
      planTitle: currentTarget.title || `PR #${currentTarget.prNumber}`,
      executionMode: 'planning',
    });
  } catch (err) {
    executionError = err;
  } finally {
    let lifecycleShutdownError: unknown;
    let roundTripError: unknown;

    if (lifecycleManager) {
      try {
        await lifecycleManager.shutdown();
      } catch (err) {
        lifecycleShutdownError = err;
      }
    }

    if (ciFixLogDirectory) {
      try {
        await removeCiFixLogDirectory(ciFixLogDirectory);
      } catch (err) {
        warn(`Failed to remove CI fix logs from ${ciFixLogDirectory}: ${err as Error}`);
      } finally {
        unregisterLogCleanup?.();
        unregisterLogCleanup = undefined;
      }
    }

    if (roundTripContext) {
      try {
        await runPostExecutionWorkspaceSync(roundTripContext, 'CI fixes');
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
      if (lifecycleShutdownError) {
        warn(`Lifecycle shutdown failed after CI fix error: ${lifecycleShutdownError as Error}`);
      }
      if (roundTripError) {
        warn(`Workspace sync failed after CI fix error: ${roundTripError as Error}`);
      }
      throw executionError;
    }

    if (lifecycleShutdownError) {
      throw lifecycleShutdownError;
    }

    if (roundTripError) {
      throw roundTripError;
    }
  }
}
