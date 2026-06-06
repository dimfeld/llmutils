import { $ } from 'bun';
import type { Database } from 'bun:sqlite';
import {
  getCurrentBranchName,
  getGitRoot,
  getTrunkBranch,
  getUsingJj,
  remoteBranchExists,
} from '../../common/git.js';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import type { PrStatusRow } from '../db/pr_status.js';
import { getDatabase } from '../db/database.js';
import type { PlanSchema } from '../planSchema.js';
import { PlanNotFoundError, resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { gatherPrContext, type PrReviewContext } from '../utils/pr_context_gathering.js';

export interface PlanReviewTarget {
  kind: 'plan';
  planId: number;
  planUuid?: string;
  planPath: string | null;
  plan: PlanSchema;
  repoRoot: string;
  planBranch?: string;
  autoSelected?: {
    selectionReason: 'branch-name';
    displayPath?: string;
  };
}

export interface CurrentWorktreeReviewTarget {
  kind: 'current';
  repoRoot: string;
  currentBranch?: string;
  baseBranch: string;
  worktreePath: string;
}

export interface BranchReviewTarget {
  kind: 'branch';
  repoRoot: string;
  requestedBranch: string;
  baseBranch: string;
  workspacePath?: string;
  checkout: {
    branchExistsLocally: boolean;
    branchExistsRemotely: boolean;
  };
}

export interface PullRequestReviewTarget {
  kind: 'pr';
  repoRoot: string;
  canonicalPrUrl: string;
  prNumber: number;
  title?: string;
  owner: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  workspacePath?: string;
  prStatusId?: number;
  prStatus: PrStatusRow;
}

export type ReviewTarget =
  | PlanReviewTarget
  | CurrentWorktreeReviewTarget
  | BranchReviewTarget
  | PullRequestReviewTarget;

export interface ReviewTargetOptions {
  current?: boolean;
  branch?: string;
  pr?: string;
  plan?: number;
  base?: string;
  cwd?: string;
}

export interface ResolveReviewTargetOptions {
  planId?: number;
  options: ReviewTargetOptions;
  configPath?: string;
}

export interface ReviewTargetDependencies {
  getDatabase: typeof getDatabase;
  resolveRepoRoot: typeof resolveRepoRoot;
  resolvePlanByNumericId: typeof resolvePlanByNumericId;
  getCurrentBranchName: typeof getCurrentBranchName;
  getTrunkBranch: typeof getTrunkBranch;
  getGitRoot: typeof getGitRoot;
  getUsingJj: typeof getUsingJj;
  remoteBranchExists: typeof remoteBranchExists;
  getRepositoryIdentity: typeof getRepositoryIdentity;
  gatherPrContext: typeof gatherPrContext;
  branchExistsLocally: (repoRoot: string, branchName: string) => Promise<boolean>;
}

const defaultDependencies: ReviewTargetDependencies = {
  getDatabase,
  resolveRepoRoot,
  resolvePlanByNumericId,
  getCurrentBranchName,
  getTrunkBranch,
  getGitRoot,
  getUsingJj,
  remoteBranchExists,
  getRepositoryIdentity,
  gatherPrContext,
  branchExistsLocally,
};

function normalizeSelectorValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getSelectedPlanId(
  planId: number | undefined,
  options: ReviewTargetOptions
): number | undefined {
  return planId ?? options.plan;
}

function validateTargetSelectorConflicts(
  planId: number | undefined,
  options: ReviewTargetOptions
): void {
  const selectedPlanId = getSelectedPlanId(planId, options);
  const selectors = [
    options.current === true ? '--current' : null,
    normalizeSelectorValue(options.branch) ? '--branch' : null,
    normalizeSelectorValue(options.pr) ? '--pr' : null,
  ].filter((selector): selector is string => selector !== null);

  if (selectedPlanId !== undefined && selectors.length > 0) {
    throw new Error(
      `Cannot combine a plan ID with ${selectors.join(', ')}. Use either a plan-backed review target or one planless target selector.`
    );
  }

  if (selectors.length > 1) {
    throw new Error(
      `Conflicting review target selectors: ${selectors.join(', ')}. Use only one of --current, --branch, or --pr.`
    );
  }
}

function createExplicitPlanTarget(planId: number, repoRoot: string): PlanReviewTarget {
  return {
    kind: 'plan',
    planId,
    planPath: null,
    plan: {
      id: planId,
      status: 'pending',
      title: '',
      goal: '',
      tasks: [],
    },
    repoRoot,
  };
}

async function resolveAutoSelectedPlanTarget(
  planId: number,
  repoRoot: string,
  deps: ReviewTargetDependencies,
  autoSelected?: PlanReviewTarget['autoSelected']
): Promise<PlanReviewTarget> {
  const resolved = await deps.resolvePlanByNumericId(planId, repoRoot);
  return {
    kind: 'plan',
    planId,
    planUuid: resolved.plan.uuid,
    planPath: resolved.planPath,
    plan: resolved.plan,
    repoRoot,
    planBranch: resolved.plan.branch,
    ...(autoSelected ? { autoSelected } : {}),
  };
}

async function autoSelectPlanFromBranch(
  repoRoot: string,
  deps: ReviewTargetDependencies
): Promise<PlanReviewTarget | null> {
  const branchName = await deps.getCurrentBranchName(repoRoot);
  const planIdMatch = branchName?.match(/^(\d+)-/);
  if (!planIdMatch) {
    return null;
  }

  const inferredPlanId = Number.parseInt(planIdMatch[1], 10);
  if (!Number.isInteger(inferredPlanId)) {
    return null;
  }

  try {
    const target = await resolveAutoSelectedPlanTarget(inferredPlanId, repoRoot, deps, {
      selectionReason: 'branch-name',
    });
    if (target.planPath) {
      target.autoSelected = {
        selectionReason: 'branch-name',
        displayPath: target.planPath,
      };
    }
    return target;
  } catch (err) {
    if (!(err instanceof PlanNotFoundError)) {
      throw err;
    }
    return null;
  }
}

async function resolveEffectiveBaseBranch(
  repoRoot: string,
  explicitBase: string | undefined,
  deps: ReviewTargetDependencies
): Promise<string> {
  const normalizedBase = normalizeSelectorValue(explicitBase);
  return normalizedBase ?? (await deps.getTrunkBranch(repoRoot));
}

async function resolveCurrentTarget(
  repoRoot: string,
  options: ReviewTargetOptions,
  deps: ReviewTargetDependencies
): Promise<CurrentWorktreeReviewTarget> {
  const [currentBranch, baseBranch] = await Promise.all([
    deps.getCurrentBranchName(repoRoot),
    resolveEffectiveBaseBranch(repoRoot, options.base, deps),
  ]);

  return {
    kind: 'current',
    repoRoot,
    currentBranch: currentBranch ?? undefined,
    baseBranch,
    worktreePath: repoRoot,
  };
}

async function branchExistsLocally(repoRoot: string, branchName: string): Promise<boolean> {
  const usingJj = await getUsingJj(repoRoot);
  const result = usingJj
    ? await $`jj log -r ${branchName} --no-graph -T commit_id`.cwd(repoRoot).quiet().nothrow()
    : await $`git show-ref --verify --quiet refs/heads/${branchName}`.cwd(repoRoot).nothrow();
  return result.exitCode === 0;
}

async function resolveBranchTarget(
  repoRoot: string,
  requestedBranch: string,
  options: ReviewTargetOptions,
  deps: ReviewTargetDependencies
): Promise<BranchReviewTarget> {
  const [baseBranch, localExists] = await Promise.all([
    resolveEffectiveBaseBranch(repoRoot, options.base, deps),
    deps.branchExistsLocally(repoRoot, requestedBranch),
  ]);
  const remoteExists = localExists
    ? false
    : await deps.remoteBranchExists(repoRoot, requestedBranch);

  if (!localExists && !remoteExists) {
    throw new Error(
      `Branch "${requestedBranch}" was not found locally or on origin. Check the branch name or fetch it before reviewing.`
    );
  }

  return {
    kind: 'branch',
    repoRoot,
    requestedBranch,
    baseBranch,
    checkout: {
      branchExistsLocally: localExists,
      branchExistsRemotely: remoteExists,
    },
  };
}

function validatePrMatchesCurrentRepository(
  prContext: PrReviewContext,
  repositoryId: string
): void {
  const parsedRepositoryId = parseOwnerRepoFromRepositoryId(repositoryId);
  if (!parsedRepositoryId) {
    throw new Error(
      `Cannot validate repository identity: ${repositoryId} is not a recognized GitHub repository. This command only works with GitHub PRs.`
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
}

async function resolvePrTarget(
  repoRoot: string,
  prUrlOrNumber: string,
  options: ReviewTargetOptions,
  deps: ReviewTargetDependencies
): Promise<PullRequestReviewTarget> {
  const db: Database = deps.getDatabase();
  const prContext = await deps.gatherPrContext({
    db,
    prUrlOrNumber,
    cwd: repoRoot,
  });
  const repoIdentity = await deps.getRepositoryIdentity({ cwd: repoRoot });
  validatePrMatchesCurrentRepository(prContext, repoIdentity.repositoryId);

  return {
    kind: 'pr',
    repoRoot,
    canonicalPrUrl: prContext.prUrl,
    prNumber: prContext.prNumber,
    title: prContext.prStatus.title ?? undefined,
    owner: prContext.owner,
    repo: prContext.repo,
    baseBranch: normalizeSelectorValue(options.base) ?? prContext.baseBranch,
    headBranch: prContext.headBranch,
    headSha: prContext.headSha,
    prStatusId: prContext.prStatus.id,
    prStatus: prContext.prStatus,
  };
}

export async function resolveReviewTarget(
  input: ResolveReviewTargetOptions,
  deps: ReviewTargetDependencies = defaultDependencies
): Promise<ReviewTarget> {
  validateTargetSelectorConflicts(input.planId, input.options);

  const cwd = input.options.cwd ?? process.cwd();
  const repoRoot = await deps.resolveRepoRoot(input.configPath, cwd);
  const explicitPlanId = getSelectedPlanId(input.planId, input.options);
  if (explicitPlanId !== undefined) {
    return createExplicitPlanTarget(explicitPlanId, repoRoot);
  }

  const branchSelector = normalizeSelectorValue(input.options.branch);
  if (branchSelector) {
    return resolveBranchTarget(repoRoot, branchSelector, input.options, deps);
  }

  const prSelector = normalizeSelectorValue(input.options.pr);
  if (prSelector) {
    return resolvePrTarget(repoRoot, prSelector, input.options, deps);
  }

  const autoSelectedPlan = await autoSelectPlanFromBranch(repoRoot, deps);
  if (autoSelectedPlan) {
    return autoSelectedPlan;
  }

  return resolveCurrentTarget(repoRoot, input.options, deps);
}
