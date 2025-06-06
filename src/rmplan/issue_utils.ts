// Utilities for processing GitHub issues into rmplan data structures

import type { PlanSchema } from './planSchema.js';

/**
 * Data structure returned by getInstructionsFromGithubIssue
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
 * Creates a stub plan from GitHub issue data
 *
 * @param issueData - The data returned from getInstructionsFromGithubIssue
 * @param planId - The new plan ID to assign
 * @returns A complete PlanSchema object for a stub plan
 */
export function createStubPlanFromIssue(
  issueData: IssueInstructionData,
  planId: string | number
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

  // Add rmfilter arguments if they were parsed from the issue
  if (issueData.rmprOptions && issueData.rmprOptions.rmfilter) {
    stubPlan.rmfilter = issueData.rmprOptions.rmfilter;
  }

  return stubPlan;
}
