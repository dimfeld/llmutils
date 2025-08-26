/**
 * Linear issue tracker client implementation
 *
 * This module implements the IssueTrackerClient interface for Linear,
 * providing methods to fetch issues and comments from the Linear API
 * using the @linear/sdk package.
 */

import { getLinearClient } from './linear_client.ts';
import { debugLog } from '../logging.ts';
import { LinearDocument } from '@linear/sdk';
import type {
  IssueTrackerClient,
  IssueTrackerConfig,
  IssueData,
  CommentData,
  IssueWithComments,
  ParsedIssueIdentifier,
  UserData,
} from './issue_tracker/types.ts';

/**
 * Linear issue tracker client implementation
 */
export class LinearIssueTrackerClient implements IssueTrackerClient {
  private config: IssueTrackerConfig;

  constructor(config: IssueTrackerConfig) {
    this.config = config;
  }

  /**
   * Parse an issue identifier from various formats:
   * - Linear issue key: TEAM-123
   * - Linear URL: https://linear.app/workspace/issue/TEAM-123
   * - Linear URL with slug: https://linear.app/workspace/issue/TEAM-123/some-title-slug
   */
  parseIssueIdentifier(spec: string): ParsedIssueIdentifier | null {
    const trimmedSpec = spec.trim();

    // Linear issue key format: TEAM-123
    const keyMatch = trimmedSpec.match(/^([A-Z][A-Z0-9]*-\d+)$/);
    if (keyMatch) {
      return {
        identifier: keyMatch[1],
      };
    }

    // Linear URL format: https://linear.app/workspace/issue/TEAM-123[/optional-slug]
    const urlMatch = trimmedSpec.match(
      /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[^/]*)?$/
    );
    if (urlMatch) {
      return {
        identifier: urlMatch[2],
        owner: urlMatch[1], // workspace name
        url: trimmedSpec,
      };
    }

    // Invalid format
    return null;
  }

  /**
   * Fetch a single issue with its comments from Linear
   */
  async fetchIssue(identifier: string): Promise<IssueWithComments> {
    debugLog(`Fetching Linear issue: ${identifier}`);

    const client = getLinearClient();
    const parsed = this.parseIssueIdentifier(identifier);

    if (!parsed) {
      throw new Error(`Invalid Linear issue identifier: ${identifier}`);
    }

    try {
      // Fetch the issue by its identifier (e.g., "TEAM-123")
      const issue = await client.issue(parsed.identifier);

      if (!issue) {
        throw new Error(`Issue not found: ${parsed.identifier}`);
      }

      // Fetch comments for the issue
      const commentsConnection = await issue.comments();
      const comments = commentsConnection.nodes;

      // Fetch related data
      const [state, labels] = await Promise.all([issue.state, issue.labels()]);

      debugLog('Fetched issue', issue);

      // Map Linear issue data to generic IssueData format
      const creator = await issue.creator;
      const assignee = await issue.assignee;
      const issueData: IssueData = {
        id: issue.id,
        number: issue.identifier, // Linear uses identifiers like "TEAM-123"
        title: issue.title,
        body: issue.description || undefined,
        htmlUrl: issue.url,
        state: state?.name || 'Unknown',
        user: creator ? this.mapLinearUserToUserData(creator) : undefined,
        assignees: [this.mapLinearUserToUserData(assignee)].filter((x) => x !== undefined),
        labels: labels?.nodes?.length
          ? labels.nodes.map((label: any) => ({
              id: label.id,
              name: label.name,
              color: label.color || undefined,
            }))
          : undefined,
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
        pullRequest: false, // Linear doesn't have pull requests
      };

      // Map Linear comments to generic CommentData format
      const commentData: CommentData[] = await Promise.all(
        comments.map(async (comment) => {
          const user = await comment.user;
          return {
            id: comment.id,
            body: comment.body || '',
            user: user ? this.mapLinearUserToUserData(user) : undefined,
            createdAt: comment.createdAt.toISOString(),
            updatedAt: comment.updatedAt?.toISOString(),
            // Linear comments don't have direct HTML URLs
            htmlUrl: undefined,
          };
        })
      );

      commentData.sort((a, b) => {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      debugLog(
        `Successfully fetched Linear issue ${parsed.identifier} with ${commentData.length} comments`
      );

      return {
        issue: issueData,
        comments: commentData,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch Linear issue ${parsed.identifier}: ${errorMessage}`);
    }
  }

  /**
   * Fetch all open issues from the user's workspace
   */
  async fetchAllOpenIssues(): Promise<IssueData[]> {
    debugLog('Fetching all open Linear issues');

    const client = getLinearClient();

    try {
      // Fetch all open issues with pagination
      const issuesConnection = await client.issues({
        filter: {
          state: {
            type: { nin: ['completed', 'canceled'] }, // Exclude completed and canceled states
          },
        },
        orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
      });

      let allIssues = [...issuesConnection.nodes];

      // Handle pagination if needed
      let currentConnection = issuesConnection;
      while (currentConnection.pageInfo.hasNextPage) {
        currentConnection = await currentConnection.fetchNext();
        allIssues = allIssues.concat(currentConnection.nodes);
      }

      // Map Linear issues to generic IssueData format
      const issueData: IssueData[] = await Promise.all(
        allIssues.map(async (issue) => {
          const [state, labels] = await Promise.all([issue.state, issue.labels()]);

          return {
            id: issue.id,
            number: issue.identifier,
            title: issue.title,
            body: issue.description || undefined,
            htmlUrl: issue.url,
            state: state?.name || 'Unknown',
            user: this.mapLinearUserToUserData(await issue.creator),
            assignees: [this.mapLinearUserToUserData(await issue.assignee)].filter(
              (x) => x != undefined
            ),
            labels: labels?.nodes?.length
              ? labels.nodes.map((label: any) => ({
                  id: label.id,
                  name: label.name,
                  color: label.color || undefined,
                }))
              : undefined,
            createdAt: issue.createdAt.toISOString(),
            updatedAt: issue.updatedAt.toISOString(),
            pullRequest: false,
          };
        })
      );

      debugLog(`Successfully fetched ${issueData.length} open Linear issues`);

      return issueData;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch open Linear issues: ${errorMessage}`);
    }
  }

  /**
   * Get the display name for this issue tracker type
   */
  getDisplayName(): string {
    return 'Linear';
  }

  /**
   * Get the configuration for this client
   */
  getConfig(): IssueTrackerConfig {
    return this.config;
  }

  /**
   * Map a Linear user object to the generic UserData format
   */
  private mapLinearUserToUserData(linearUser: any): UserData | undefined {
    if (!linearUser) {
      return undefined;
    }

    debugLog('Mapping Linear user:', linearUser);
    return {
      id: linearUser.id,
      name: linearUser.name || linearUser.displayName,
      email: linearUser.email || undefined,
      avatarUrl: linearUser.avatarUrl || undefined,
      // Linear users don't typically have login usernames like GitHub
      login: undefined,
    };
  }
}

/**
 * Factory function to create a Linear issue tracker client
 */
export function createLinearClient(config: IssueTrackerConfig): IssueTrackerClient {
  return new LinearIssueTrackerClient(config);
}
