/**
 * GitHub issue tracker client implementation
 *
 * This module implements the IssueTrackerClient interface for GitHub,
 * wrapping the existing functions from src/common/github/issues.ts
 * to provide a consistent API with other issue trackers.
 */

import {
  fetchIssueAndComments,
  fetchAllOpenIssues,
  parseGitHubIssueIdentifier,
} from '../github/issues.js';
import { parsePrOrIssueNumber } from '../github/identifiers.js';
import { debugLog } from '../../logging.js';
import type {
  IssueTrackerClient,
  IssueTrackerConfig,
  IssueData,
  CommentData,
  IssueWithComments,
  ParsedIssueIdentifier,
  UserData,
} from './types.js';

/**
 * GitHub issue tracker client implementation
 */
export class GitHubIssueTrackerClient implements IssueTrackerClient {
  private config: IssueTrackerConfig;

  constructor(config: IssueTrackerConfig) {
    this.config = config;
  }

  /**
   * Parse an issue identifier from various formats:
   * - Issue number: 123
   * - Full format: owner/repo#123 or owner/repo/123
   * - GitHub URL: https://github.com/owner/repo/issues/123
   */
  parseIssueIdentifier(spec: string): ParsedIssueIdentifier | null {
    return parseGitHubIssueIdentifier(spec);
  }

  /**
   * Fetch a single issue with its comments from GitHub
   */
  async fetchIssue(identifier: string): Promise<IssueWithComments> {
    debugLog(`Fetching GitHub issue: ${identifier}`);

    const parsed = await parsePrOrIssueNumber(identifier);

    if (!parsed) {
      throw new Error(`Invalid GitHub issue identifier: ${identifier}`);
    }

    try {
      const result = await fetchIssueAndComments(parsed);

      // Map GitHub issue data to generic IssueData format
      const issueData: IssueData = {
        id: result.issue.id.toString(),
        number: result.issue.number,
        title: result.issue.title,
        body: result.issue.body || undefined,
        htmlUrl: result.issue.html_url,
        state: result.issue.state,
        user: result.issue.user ? this.mapGitHubUserToUserData(result.issue.user) : undefined,
        assignees: result.issue.assignees?.length
          ? result.issue.assignees.map((assignee: any) => this.mapGitHubUserToUserData(assignee))
          : undefined,
        labels: result.issue.labels?.length
          ? result.issue.labels.map((label: any) => ({
              id: label.id.toString(),
              name: label.name,
              color: label.color || undefined,
            }))
          : undefined,
        createdAt: result.issue.created_at,
        updatedAt: result.issue.updated_at,
        pullRequest: !!result.issue.pull_request,
      };

      // Map GitHub comments to generic CommentData format
      const commentData: CommentData[] = result.comments.map((comment) => ({
        id: comment.id.toString(),
        body: comment.body || '',
        user: comment.user ? this.mapGitHubUserToUserData(comment.user) : undefined,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at || undefined,
        htmlUrl: comment.html_url || undefined,
      }));

      debugLog(
        `Successfully fetched GitHub issue #${parsed.number} with ${commentData.length} comments`
      );

      return {
        issue: issueData,
        comments: commentData,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch GitHub issue #${parsed.number}: ${errorMessage}`);
    }
  }

  /**
   * Fetch all open issues from the current GitHub repository
   */
  async fetchAllOpenIssues(): Promise<IssueData[]> {
    debugLog('Fetching all open GitHub issues');

    try {
      const issues = await fetchAllOpenIssues();

      // Map GitHub issues to generic IssueData format
      const issueData: IssueData[] = issues.map((issue) => ({
        id: issue.id.toString(),
        number: issue.number,
        title: issue.title,
        body: issue.body || undefined,
        htmlUrl: issue.html_url,
        state: issue.state,
        user: issue.user ? this.mapGitHubUserToUserData(issue.user) : undefined,
        assignees: issue.assignees?.length
          ? issue.assignees.map((assignee: any) => this.mapGitHubUserToUserData(assignee))
          : undefined,
        labels: issue.labels?.length
          ? issue.labels.map((label: any) => ({
              id: label.id.toString(),
              name: label.name,
              color: label.color || undefined,
            }))
          : undefined,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        pullRequest: !!issue.pull_request,
      }));

      debugLog(`Successfully fetched ${issueData.length} open GitHub issues`);

      return issueData;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch open GitHub issues: ${errorMessage}`);
    }
  }

  /**
   * Get the display name for this issue tracker type
   */
  getDisplayName(): string {
    return 'GitHub';
  }

  /**
   * Get the configuration for this client
   */
  getConfig(): IssueTrackerConfig {
    return this.config;
  }

  /**
   * Map a GitHub user object to the generic UserData format
   */
  private mapGitHubUserToUserData(githubUser: any): UserData {
    return {
      id: githubUser.id.toString(),
      login: githubUser.login,
      name: githubUser.name || githubUser.login,
      email: githubUser.email || undefined,
      avatarUrl: githubUser.avatar_url || undefined,
    };
  }
}

/**
 * Factory function to create a GitHub issue tracker client
 */
export function createGitHubClient(config: IssueTrackerConfig): IssueTrackerClient {
  return new GitHubIssueTrackerClient(config);
}
