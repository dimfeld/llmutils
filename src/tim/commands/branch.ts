import { writeStdout } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { slugify } from '../id_utils.js';
import { parseLinearIssueIdentifier } from '../../common/linear.js';
import { parseGitHubIssueIdentifier } from '../../common/github/issues.js';
import { getDatabase } from '../db/database.js';
import { getProjectSetting } from '../db/project_settings.js';
import { resolveProjectContext } from '../plan_materialize.js';
import {
  findLatestPlanFromDb,
  findNextPlanFromDb,
  findNextReadyDependencyFromDb,
} from './plan_discovery.js';
import { resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { Database } from 'bun:sqlite';
import { BRANCH_PREFIX_VALIDATION_MESSAGE, isValidBranchPrefix } from '../branch_prefix.js';

type BranchCommandOptions = {
  next?: boolean;
  current?: boolean;
  nextReady?: number;
  latest?: boolean;
};

export class BranchPrefixValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchPrefixValidationError';
  }
}

const MAX_BRANCH_NAME_LENGTH = 63;

export function normalizeBranchPrefix(prefix: string | undefined): string {
  if (!prefix) {
    return '';
  }

  const trimmed = prefix.trim();
  if (trimmed.length === 0) {
    return '';
  }

  if (!isValidBranchPrefix(trimmed)) {
    throw new BranchPrefixValidationError(
      `Invalid branch prefix "${trimmed}": ${BRANCH_PREFIX_VALIDATION_MESSAGE}`
    );
  }

  if (trimmed.endsWith('/') || trimmed.endsWith('-') || trimmed.endsWith('_')) {
    return trimmed;
  }

  return `${trimmed}/`;
}

export function resolveBranchPrefix(options: {
  config: TimConfig;
  db: Database;
  projectId: number;
}): string {
  const settingValue = getProjectSetting(options.db, options.projectId, 'branchPrefix');
  const normalizedSetting =
    typeof settingValue === 'string' ? normalizeBranchPrefix(settingValue) : '';
  const resolvedPrefix =
    normalizedSetting.length > 0
      ? normalizedSetting
      : normalizeBranchPrefix(options.config.branchPrefix);

  if (options.config.requireBranchPrefix === true && resolvedPrefix.length === 0) {
    throw new BranchPrefixValidationError(
      'This repository requires a branch prefix (`requireBranchPrefix` is enabled), but none is configured. Set `branchPrefix` in your tim config or set the per-project `branchPrefix` setting in the web UI.'
    );
  }

  return resolvedPrefix;
}

export function generateBranchNameFromPlan(
  plan: PlanSchema,
  options?: { branchPrefix?: string; parentPlan?: PlanSchema }
): string {
  const title = plan.title || plan.goal || 'plan';
  const slug = slugify(title);
  const issueId = getIssueIdFromPlanIssues(plan, options?.parentPlan);
  const slugSegment = slug.length > 0 ? slug : undefined;
  const branchPrefix = normalizeBranchPrefix(options?.branchPrefix);
  if (branchPrefix.length >= MAX_BRANCH_NAME_LENGTH) {
    throw new BranchPrefixValidationError(
      `Branch prefix "${branchPrefix}" is too long; it must be shorter than ${MAX_BRANCH_NAME_LENGTH} characters`
    );
  }
  const maxBaseNameLength = Math.max(0, MAX_BRANCH_NAME_LENGTH - branchPrefix.length);

  if (plan.id !== undefined && plan.id !== null) {
    return `${branchPrefix}${buildBranchNameWithId(plan.id, slugSegment, issueId, maxBaseNameLength)}`;
  } else {
    return `${branchPrefix}${buildBranchNameWithoutId(slugSegment, issueId, maxBaseNameLength)}`;
  }
}

interface BranchIssueReference {
  branchIssueId: string;
  identity: string;
}

function parseBranchIssueReference(rawIssue: string): BranchIssueReference | undefined {
  const linearParsedIssue = parseLinearIssueIdentifier(rawIssue);
  if (linearParsedIssue) {
    const identifier = linearParsedIssue.identifier.toLowerCase();
    const owner = linearParsedIssue.owner?.toLowerCase();
    return {
      branchIssueId: identifier,
      identity: owner ? `linear:${owner}:${identifier}` : `linear:${identifier}`,
    };
  }

  const githubParsedIssue = parseGitHubIssueIdentifier(rawIssue);
  if (githubParsedIssue) {
    const identifier = githubParsedIssue.identifier;
    const owner = githubParsedIssue.owner?.toLowerCase();
    const repo = githubParsedIssue.repo?.toLowerCase();
    return {
      branchIssueId: `gh-${identifier}`,
      identity: owner && repo ? `github:${owner}/${repo}:${identifier}` : `github:${identifier}`,
    };
  }

  return undefined;
}

function getIssueIdFromPlanIssues(
  plan: PlanSchema,
  parentPlan: PlanSchema | undefined
): string | undefined {
  if (!plan.issue || plan.issue.length === 0) {
    return undefined;
  }

  const planIssueReferences = plan.issue
    .map((rawIssue) => parseBranchIssueReference(rawIssue))
    .filter((issueReference) => issueReference !== undefined);

  if (planIssueReferences.length === 0) {
    return undefined;
  }

  if (plan.parent && parentPlan?.issue && parentPlan.issue.length > 0) {
    const parentIssueIdentities = new Set(
      parentPlan.issue
        .map((rawIssue) => parseBranchIssueReference(rawIssue)?.identity)
        .filter((identity) => identity !== undefined)
    );
    const childOnlyIssue = planIssueReferences.find(
      (issueReference) => !parentIssueIdentities.has(issueReference.identity)
    );
    if (childOnlyIssue) {
      return childOnlyIssue.branchIssueId;
    }
  }

  return planIssueReferences[0].branchIssueId;
}

export async function resolveParentPlanForBranchName(
  plan: PlanSchema,
  repoRoot: string
): Promise<PlanSchema | undefined> {
  if (!plan.parent) {
    return undefined;
  }

  try {
    return (await resolvePlanByNumericId(plan.parent, repoRoot)).plan;
  } catch {
    return undefined;
  }
}

function buildBranchNameWithId(
  planId: number,
  slugSegment: string | undefined,
  issueId: string | undefined,
  maxLength: number
): string {
  return buildBranchNameWithSlugSegment(`${planId}`, slugSegment, issueId, maxLength);
}

function buildBranchNameWithoutId(
  slugSegment: string | undefined,
  issueId: string | undefined,
  maxLength: number
): string {
  return buildBranchNameWithSlugSegment('plan', slugSegment, issueId, maxLength);
}

function buildBranchNameWithSlugSegment(
  prefix: string,
  slugSegment: string | undefined,
  issueId: string | undefined,
  maxLength: number
): string {
  const issueSuffix = issueId ? `-${issueId}` : '';
  const baseBranch = `${prefix}${issueSuffix}`;

  if (!slugSegment) {
    if (baseBranch.length > maxLength) {
      throw new BranchPrefixValidationError(
        `Generated branch name "${baseBranch}" exceeds ${maxLength} characters`
      );
    }

    return baseBranch;
  }

  const availableSlugLength = maxLength - baseBranch.length - 1;
  if (availableSlugLength <= 0) {
    if (baseBranch.length > maxLength) {
      throw new BranchPrefixValidationError(
        `Generated branch name "${baseBranch}" exceeds ${maxLength} characters`
      );
    }

    return baseBranch;
  }

  const slugPart = slugSegment.slice(0, availableSlugLength);
  if (slugPart.length === 0) {
    return baseBranch;
  }

  return `${prefix}-${slugPart}${issueSuffix}`;
}

export async function handleBranchCommand(
  planId: number | undefined,
  options: BranchCommandOptions,
  command: any
): Promise<void> {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const repoRoot = (await getGitRoot()) || process.cwd();
  const effectiveRepoRoot = globalOpts.config
    ? await resolveRepoRoot(globalOpts.config, repoRoot)
    : repoRoot;

  let selectedPlan: PlanSchema | undefined;
  let selectedPlanRepoRoot = effectiveRepoRoot;

  if (options.nextReady !== undefined) {
    const result = await findNextReadyDependencyFromDb(
      options.nextReady,
      selectedPlanRepoRoot,
      selectedPlanRepoRoot,
      true
    );
    if (!result.plan) {
      throw new Error(result.message);
    }

    selectedPlan = result.plan;
  } else if (options.latest) {
    const latestPlan = await findLatestPlanFromDb(effectiveRepoRoot, effectiveRepoRoot);
    if (!latestPlan) {
      throw new Error('No plans with updatedAt field found in the database.');
    }

    selectedPlan = latestPlan;
  } else if (options.next || options.current) {
    const plan = await findNextPlanFromDb(effectiveRepoRoot, effectiveRepoRoot, {
      includePending: true,
      includeInProgress: options.current,
    });

    if (!plan) {
      if (options.current) {
        throw new Error(
          'No current plans found. No plans are in progress or ready to be implemented.'
        );
      } else {
        throw new Error('No ready plans found. All pending plans have incomplete dependencies.');
      }
    }

    selectedPlan = plan;
  } else {
    if (!planId) {
      throw new Error(
        'Please provide a numeric plan ID or use --latest/--next/--current/--next-ready to find a plan'
      );
    }

    const planRepoRoot = await resolveRepoRoot(globalOpts.config, repoRoot);
    selectedPlanRepoRoot = planRepoRoot;
    selectedPlan = (await resolvePlanByNumericId(planId, planRepoRoot)).plan;
  }

  const plan = selectedPlan;
  if (!plan) {
    throw new Error('Failed to resolve plan');
  }
  let branchName: string;
  if (plan.branch) {
    branchName = plan.branch;
  } else {
    const effectiveConfig =
      selectedPlanRepoRoot !== repoRoot
        ? await loadEffectiveConfig(globalOpts.config, { cwd: selectedPlanRepoRoot })
        : config;
    branchName = generateBranchNameFromPlan(plan, {
      parentPlan: await resolveParentPlanForBranchName(plan, selectedPlanRepoRoot),
      branchPrefix: resolveBranchPrefix({
        config: effectiveConfig,
        db: getDatabase(),
        projectId: (await resolveProjectContext(selectedPlanRepoRoot)).projectId,
      }),
    });
  }
  writeStdout(`${branchName}\n`);
}
