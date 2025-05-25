import type { Octokit } from 'octokit';
import type { ReviewResponse, PullRequest } from './types.js';

export class CommentPoster {
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string
  ) {}
  
  async postResponses(
    responses: ReviewResponse[],
    pr: PullRequest
  ): Promise<void> {
    // Group responses by thread
    const byThread = this.groupByThread(responses);
    
    for (const [threadId, threadResponses] of byThread) {
      if (threadId) {
        // Reply to existing thread
        await this.replyToThread(threadId, threadResponses, pr);
      } else {
        // Create new comments
        for (const response of threadResponses) {
          await this.createComment(response, pr);
        }
      }
    }
    
    // Mark resolved comments
    await this.markResolvedComments(responses, pr);
  }
  
  private groupByThread(responses: ReviewResponse[]): Map<string | null, ReviewResponse[]> {
    const byThread = new Map<string | null, ReviewResponse[]>();
    
    for (const response of responses) {
      const threadId = response.comment.thread?.id || null;
      const existing = byThread.get(threadId) || [];
      existing.push(response);
      byThread.set(threadId, existing);
    }
    
    return byThread;
  }
  
  private async replyToThread(
    threadId: string,
    responses: ReviewResponse[],
    pr: PullRequest
  ): Promise<void> {
    // Combine responses for the thread
    const combined = this.combineResponses(responses);
    
    // Find the original comment ID to reply to
    const originalCommentId = responses[0]?.comment.id;
    
    if (originalCommentId) {
      try {
        await this.octokit.rest.pulls.createReplyForReviewComment({
          owner: this.owner,
          repo: this.repo,
          pull_number: pr.number,
          comment_id: originalCommentId,
          body: combined
        });
      } catch (error) {
        console.error(`Failed to reply to thread ${threadId}:`, error);
      }
    }
  }
  
  private async createComment(
    response: ReviewResponse,
    pr: PullRequest
  ): Promise<void> {
    try {
      if (response.comment.type === 'inline' && response.comment.path) {
        // Create inline comment
        await this.createInlineComment(response, pr);
      } else {
        // Create general PR comment
        await this.createGeneralComment(response, pr);
      }
    } catch (error) {
      console.error(`Failed to create comment:`, error);
    }
  }
  
  private async createInlineComment(
    response: ReviewResponse,
    pr: PullRequest
  ): Promise<void> {
    const comment = response.comment;
    
    if (!comment.path || !comment.line) {
      // Fall back to general comment
      return this.createGeneralComment(response, pr);
    }
    
    await this.octokit.rest.pulls.createReviewComment({
      owner: this.owner,
      repo: this.repo,
      pull_number: pr.number,
      body: response.message,
      path: comment.path,
      line: comment.line,
      side: comment.side || 'RIGHT',
      commit_id: await this.getLatestCommit(pr)
    });
  }
  
  private async createGeneralComment(
    response: ReviewResponse,
    pr: PullRequest
  ): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: pr.number,
      body: response.message
    });
  }
  
  private combineResponses(responses: ReviewResponse[]): string {
    if (responses.length === 1) {
      return responses[0].message;
    }
    
    // Multiple related changes
    let combined = '✅ Applied the following changes:\n\n';
    
    for (const response of responses) {
      combined += `- ${response.summary}\n`;
    }
    
    // Add details section
    const detailedResponses = responses.filter(r => r.details);
    if (detailedResponses.length > 0) {
      combined += '\n<details>\n<summary>Details</summary>\n\n';
      
      for (const response of detailedResponses) {
        if (response.details?.codeSnippet) {
          combined += `### ${response.changes?.[0]?.description || 'Change'}\n`;
          combined += `\`\`\`${response.details.language || 'diff'}\n`;
          combined += response.details.codeSnippet;
          combined += '\n\`\`\`\n\n';
        }
      }
      
      combined += '</details>';
    }
    
    return combined;
  }
  
  private async markResolvedComments(
    responses: ReviewResponse[],
    pr: PullRequest
  ): Promise<void> {
    // Filter for successfully addressed comments
    const resolvedResponses = responses.filter(r => 
      r.status === 'success' && r.action.type === 'change'
    );
    
    for (const response of resolvedResponses) {
      if (response.comment.thread?.id && !response.comment.resolved) {
        try {
          // GitHub doesn't have a direct API to resolve threads
          // We'll add a comment indicating resolution
          await this.addResolutionComment(response.comment.thread.id, pr);
        } catch (error) {
          console.error(`Failed to mark comment as resolved:`, error);
        }
      }
    }
  }
  
  private async addResolutionComment(
    threadId: string,
    pr: PullRequest
  ): Promise<void> {
    // Add a simple resolution indicator
    const body = '✅ This has been addressed in the latest commit.';
    
    // This would be implemented based on the specific GitHub API
    // For now, we'll just log it
    console.log(`Would mark thread ${threadId} as resolved`);
  }
  
  private async getLatestCommit(pr: PullRequest): Promise<string> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pr.number
      });
      
      return data.head.sha;
    } catch (error) {
      console.error('Failed to get latest commit:', error);
      return '';
    }
  }
  
  async postBatchSummary(
    summary: string,
    pr: PullRequest
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: pr.number,
        body: summary
      });
    } catch (error) {
      console.error('Failed to post batch summary:', error);
    }
  }
}