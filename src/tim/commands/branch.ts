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
import { parsePlanIdFromCliArg, resolvePlanFromDb } from '../plans.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { Database } from 'bun:sqlite';
import { BRANCH_PREFIX_VALIDATION_MESSAGE, isValidBranchPrefix } from '../branch_prefix.js';

type BranchCommandOptions = {
  next?: boolean;
  current?: boolean;
  nextReady?: string;
  latest?: boolean;
};

export class BranchPrefixValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchPrefixValidationError';
  }
}

const MAX_BRANCH_NAME_LENGTH = 63;
const MID_TRUNCATION_MARKER = '...';

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
  if (typeof settingValue === 'string' && settingValue.length > 0) {
    return normalizeBranchPrefix(settingValue);
  }

  return normalizeBranchPrefix(options.config.branchPrefix);
}

export function generateBranchNameFromPlan(
  plan: PlanSchema,
  options?: { branchPrefix?: string }
): string {
  const title = plan.title || plan.goal || 'plan';
  const slug = slugify(title);
  const issueId = getIssueIdFromPlanIssues(plan);
  const slugSegment = slug.length > 0 ? slug : undefined;
  const branchPrefix = normalizeBranchPrefix(options?.branchPrefix);
  if (branchPrefix.length >= MAX_BRANCH_NAME_LENGTH) {
    throw new BranchPrefixValidationError(
      `Branch prefix "${branchPrefix}" is too long; it must be shorter than ${MAX_BRANCH_NAME_LENGTH} characters`
    );
  }
  const maxBaseNameLength = Math.max(0, MAX_BRANCH_NAME_LENGTH - branchPrefix.length);

  let branchName: string;

  if (plan.id !== undefined && plan.id !== null) {
    branchName = buildBranchNameWithId(plan.id, slugSegment, issueId, maxBaseNameLength);
  } else {
    branchName = buildBranchNameWithoutId(slugSegment, issueId, maxBaseNameLength);
  }

  if (branchName.length > maxBaseNameLength) {
    branchName = truncateMiddle(branchName, maxBaseNameLength);
  }

  const fullBranchName = `${branchPrefix}${branchName}`;
  if (fullBranchName.length > MAX_BRANCH_NAME_LENGTH) {
    throw new BranchPrefixValidationError(
      `Generated branch name "${fullBranchName}" exceeds ${MAX_BRANCH_NAME_LENGTH} characters`
    );
  }

  return fullBranchName;
}

function getIssueIdFromPlanIssues(plan: PlanSchema): string | undefined {
  if (!plan.issue || plan.issue.length === 0) {
    return undefined;
  }

  for (const rawIssue of plan.issue) {
    const linearParsedIssue = parseLinearIssueIdentifier(rawIssue);
    if (linearParsedIssue) {
      return linearParsedIssue.identifier?.toLowerCase();
    }

    const githubParsedIssue = parseGitHubIssueIdentifier(rawIssue);
    if (githubParsedIssue) {
      return `gh-${githubParsedIssue.identifier}`;
    }
  }

  return undefined;
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
  if (!slugSegment) {
    return `${prefix}${issueSuffix}`;
  }

  const availableSlugLength = Math.max(0, maxLength - prefix.length - issueSuffix.length - 1);
  const truncatedSlug = truncateMiddle(slugSegment, availableSlugLength);

  if (truncatedSlug.length === 0) {
    return `${prefix}${issueSuffix}`;
  }

  return `${prefix}-${truncatedSlug}${issueSuffix}`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 0) {
    return '';
  }

  if (maxLength <= MID_TRUNCATION_MARKER.length) {
    return value.slice(0, maxLength);
  }

  const visibleLength = maxLength - MID_TRUNCATION_MARKER.length;
  const leftLength = Math.ceil(visibleLength / 2);
  const rightLength = Math.floor(visibleLength / 2);

  const left = value.slice(0, leftLength);
  const right = value.slice(value.length - rightLength);

  return `${left}${MID_TRUNCATION_MARKER}${right}`;
}

export async function handleBranchCommand(
  planFile: string | undefined,
  options: BranchCommandOptions,
  command: any
): Promise<void> {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const repoRoot = (await getGitRoot()) || process.cwd();
  const effectiveRepoRoot = globalOpts.config
    ? await resolveRepoRootForPlanArg('', repoRoot, globalOpts.config)
    : repoRoot;

  let selectedPlan: PlanSchema | undefined;
  let selectedPlanRepoRoot = effectiveRepoRoot;

  if (options.nextReady) {
    if (!options.nextReady || options.nextReady.trim() === '') {
      throw new Error('--next-ready requires a numeric parent plan ID');
    }

    const parentPlanId = parsePlanIdFromCliArg(options.nextReady);

    const result = await findNextReadyDependencyFromDb(
      parentPlanId,
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
    if (!planFile) {
      throw new Error(
        'Please provide a numeric plan ID or use --latest/--next/--current/--next-ready to find a plan'
      );
    }
    const planIdArg = String(parsePlanIdFromCliArg(planFile));

    const planRepoRoot = await resolveRepoRootForPlanArg(planIdArg, repoRoot, globalOpts.config);
    selectedPlanRepoRoot = planRepoRoot;
    selectedPlan = (await resolvePlanFromDb(planIdArg, planRepoRoot)).plan;
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
      branchPrefix: resolveBranchPrefix({
        config: effectiveConfig,
        db: getDatabase(),
        projectId: (await resolveProjectContext(selectedPlanRepoRoot)).projectId,
      }),
    });
  }
  writeStdout(`${branchName}\n`);
}
