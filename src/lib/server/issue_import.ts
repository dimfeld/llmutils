import {
  combineRmprOptions,
  parseCommandOptionsFromComment,
  type RmprOptions,
} from '$common/comment_options.js';
import { getGitRepository } from '$common/git.js';
import { getAvailableTrackers, getIssueTracker } from '$common/issue_tracker/factory.js';
import type { IssueWithComments } from '$common/issue_tracker/types.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getProjectById } from '$tim/db/project.js';
import {
  reserveImportedPlanStartId,
  writeImportedPlansToDbTransactionally,
  type PendingImportedPlanWrite,
} from '$tim/commands/import/import_helpers.js';
import {
  createStubPlanFromIssue,
  parseIssueInput,
  type IssueInstructionData,
} from '$tim/issue_utils.js';
import { getServerContext } from './init.js';

export type IssueImportMode = 'single' | 'separate' | 'merged';

export interface SelectedIssueContent {
  selectedParentContent: number[];
  selectedChildIndices: number[];
  selectedChildContent: Record<number, number[]>;
}

export interface IssueTrackerStatus {
  available: boolean;
  trackerType: 'github' | 'linear';
  displayName: string;
  supportsHierarchical: boolean;
}

function getTrackerDisplayName(trackerType: 'github' | 'linear'): string {
  return trackerType === 'linear' ? 'Linear' : 'GitHub';
}

function normalizeSelectionIndexes(indexes: number[], maxIndex: number): number[] {
  if (maxIndex < 0) {
    return [];
  }

  return [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index <= maxIndex)
    .sort((a, b) => a - b);
}

function extractSelectedContent(issueData: IssueWithComments, selectedIndexes: number[]): string[] {
  const sortedUniqueIndexes = [...new Set(selectedIndexes)].sort((a, b) => a - b);
  const content: string[] = [];

  for (const index of sortedUniqueIndexes) {
    if (index === 0) {
      const body = issueData.issue.body?.trim();
      if (body) {
        content.push(body);
      }
      continue;
    }

    const comment = issueData.comments[index - 1];
    const body = comment?.body?.trim();
    if (body) {
      content.push(body);
    }
  }

  return content;
}

function buildSuggestedFileName(issueData: IssueWithComments): string {
  return `issue-${issueData.issue.number}-${issueData.issue.title.replace(/[^a-zA-Z0-9]+/g, '-')}.md`.toLowerCase();
}

function getIssueInstructionData(
  issueData: IssueWithComments,
  selectedContentIndexes: number[]
): IssueInstructionData {
  const selectedContent = extractSelectedContent(issueData, selectedContentIndexes);
  return {
    suggestedFileName: buildSuggestedFileName(issueData),
    issue: {
      ...issueData.issue,
      html_url: issueData.issue.htmlUrl,
    },
    plan: selectedContent.join('\n\n'),
    rmprOptions: getRmprOptions(issueData),
  };
}

function getRmprOptions(issueData: IssueWithComments): RmprOptions | null {
  let rmprOptions: RmprOptions | null = null;
  if (issueData.issue.body) {
    rmprOptions = parseCommandOptionsFromComment(issueData.issue.body).options;
  }
  for (const comment of issueData.comments) {
    if (!comment.body) {
      continue;
    }
    const commentOptions = parseCommandOptionsFromComment(comment.body).options;
    if (!commentOptions) {
      continue;
    }
    rmprOptions = rmprOptions ? combineRmprOptions(rmprOptions, commentOptions) : commentOptions;
  }

  return rmprOptions;
}

export async function fetchIssueForImport(
  identifier: string,
  mode: IssueImportMode,
  gitRoot: string
): Promise<{ issueData: IssueWithComments; tracker: IssueTrackerStatus }> {
  const config = await loadEffectiveConfig(undefined, { cwd: gitRoot });
  const trackerType = config.issueTracker ?? 'github';
  const trackerStatus = getIssueTrackerStatusFromType(trackerType);
  if (!trackerStatus.available) {
    throw new Error(`${trackerStatus.displayName} issue tracker is not configured`);
  }

  const trimmedIdentifier = identifier.trim();
  const parsedInput = parseIssueInput(trimmedIdentifier);
  if (!parsedInput) {
    throw new Error(
      'Invalid issue identifier. Enter an issue ID, issue URL, or branch name containing the issue ID.'
    );
  }

  const issueTracker = await getIssueTracker(config);
  const supportsHierarchical = Boolean(issueTracker.fetchIssueWithChildren);

  let trackerIdentifier = parsedInput.isBranchName ? parsedInput.identifier : trimmedIdentifier;
  if (trackerType === 'github' && /^\d+$/.test(trackerIdentifier)) {
    const repository = await getGitRepository(gitRoot);
    trackerIdentifier = `${repository}#${trackerIdentifier}`;
  }

  const issueData =
    mode !== 'single' && supportsHierarchical
      ? await issueTracker.fetchIssueWithChildren!(trackerIdentifier)
      : await issueTracker.fetchIssue(trackerIdentifier);

  return {
    issueData,
    tracker: {
      ...trackerStatus,
      displayName: issueTracker.getDisplayName(),
      supportsHierarchical,
    },
  };
}

export async function createPlansFromIssue(
  projectId: number,
  issueData: IssueWithComments,
  mode: IssueImportMode,
  selectedContent: SelectedIssueContent
): Promise<{ planUuid: string }> {
  const { db } = await getServerContext();
  const project = getProjectById(db, projectId);
  if (!project?.last_git_root) {
    throw new Error('Project does not have a git root configured');
  }
  const repoRoot = project.last_git_root;

  const children = issueData.children ?? [];
  const normalizedParentContent = normalizeSelectionIndexes(
    selectedContent.selectedParentContent,
    issueData.comments.length
  );
  const selectedChildIndices = [...new Set(selectedContent.selectedChildIndices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < children.length)
    .sort((a, b) => a - b);
  const normalizedChildContent = Object.fromEntries(
    selectedChildIndices.map((index) => [
      index,
      normalizeSelectionIndexes(
        selectedContent.selectedChildContent[index] ?? [],
        children[index].comments.length
      ),
    ])
  );

  const parentExtracted = extractSelectedContent(issueData, normalizedParentContent);

  if (mode === 'single' && parentExtracted.length === 0) {
    throw new Error('Select at least one parent content item with non-empty text to import.');
  }

  if (mode !== 'single') {
    const childExtracted = new Map<number, string[]>();
    for (const childIndex of selectedChildIndices) {
      const extracted = extractSelectedContent(
        children[childIndex],
        normalizedChildContent[childIndex] ?? []
      );
      childExtracted.set(childIndex, extracted);
    }

    const hasAnyContent =
      parentExtracted.length > 0 ||
      [...childExtracted.values()].some((content) => content.length > 0);
    if (!hasAnyContent) {
      throw new Error('Select at least one parent or subissue content item to import.');
    }
    for (const childIndex of selectedChildIndices) {
      if ((childExtracted.get(childIndex) ?? []).length === 0) {
        throw new Error(
          `Selected subissue ${children[childIndex].issue.number} has no non-empty content selected.`
        );
      }
    }
  }

  const pendingWrites: PendingImportedPlanWrite[] = [];
  let parentPlanId = 0;

  if (mode === 'single' || selectedChildIndices.length === 0) {
    parentPlanId = await reserveImportedPlanStartId(repoRoot, 1);
    const parentInstruction = getIssueInstructionData(issueData, normalizedParentContent);
    const parentPlan = createStubPlanFromIssue(parentInstruction, parentPlanId);
    pendingWrites.push({ plan: parentPlan, filePath: null });
  } else if (mode === 'separate') {
    const totalPlans = 1 + selectedChildIndices.length;
    const startId = await reserveImportedPlanStartId(repoRoot, totalPlans);
    parentPlanId = startId;

    const parentInstruction = getIssueInstructionData(issueData, normalizedParentContent);
    const parentPlan = createStubPlanFromIssue(parentInstruction, parentPlanId);
    const childIds: number[] = [];

    for (let index = 0; index < selectedChildIndices.length; index++) {
      const childIssueIndex = selectedChildIndices[index];
      const childIssue = children[childIssueIndex];
      const childPlanId = startId + index + 1;
      childIds.push(childPlanId);
      const childInstruction = getIssueInstructionData(
        childIssue,
        normalizedChildContent[childIssueIndex] ?? []
      );
      const childPlan = createStubPlanFromIssue(childInstruction, childPlanId);
      childPlan.parent = parentPlanId;
      pendingWrites.push({ plan: childPlan, filePath: null });
    }

    parentPlan.dependencies = childIds;
    pendingWrites.push({ plan: parentPlan, filePath: null });
  } else {
    parentPlanId = await reserveImportedPlanStartId(repoRoot, 1);
    const parentInstruction = getIssueInstructionData(issueData, normalizedParentContent);
    const parentPlan = createStubPlanFromIssue(parentInstruction, parentPlanId);
    const mergedDetails: string[] = [];

    if (parentInstruction.plan.trim()) {
      mergedDetails.push(parentInstruction.plan.trim());
    }

    const mergedIssueUrls = new Set<string>([issueData.issue.htmlUrl]);
    for (const childIssueIndex of selectedChildIndices) {
      const childIssue = children[childIssueIndex];
      const childInstruction = getIssueInstructionData(
        childIssue,
        normalizedChildContent[childIssueIndex] ?? []
      );
      mergedIssueUrls.add(childIssue.issue.htmlUrl);
      if (!childInstruction.plan.trim()) {
        continue;
      }
      mergedDetails.push(
        `## Subissue ${childIssue.issue.number}: ${childIssue.issue.title}\n\n${childInstruction.plan.trim()}`
      );
    }

    parentPlan.details = mergedDetails.join('\n\n');
    parentPlan.issue = [...mergedIssueUrls];
    pendingWrites.push({ plan: parentPlan, filePath: null });
  }

  const persistedWrites = await writeImportedPlansToDbTransactionally(repoRoot, pendingWrites);
  const parentWrite = persistedWrites.find((entry) => entry.plan.id === parentPlanId);
  if (!parentWrite?.plan.uuid) {
    throw new Error('Failed to determine imported plan UUID');
  }

  return { planUuid: parentWrite.plan.uuid };
}

function getIssueTrackerStatusFromType(trackerType: 'github' | 'linear'): IssueTrackerStatus {
  const availableTrackers = getAvailableTrackers();
  return {
    available: availableTrackers[trackerType],
    trackerType,
    displayName: getTrackerDisplayName(trackerType),
    supportsHierarchical: trackerType === 'linear',
  };
}

export async function getIssueTrackerStatus(gitRoot: string): Promise<IssueTrackerStatus> {
  const config = await loadEffectiveConfig(undefined, { cwd: gitRoot });
  const trackerType = config.issueTracker ?? 'github';
  return getIssueTrackerStatusFromType(trackerType);
}
