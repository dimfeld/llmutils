import { writeStdout } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { slugify } from '../id_utils.js';
import { parseLinearIssueIdentifier } from '../../common/linear.js';
import { parseGitHubIssueIdentifier } from '../../common/github/issues.js';
import {
  findLatestPlanFromDb,
  findNextPlanFromDb,
  findNextReadyDependencyFromDb,
} from './plan_discovery.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import type { PlanSchema } from '../planSchema.js';

type BranchCommandOptions = {
  next?: boolean;
  current?: boolean;
  nextReady?: string;
  latest?: boolean;
};

const MAX_BRANCH_NAME_LENGTH = 63;
const MID_TRUNCATION_MARKER = '...';

export function generateBranchNameFromPlan(plan: PlanSchema): string {
  const title = plan.title || plan.goal || 'plan';
  const slug = slugify(title);
  const issueId = getIssueIdFromPlanIssues(plan);
  const slugSegment = slug.length > 0 ? slug : undefined;

  if (plan.id !== undefined && plan.id !== null) {
    return buildBranchNameWithId(plan.id, slugSegment, issueId);
  }

  return buildBranchNameWithoutId(slugSegment, issueId);
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
  issueId: string | undefined
): string {
  return buildBranchNameWithSlugSegment(`${planId}`, slugSegment, issueId);
}

function buildBranchNameWithoutId(
  slugSegment: string | undefined,
  issueId: string | undefined
): string {
  return buildBranchNameWithSlugSegment('plan', slugSegment, issueId);
}

function buildBranchNameWithSlugSegment(
  prefix: string,
  slugSegment: string | undefined,
  issueId: string | undefined
): string {
  const issueSuffix = issueId ? `-${issueId}` : '';
  if (!slugSegment) {
    return `${prefix}${issueSuffix}`;
  }

  const availableSlugLength = Math.max(
    0,
    MAX_BRANCH_NAME_LENGTH - prefix.length - issueSuffix.length - 1
  );
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
  await loadEffectiveConfig(globalOpts.config);
  const repoRoot = (await getGitRoot()) || process.cwd();

  let selectedPlan: PlanSchema | undefined;

  if (options.nextReady) {
    if (!options.nextReady || options.nextReady.trim() === '') {
      throw new Error('--next-ready requires a parent plan ID or file path');
    }

    let parentPlanId: number;
    const parsedId = Number.parseInt(options.nextReady, 10);
    if (!Number.isNaN(parsedId)) {
      parentPlanId = parsedId;
    } else {
      const parentRepoRoot = await resolveRepoRootForPlanArg(
        options.nextReady,
        repoRoot,
        globalOpts.config
      );
      const planFromFile = (
        await resolvePlanFromDbOrSyncFile(options.nextReady, parentRepoRoot, parentRepoRoot)
      ).plan;
      if (!planFromFile.id || typeof planFromFile.id !== 'number') {
        throw new Error(`Plan ${options.nextReady} does not have a valid numeric ID`);
      }
      parentPlanId = planFromFile.id;
    }

    const result = await findNextReadyDependencyFromDb(parentPlanId, repoRoot, repoRoot, true);
    if (!result.plan) {
      throw new Error(result.message);
    }

    selectedPlan = result.plan;
  } else if (options.latest) {
    const latestPlan = await findLatestPlanFromDb(repoRoot, repoRoot);
    if (!latestPlan) {
      throw new Error('No plans with updatedAt field found in the database.');
    }

    selectedPlan = latestPlan;
  } else if (options.next || options.current) {
    const plan = await findNextPlanFromDb(repoRoot, repoRoot, {
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
        'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
      );
    }

    const planRepoRoot = await resolveRepoRootForPlanArg(planFile, repoRoot, globalOpts.config);
    selectedPlan = (await resolvePlanFromDbOrSyncFile(planFile, planRepoRoot, planRepoRoot)).plan;
  }

  const plan = selectedPlan;
  if (!plan) {
    throw new Error('Failed to resolve plan');
  }
  const branchName = generateBranchNameFromPlan(plan);
  writeStdout(`${branchName}\n`);
}
