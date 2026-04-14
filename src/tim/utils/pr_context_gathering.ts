import { $ } from 'bun';
import type { Database } from 'bun:sqlite';
import {
  canonicalizePrUrl,
  parsePrOrIssueNumber,
  validatePrIdentifier,
} from '../../common/github/identifiers.js';
import {
  getGitRepository,
  getGitRoot,
  getUsingJj,
  getWorkingCopyStatus,
  type WorkingCopyStatus,
} from '../../common/git.js';
import { refreshPrStatus } from '../../common/github/pr_status_service.js';
import {
  getPrStatusByUrl,
  getPrStatusForPlan,
  type PrStatusDetail,
  type PrStatusRow,
} from '../db/pr_status.js';
import { resolvePlanFromDb } from '../plans.js';

const DEFAULT_PR_STATUS_MAX_AGE_MS = 30 * 60 * 1000;

export interface PrReviewContext {
  prStatus: PrStatusRow;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
}

export interface GatherPrContextOptions {
  db: Database;
  prUrlOrNumber?: string;
  plan?: string | number;
  cwd?: string;
  maxStatusAgeMs?: number;
}

export interface PrContextGatheringDependencies {
  canonicalizePrUrl: typeof canonicalizePrUrl;
  parsePrOrIssueNumber: typeof parsePrOrIssueNumber;
  validatePrIdentifier: typeof validatePrIdentifier;
  getGitRepository: typeof getGitRepository;
  getGitRoot: typeof getGitRoot;
  resolvePlanFromDb: typeof resolvePlanFromDb;
  getPrStatusByUrl: typeof getPrStatusByUrl;
  getPrStatusForPlan: typeof getPrStatusForPlan;
  refreshPrStatus: typeof refreshPrStatus;
}

const defaultDependencies: PrContextGatheringDependencies = {
  canonicalizePrUrl,
  parsePrOrIssueNumber,
  validatePrIdentifier,
  getGitRepository,
  getGitRoot,
  resolvePlanFromDb,
  getPrStatusByUrl,
  getPrStatusForPlan,
  refreshPrStatus,
};

function parseStatusTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function isStatusStale(detail: PrStatusDetail, maxAgeMs: number): boolean {
  const fetchedAt = parseStatusTimestamp(detail.status.last_fetched_at);
  if (fetchedAt === null) {
    return true;
  }

  return Date.now() - fetchedAt > maxAgeMs;
}

function getSingleLinkedPrUrl(details: PrStatusDetail[], planId: number): string {
  if (details.length === 0) {
    throw new Error(`Plan ${planId} has no linked pull requests.`);
  }

  if (details.length > 1) {
    throw new Error(
      `Plan ${planId} has multiple linked pull requests. Specify a PR URL or number explicitly.`
    );
  }

  return details[0]!.status.pr_url;
}

function buildPrUrlFromNumber(ownerRepo: string, prNumber: string): string {
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`Could not determine repository owner/name from git remote: ${ownerRepo}`);
  }

  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

export async function resolvePrUrl(
  options: GatherPrContextOptions,
  deps: PrContextGatheringDependencies = defaultDependencies
): Promise<string> {
  if (options.plan !== undefined) {
    const gitRoot = await deps.getGitRoot(options.cwd);
    const resolved = await deps.resolvePlanFromDb(String(options.plan), gitRoot);
    const plan = resolved.plan;
    if (!plan.uuid || !plan.id) {
      throw new Error(`Could not resolve plan UUID for plan ${options.plan}`);
    }

    const linkedPrs = deps.getPrStatusForPlan(options.db, plan.uuid);
    const planPrUrl = getSingleLinkedPrUrl(linkedPrs, plan.id);
    return deps.canonicalizePrUrl(planPrUrl);
  }

  if (!options.prUrlOrNumber) {
    throw new Error('PR URL/number is required when --plan is not provided.');
  }

  const raw = options.prUrlOrNumber.trim();
  if (/^\d+$/.test(raw)) {
    const repository = await deps.getGitRepository(options.cwd);
    const builtPrUrl = buildPrUrlFromNumber(repository, raw);
    return deps.canonicalizePrUrl(builtPrUrl);
  }

  deps.validatePrIdentifier(raw);
  return deps.canonicalizePrUrl(raw);
}

export async function gatherPrContext(
  options: GatherPrContextOptions,
  deps: PrContextGatheringDependencies = defaultDependencies
): Promise<PrReviewContext> {
  const maxStatusAgeMs = options.maxStatusAgeMs ?? DEFAULT_PR_STATUS_MAX_AGE_MS;
  const prUrl = await resolvePrUrl(options, deps);
  const parsed = await deps.parsePrOrIssueNumber(prUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${prUrl}`);
  }

  let detail = deps.getPrStatusByUrl(options.db, prUrl);
  if (!detail || isStatusStale(detail, maxStatusAgeMs)) {
    detail = await deps.refreshPrStatus(options.db, prUrl);
  }

  const baseBranch = detail.status.base_branch;
  const headBranch = detail.status.head_branch;
  const headSha = detail.status.head_sha;

  if (!baseBranch || !headBranch || !headSha) {
    throw new Error(
      `PR metadata is incomplete for ${prUrl}. Missing ${[
        !baseBranch ? 'base branch' : null,
        !headBranch ? 'head branch' : null,
        !headSha ? 'head SHA' : null,
      ]
        .filter(Boolean)
        .join(', ')}.`
    );
  }

  return {
    prStatus: detail.status,
    baseBranch,
    headBranch,
    headSha,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.number,
    prUrl,
  };
}

export interface CheckoutPrBranchOptions {
  branch: string;
  /** PR number, used to fetch via refs/pull/<number>/head for fork-based PRs. */
  prNumber?: number;
  /** Base branch to fetch so agents can compute diffs against it. */
  baseBranch?: string;
  /** Skip the dirty working tree check. The caller is responsible for ensuring workspace isolation. */
  skipDirtyCheck?: boolean;
  cwd?: string;
}

export interface BranchCheckoutDependencies {
  getWorkingCopyStatus: (cwd: string) => Promise<WorkingCopyStatus>;
  getUsingJj: typeof getUsingJj;
  runCommand: (args: string[], cwd: string) => Promise<{ exitCode: number; stderr: string }>;
}

const defaultBranchCheckoutDependencies: BranchCheckoutDependencies = {
  getWorkingCopyStatus,
  getUsingJj,
  runCommand: async (args: string[], cwd: string) => {
    const result = await $`${args}`.cwd(cwd).quiet().nothrow();
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString().trim(),
    };
  },
};

export async function checkoutPrBranch(
  options: CheckoutPrBranchOptions,
  deps: BranchCheckoutDependencies = defaultBranchCheckoutDependencies
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  if (!options.skipDirtyCheck) {
    const status = await deps.getWorkingCopyStatus(cwd);
    if (status.checkFailed) {
      throw new Error(
        'Failed to determine working tree status. Cannot safely proceed with checkout.'
      );
    }
    if (status.hasChanges) {
      throw new Error(
        'Working tree has uncommitted changes. Commit/stash them or rerun with --auto-workspace.'
      );
    }
  }

  // For now we always use Git for this since JJ can't fetch `refs/pull/*`
  const usingJj = false; // await deps.getUsingJj(cwd);
  if (usingJj) {
    await checkoutJjBranch(options.branch, options.prNumber, cwd, deps);
  } else {
    await checkoutGitBranch(options.branch, options.prNumber, cwd, deps);
  }

  // Fetch the base branch so agents can compute diffs against it.
  // Prompts instruct agents to diff against origin/<base> / <base>@origin,
  // so a failed fetch would lead to incorrect diffs.
  if (options.baseBranch) {
    const fetchArgs = usingJj
      ? ['jj', 'git', 'fetch', '--branch', options.baseBranch]
      : ['git', 'fetch', 'origin', options.baseBranch];
    const fetchResult = await deps.runCommand(fetchArgs, cwd);
    if (fetchResult.exitCode !== 0) {
      throw new Error(
        `Failed to fetch base branch "${options.baseBranch}": ${fetchResult.stderr || 'unknown error'}`
      );
    }
  }
}

async function checkoutGitBranch(
  branch: string,
  prNumber: number | undefined,
  cwd: string,
  deps: BranchCheckoutDependencies
): Promise<void> {
  // Always operate in detached HEAD for review runs to avoid mutating local branches.
  const fetchResult = await deps.runCommand(['git', 'fetch', 'origin', branch], cwd);
  if (fetchResult.exitCode === 0) {
    const detachResult = await deps.runCommand(
      ['git', 'checkout', '--detach', `origin/${branch}`],
      cwd
    );
    if (detachResult.exitCode === 0) {
      return;
    }
  }

  // For fork-based PRs, the branch won't exist on origin. Use refs/pull/<number>/head.
  if (prNumber != null) {
    const prRef = `refs/pull/${prNumber}/head`;
    const fetchPrResult = await deps.runCommand(['git', 'fetch', 'origin', prRef], cwd);
    if (fetchPrResult.exitCode === 0) {
      const checkoutPrResult = await deps.runCommand(
        ['git', 'checkout', '--detach', 'FETCH_HEAD'],
        cwd
      );
      if (checkoutPrResult.exitCode === 0) {
        return;
      }
    }
  }

  throw new Error(
    `Failed to switch to branch "${branch}" with git checkout. ` +
      `The branch may not exist on origin or as a PR ref.`
  );
}

async function checkoutJjBranch(
  branch: string,
  prNumber: number | undefined,
  cwd: string,
  deps: BranchCheckoutDependencies
): Promise<void> {
  if (prNumber != null) {
    const prRef = `refs/pull/${prNumber}/head`;
    const fetchResult = await deps.runCommand(
      ['jj', 'git', 'fetch', '--remote', 'origin', '--branch', prRef],
      cwd
    );
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch PR ref ${prRef}: ${fetchResult.stderr || 'unknown error'}`);
    }

    const setResult = await deps.runCommand(
      ['jj', 'bookmark', 'set', branch, '-r', `${prRef}@origin`],
      cwd
    );
    if (setResult.exitCode !== 0) {
      throw new Error(
        `Failed to update bookmark "${branch}": ${setResult.stderr || 'unknown error'}`
      );
    }

    const result = await deps.runCommand(['jj', 'new', branch], cwd);
    if (result.exitCode === 0) {
      return;
    }

    const errorSuffix = result.stderr ? `: ${result.stderr}` : '';
    throw new Error(`Failed to switch to branch "${branch}" with jj new${errorSuffix}`);
  }

  // jj new creates a new working-copy revision on top of the branch.
  // This is the standard jj workflow — all work happens on new revisions.
  // Same pattern as workspace_manager.ts:checkoutWorkspaceBranch().
  const result = await deps.runCommand(['jj', 'new', branch], cwd);
  if (result.exitCode === 0) {
    return;
  }

  const errorSuffix = result.stderr ? `: ${result.stderr}` : '';
  throw new Error(`Failed to switch to branch "${branch}" with jj new${errorSuffix}`);
}
