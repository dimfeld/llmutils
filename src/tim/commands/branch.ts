import { writeStdout } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitle } from '../display_utils.js';
import { slugify } from '../id_utils.js';
import { parseLinearIssueIdentifier } from '../../common/linear.js';
import { parseGitHubIssueIdentifier } from '../../common/github/issues.js';
import { findNextReadyDependency } from './find_next_dependency.js';
import { findMostRecentlyUpdatedPlan } from './prompts.js';
import { findNextPlan, readAllPlans, readPlanFile, resolvePlanFile } from '../plans.js';
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
  const title = getCombinedTitle(plan) || plan.goal || 'plan';
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
      return linearParsedIssue.identifier;
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
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = await resolveTasksDir(config);

  let resolvedPlanFile: string;
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
      const resolvedInput = await resolvePlanFile(options.nextReady, globalOpts.config);
      const planFromFile = await readPlanFile(resolvedInput);
      if (!planFromFile.id || typeof planFromFile.id !== 'number') {
        throw new Error(`Plan file ${resolvedInput} does not have a valid numeric ID`);
      }
      parentPlanId = planFromFile.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDir, true);
    if (!result.plan) {
      throw new Error(result.message);
    }

    resolvedPlanFile = result.plan.filename;
    selectedPlan = result.plan;
  } else if (options.latest) {
    const { plans } = await readAllPlans(tasksDir);
    if (plans.size === 0) {
      throw new Error('No plans found in tasks directory.');
    }

    const latestPlan = await findMostRecentlyUpdatedPlan(plans);
    if (!latestPlan) {
      throw new Error('No plans with updatedAt field found in tasks directory.');
    }

    resolvedPlanFile = latestPlan.filename;
    selectedPlan = latestPlan;
  } else if (options.next || options.current) {
    const plan = await findNextPlan(tasksDir, {
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

    resolvedPlanFile = plan.filename;
    selectedPlan = plan;
  } else {
    if (!planFile) {
      throw new Error(
        'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
      );
    }

    resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  }

  const plan = selectedPlan ?? (await readPlanFile(resolvedPlanFile));
  const branchName = generateBranchNameFromPlan(plan);
  writeStdout(`${branchName}\n`);
}
