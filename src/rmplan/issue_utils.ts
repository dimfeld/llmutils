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
    goal: `Implement: ${issueData.issue.title}`,
    details: issueData.plan,
    status: 'pending',
    issue: [issueData.issue.html_url],
    tasks: [], // Empty tasks array - this is the "stub" part
    createdAt: now,
    updatedAt: now,
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
