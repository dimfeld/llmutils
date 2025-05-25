import type { Octokit } from 'octokit';
import type { 
  ResponseOptions, 
  ResponseResult, 
  PullRequest,
  ReviewResponse,
  CommitInfo
} from './types.js';
import type { ParsedReview } from '../reviews/types.js';
import { ReviewParsingPipeline } from '../reviews/pipeline.js';
import { BatchProcessor } from './batch_processor.js';
import { CommentPoster } from './comment_poster.js';
import { ResponseGenerator } from './response_generator.js';
import { ClarificationHandler } from './clarification.js';
import { ClaudeCodeExecutor } from '../../rmplan/executors/claude_code.js';
import type { RmplanConfig } from '../../rmplan/configSchema.js';

export class ReviewResponsePipeline {
  private reviewPipeline: ReviewParsingPipeline;
  private batchProcessor: BatchProcessor;
  private commentPoster: CommentPoster;
  private responseGenerator: ResponseGenerator;
  private clarificationHandler: ClarificationHandler;
  
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private rmplanConfig: RmplanConfig = { defaultExecutor: 'claude-code' }
  ) {
    this.reviewPipeline = new ReviewParsingPipeline(octokit, owner, repo, process.cwd());
    this.batchProcessor = new BatchProcessor(rmplanConfig);
    this.commentPoster = new CommentPoster(octokit, owner, repo);
    this.responseGenerator = new ResponseGenerator();
    this.clarificationHandler = new ClarificationHandler();
  }
  
  async respondToReviews(
    pr: PullRequest,
    options: ResponseOptions = {}
  ): Promise<ResponseResult> {
    try {
      // Use Claude Code to orchestrate the entire review response process
      const executor = new ClaudeCodeExecutor(
        {
          allowedTools: [
            'Read',
            'Edit',
            'MultiEdit',
            'Bash(git:*)',
            'Bash(gh pr comment:*)',
            'TodoWrite',
            'TodoRead'
          ],
          includeDefaultTools: true
        },
        { model: options.model || 'sonnet', baseDir: pr.workspace },
        this.rmplanConfig
      );
      
      const prompt = this.buildResponsePrompt(pr, options);
      const result = await executor.execute(prompt);
      
      return this.parseResponseResult(result);
    } catch (error) {
      // Fallback to programmatic approach
      return this.respondProgrammatically(pr, options);
    }
  }
  
  private buildResponsePrompt(pr: PullRequest, options: ResponseOptions): string {
    return `Respond to all review comments on PR #${pr.number}:

1. Parse and analyze all review comments using GitHub API
2. For each actionable comment:
   - Determine if it needs clarification (ambiguous location, unclear request)
   - If clear, apply the requested change
   - Track changes with TodoWrite

3. Group related changes by file to avoid conflicts

4. For each successfully applied change:
   - Post a response comment explaining what was done
   - Include relevant code snippets if helpful
   - Mark the comment as resolved

5. For comments needing clarification:
   - Post a polite request for more details
   - Explain what information is needed

6. Create commits with meaningful messages:
   - Group related changes
   - Reference the review comments
   - Use conventional commit format

7. Provide a summary of:
   - Changes applied successfully
   - Comments that need clarification
   - Any failures or issues

Options:
- Auto-commit: ${options.autoCommit ?? true}
- Batch size: ${options.batchSize ?? 10}
- Skip clarifications: ${options.skipClarifications ?? false}
- Dry run: ${options.dryRun ?? false}

Workspace: ${pr.workspace}
Base branch: ${pr.baseBranch}

Important: Be thorough in applying changes and clear in your responses.`;
  }
  
  private async respondProgrammatically(
    pr: PullRequest,
    options: ResponseOptions = {}
  ): Promise<ResponseResult> {
    const responses: ReviewResponse[] = [];
    const commits: CommitInfo[] = [];
    const errors: Error[] = [];
    
    try {
      // Parse all reviews
      const parsedReviews = await this.reviewPipeline.parseReviews(pr.number);
      
      // Separate reviews that need clarification
      const { actionable, needsClarification } = this.categorizeReviews(
        parsedReviews.reviews,
        options
      );
      
      // Handle clarifications
      if (!options.skipClarifications && needsClarification.length > 0) {
        const clarificationResponses = await this.handleClarifications(needsClarification);
        responses.push(...clarificationResponses);
      }
      
      // Process actionable reviews in batches
      if (actionable.length > 0) {
        const batchResults = await this.batchProcessor.processInBatches(
          actionable,
          pr.workspace,
          options.batchSize || 10
        );
        
        responses.push(...batchResults.responses);
        commits.push(...batchResults.commits);
      }
      
      // Post all responses (unless dry run)
      if (!options.dryRun && responses.length > 0) {
        await this.commentPoster.postResponses(responses, pr);
        
        // Post summary if we processed many comments
        if (responses.length >= 5) {
          const summary = this.responseGenerator.formatBatchSummary(responses);
          await this.commentPoster.postBatchSummary(summary, pr);
        }
      }
      
    } catch (error) {
      console.error('Error in review response pipeline:', error);
      errors.push(error as Error);
    }
    
    // Generate summary
    const summary = this.generateSummary(responses, commits);
    
    return {
      responses,
      commits,
      summary,
      errors
    };
  }
  
  private categorizeReviews(
    reviews: ParsedReview[],
    options: ResponseOptions
  ): { actionable: ParsedReview[], needsClarification: ParsedReview[] } {
    const actionable: ParsedReview[] = [];
    const needsClarification: ParsedReview[] = [];
    
    for (const review of reviews) {
      if (this.clarificationHandler.needsClarification(review)) {
        needsClarification.push(review);
      } else {
        actionable.push(review);
      }
    }
    
    return { actionable, needsClarification };
  }
  
  private async handleClarifications(
    reviews: ParsedReview[]
  ): Promise<ReviewResponse[]> {
    const responses: ReviewResponse[] = [];
    
    for (const review of reviews) {
      const message = this.clarificationHandler.generateClarificationRequest(review);
      
      const response = this.responseGenerator.createReviewResponse(
        review.comment,
        { type: 'clarification' },
        undefined,
        message
      );
      
      responses.push(response);
    }
    
    return responses;
  }
  
  private generateSummary(
    responses: ReviewResponse[],
    commits: CommitInfo[]
  ): any {
    const filesModified = new Set<string>();
    const changesByType = new Map<string, number>();
    
    // Collect file information
    for (const response of responses) {
      if (response.changes) {
        for (const change of response.changes) {
          filesModified.add(change.file);
          const count = changesByType.get(change.type) || 0;
          changesByType.set(change.type, count + 1);
        }
      }
    }
    
    return {
      total: responses.length,
      successful: responses.filter(r => r.status === 'success').length,
      partial: responses.filter(r => r.status === 'partial').length,
      failed: responses.filter(r => r.status === 'failed').length,
      clarifications: responses.filter(r => r.action.type === 'clarification').length,
      filesModified: Array.from(filesModified),
      changesByType,
      commits: commits.length,
      totalAdditions: commits.reduce((sum, c) => sum + c.stats.additions, 0),
      totalDeletions: commits.reduce((sum, c) => sum + c.stats.deletions, 0)
    };
  }
  
  private parseResponseResult(result: any): ResponseResult {
    // Parse the result from Claude Code execution
    // This would extract the relevant information from the execution result
    
    return {
      responses: [],
      commits: [],
      summary: {
        total: 0,
        successful: 0,
        partial: 0,
        failed: 0,
        clarifications: 0,
        filesModified: [],
        changesByType: new Map()
      },
      errors: []
    };
  }
  
  async previewResponses(
    pr: PullRequest,
    options: ResponseOptions = {}
  ): Promise<ResponseResult> {
    // Run in dry-run mode to preview
    return this.respondToReviews(pr, { ...options, dryRun: true });
  }
}