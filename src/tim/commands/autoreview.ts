import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { getUsingJj } from '../../common/git.js';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { getLoggerAdapter } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import {
  findPrStatusesByRepositoryBranch,
  getPrStatusForPlan,
  type PrStatusRow,
} from '../db/pr_status.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { isCodexAppServerEnabled } from '../executors/codex_cli/app_server_mode.js';
import {
  ClaudeCodeExecutorName,
  CodexCliExecutorName,
  type ClaudeCodeReasoningEffort,
  type CodexReasoningLevel,
} from '../executors/schemas.js';
import { buildInteractiveExecutorOptions } from '../executors/shared/interactive_options.js';
import {
  buildTimWorkspaceCommandEnvironmentOptionsForPath,
  getWorkspaceInfoByPathIfAvailable,
} from '../environment_options.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../common/env.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { LifecycleManager } from '../lifecycle.js';
import { watchPlanFile } from '../plan_file_watcher.js';
import { resolvePlanByNumericId } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { resolveReviewTarget, type ReviewTarget } from './review_target.js';
import { resolveChatModel, resolveInteractiveExecutor, type ChatGlobalOptions } from './chat.js';
import { type ReviewCommandOptions } from './review.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { touchWorkspaceInfo } from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';

export interface AutoreviewCommandOptions extends Pick<
  ReviewCommandOptions,
  'executor' | 'model' | 'current' | 'branch' | 'pr' | 'base'
> {
  nonInteractive?: boolean;
  terminalInput?: boolean;
  headlessAdapter?: boolean;
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  workspaceSync?: boolean;
  dryRun?: boolean;
  effort?: string;
}

export interface BuildAutoreviewPromptOptions {
  target: ReviewTarget;
  useJj?: boolean;
  base?: string;
  linkedPr?: AutoreviewLinkedPr;
}

export interface AutoreviewLinkedPr {
  prNumber: number;
  owner: string;
  repo: string;
  url: string;
  title?: string;
  headSha?: string;
}

const TIM_AUTOREVIEW_ENV = 'TIM_AUTOREVIEW';

function withAutoreviewEnvironment(
  timEnvironment: TimWorkspaceCommandEnvironmentOptions
): TimWorkspaceCommandEnvironmentOptions {
  return {
    ...timEnvironment,
    environment: {
      ...timEnvironment.environment,
      [TIM_AUTOREVIEW_ENV]: {
        value: '1',
        precedence: 'override-dotenv',
      },
    },
  };
}

function appendBase(command: string, base: string | undefined): string {
  const trimmedBase = base?.trim();
  if (!trimmedBase) {
    return command;
  }
  return `${command} --base ${trimmedBase}`;
}

function resolveStringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function buildAutoreviewExecutorOptions(
  executorName: string,
  effort: string | undefined,
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>
): Record<string, unknown> | undefined {
  if (!effort) {
    return undefined;
  }

  if (executorName === ClaudeCodeExecutorName) {
    return { reasoningEffort: effort as ClaudeCodeReasoningEffort };
  }

  if (executorName === CodexCliExecutorName) {
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

function buildReviewCommandForTarget(target: ReviewTarget, base: string | undefined): string {
  switch (target.kind) {
    case 'plan':
      return `tim review ${target.planId} --print`;
    case 'current':
      return `${appendBase('tim review --current', base)} --print`;
    case 'branch':
      return `${appendBase(`tim review --branch ${target.requestedBranch}`, base)} --print`;
    case 'pr':
      return `${appendBase(`tim review --pr ${target.prNumber}`, base)} --print`;
  }
}

function buildTargetDescription(target: ReviewTarget): string {
  switch (target.kind) {
    case 'plan':
      return target.plan?.title
        ? `plan ${target.planId} (${target.plan.title})`
        : `plan ${target.planId}`;
    case 'current':
      return target.currentBranch
        ? `the current worktree on branch ${target.currentBranch}`
        : 'the current worktree';
    case 'branch':
      return `branch ${target.requestedBranch}`;
    case 'pr':
      return target.title ? `PR #${target.prNumber}: ${target.title}` : `PR #${target.prNumber}`;
  }
}

function buildSubagentGuidance(target: ReviewTarget): string {
  if (target.kind === 'plan') {
    return `- For non-conflicting, independent fixes, you may delegate to your own subagent capability; because this is plan-backed, \`tim subagent implementer ${target.planId} --input "..."\` is also available. Handle same-file or overlapping fixes directly to avoid conflicts.`;
  }

  return '- For non-conflicting, independent fixes, you may delegate to your own subagent capability. Handle same-file or overlapping fixes directly to avoid conflicts.';
}

function buildCommitGuidance(useJj: boolean): string {
  if (useJj) {
    return '- After each round of selected fixes, commit the changes with the repository VCS. This repository appears to use Jujutsu (jj), so prefer `jj status` and `jj commit -m "..."`; if you find it is not using jj, use git normally.';
  }

  return '- After each round of selected fixes, commit the changes with the repository VCS. This repository appears to use git, so use `git status`, `git add ...`, and `git commit -m "..."`; if you find it uses Jujutsu (jj), use `jj status` and `jj commit -m "..."` instead.';
}

function buildPrReviewTrailGuidance(linkedPr?: AutoreviewLinkedPr): string {
  if (!linkedPr) {
    return '';
  }

  const prRef = `PR #${linkedPr.prNumber} (${linkedPr.owner}/${linkedPr.repo})`;
  const headShaValue =
    linkedPr.headSha ??
    `<headSha from: gh pr view ${linkedPr.prNumber} --repo ${linkedPr.owner}/${linkedPr.repo} --json headRefOid -q .headRefOid>`;
  const titleText = linkedPr.title ? `, "${linkedPr.title}"` : '';

  return `## PR Review Trail

This target has a resolvable GitHub PR: ${prRef}${titleText} at ${linkedPr.url}. Mirror the autoreview conversation onto that PR so reviewers have a durable, auditable trail of what was found, what was fixed, and what was intentionally ignored. The "comment, then reply to yourself" pattern can look redundant, but it is intentional: the goal is a durable PR trail, not just the terminal transcript.

### Per-Round Protocol

- When the user selects which issues to act on, create PR review threads only for issues the user acts on in this round, either fixes or explicit ignores. Do not create threads for every issue merely presented.
- For each acted-on issue that has a referenced location in the PR diff, create an inline review thread anchored at that diff location. Use the issue content and suggestion as the comment body.
- If an issue has no file/line, or the referenced line is not part of the PR diff, put it in the review body instead of an inline thread. These are the body-only (un-anchorable) issues referenced below.
- When the PR trail is active and the user asks to ignore an issue without giving a reason, ask them for a brief reason first so it can be recorded on the PR.
- For ignored issues that have an inline thread, immediately reply with the user's stated reason for ignoring the issue and resolve the thread.
- For ignored issues that are body-only (un-anchorable, so there is no thread), immediately add a PR comment stating the issue is being ignored along with the user's stated reason, and record it in the scratch file. There is no thread to resolve in this case.
- After fixes are committed, reply to each addressed inline thread confirming the fix and resolve it. For addressed body-only issues, add a new follow-up PR comment confirming the issue was addressed.

### Threading Discipline

- If an issue that already has a thread resurfaces in a later round, reply on the existing thread instead of opening a duplicate.
- Maintain a temporary scratch file under the workspace temp directory mapping each issue to its created review/thread node ID and top-comment \`databaseId\`. Consult and update it each round. Resolving a thread through GraphQL needs the thread node ID, and replying through REST needs the top comment database ID.
- For the GitHub mechanics, you may delegate to your own subagent capability so the main review -> ask -> fix -> commit loop stays focused.
- If \`gh\`, \`GITHUB_TOKEN\`, or GitHub auth is unavailable, or if a GitHub call fails, continue the local review -> fix -> commit loop and report that the PR trail step could not be performed. Do not abort the review solely because the PR trail failed.

### GitHub Recipes

Use these \`gh api\` shapes for ${prRef}. The current head SHA for the review payload is \`${headShaValue}\`. If that placeholder is not already a concrete SHA, read it with:

    gh pr view ${linkedPr.prNumber} --repo ${linkedPr.owner}/${linkedPr.repo} --json headRefOid -q .headRefOid

Create one review with inline comments and body-only fallbacks. Inline comment fields mirror the review-comment API semantics: \`path\`, \`body\`, \`line\`, \`side\`, and optional \`start_line\`/\`start_side\` for ranges. Write the payload to a temp file and pass it with \`--input\` (this avoids fragile shell quoting/heredocs). For example, write this JSON to \`"$TMPDIR/autoreview-review.json"\`:

    {
      "commit_id": "${headShaValue}",
      "event": "COMMENT",
      "body": "Body-only issues that cannot be anchored in the diff go here.",
      "comments": [
        {
          "path": "src/example.ts",
          "line": 42,
          "side": "RIGHT",
          "body": "Issue content and suggestion go here."
        }
      ]
    }

then submit it:

    gh api --method POST repos/${linkedPr.owner}/${linkedPr.repo}/pulls/${linkedPr.prNumber}/reviews --input "$TMPDIR/autoreview-review.json"

Query review thread node IDs and top-comment database IDs after creating comments, then write the IDs into the scratch file:

    gh api graphql -f query='{ repository(owner:"${linkedPr.owner}", name:"${linkedPr.repo}"){ pullRequest(number:${linkedPr.prNumber}){ reviewThreads(first:100){ nodes { id isResolved path line comments(first:1){ nodes { databaseId body } } } } } } }'

Reply to a thread's top comment:

    gh api --method POST repos/${linkedPr.owner}/${linkedPr.repo}/pulls/${linkedPr.prNumber}/comments/{commentDatabaseId}/replies -f body='Fixed in <commit>.'

Resolve a review thread. Resolution is GraphQL-only:

    gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }' -f id='<threadNodeId>'

Add a body-only follow-up PR comment when an un-anchorable issue is fixed:

    gh api --method POST repos/${linkedPr.owner}/${linkedPr.repo}/issues/${linkedPr.prNumber}/comments -f body='Addressed the body-only autoreview issue in <commit>.'

You can also create a single inline review comment with \`POST repos/${linkedPr.owner}/${linkedPr.repo}/pulls/${linkedPr.prNumber}/comments\`; that endpoint returns the created comment ID directly, which can make ID tracking easier for one-off comments.`;
}

export function buildAutoreviewPrompt(options: BuildAutoreviewPromptOptions): string {
  const reviewCommand = buildReviewCommandForTarget(options.target, options.base);
  const targetDescription = buildTargetDescription(options.target);
  const prReviewTrailGuidance = buildPrReviewTrailGuidance(options.linkedPr);

  const prompt = `# Autoreview Orchestrator

You are the orchestrator for a tim review-and-fix loop targeting ${targetDescription}.

## Available Commands

- Run \`${reviewCommand}\` to review the current target. The command prints JSON; parse that JSON and use it as the source of truth for issues. This command will likely take a long time to run, so do not expect any output for a while after starting it.
${buildSubagentGuidance(options.target)}
${buildCommitGuidance(options.useJj === true)}

## Workflow

1. **Review**
   - Run \`${reviewCommand}\` at the start of each iteration.
   - Parse the JSON output into issues. Treat missing, empty, or non-actionable issue lists as no remaining review work.
2. **Display and Ask**
   - Present the current un-skipped issues clearly in conversation.
   - The review JSON may contain duplicate reports of the same underlying issue because issues can come from multiple sources. Combine duplicates into one displayed issue, preserving the full useful details, suggestions, and source information from each duplicate report.
   - For each issue you show, include the complete issue content from the review JSON, its file/line or range, severity, category, and source when present, plus the full suggestion text when present. Do not summarize, truncate, or omit suggestions.
   - The user should be able to decide whether and how each issue should be fixed based solely on what you display here, without needing to inspect the raw review output.
   - Ask the user which issues they want fixed, and wait for their answer before changing files.
3. **Remember Skips**
   - For the rest of this session, remember every issue the user declines or asks to skip.
   - Do not re-raise skipped issues in later iterations.
   - Use your judgment to recognize the same issue across re-reviews, even if line numbers, snippets, ordering, or wording shift.
4. **Fix**
   - Fix only the issues the user chose for this round.
   - Keep unrelated changes out of the round.
5. **Commit**
   - After applying a round of fixes, inspect the changed files and commit the round using the repository VCS.
6. **Loop**
   - Re-run \`${reviewCommand}\` after committing fixes.
   - Continue the review -> ask -> fix -> commit -> re-review loop until the user says to stop or no un-skipped issues remain.
   - End with a short summary of fixed issues, skipped issues, and the final review state.

## Guardrails

- Never nag the user about issues they explicitly skipped during this session.
- If a re-reported issue is substantially the same as a skipped issue, suppress it from the list you show the user.
- If issues conflict or touch overlapping code, handle them yourself rather than delegating.
- If a review command fails or returns invalid JSON, explain the failure and ask the user how to proceed.
`;

  return prReviewTrailGuidance ? `${prompt}\n${prReviewTrailGuidance}` : prompt;
}

async function resolvePlanExecutionContext(target: ReviewTarget): Promise<{
  planId: string;
  planTitle: string;
  planFilePath: string;
  planData?: PlanSchema;
}> {
  if (target.kind !== 'plan') {
    return {
      planId: 'autoreview',
      planTitle: 'Autoreview Session',
      planFilePath: '',
    };
  }

  if (target.plan) {
    return {
      planId: String(target.planId),
      planTitle: target.plan.title || 'Autoreview Session',
      planFilePath: target.planPath ?? '',
      planData: target.plan,
    };
  }

  const resolvedPlan = await resolvePlanByNumericId(target.planId, target.repoRoot);
  return {
    planId: String(target.planId),
    planTitle: resolvedPlan.plan.title || 'Autoreview Session',
    planFilePath: resolvedPlan.planPath ?? '',
    planData: resolvedPlan.plan,
  };
}

function pickBestPrStatus(rows: PrStatusRow[]): PrStatusRow | undefined {
  return [...rows].sort((left: PrStatusRow, right: PrStatusRow) => {
    const leftOpen = left.state === 'open' ? 0 : 1;
    const rightOpen = right.state === 'open' ? 0 : 1;
    if (leftOpen !== rightOpen) {
      return leftOpen - rightOpen;
    }

    return left.pr_number - right.pr_number;
  })[0];
}

function mapPrStatusToAutoreviewLinkedPr(status: PrStatusRow): AutoreviewLinkedPr {
  return {
    prNumber: status.pr_number,
    owner: status.owner,
    repo: status.repo,
    url: status.pr_url,
    title: status.title ?? undefined,
    headSha: status.head_sha ?? undefined,
  };
}

export async function resolveAutoreviewLinkedPr(
  target: ReviewTarget,
  planData: PlanSchema | undefined,
  openDb: () => Database = getDatabase
): Promise<AutoreviewLinkedPr | undefined> {
  // `--pr` targets carry their own PR identity and need no database lookup, so resolve them
  // before opening the db. This keeps the PR trail working even if the database is unavailable.
  if (target.kind === 'pr') {
    return {
      prNumber: target.prNumber,
      owner: target.owner,
      repo: target.repo,
      url: target.canonicalPrUrl,
      title: target.title,
      headSha: target.headSha,
    };
  }

  try {
    switch (target.kind) {
      case 'plan': {
        if (!planData?.uuid) {
          return undefined;
        }

        const db = openDb();
        const planPullRequestUrls = planData.pullRequest;
        // Plan targets intentionally use prefer-open rather than open-only: a plan may link
        // an already-merged or closed PR and still deserves an audit trail on that PR.
        const statuses = getPrStatusForPlan(db, planData.uuid, planPullRequestUrls).map(
          (detail) => detail.status
        );
        const bestStatus = pickBestPrStatus(statuses);
        return bestStatus ? mapPrStatusToAutoreviewLinkedPr(bestStatus) : undefined;
      }
      case 'current':
      case 'branch': {
        const headBranch =
          target.kind === 'current' ? target.currentBranch : target.requestedBranch;
        if (!headBranch) {
          return undefined;
        }

        const db = openDb();
        const repoIdentity = await getRepositoryIdentity({ cwd: target.repoRoot });
        const ownerRepo = parseOwnerRepoFromRepositoryId(repoIdentity.repositoryId);
        if (!ownerRepo) {
          return undefined;
        }

        // For current/branch targets, only an open PR for the head branch represents
        // active work to mirror; if none is open, treat the target as having no linked PR.
        const statuses = findPrStatusesByRepositoryBranch(db, {
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          branch: headBranch,
          openOnly: true,
        });
        const bestStatus = pickBestPrStatus(statuses);
        return bestStatus ? mapPrStatusToAutoreviewLinkedPr(bestStatus) : undefined;
      }
    }
  } catch (err) {
    warn(
      `Failed to resolve linked PR for autoreview: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

export async function handleAutoreviewCommand(
  planId: number | undefined,
  options: AutoreviewCommandOptions,
  command: any
): Promise<void> {
  const globalOpts: ChatGlobalOptions = command.parent?.opts?.() ?? {};
  const initialConfig = await loadEffectiveConfig(globalOpts.config);

  // Selector-conflict validation (e.g. --current + --branch, or planId + --current) is handled
  // inside resolveReviewTarget via validateTargetSelectorConflicts.
  const reviewTarget = await resolveReviewTarget({
    planId,
    options,
    configPath: globalOpts.config,
  });

  const config =
    path.resolve(reviewTarget.repoRoot) === path.resolve(process.cwd())
      ? initialConfig
      : await loadEffectiveConfig(globalOpts.config, { cwd: reviewTarget.repoRoot });
  const configuredAutoreview = config.autoreview;
  const resolvedModel = resolveChatModel(
    resolveStringOption(options.model) ?? configuredAutoreview?.model
  );
  const configuredExecutor = configuredAutoreview?.executor ?? config.defaultExecutor;
  const executorName = resolveInteractiveExecutor({
    explicitExecutor: resolveStringOption(options.executor),
    configDefaultExecutor: configuredExecutor,
    resolvedModel,
    commandName: 'tim autoreview',
  });
  const effort = resolveStringOption(options.effort) ?? configuredAutoreview?.effort;
  const useJj = await getUsingJj(reviewTarget.repoRoot);
  const planContext = await resolvePlanExecutionContext(reviewTarget);
  const linkedPr = await resolveAutoreviewLinkedPr(reviewTarget, planContext.planData);
  const prompt = buildAutoreviewPrompt({
    target: reviewTarget,
    useJj,
    base: options.base,
    linkedPr,
  });

  if (options.dryRun === true) {
    console.log(prompt);
    return;
  }

  const noninteractive = options.nonInteractive === true;
  const tunnelActive = isTunnelActive();
  const { sharedExecutorOptions } = buildInteractiveExecutorOptions({
    baseDir: reviewTarget.repoRoot,
    model: resolvedModel,
    noninteractive,
    executorName,
    requestedTerminalInput: options.terminalInput,
    configTerminalInput: config.terminalInput,
    stdinIsTTY: process.stdin.isTTY,
    codexAppServerEnabled: isCodexAppServerEnabled(),
  });

  await runWithHeadlessAdapterIfEnabled({
    enabled: options.headlessAdapter === true || !tunnelActive,
    command: 'autoreview',
    interactive: !noninteractive,
    plan: planContext.planData
      ? {
          id: planContext.planData.id,
          uuid: planContext.planData.uuid,
          title: planContext.planData.title,
        }
      : undefined,
    callback: async () => {
      let currentBaseDir = reviewTarget.repoRoot;
      let currentPlanFile = planContext.planFilePath;
      let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
      let touchedWorkspacePath: string | null = null;
      let executionError: unknown;
      let planWatcher: ReturnType<typeof watchPlanFile> | undefined;
      let lifecycleManager: LifecycleManager | undefined;

      try {
        const workspaceRequested =
          options.workspace !== undefined ||
          options.autoWorkspace === true ||
          options.newWorkspace === true;
        const useWorkspace = workspaceRequested || reviewTarget.kind !== 'current';

        if (useWorkspace) {
          let checkoutBranch: string | undefined;
          if (reviewTarget.kind === 'plan' && planContext.planData) {
            checkoutBranch = planContext.planData.branch;
          } else if (reviewTarget.kind === 'branch') {
            checkoutBranch = reviewTarget.requestedBranch;
          } else if (reviewTarget.kind === 'pr') {
            checkoutBranch = reviewTarget.headBranch;
          }

          const workspaceResult = await setupWorkspace(
            {
              workspace: options.workspace,
              autoWorkspace: options.autoWorkspace === true || !options.workspace,
              newWorkspace: options.newWorkspace,
              nonInteractive: options.nonInteractive,
              requireWorkspace: false,
              planId: planContext.planData?.id,
              planUuid: planContext.planData?.uuid,
              checkoutBranch,
              branchName: checkoutBranch,
              createBranch: checkoutBranch ? false : undefined,
              allowPrimaryWorkspaceWhenLocked: true,
            },
            reviewTarget.repoRoot,
            currentPlanFile || undefined,
            config,
            'tim autoreview'
          );
          currentBaseDir = workspaceResult.baseDir;
          currentPlanFile = workspaceResult.planFile;
          touchedWorkspacePath = currentBaseDir;

          if (path.resolve(currentBaseDir) !== path.resolve(reviewTarget.repoRoot)) {
            roundTripContext = await prepareWorkspaceRoundTrip({
              workspacePath: currentBaseDir,
              workspaceSyncEnabled: options.workspaceSync !== false,
              branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
            });
          }

          if (roundTripContext) {
            await runPreExecutionWorkspaceSync(roundTripContext);

            const materializedPlanFile = await materializePlansForExecution(
              currentBaseDir,
              planContext.planData?.id
            );
            if (materializedPlanFile) {
              currentPlanFile = materializedPlanFile;
            }
          }
        }

        const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
          config,
          currentBaseDir,
          planContext.planData
            ? {
                planId: planContext.planData.id,
                planUuid: planContext.planData.uuid,
                planFilePath: currentPlanFile,
                branch: planContext.planData.branch,
              }
            : null,
          reviewTarget.repoRoot
        );

        if (config.lifecycle?.commands && config.lifecycle.commands.length > 0) {
          const workspaceInfo = getWorkspaceInfoByPathIfAvailable(currentBaseDir);
          lifecycleManager = new LifecycleManager(
            config.lifecycle.commands,
            currentBaseDir,
            workspaceInfo?.workspaceType,
            'autoreview',
            undefined,
            {
              timEnvironment,
            }
          );
          await lifecycleManager.startup();
        }

        const executor = buildExecutorAndLog(
          executorName,
          {
            ...sharedExecutorOptions,
            baseDir: currentBaseDir,
            timEnvironment: withAutoreviewEnvironment(timEnvironment),
          },
          config,
          buildAutoreviewExecutorOptions(executorName, effort, config)
        );

        const loggerAdapter = getLoggerAdapter();
        if (currentPlanFile && loggerAdapter instanceof HeadlessAdapter) {
          planWatcher = watchPlanFile(currentPlanFile, ({ content, tasks }) => {
            loggerAdapter.sendPlanContent(content, tasks);
          });
        }

        await executor.execute(prompt, {
          planId: planContext.planId,
          planTitle: planContext.planTitle,
          planFilePath: currentPlanFile,
          executionMode: 'bare',
          interactiveSession: true,
        });
      } catch (err) {
        executionError = err;
      } finally {
        await planWatcher?.closeAndFlush();

        let lifecycleShutdownError: unknown;
        if (lifecycleManager) {
          try {
            await lifecycleManager.shutdown();
          } catch (err) {
            lifecycleShutdownError = err;
          }
        }

        let roundTripError: unknown;
        if (roundTripContext) {
          try {
            await runPostExecutionWorkspaceSync(roundTripContext, 'autoreview session');
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
            warn(
              `Lifecycle shutdown failed after autoreview error: ${lifecycleShutdownError as Error}`
            );
          }
          if (roundTripError) {
            warn(`Workspace sync failed after autoreview error: ${roundTripError as Error}`);
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
    },
  });
}
