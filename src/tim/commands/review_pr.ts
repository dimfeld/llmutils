import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import type { Database } from 'bun:sqlite';
import {
  getGitInfoExcludePath,
  getMergeBase,
  getGitRoot,
  isIgnoredByGitSharedExcludes,
} from '../../common/git.js';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { parseLineRange } from '../../common/review_line_range.js';
export { parseLineRange };
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import {
  createReview,
  getLatestReviewByPrUrl,
  getReviewIssues,
  type ReviewIssueRow,
} from '../db/review.js';
import { getLinkedPlansByPrUrl } from '../db/pr_status.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { type PrReviewMetadata } from './review_pr_prompt.js';
import {
  loadCustomReviewInstructions,
  loadReviewGuideDiffCatalog,
  resolveProjectContextForRepo,
  runReviewGuideWorkflow,
} from './review_workflow.js';
export { buildReviewGuideDiffCatalog, expandReviewGuideDiffReferences } from './review_workflow.js';
import { resolveReviewExecutorSelection } from '../review_runner.js';
import { gatherPrContext, checkoutPrBranch, resolvePrUrl } from '../utils/pr_context_gathering.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { getSignalExitCode, isShuttingDown, setDeferSignalExit } from '../shutdown_state.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

export interface ReviewGuideCommandOptions {
  plan?: number;
  executor?: string;
  autoWorkspace?: boolean;
  model?: string;
  terminalInput?: boolean;
  nonInteractive?: boolean;
  verbose?: boolean;
}

interface MaterializeCommandOptions {
  // Currently no options; placeholder for future extension.
}

const REVIEW_GUIDE_FILENAME = 'review-guide.md';
const MATERIALIZED_REVIEWS_DIR = path.join('.tim', 'reviews');

const SEVERITY_ORDER: ReviewIssueRow['severity'][] = ['critical', 'major', 'minor', 'info', 'note'];

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function buildPrMetadata(context: Awaited<ReturnType<typeof gatherPrContext>>): PrReviewMetadata {
  return {
    kind: 'pr',
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    title: context.prStatus.title,
    author: context.prStatus.author,
    baseBranch: context.baseBranch,
    headBranch: context.headBranch,
    owner: context.owner,
    repo: context.repo,
  };
}

function updateReviewGuideSessionInfo(
  db: Database,
  context: Awaited<ReturnType<typeof gatherPrContext>>
): void {
  const linkedPlan = getLinkedPlansByPrUrl(db, [context.prUrl]).get(context.prUrl)?.[0];

  updateHeadlessSessionInfo({
    linkedPrUrl: context.prUrl,
    linkedPrNumber: context.prNumber,
    linkedPrTitle: context.prStatus.title ?? undefined,
    linkedPlanId: linkedPlan?.planId,
    linkedPlanUuid: linkedPlan?.planUuid,
    linkedPlanTitle: linkedPlan?.title ?? undefined,
  });
}

async function resolveReviewedShaAfterCheckout(
  baseDir: string,
  fallbackReviewedSha: string
): Promise<string> {
  const result = await $`git rev-parse HEAD`.cwd(baseDir).quiet().nothrow();
  const sha = result.stdout.toString().trim();
  return result.exitCode === 0 && sha ? sha : fallbackReviewedSha;
}

async function resolveReviewGuideBaseSha(baseDir: string, baseBranch: string): Promise<string> {
  const remoteBaseRef = `origin/${baseBranch}`;
  const gitResult = await $`git merge-base HEAD ${remoteBaseRef}`.cwd(baseDir).quiet().nothrow();
  const gitBaseSha = gitResult.stdout.toString().trim();
  if (gitResult.exitCode === 0 && gitBaseSha) {
    return gitBaseSha;
  }

  const fallbackBaseSha = await getMergeBase(baseDir, baseBranch, 'HEAD');
  if (fallbackBaseSha) {
    log(
      `Resolved PR review diff base with repository merge-base fallback for ${baseBranch}: ${fallbackBaseSha}.`
    );
    return fallbackBaseSha;
  }

  const gitError = gitResult.stderr.toString().trim();
  throw new Error(
    `Failed to resolve PR review diff base from ${remoteBaseRef}: ${gitError || 'git merge-base failed.'}`
  );
}

async function ensureReviewsDirExcluded(repoRoot: string): Promise<void> {
  const infoExcludePath = await getGitInfoExcludePath(repoRoot);
  if (!infoExcludePath) {
    return;
  }

  const isIgnored = await isIgnoredByGitSharedExcludes(
    repoRoot,
    path.join(MATERIALIZED_REVIEWS_DIR, '__tim_review_probe__')
  );
  if (isIgnored) {
    return;
  }

  let existing = '';
  try {
    existing = await fs.readFile(infoExcludePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const lines = existing
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(MATERIALIZED_REVIEWS_DIR)) {
    return;
  }

  const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(infoExcludePath, `${existing}${suffix}${MATERIALIZED_REVIEWS_DIR}\n`);
}

function formatIssueLocation(issue: Pick<ReviewIssueRow, 'file' | 'line' | 'start_line'>): string {
  if (!issue.file) {
    return '(no file)';
  }

  if (issue.start_line && issue.line) {
    return `${issue.file}:${issue.start_line}-${issue.line}`;
  }

  if (issue.line) {
    return `${issue.file}:${issue.line}`;
  }

  return issue.file;
}

export function formatReviewIssuesMarkdown(issues: ReviewIssueRow[]): string {
  const sections: string[] = ['# Review Issues', ''];

  for (const severity of SEVERITY_ORDER) {
    const severityIssues = issues.filter((issue) => issue.severity === severity);
    if (severityIssues.length === 0) {
      continue;
    }

    sections.push(`## ${severity[0].toUpperCase()}${severity.slice(1)} (${severityIssues.length})`);
    sections.push('');

    severityIssues.forEach((issue, index) => {
      sections.push(`### ${index + 1}. ${issue.content}`);
      sections.push(`- Category: ${issue.category}`);
      sections.push(`- Location: ${formatIssueLocation(issue)}`);
      if (issue.suggestion) {
        sections.push(`- Suggestion: ${issue.suggestion}`);
      }
      if (issue.source) {
        sections.push(`- Source: ${issue.source}`);
      }
      sections.push(`- Resolved: ${issue.resolved === 1 ? 'yes' : 'no'}`);
      sections.push('');
    });
  }

  if (sections.length === 2) {
    sections.push('No issues were stored for this review.');
  }

  return sections.join('\n').trimEnd() + '\n';
}

export async function handleReviewGuideCommand(
  prArg: string | undefined,
  options: ReviewGuideCommandOptions,
  command: RootCommandLike
): Promise<void> {
  if (!prArg && options.plan === undefined) {
    throw new Error('Provide a PR URL/number or use --plan <id>.');
  }

  const globalOpts = getRootOptions(command);
  const db = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });
  const tunnelActive = isTunnelActive();

  // Review sessions can accept follow-up input from three channels:
  // terminal stdin, tunnel forwarding, or the headless adapter. TTY presence
  // only controls terminal input availability; it should not force the whole
  // review into noninteractive mode when forwarded input is still available.
  const reviewInteractive = options.nonInteractive !== true;

  const effectiveTerminalInput =
    options.terminalInput !== false &&
    config.terminalInput !== false &&
    reviewInteractive &&
    process.stdin.isTTY === true;

  const reviewSelection = resolveReviewExecutorSelection(options.executor, config);

  let baseDir = initialRepoRoot;

  try {
    // Allow SIGTERM/SIGINT to be captured while this command finishes async cleanup.
    // The tim CLI will exit using the stored signal code once the callback completes.
    setDeferSignalExit(true);

    await runWithHeadlessAdapterIfEnabled({
      enabled: !tunnelActive,
      command: 'review-guide',
      interactive: reviewInteractive,
      callback: async () => {
        const prContext = await gatherPrContext({
          db,
          prUrlOrNumber: prArg,
          plan: options.plan,
          cwd: baseDir,
        });
        updateReviewGuideSessionInfo(db, prContext);

        const metadata = buildPrMetadata(prContext);
        const { projectId, repoRoot } = await resolveProjectContextForRepo(db, baseDir);
        const repoIdentity = await getRepositoryIdentity({ cwd: repoRoot });
        const parsedRepositoryId = parseOwnerRepoFromRepositoryId(repoIdentity.repositoryId);
        if (!parsedRepositoryId) {
          throw new Error(
            `Cannot validate repository identity: ${repoIdentity.repositoryId} is not a recognized GitHub repository. This command only works with GitHub PRs.`
          );
        }
        if (
          parsedRepositoryId.owner.toLowerCase() !== prContext.owner.toLowerCase() ||
          parsedRepositoryId.repo.toLowerCase() !== prContext.repo.toLowerCase()
        ) {
          throw new Error(
            `PR ${prContext.prUrl} belongs to ${prContext.owner}/${prContext.repo}, but the current repository is ${parsedRepositoryId.owner}/${parsedRepositoryId.repo}. Run this command from inside the matching repository.`
          );
        }

        if (options.autoWorkspace === true) {
          const selector = new WorkspaceAutoSelector(baseDir, config);
          const taskId = `pr-review-${prContext.prNumber}-${Date.now()}`;
          const selectedWorkspace = await selector.selectWorkspace(taskId, undefined, {
            interactive: options.nonInteractive !== true,
            createBranch: false,
          });
          if (!selectedWorkspace) {
            throw new Error('Failed to select or create a workspace for PR review.');
          }

          const lockInfo = await WorkspaceLock.acquireLock(
            selectedWorkspace.workspace.workspacePath,
            'tim pr review-guide',
            {
              type: 'pid',
              ...(selectedWorkspace.isNew ? { allowPersistentToPidTransition: true } : {}),
            }
          );
          WorkspaceLock.setupCleanupHandlers(
            selectedWorkspace.workspace.workspacePath,
            lockInfo.type
          );

          baseDir = selectedWorkspace.workspace.workspacePath;
          updateHeadlessSessionInfo({ workspacePath: baseDir });
        }

        await checkoutPrBranch({
          branch: prContext.headBranch,
          baseBranch: prContext.baseBranch,
          prNumber: prContext.prNumber,
          skipDirtyCheck: options.autoWorkspace === true,
          cwd: baseDir,
        });

        // checkoutPrBranch uses Git fetch/checkout even for colocated jj repositories so review
        // diffs should resolve against the Git refs that checkout just fetched.
        const reviewedSha = await resolveReviewedShaAfterCheckout(baseDir, prContext.headSha);
        const baseSha = await resolveReviewGuideBaseSha(baseDir, prContext.baseBranch);
        const diffCatalog = await loadReviewGuideDiffCatalog({
          baseDir,
          baseSha,
          reviewedSha,
        });
        const customInstructions = await loadCustomReviewInstructions(config, baseDir);

        const review = createReview(db, {
          projectId,
          prStatusId: prContext.prStatus.id,
          prUrl: prContext.prUrl,
          branch: prContext.headBranch,
          baseBranch: prContext.baseBranch,
          status: 'in_progress',
        });

        await runReviewGuideWorkflow({
          db,
          config,
          baseDir,
          review,
          metadata,
          baseSha,
          reviewedSha,
          diffCatalog,
          executorSelection: reviewSelection,
          executorTerminalInput: effectiveTerminalInput,
          executorNoninteractive: !reviewInteractive,
          customInstructions,
          verbose: options.verbose,
          model: options.model,
          filesReviewed: prContext.prStatus.changed_files ?? 0,
          completionLabel: prContext.prUrl,
        });
      },
    });
  } finally {
    setDeferSignalExit(false);
    if (isShuttingDown()) {
      process.exit(getSignalExitCode() ?? 1);
    }
  }
}

export async function handleMaterializeCommand(
  prArg: string,
  _options: MaterializeCommandOptions,
  command: RootCommandLike
): Promise<void> {
  const globalOpts = getRootOptions(command);
  const db = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });

  const canonicalPrUrl = await resolvePrUrl({
    db,
    prUrlOrNumber: prArg,
    cwd: process.cwd(),
  });
  const { repoRoot, projectId } = await resolveProjectContextForRepo(db, process.cwd());
  const review = getLatestReviewByPrUrl(db, canonicalPrUrl, { projectId, status: 'complete' });
  if (!review) {
    throw new Error(
      `No completed review found for ${canonicalPrUrl}. Run 'tim pr review-guide ${prArg}' first.`
    );
  }

  const issues = getReviewIssues(db, review.id);
  const reviewsDir = path.join(repoRoot, MATERIALIZED_REVIEWS_DIR);
  await fs.mkdir(reviewsDir, { recursive: true });
  await ensureReviewsDirExcluded(repoRoot);

  const guidePath = path.join(reviewsDir, REVIEW_GUIDE_FILENAME);
  const issuesPath = path.join(reviewsDir, 'review-issues.md');

  const guideContent = review.review_guide?.trim().length
    ? review.review_guide
    : '# Review Guide\n\nNo review guide was stored for this run.\n';
  await fs.writeFile(guidePath, guideContent, 'utf8');
  await fs.writeFile(issuesPath, formatReviewIssuesMarkdown(issues), 'utf8');

  log(`Materialized review artifacts:`);
  log(`  ${guidePath}`);
  log(`  ${issuesPath}`);
}
