import {
  combineRmprOptions,
  parseCommandOptionsFromComment,
  type RmprOptions,
} from '$common/comment_options.js';
import { getGitRepository } from '$common/git.js';
import { getAvailableTrackers, getIssueTracker } from '$common/issue_tracker/factory.js';
import type { IssueWithComments } from '$common/issue_tracker/types.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getRepositoryIdentity } from '$tim/assignments/workspace_identifier.js';
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
import type { PlanSchema, PlanWithLegacyMetadata } from '$tim/planSchema.js';
import { loadPlansFromDb } from '$tim/plans_db.js';
import { resolvePlanFromDb } from '$tim/plans.js';
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
  // Callers always pass indexes through normalizeSelectionIndexes first,
  // which already deduplicates and sorts.
  const content: string[] = [];

  for (const index of selectedIndexes) {
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
  selectedContentIndexes: number[],
  options?: { skipRmprOptions?: boolean }
): IssueInstructionData {
  const selectedContent = extractSelectedContent(issueData, selectedContentIndexes);
  return {
    suggestedFileName: buildSuggestedFileName(issueData),
    issue: {
      ...issueData.issue,
      html_url: issueData.issue.htmlUrl,
    },
    plan: selectedContent.join('\n\n'),
    rmprOptions: options?.skipRmprOptions ? null : getRmprOptions(issueData),
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

function findPlanByIssueUrl(
  plans: Map<number, PlanSchema>,
  issueUrl: string
): PlanSchema | undefined {
  for (const plan of plans.values()) {
    if ((plan.issue ?? [])[0] === issueUrl) {
      return plan;
    }
  }
  return undefined;
}

function appendMissingSegments(
  existingDetails: string | undefined,
  candidateSegments: string[]
): { details: string; newSegments: string[] } {
  const current = existingDetails ?? '';
  const newSegments = candidateSegments.filter((segment) => !current.includes(segment));
  if (newSegments.length === 0) {
    return { details: current, newSegments: [] };
  }

  let updated = current.trim();
  if (updated && !updated.endsWith('\n')) {
    updated += '\n';
  }
  if (updated) {
    updated += '\n';
  }
  updated += newSegments.join('\n\n');

  return { details: updated, newSegments };
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
  if (!trimmedIdentifier) {
    throw new Error(
      'Invalid issue identifier. Enter an issue ID, issue URL, or branch name containing the issue ID.'
    );
  }

  const parsedInput = parseIssueInput(trimmedIdentifier);

  const issueTracker = await getIssueTracker(config);
  const supportsHierarchical = Boolean(issueTracker.fetchIssueWithChildren);

  // parseIssueInput handles common formats (bare numbers, URLs, branch names).
  // If it doesn't recognize the identifier, pass it through directly to the tracker
  // which supports additional formats (e.g. owner/repo#123, #123, owner/repo/123).
  let trackerIdentifier: string;
  if (parsedInput?.isBranchName) {
    trackerIdentifier = parsedInput.identifier;
    if (trackerType === 'github' && /^\d+$/.test(trackerIdentifier)) {
      const repository = await getGitRepository(gitRoot);
      trackerIdentifier = `${repository}#${trackerIdentifier}`;
    }
  } else if (parsedInput) {
    trackerIdentifier = trimmedIdentifier;
    if (trackerType === 'github' && /^\d+$/.test(trackerIdentifier)) {
      const repository = await getGitRepository(gitRoot);
      trackerIdentifier = `${repository}#${trackerIdentifier}`;
    }
  } else {
    // Unrecognized format — pass directly to tracker
    trackerIdentifier = trimmedIdentifier;
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
  const repository = await getRepositoryIdentity({ cwd: repoRoot });
  const { plans: allPlans } = loadPlansFromDb(repoRoot, repository.repositoryId);

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

  const pendingWrites: PendingImportedPlanWrite[] = [];
  let parentPlanId = 0;

  if (mode === 'single' || selectedChildIndices.length === 0) {
    const parentIssueUrl = issueData.issue.htmlUrl;
    const existingParentPlan = findPlanByIssueUrl(allPlans, parentIssueUrl);
    const parentInstruction = getIssueInstructionData(issueData, normalizedParentContent);
    if (existingParentPlan) {
      const resolvedParentPlan = await resolvePlanFromDb(String(existingParentPlan.id), repoRoot);
      const currentPlan = resolvedParentPlan.plan as PlanWithLegacyMetadata;
      const { details: updatedDetails, newSegments } = appendMissingSegments(currentPlan.details, [
        ...parentExtracted,
      ]);
      const rmprOptions = getRmprOptions(issueData);
      const rmfilterChanged =
        rmprOptions?.rmfilter &&
        JSON.stringify(currentPlan.rmfilter) !== JSON.stringify(rmprOptions.rmfilter);
      const titleChanged = currentPlan.title !== issueData.issue.title;
      const hasNewContent = newSegments.length > 0;

      parentPlanId = currentPlan.id;
      if (!titleChanged && !rmfilterChanged && !hasNewContent) {
        if (!currentPlan.uuid) {
          throw new Error('Failed to determine imported plan UUID');
        }
        return { planUuid: currentPlan.uuid };
      }

      const updatedPlan: PlanWithLegacyMetadata = {
        ...currentPlan,
        title: issueData.issue.title,
        details: updatedDetails,
        updatedAt: new Date().toISOString(),
      };
      if (rmprOptions?.rmfilter) {
        updatedPlan.rmfilter = rmprOptions.rmfilter;
      }
      pendingWrites.push({ plan: updatedPlan, filePath: null });
    } else {
      if (parentExtracted.length === 0) {
        throw new Error('Select at least one parent content item with non-empty text to import.');
      }
      parentPlanId = await reserveImportedPlanStartId(repoRoot, 1);
      const parentPlan = createStubPlanFromIssue(parentInstruction, parentPlanId);
      pendingWrites.push({ plan: parentPlan, filePath: null });
    }
  } else if (mode === 'separate') {
    const parentIssueUrl = issueData.issue.htmlUrl;
    const existingParentPlan = findPlanByIssueUrl(allPlans, parentIssueUrl);
    const parentInstruction = getIssueInstructionData(issueData, normalizedParentContent);
    const existingChildren = new Map<number, PlanSchema | undefined>();
    const childExtracted = new Map<number, string[]>();
    for (const childIndex of selectedChildIndices) {
      existingChildren.set(
        childIndex,
        findPlanByIssueUrl(allPlans, children[childIndex].issue.htmlUrl)
      );
      const extracted = extractSelectedContent(
        children[childIndex],
        normalizedChildContent[childIndex] ?? []
      );
      childExtracted.set(childIndex, extracted);
    }
    const hasAnyContent =
      parentExtracted.length > 0 ||
      [...childExtracted.values()].some((content) => content.length > 0);
    const needsNewPlans =
      !existingParentPlan || selectedChildIndices.some((index) => !existingChildren.get(index));
    if (needsNewPlans && !hasAnyContent) {
      throw new Error('Select at least one parent or subissue content item to import.');
    }

    const existingChildPlans = selectedChildIndices.map((index) => existingChildren.get(index));
    const newPlansCount =
      (existingParentPlan ? 0 : 1) + existingChildPlans.filter((plan) => !plan).length;
    const startId =
      newPlansCount > 0 ? await reserveImportedPlanStartId(repoRoot, newPlansCount) : 0;
    let nextPlanId = startId;

    let parentPlan: PlanSchema;
    let shouldWriteParent = false;
    if (existingParentPlan) {
      const resolvedParentPlan = await resolvePlanFromDb(String(existingParentPlan.id), repoRoot);
      const currentParentPlan = resolvedParentPlan.plan;
      parentPlanId = currentParentPlan.id;
      const { details: updatedDetails, newSegments } = appendMissingSegments(
        currentParentPlan.details,
        [parentInstruction.plan.trim()]
      );
      const titleChanged = currentParentPlan.title !== issueData.issue.title;
      const hasNewContent = newSegments.length > 0;
      shouldWriteParent = titleChanged || hasNewContent;
      if (shouldWriteParent) {
        parentPlan = {
          ...currentParentPlan,
          title: issueData.issue.title,
          details: updatedDetails,
          updatedAt: new Date().toISOString(),
        };
      } else {
        parentPlan = currentParentPlan;
      }
    } else {
      parentPlanId = nextPlanId;
      nextPlanId++;
      parentPlan = createStubPlanFromIssue(parentInstruction, parentPlanId);
      shouldWriteParent = true;
    }

    const childIds: number[] = [];
    for (let index = 0; index < selectedChildIndices.length; index++) {
      const childIssueIndex = selectedChildIndices[index];
      const childIssue = children[childIssueIndex];
      const childInstruction = getIssueInstructionData(
        childIssue,
        normalizedChildContent[childIssueIndex] ?? [],
        { skipRmprOptions: true }
      );
      const existingChildPlan = existingChildPlans[index];
      let childPlan: PlanSchema;
      let childPlanId: number;
      let shouldWriteChild = false;

      if (existingChildPlan) {
        const resolvedChildPlan = await resolvePlanFromDb(String(existingChildPlan.id), repoRoot);
        const currentChildPlan = resolvedChildPlan.plan;
        childPlanId = currentChildPlan.id;
        const { details: updatedDetails, newSegments } = appendMissingSegments(
          currentChildPlan.details,
          [childInstruction.plan.trim()]
        );
        const titleChanged = currentChildPlan.title !== childIssue.issue.title;
        const hasNewContent = newSegments.length > 0;
        const parentChanged = currentChildPlan.parent !== parentPlanId;
        shouldWriteChild = titleChanged || hasNewContent || parentChanged;
        if (shouldWriteChild) {
          childPlan = {
            ...currentChildPlan,
            title: childIssue.issue.title,
            details: updatedDetails,
            parent: parentPlanId,
            updatedAt: new Date().toISOString(),
          };
        } else {
          childPlan = currentChildPlan;
        }
      } else {
        childPlanId = nextPlanId;
        nextPlanId++;
        childPlan = createStubPlanFromIssue(childInstruction, childPlanId);
        childPlan.parent = parentPlanId;
        shouldWriteChild = true;
      }

      childIds.push(childPlanId);
      if (shouldWriteChild) {
        pendingWrites.push({ plan: childPlan, filePath: null });
      }
    }

    const originalDependencies = parentPlan.dependencies ?? [];
    const updatedDependencies = [...new Set([...originalDependencies, ...childIds])];
    const dependenciesChanged =
      updatedDependencies.length !== originalDependencies.length ||
      updatedDependencies.some(
        (dependencyId, index) => dependencyId !== originalDependencies[index]
      );
    if (dependenciesChanged) {
      shouldWriteParent = true;
      parentPlan = {
        ...parentPlan,
        dependencies: updatedDependencies,
        updatedAt: new Date().toISOString(),
      };
    } else if (shouldWriteParent) {
      parentPlan = {
        ...parentPlan,
        dependencies: updatedDependencies,
      };
    }

    if (shouldWriteParent) {
      pendingWrites.push({ plan: parentPlan, filePath: null });
    }
  } else {
    const parentIssueUrl = issueData.issue.htmlUrl;
    const existingParentPlan = findPlanByIssueUrl(allPlans, parentIssueUrl);
    const parentInstruction = getIssueInstructionData(issueData, normalizedParentContent);
    const mergedDetailsSegments: string[] = [];
    if (parentInstruction.plan.trim()) {
      mergedDetailsSegments.push(parentInstruction.plan.trim());
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
      mergedDetailsSegments.push(
        `## Subissue ${childIssue.issue.number}: ${childIssue.issue.title}\n\n${childInstruction.plan.trim()}`
      );
    }

    if (existingParentPlan) {
      const resolvedParentPlan = await resolvePlanFromDb(String(existingParentPlan.id), repoRoot);
      const currentParentPlan = resolvedParentPlan.plan;
      parentPlanId = currentParentPlan.id;
      const { details: updatedDetails, newSegments } = appendMissingSegments(
        currentParentPlan.details,
        mergedDetailsSegments
      );
      const updatedIssueUrls = [
        ...new Set([...(currentParentPlan.issue ?? []), ...mergedIssueUrls]),
      ];
      const issueUrlsChanged =
        updatedIssueUrls.length !== (currentParentPlan.issue ?? []).length ||
        updatedIssueUrls.some((url, index) => url !== (currentParentPlan.issue ?? [])[index]);
      const titleChanged = currentParentPlan.title !== issueData.issue.title;
      const hasNewContent = newSegments.length > 0;
      if (!titleChanged && !hasNewContent && !issueUrlsChanged) {
        if (!currentParentPlan.uuid) {
          throw new Error('Failed to determine imported plan UUID');
        }
        return { planUuid: currentParentPlan.uuid };
      }

      const parentPlan: PlanSchema = {
        ...currentParentPlan,
        title: issueData.issue.title,
        details: updatedDetails,
        issue: updatedIssueUrls,
        updatedAt: new Date().toISOString(),
      };
      pendingWrites.push({ plan: parentPlan, filePath: null });
    } else {
      if (mergedDetailsSegments.length === 0) {
        throw new Error('Select at least one parent or subissue content item to import.');
      }
      parentPlanId = await reserveImportedPlanStartId(repoRoot, 1);
      const parentPlan = createStubPlanFromIssue(parentInstruction, parentPlanId);
      parentPlan.details = mergedDetailsSegments.join('\n\n');
      parentPlan.issue = [...mergedIssueUrls];
      pendingWrites.push({ plan: parentPlan, filePath: null });
    }
  }

  if (pendingWrites.length === 0) {
    const existingParentPlan = allPlans.get(parentPlanId);
    if (!existingParentPlan?.uuid) {
      throw new Error('Failed to determine imported plan UUID');
    }
    return { planUuid: existingParentPlan.uuid };
  }

  const persistedWrites = await writeImportedPlansToDbTransactionally(repoRoot, pendingWrites);
  const parentWrite = persistedWrites.find((entry) => entry.plan.id === parentPlanId);
  const parentUuid = parentWrite?.plan.uuid ?? allPlans.get(parentPlanId)?.uuid;
  if (!parentUuid) {
    throw new Error('Failed to determine imported plan UUID');
  }

  return { planUuid: parentUuid };
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
