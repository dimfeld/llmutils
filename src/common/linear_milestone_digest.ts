import { getLinearClient } from './linear_client.js';
import { debugLog } from '../logging.js';

interface LinearConnectionLike<TNode> {
  nodes: TNode[];
  pageInfo: {
    hasNextPage?: boolean;
  };
  fetchNext: () => Promise<LinearConnectionLike<TNode>>;
}

export interface LinearMilestoneDigestEntry {
  milestoneName: string;
  milestoneUrl?: string | null;
  targetDate: string;
  projectName: string;
  projectUrl?: string | null;
  milestoneOwner: string;
}

export interface FetchLinearMilestonesDigestOptions {
  nowMs: number;
  timezone: string;
  apiKey?: string;
  client?: LinearClientLike;
}

export interface LinearClientLike {
  projectMilestones: (variables?: {
    first?: number | null;
  }) => Promise<LinearConnectionLike<ProjectMilestoneLike>>;
}

interface ProjectLike {
  archivedAt?: Date | string | null;
  canceledAt?: Date | string | null;
  completedAt?: Date | string | null;
  name: string;
  targetDate?: string | null;
  trashed?: boolean | null;
  url?: string | null;
  lead?: Promise<UserLike | undefined> | undefined;
  status?: Promise<ProjectStatusLike | undefined> | undefined;
}

interface ProjectMilestoneLike {
  archivedAt?: Date | string | null;
  name: string;
  status?: unknown;
  targetDate?: string | null;
  url?: string | null;
  project?: Promise<ProjectLike | undefined> | undefined;
  issues?: (variables?: { first?: number | null }) => Promise<LinearConnectionLike<IssueLike>>;
}

interface IssueLike {
  assignee?: Promise<UserLike | undefined> | undefined;
}

interface ProjectStatusLike {
  type?: unknown;
}

interface UserLike {
  displayName?: string;
  name?: string;
}

const PAGE_SIZE = 100;
const COMPLETED_OR_CANCELED_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'canceled',
  'cancelled',
]);

export async function fetchLinearMilestonesDueOrOverdue(
  options: FetchLinearMilestonesDigestOptions
): Promise<LinearMilestoneDigestEntry[]> {
  const client = options.client ?? (getLinearClient(options.apiKey) as LinearClientLike);
  const { startDate, endDate } = getWeekDateRange(options.nowMs, options.timezone);
  debugLog(
    '[linear_milestone_digest] Fetching Linear milestones due or overdue: timezone=%s start=%s end=%s',
    options.timezone,
    startDate,
    endDate
  );
  const milestones = await fetchAllConnectionNodes<ProjectMilestoneLike>(() =>
    client.projectMilestones({ first: PAGE_SIZE })
  );
  debugLog('[linear_milestone_digest] Loaded %d Linear milestones', milestones.length);
  const entries: LinearMilestoneDigestEntry[] = [];
  let skippedClosedProjects = 0;
  let skippedMilestonesWithoutTarget = 0;
  let skippedClosedMilestones = 0;
  let skippedFutureMilestones = 0;
  let skippedMilestonesWithoutProject = 0;

  for (const milestone of milestones) {
    const decision = getMilestoneSkipReason(milestone, startDate, endDate);
    if (decision !== null) {
      if (decision === 'no-target-date') {
        skippedMilestonesWithoutTarget += 1;
      } else if (decision === 'closed') {
        skippedClosedMilestones += 1;
      } else {
        skippedFutureMilestones += 1;
      }
      debugLog(
        '[linear_milestone_digest] Skipping milestone: milestone=%s reason=%s targetDate=%s status=%s',
        milestone.name,
        decision,
        milestone.targetDate ?? 'none',
        formatStatusForDebug(milestone.status)
      );
      continue;
    }

    const project = await milestone.project;
    if (!project) {
      skippedMilestonesWithoutProject += 1;
      debugLog(
        '[linear_milestone_digest] Skipping milestone without project: milestone=%s targetDate=%s',
        milestone.name,
        milestone.targetDate
      );
      continue;
    }

    if (await isClosedProject(project)) {
      skippedClosedProjects += 1;
      debugLog(
        '[linear_milestone_digest] Skipping milestone for closed project: project=%s milestone=%s',
        project.name,
        milestone.name
      );
      continue;
    }

    const [lead, milestoneIssueOwner] = await Promise.all([
      project.lead,
      getSingleIssueOwnerForMilestone(milestone),
    ]);
    const milestoneOwner = milestoneIssueOwner ?? formatUserName(lead) ?? 'Unassigned';

    debugLog(
      '[linear_milestone_digest] Including milestone: project=%s milestone=%s owner=%s targetDate=%s',
      project.name,
      milestone.name,
      milestoneOwner,
      milestone.targetDate
    );
    entries.push({
      milestoneName: milestone.name,
      milestoneUrl: milestone.url ?? null,
      targetDate: milestone.targetDate!,
      projectName: project.name,
      projectUrl: project.url ?? null,
      milestoneOwner,
    });
  }

  debugLog(
    '[linear_milestone_digest] Linear milestone digest result: included=%d checkedMilestones=%d skippedClosedProjects=%d skippedNoTarget=%d skippedClosedMilestones=%d skippedFuture=%d skippedWithoutProject=%d',
    entries.length,
    milestones.length,
    skippedClosedProjects,
    skippedMilestonesWithoutTarget,
    skippedClosedMilestones,
    skippedFutureMilestones,
    skippedMilestonesWithoutProject
  );

  return entries.sort(compareLinearMilestoneDigestEntries);
}

export function getWeekDateRange(
  nowMs: number,
  timezone: string
): { startDate: string; endDate: string } {
  const parts = getZonedDateParts(nowMs, timezone);
  const currentDateMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  const daysSinceMonday = (parts.weekday + 6) % 7;
  const startDateMs = currentDateMs - daysSinceMonday * 86_400_000;
  const endDateMs = startDateMs + 6 * 86_400_000;

  return {
    startDate: new Date(startDateMs).toISOString().slice(0, 10),
    endDate: new Date(endDateMs).toISOString().slice(0, 10),
  };
}

async function fetchAllConnectionNodes<TNode>(
  fetchFirstPage: () => Promise<LinearConnectionLike<TNode>>
): Promise<TNode[]> {
  const connection = await fetchFirstPage();

  while (connection.pageInfo.hasNextPage === true) {
    const previousLength = connection.nodes.length;
    await connection.fetchNext();
    if (connection.nodes.length === previousLength) {
      break;
    }
  }

  return connection.nodes;
}

async function isClosedProject(project: ProjectLike): Promise<boolean> {
  if (project.archivedAt || project.canceledAt || project.completedAt || project.trashed === true) {
    return true;
  }

  const status = await project.status;
  return isCompletedOrCanceledStatus(status?.type);
}

async function getSingleIssueOwnerForMilestone(
  milestone: ProjectMilestoneLike
): Promise<string | null> {
  if (!milestone.issues) {
    return null;
  }

  const milestoneWithIssues = milestone as ProjectMilestoneLike & {
    issues: (variables?: { first?: number | null }) => Promise<LinearConnectionLike<IssueLike>>;
  };
  const issues = await fetchAllConnectionNodes<IssueLike>(() =>
    milestoneWithIssues.issues({ first: PAGE_SIZE })
  );
  if (issues.length === 0) {
    debugLog(
      '[linear_milestone_digest] No linked issues for milestone owner lookup: milestone=%s',
      milestone.name
    );
    return null;
  }

  const assignees = await Promise.all(
    issues.map((issue) => Promise.resolve(issue.assignee).then((assignee) => assignee))
  );
  const assigneeNames = assignees.map(formatUserName);
  if (assigneeNames.some((name) => name === null)) {
    debugLog(
      '[linear_milestone_digest] Falling back to project lead; at least one issue is unassigned: milestone=%s issueCount=%d',
      milestone.name,
      issues.length
    );
    return null;
  }

  const uniqueAssigneeNames = new Set(assigneeNames);
  if (uniqueAssigneeNames.size !== 1) {
    debugLog(
      '[linear_milestone_digest] Falling back to project lead; milestone issues have mixed owners: milestone=%s issueCount=%d ownerCount=%d',
      milestone.name,
      issues.length,
      uniqueAssigneeNames.size
    );
    return null;
  }

  const [owner] = uniqueAssigneeNames;
  debugLog(
    '[linear_milestone_digest] Using shared issue assignee as milestone owner: milestone=%s issueCount=%d owner=%s',
    milestone.name,
    issues.length,
    owner
  );
  return owner ?? null;
}

function getMilestoneSkipReason(
  milestone: ProjectMilestoneLike,
  startDate: string,
  endDate: string
): 'no-target-date' | 'closed' | 'future' | null {
  const targetDate = milestone.targetDate;
  if (!targetDate) {
    return 'no-target-date';
  }

  if (milestone.archivedAt || isCompletedOrCanceledStatus(milestone.status)) {
    return 'closed';
  }

  if (targetDate > endDate) {
    return 'future';
  }

  return null;
}

function isCompletedOrCanceledStatus(status: unknown): boolean {
  if (typeof status !== 'string') {
    return false;
  }

  return COMPLETED_OR_CANCELED_STATUSES.has(status.trim().toLowerCase());
}

function formatUserName(user: UserLike | undefined): string | null {
  const displayName = user?.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const name = user?.name?.trim();
  return name || null;
}

function formatStatusForDebug(status: unknown): string {
  if (typeof status === 'string') {
    return status;
  }

  if (status === undefined || status === null) {
    return 'none';
  }

  return typeof status;
}

function compareLinearMilestoneDigestEntries(
  left: LinearMilestoneDigestEntry,
  right: LinearMilestoneDigestEntry
): number {
  return (
    left.targetDate.localeCompare(right.targetDate) ||
    left.projectName.localeCompare(right.projectName) ||
    left.milestoneName.localeCompare(right.milestoneName)
  );
}

function getZonedDateParts(
  nowMs: number,
  timezone: string
): { year: number; month: number; day: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value])
  );
  const weekday = parseWeekday(parts.weekday);

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday,
  };
}

function parseWeekday(weekday: string | undefined): number {
  switch (weekday) {
    case 'Sun':
      return 0;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      throw new Error(`Unexpected weekday from Intl.DateTimeFormat: ${weekday ?? 'missing'}`);
  }
}
