import { getGitRepository, getUsingJj } from '../../common/git.js';
import { fetchOpenPullRequests, type OpenPullRequest } from '../../common/github/pull_requests.js';
import { refreshPrStatus } from '../../common/github/pr_status_service.js';
import { boldMarkdownHeaders, log } from '../../logging.js';
import { resolveEffectivePrBase } from '../commands/create_pr.js';
import type { TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { getPrStatusByUrl, linkPlanToPrs } from '../db/pr_status.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import type { PlanSchema } from '../planSchema.js';
import { generateDiffForReview } from '../review_diff.js';
import { countChangedLines } from './changed_lines.js';

const CLAUDE_CODE_EXECUTOR_NAME = 'claude-code';
const PR_STACKING_ALLOWED_BASH_TOOLS = [
  'Bash(git:*)',
  'Bash(jj:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr view:*)',
];

export interface PrStackingPlan {
  id?: number;
  uuid?: string;
  title?: string;
  goal?: string;
  details?: string;
  branch?: string;
  pullRequest?: string[];
}

export interface RunPrStackingOptions {
  plan: PrStackingPlan;
  planFilePath: string;
  mainPrUrl: string;
  baseDir: string;
  repoPath?: string;
  config: TimConfig;
  terminalInput?: boolean;
  manual?: boolean;
  baseBranch?: string;
}

export interface PrStackingResult {
  ran: boolean;
  changedLines: number;
  reason?: 'not-configured' | 'no-changes' | 'below-threshold';
}

export interface PrStackingPromptOptions {
  plan: PrStackingPlan;
  vcsType: 'git' | 'jj';
  mainBranch: string;
  mainPrUrl: string;
  baseBranch: string;
  comparisonRef: string;
  changedLines: number;
  targetMaxChangedLines?: number;
}

export function buildPrStackingPrompt(options: PrStackingPromptOptions): string {
  const planGoal = options.plan.goal?.trim();
  const planDetails = options.plan.details?.trim();
  const planContext = [
    `Plan: ${options.plan.title ?? '(untitled plan)'}`,
    planGoal ? `Goal: ${planGoal}` : undefined,
    planDetails ? `Details:\n${planDetails}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const sliceSizeGuidance =
    options.targetMaxChangedLines === undefined
      ? []
      : [
          `- When practical, keep each slice below ${options.targetMaxChangedLines} changed lines (additions plus deletions). Treat this as a review-size target, not a reason to create incoherent slices.`,
        ];

  return [
    'The implementation and its main pull request are complete. Reorganize this branch into a stack of smaller vertical-slice pull requests when that produces a materially easier review.',
    '',
    'Do not ask for confirmation. The user has authorized commit-history rewrites, force pushes, branch creation, pull-request creation, and pull-request base/body edits for this task.',
    '',
    '## Fixed context',
    '',
    ...planContext,
    `Version control: ${options.vcsType}`,
    `Original branch: ${options.mainBranch}`,
    `Original pull request: ${options.mainPrUrl}`,
    `Stack base branch: ${options.baseBranch}`,
    `Comparison ref: ${options.comparisonRef}`,
    `Measured change size: ${options.changedLines} additions plus deletions`,
    '',
    '## Required outcome',
    '',
    `- Preserve the exact final file tree currently at ${options.mainBranch}. Do not change source, test, documentation, generated, or plan file content.`,
    '- First record the final tree identifier. After all history edits, verify that the original branch has the same final tree. If it differs, repair the stack before you finish.',
    '- A single changed file may have its hunks distributed across several slices and branches. Do not require each slice to contain all changes to a file or to change a separate set of files.',
    '- Intermediate branches may contain new changes or a temporary version of a file. This is acceptable when the combined changes from all stack commits produce exactly the original final tree. Verify the combined result before you finish.',
    ...sliceSizeGuidance,
    '- Split the work only if you can make at least two coherent vertical slices. Give each slice a focused, reviewable scope with its necessary tests and documentation. Do not make horizontal layers such as "types", "implementation", and "tests" into separate slices.',
    '- After identifying the vertical slices, inspect every large candidate slice for further coherent splits. An intermediate PR does not need to contain the full end-to-end functionality of the larger slice; it may be a partial or enabling increment because the stack will normally merge together in a merge queue. Every PR must still pass CI and remain buildable and testable on its own.',
    '- Use one commit per vertical slice. Order dependent slices from the stack base upward.',
    `- Keep ${options.mainBranch} and ${options.mainPrUrl} as the top and final slice of the stack. Never close or replace the original pull request.`,
    '- Create a unique, descriptive branch for every lower slice. Do not reuse or overwrite an unrelated local or remote branch. If the branch being split starts with the plan number, every new lower-slice branch name should also start with that plan number. Do not copy external issue-tracker IDs, such as a trailing Linear issue tag, into new lower-slice branch names. The existing top branch may retain those external IDs.',
    `- The bottom slice must target ${options.baseBranch}. Each later slice must target the branch immediately below it. Change the base of ${options.mainPrUrl} to the branch immediately below ${options.mainBranch}.`,
    '- Push every slice branch. A history rewrite of the original branch can use a force-with-lease equivalent, but do not use an unguarded force push when a guarded form is available.',
    '- Create every new lower-slice pull request as a draft. Preserve the current draft/ready state of the original pull request.',
    '- Give each pull request a focused title and body for only its slice.',
    '- Add or update a clearly marked "Stack" section in every pull-request body. It must list the complete stack in merge order, identify the current pull request, link the other pull requests, state each slice scope, and explain that reviewers should start at the bottom. Preserve useful existing body content.',
    '- In every intermediate pull-request description, refer to related issues with language such as "Related to ISSUE". Do not use "Closes", "Fixes", or other issue-closing keywords in intermediate descriptions, so the issue stays open until the complete stack is merged. The existing top pull request may keep its current issue-closing language.',
    '- After all pull requests exist, verify each head branch, base branch, draft state, title, and body with `gh pr view`.',
    '',
    '## Safe no-op',
    '',
    'If the change cannot be split into at least two coherent vertical slices without changing the final file tree, leave all commits, branches, and pull requests unchanged. Report why a split was not useful.',
    '',
    'Do not run implementation work or modify file content. This phase changes only commit history, branches, and pull-request metadata.',
  ].join('\n');
}

function areSamePullRequests(left: string, right: string): boolean {
  const normalize = (url: string): string =>
    url.replace(/\/pulls?\//, '/pull/').split(/[?#]/, 1)[0];
  return normalize(left) === normalize(right);
}

export function findStackPullRequests(
  openPullRequests: OpenPullRequest[],
  mainPrUrl: string,
  baseBranch: string
): OpenPullRequest[] {
  const mainPr = openPullRequests.find((pullRequest) =>
    areSamePullRequests(pullRequest.html_url, mainPrUrl)
  );
  if (!mainPr) {
    return [];
  }

  const pullRequestsByHeadBranch = new Map<string, OpenPullRequest[]>();
  for (const pullRequest of openPullRequests) {
    const matches = pullRequestsByHeadBranch.get(pullRequest.headRefName) ?? [];
    matches.push(pullRequest);
    pullRequestsByHeadBranch.set(pullRequest.headRefName, matches);
  }

  const stack = [mainPr];
  const seenUrls = new Set([mainPr.html_url]);
  let current = mainPr;
  while (current.baseRefName && current.baseRefName !== baseBranch) {
    const candidates = pullRequestsByHeadBranch.get(current.baseRefName) ?? [];
    const next = candidates.find((candidate) => !seenUrls.has(candidate.html_url));
    if (!next) {
      break;
    }

    stack.push(next);
    seenUrls.add(next.html_url);
    current = next;
  }

  return stack;
}

async function linkStackPullRequests(options: {
  planUuid: string | undefined;
  mainPrUrl: string;
  baseDir: string;
  baseBranch: string;
}): Promise<void> {
  if (!options.planUuid) {
    log('Cannot associate stacked pull requests: the plan has no UUID.');
    return;
  }

  const repository = await getGitRepository(options.baseDir);
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    log(`Cannot associate stacked pull requests: invalid GitHub repository "${repository}".`);
    return;
  }

  const openPullRequests = await fetchOpenPullRequests(owner, repo);
  const stackPullRequests = findStackPullRequests(
    openPullRequests,
    options.mainPrUrl,
    options.baseBranch
  );
  if (stackPullRequests.length === 0) {
    log(`Cannot associate stacked pull requests: could not find ${options.mainPrUrl} in GitHub.`);
    return;
  }

  const db = getDatabase();
  const prStatusIds: number[] = [];
  for (const pullRequest of stackPullRequests) {
    const detail =
      getPrStatusByUrl(db, pullRequest.html_url) ??
      (await refreshPrStatus(db, pullRequest.html_url));
    prStatusIds.push(detail.status.id);
  }

  linkPlanToPrs(db, options.planUuid, prStatusIds, 'auto');
  log(`Associated ${prStatusIds.length} stacked pull requests with plan ${options.planUuid}.`);
}

export async function runPrStacking(options: RunPrStackingOptions): Promise<PrStackingResult> {
  const stackingConfig = options.config.prStacking;
  const minChangedLines = stackingConfig?.minChangedLines;
  if (minChangedLines === undefined && options.manual !== true) {
    return { ran: false, changedLines: 0, reason: 'not-configured' };
  }
  if (!options.plan.branch) {
    throw new Error(`Plan ${options.plan.id ?? '(unknown)'} has no branch for PR stacking`);
  }

  let baseBranch = options.baseBranch;
  if (baseBranch === undefined) {
    if (options.plan.id === undefined) {
      throw new Error('A base branch is required when stacking a branch without a plan');
    }
    baseBranch = await resolveEffectivePrBase(
      options.plan as PlanSchema,
      options.baseDir,
      options.config
    );
  }
  const diffResult = await generateDiffForReview(options.baseDir, { baseBranch });
  if (!diffResult.mergeBaseCommit) {
    if (!diffResult.hasChanges) {
      log('Skipping PR stacking: no changes against the PR base.');
      return { ran: false, changedLines: 0, reason: 'no-changes' };
    }
    throw new Error(`Could not resolve the comparison ref for PR stacking against ${baseBranch}`);
  }

  const usingJj = await getUsingJj(options.baseDir);
  const vcsType = usingJj ? 'jj' : 'git';
  const changedLines = await countChangedLines(
    options.baseDir,
    diffResult.mergeBaseCommit,
    vcsType
  );
  if (changedLines === 0) {
    log('Skipping PR stacking: no changed lines against the PR base.');
    return { ran: false, changedLines: 0, reason: 'no-changes' };
  }
  if (options.manual !== true && minChangedLines !== undefined && changedLines < minChangedLines) {
    log(
      `Skipping PR stacking: ${changedLines} changed lines is below the configured ${minChangedLines}-line threshold.`
    );
    return { ran: false, changedLines, reason: 'below-threshold' };
  }

  const executorName =
    stackingConfig?.executor ?? options.config.defaultExecutor ?? DEFAULT_EXECUTOR;
  const model =
    stackingConfig?.model ??
    options.config.models?.execution ??
    defaultModelForExecutor(executorName, 'execution');
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: options.baseDir,
    model,
    terminalInput: options.terminalInput ?? false,
    disableInactivityTimeout: true,
    timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(
      options.config,
      options.baseDir,
      {
        planId: options.plan.id,
        planUuid: options.plan.uuid,
        planFilePath: options.planFilePath,
        branch: options.plan.branch,
      },
      options.repoPath ?? options.baseDir
    ),
  };
  const executorOptions =
    executorName === CLAUDE_CODE_EXECUTOR_NAME
      ? {
          allowedTools: [
            ...new Set([
              ...((options.config.executors as Record<string, any>)?.[CLAUDE_CODE_EXECUTOR_NAME]
                ?.allowedTools ?? []),
              ...PR_STACKING_ALLOWED_BASH_TOOLS,
            ]),
          ],
        }
      : {};
  const executor = buildExecutorAndLog(
    executorName,
    sharedExecutorOptions,
    options.config,
    executorOptions
  );
  const prompt = buildPrStackingPrompt({
    plan: options.plan,
    vcsType,
    mainBranch: options.plan.branch,
    mainPrUrl: options.mainPrUrl,
    baseBranch,
    comparisonRef: diffResult.mergeBaseCommit,
    changedLines,
    targetMaxChangedLines: minChangedLines,
  });

  log(boldMarkdownHeaders('\n## Splitting Pull Request into a Stack\n'));
  await executor.execute(prompt, {
    planId: options.plan.id?.toString() ?? options.plan.uuid ?? 'pr-stacking',
    planTitle: options.plan.title ?? 'Split Pull Request',
    planFilePath: options.planFilePath,
    executionMode: 'bare',
    captureOutput: 'none',
  });
  await linkStackPullRequests({
    planUuid: options.plan.uuid,
    mainPrUrl: options.mainPrUrl,
    baseDir: options.baseDir,
    baseBranch,
  });
  return { ran: true, changedLines };
}
