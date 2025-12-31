// Utilities for processing issues from various issue trackers into rmplan data structures

import { checkbox } from '@inquirer/prompts';
import type { PlanSchema } from './planSchema.js';
import type {
  IssueTrackerClient,
  IssueWithComments,
  IssueData,
  CommentData,
} from '../common/issue_tracker/types.js';
import { singleLineWithPrefix, limitLines } from '../common/formatting.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
  type RmprOptions,
} from '../rmpr/comment_options.js';

/**
 * Result of parsing an issue identifier
 */
export interface ParsedIssueInput {
  /** The extracted issue identifier (e.g., 'DF-1245' or '123') */
  identifier: string;
  /** Whether the original input was a branch name (vs a plain identifier) */
  isBranchName: boolean;
  /** The original input value (used as branch name if isBranchName is true) */
  originalInput: string;
}

/**
 * Parse an issue identifier or branch name to extract the issue ID.
 * Determines if the input is a plain issue identifier or a branch name containing an issue ID.
 *
 * Plain identifier patterns:
 * - Linear key: DF-1245
 * - Linear URL: https://linear.app/workspace/issue/DF-1245
 * - GitHub number: 123
 * - GitHub URL: https://github.com/owner/repo/issues/123
 *
 * Branch name patterns (identifier embedded in branch):
 * - Linear-style: feature-df-1245 → extracts DF-1245
 * - GitHub-style: fix-bug-123 → extracts 123
 */
export function parseIssueInput(input: string): ParsedIssueInput | null {
  const trimmedInput = input.trim();

  // Check for plain Linear key: TEAM-123 (case-insensitive)
  const linearKeyMatch = trimmedInput.match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/);
  if (linearKeyMatch) {
    return {
      identifier: linearKeyMatch[1].toUpperCase(),
      isBranchName: false,
      originalInput: trimmedInput,
    };
  }

  // Check for plain GitHub issue number
  const githubNumberMatch = trimmedInput.match(/^(\d+)$/);
  if (githubNumberMatch) {
    return {
      identifier: githubNumberMatch[1],
      isBranchName: false,
      originalInput: trimmedInput,
    };
  }

  // Check for Linear URL: https://linear.app/workspace/issue/TEAM-123[/optional-slug]
  const linearUrlMatch = trimmedInput.match(
    /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/]*)?$/i
  );
  if (linearUrlMatch) {
    return {
      identifier: linearUrlMatch[1].toUpperCase(),
      isBranchName: false,
      originalInput: trimmedInput,
    };
  }

  // Check for GitHub URL: https://github.com/owner/repo/issues/123
  const githubUrlMatch = trimmedInput.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (githubUrlMatch) {
    return {
      identifier: githubUrlMatch[1],
      isBranchName: false,
      originalInput: trimmedInput,
    };
  }

  // Check for branch name with Linear-style issue ID suffix: feature-df-1245
  const branchLinearMatch = trimmedInput.match(/-([A-Za-z][A-Za-z0-9]*-\d+)$/i);
  if (branchLinearMatch) {
    return {
      identifier: branchLinearMatch[1].toUpperCase(),
      isBranchName: true,
      originalInput: trimmedInput,
    };
  }

  // Check for branch name with GitHub-style issue number suffix: fix-bug-123
  const branchGithubMatch = trimmedInput.match(/-(\d+)$/);
  if (branchGithubMatch) {
    return {
      identifier: branchGithubMatch[1],
      isBranchName: true,
      originalInput: trimmedInput,
    };
  }

  return null;
}

/**
 * Data structure returned by getInstructionsFromIssue (works with any issue tracker)
 */
export interface IssueInstructionData {
  issue: {
    title: string;
    html_url: string;
    [key: string]: any;
  };
  plan: string;
  rmprOptions?: {
    rmfilter?: string[];
  } | null;
  suggestedFileName: string;
}

// Type definitions for hierarchical selection
interface ParentSelectionValue {
  type: 'parent';
  content: string | undefined;
}

interface ChildSelectionValue {
  type: 'child';
  childIndex: number;
  content: string | undefined;
}

type HierarchicalSelectionValue = ParentSelectionValue | ChildSelectionValue;

/**
 * Select comments from a hierarchical issue structure for inclusion in the plan
 *
 * @param data - The issue and comments data with optional children
 * @param includeTitle - Whether to include the issue title in the selection
 * @returns Array of selected content from the hierarchical structure
 */
export async function selectHierarchicalIssueComments(
  data: IssueWithComments,
  includeTitle = true
): Promise<{
  parentContent: string[];
  childrenContent: Array<{ issueData: IssueWithComments; selectedContent: string[] }>;
}> {
  // First, let user select which subissues to include
  let selectedChildren: IssueWithComments[] = [];

  if (data.children && data.children.length > 0) {
    const childChoices = data.children.map((child, index) => ({
      name: `${child.issue.number}: ${child.issue.title}`,
      value: index,
      checked: true, // Default to checked
    }));

    const selectedChildIndices = await checkbox({
      message: `Select subissues to import for ${data.issue.number} - ${data.issue.title}:`,
      choices: childChoices,
      required: false,
    });

    selectedChildren = selectedChildIndices.map((index) => data.children![index]);

    if (selectedChildren.length === 0) {
      console.log('No subissues selected for import.\n');
    } else {
      console.log(
        `Selected ${selectedChildren.length} of ${data.children.length} subissue(s) for import.\n`
      );
    }
  }
  const LINE_PADDING = 4;
  const MAX_HEIGHT = Math.floor(process.stdout.rows / 3) - 10; // Reduce height for hierarchical display

  // Build hierarchical choices
  const items: Array<{
    name: string;
    description: string;
    checked: boolean;
    value: HierarchicalSelectionValue;
  }> = [
    includeTitle
      ? {
          name: `📋 Parent: ${data.issue.title}`,
          description: `Title: ${data.issue.title}`,
          checked: true,
          value: {
            type: 'parent',
            content: `This project is designed to implement the feature: ${data.issue.title}`,
          } as ParentSelectionValue,
        }
      : undefined,
    {
      name: singleLineWithPrefix(
        '📝 Parent Body: ',
        data.issue.body?.replaceAll(/\n+/g, '  ') ?? '',
        LINE_PADDING
      ),
      checked: true,
      description: limitLines(data.issue.body ?? '', MAX_HEIGHT),
      value: { type: 'parent', content: data.issue.body } as ParentSelectionValue,
    },
    ...data.comments.map((comment) => {
      const name = `💬 Parent Comment (${comment.user?.name ?? comment.user?.login}): `;
      return {
        name: singleLineWithPrefix(
          name,
          comment.body?.replaceAll(/\n+/g, '  ') ?? '',
          LINE_PADDING
        ),
        checked: false,
        description: limitLines(comment.body ?? '', MAX_HEIGHT),
        value: { type: 'parent', content: comment.body } as ParentSelectionValue,
      };
    }),
  ].filter((i): i is NonNullable<typeof i> => i != null);

  // Add selected children
  if (selectedChildren.length > 0) {
    for (let i = 0; i < selectedChildren.length; i++) {
      const child = selectedChildren[i];
      const childPrefix = `🔗 Child ${i + 1} (${child.issue.title})`;

      // Add child body
      items.push({
        name: singleLineWithPrefix(
          `${childPrefix} Body: `,
          child.issue.body?.replaceAll(/\n+/g, '  ') ?? '',
          LINE_PADDING
        ),
        checked: true,
        description: limitLines(child.issue.body ?? '', MAX_HEIGHT),
        value: { type: 'child', childIndex: i, content: child.issue.body } as ChildSelectionValue,
      });

      // Add child comments
      child.comments.forEach((comment) => {
        const name = `${childPrefix} Comment (${comment.user?.name ?? comment.user?.login}): `;
        items.push({
          name: singleLineWithPrefix(
            name,
            comment.body?.replaceAll(/\n+/g, '  ') ?? '',
            LINE_PADDING
          ),
          checked: false,
          description: limitLines(comment.body ?? '', MAX_HEIGHT),
          value: { type: 'child', childIndex: i, content: comment.body } as ChildSelectionValue,
        });
      });
    }
  }

  const withIndex = items.map((item, i) => ({ ...item, value: i }));
  const chosen = await checkbox({
    message: `Select content from ${data.issue.number} - ${data.issue.title}${selectedChildren.length > 0 ? ` and ${selectedChildren.length} selected child issue(s)` : ''}`,
    required: true,
    shortcuts: {
      all: 'a',
    },
    pageSize: Math.min(15, process.stdout.rows - 5),
    choices: withIndex,
  });

  // Process the selected items
  const parentContent: string[] = [];
  const childrenContentMap = new Map<number, string[]>();

  chosen
    .sort((a, b) => a - b)
    .map((index) => items[index])
    .filter((item): item is NonNullable<typeof item> => item != null)
    .forEach((item) => {
      if (item.value.type === 'parent') {
        if (item.value.content) {
          parentContent.push(item.value.content);
        }
      } else if (item.value.type === 'child' && item.value.content) {
        const childValue = item.value;
        const childIndex = childValue.childIndex;
        if (!childrenContentMap.has(childIndex)) {
          childrenContentMap.set(childIndex, []);
        }
        childrenContentMap.get(childIndex)!.push(childValue.content!);
      }
    });

  // Build children content array
  const childrenContent = selectedChildren.map((child, index) => ({
    issueData: child,
    selectedContent: childrenContentMap.get(index) || [],
  }));

  console.log({
    selectedChildren,
    parentContent,
    childrenContent,
  });

  return { parentContent, childrenContent };
}

/**
 * Select comments from an issue for inclusion in the plan
 *
 * @param data - The issue and comments data
 * @param includeTitle - Whether to include the issue title in the selection
 * @returns Array of selected comment/issue bodies
 */
export async function selectIssueComments(
  data: IssueWithComments,
  includeTitle = true
): Promise<string[]> {
  const LINE_PADDING = 4;
  const MAX_HEIGHT = process.stdout.rows - data.comments.length - 10;

  const items = [
    includeTitle
      ? {
          name: singleLineWithPrefix('Title: ', data.issue.title, LINE_PADDING),
          description: `Title: ${data.issue.title}`,
          checked: true,
          value: `This project is designed to implement the feature: ${data.issue.title}`,
        }
      : undefined,
    {
      name: singleLineWithPrefix(
        'Body: ',
        data.issue.body?.replaceAll(/\n+/g, '  ') ?? '',
        LINE_PADDING
      ),
      checked: true,
      description: limitLines(data.issue.body ?? '', MAX_HEIGHT),
      value: data.issue.body,
    },
    ...data.comments.map((comment) => {
      const name = `${comment.user?.name ?? comment.user?.login}: `;
      return {
        name: singleLineWithPrefix(
          name,
          comment.body?.replaceAll(/\n+/g, '  ') ?? '',
          LINE_PADDING
        ),
        checked: false,
        description: limitLines(comment.body ?? '', MAX_HEIGHT),
        value: comment.body,
      };
    }),
  ].filter((i) => i != undefined);

  const withValue = items.map((item, i) => ({ ...item, value: i }));
  const chosen = await checkbox({
    message: `Issue ${data.issue.number} - ${data.issue.title}`,
    required: true,
    shortcuts: {
      all: 'a',
    },
    pageSize: 10,
    choices: withValue,
  });

  return chosen
    .sort((a, b) => a - b)
    .map((a) => items[a].value)
    .filter((s): s is string => s != null && s != undefined && s != '');
}

/**
 * Data structure returned by getHierarchicalInstructionsFromIssue
 */
export interface HierarchicalIssueInstructionData {
  parentIssue: IssueInstructionData;
  childIssues: Array<{
    issueData: IssueInstructionData;
    selectedContent: string[];
  }>;
}

/**
 * Get hierarchical instructions and metadata from an issue using any issue tracker client
 *
 * @param issueTracker - The issue tracker client to use
 * @param issueSpec - The issue identifier or pre-fetched issue data
 * @param includeTitleInDetails - Whether to include the title in the details
 * @returns Hierarchical issue instruction data for creating plan trees
 */
export async function getHierarchicalInstructionsFromIssue(
  issueTracker: IssueTrackerClient,
  issueSpec: string | IssueWithComments,
  includeTitleInDetails = true
): Promise<HierarchicalIssueInstructionData> {
  let data: IssueWithComments;

  if (typeof issueSpec === 'string') {
    // Use fetchIssueWithChildren if available, fallback to regular fetchIssue
    if (issueTracker.fetchIssueWithChildren) {
      data = await issueTracker.fetchIssueWithChildren(issueSpec);
    } else {
      data = await issueTracker.fetchIssue(issueSpec);
    }
  } else {
    data = issueSpec;
  }

  // Get hierarchical content selection
  const { parentContent, childrenContent } = await selectHierarchicalIssueComments(
    data,
    includeTitleInDetails
  );

  // Parse RmprOptions from parent issue body and comments
  let rmprOptions: RmprOptions | null = null;
  if (data.issue.body) {
    const issueOptions = parseCommandOptionsFromComment(data.issue.body);
    rmprOptions = issueOptions.options;
  }
  for (const comment of data.comments) {
    if (comment.body) {
      const commentOptions = parseCommandOptionsFromComment(comment.body);
      if (commentOptions.options) {
        rmprOptions = rmprOptions
          ? combineRmprOptions(rmprOptions, commentOptions.options)
          : commentOptions.options;
      }
    }
  }

  // Create parent issue instruction data
  const parentIssueData: IssueInstructionData = {
    suggestedFileName:
      `issue-${data.issue.number}-${data.issue.title.replace(/[^a-zA-Z0-9]+/g, '-')}.md`.toLowerCase(),
    issue: {
      ...data.issue,
      html_url: data.issue.htmlUrl,
    },
    plan: parentContent.join('\n\n'),
    rmprOptions,
  };

  // Create child issue instruction data
  const childIssues = childrenContent.map((child) => ({
    issueData: {
      suggestedFileName:
        `issue-${child.issueData.issue.number}-${child.issueData.issue.title.replace(/[^a-zA-Z0-9]+/g, '-')}.md`.toLowerCase(),
      issue: {
        ...child.issueData.issue,
        html_url: child.issueData.issue.htmlUrl,
      },
      plan: child.selectedContent.join('\n\n'),
      rmprOptions: null, // Child issues don't inherit parent options
    } as IssueInstructionData,
    selectedContent: child.selectedContent,
  }));

  return {
    parentIssue: parentIssueData,
    childIssues,
  };
}

/**
 * Get instructions and metadata from an issue using any issue tracker client
 *
 * @param issueTracker - The issue tracker client to use
 * @param issueSpec - The issue identifier or pre-fetched issue data
 * @param includeTitleInDetails - Whether to include the title in the details
 * @returns Issue instruction data for creating plans
 */
export async function getInstructionsFromIssue(
  issueTracker: IssueTrackerClient,
  issueSpec: string | IssueWithComments,
  includeTitleInDetails = true
): Promise<IssueInstructionData> {
  let data: IssueWithComments;
  if (typeof issueSpec === 'string') {
    data = await issueTracker.fetchIssue(issueSpec);
  } else {
    data = issueSpec;
  }

  // Parse RmprOptions from issue body and comments
  let rmprOptions: RmprOptions | null = null;
  if (data.issue.body) {
    const issueOptions = parseCommandOptionsFromComment(data.issue.body);
    rmprOptions = issueOptions.options;
  }
  for (const comment of data.comments) {
    if (comment.body) {
      const commentOptions = parseCommandOptionsFromComment(comment.body);
      if (commentOptions.options) {
        rmprOptions = rmprOptions
          ? combineRmprOptions(rmprOptions, commentOptions.options)
          : commentOptions.options;
      }
    }
  }

  const selected = await selectIssueComments(data, includeTitleInDetails);
  const plan = selected.join('\n\n');

  // Generate a filename based on the issue identifier and title
  const issueIdentifier = data.issue.number;
  const suggestedFileName =
    `issue-${issueIdentifier}-${data.issue.title.replace(/[^a-zA-Z0-9]+/g, '-')}.md`.toLowerCase();

  return {
    suggestedFileName,
    issue: {
      ...data.issue, // Include all original data for backward compatibility
      html_url: data.issue.htmlUrl, // Override with the standardized property name
    },
    plan,
    rmprOptions,
  };
}

/**
 * Creates a stub plan from issue data
 *
 * @param issueData - The data returned from getInstructionsFromIssue
 * @param planId - The new plan ID to assign
 * @returns A complete PlanSchema object for a stub plan
 */
export function createStubPlanFromIssue(
  issueData: IssueInstructionData,
  planId: number
): PlanSchema {
  const now = new Date().toISOString();

  const stubPlan: PlanSchema = {
    id: planId,
    title: issueData.issue.title,
    details: issueData.plan,
    status: 'pending',
    issue: [issueData.issue.html_url],
    tasks: [], // Empty tasks array - this is the "stub" part
    createdAt: now,
    updatedAt: now,
    tags: [],
  };

  // Add project information if present in the issue
  if (issueData.issue.project) {
    stubPlan.project = {
      title: issueData.issue.project.name,
      details: issueData.issue.project.description,
    };
  }

  // Add rmfilter arguments if they were parsed from the issue
  if (issueData.rmprOptions && issueData.rmprOptions.rmfilter) {
    stubPlan.rmfilter = issueData.rmprOptions.rmfilter;
  }

  return stubPlan;
}
