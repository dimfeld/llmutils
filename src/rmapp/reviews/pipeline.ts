import type { Octokit } from 'octokit';
import {
  ReviewIntent,
  type ParsedReview,
  type ParsedReviewSet,
  type ReviewComment,
  type PullRequestContext,
  type ReviewSummary,
} from './types';
import { ReviewNLPParser } from './nlp_parser';
import { CodeReferenceResolver } from './reference_resolver';
import { ChangeRequestAnalyzer } from './change_analyzer';
import { ReviewContextBuilder } from './context_builder';
import { ReviewGrouper } from './grouper';
import { SuggestionHandler } from './suggestions';

export class ReviewParsingPipeline {
  private nlpParser: ReviewNLPParser;
  private resolver: CodeReferenceResolver;
  private analyzer: ChangeRequestAnalyzer;
  private contextBuilder: ReviewContextBuilder;
  private grouper: ReviewGrouper;
  private suggestionHandler: SuggestionHandler;

  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private workDir: string
  ) {
    this.nlpParser = new ReviewNLPParser();
    this.resolver = new CodeReferenceResolver(octokit, owner, repo, workDir);
    this.analyzer = new ChangeRequestAnalyzer();
    this.contextBuilder = new ReviewContextBuilder(octokit, owner, repo, workDir);
    this.grouper = new ReviewGrouper();
    this.suggestionHandler = new SuggestionHandler(workDir);
  }

  async parseReviews(
    prNumber: number
  ): Promise<ParsedReviewSet> {
    // Fetch PR details
    const pr = await this.fetchPRDetails(prNumber);

    // Fetch all review comments
    const comments = await this.fetchReviewComments(prNumber);

    // Parse each comment
    const parsed: ParsedReview[] = [];

    for (const comment of comments) {
      try {
        const parsedReview = await this.parseComment(comment, pr);
        if (parsedReview) {
          parsed.push(parsedReview);
        }
      } catch (error) {
        console.error(`Failed to parse comment ${comment.id}:`, error);
      }
    }

    // Group reviews
    const grouped = this.grouper.groupReviews(parsed);

    // Prioritize
    const prioritized = this.grouper.prioritizeGroups(grouped);

    // Generate summary
    const summary = this.generateSummary(parsed);

    return {
      reviews: parsed,
      grouped: prioritized,
      summary,
    };
  }

  private async fetchPRDetails(prNumber: number): Promise<PullRequestContext> {
    const pr = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    return {
      number: pr.data.number,
      title: pr.data.title,
      body: pr.data.body || '',
      base: pr.data.base.ref,
      head: pr.data.head.ref,
      draft: pr.data.draft || false,
      labels: pr.data.labels.map(l => l.name),
    };
  }

  private async fetchReviewComments(prNumber: number): Promise<ReviewComment[]> {
    const comments: ReviewComment[] = [];

    // Fetch review comments (inline comments)
    const reviewComments = await this.octokit.rest.pulls.listReviewComments({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    for (const comment of reviewComments.data) {
      comments.push({
        id: comment.id,
        type: comment.body.includes('```suggestion') ? 'suggestion' : 'inline',
        body: comment.body,
        author: comment.user?.login || 'unknown',
        createdAt: new Date(comment.created_at),
        resolved: false, // GitHub doesn't directly expose this
        path: comment.path,
        line: comment.line || undefined,
        side: comment.side as 'LEFT' | 'RIGHT' | undefined,
        diffHunk: comment.diff_hunk,
      });
    }

    // Fetch general PR comments (issue comments on PR)
    const issueComments = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
    });

    for (const comment of issueComments.data) {
      // Skip bot comments unless they're review-related
      if (comment.user?.type === 'Bot' && !this.isReviewBot(comment.user.login)) {
        continue;
      }

      comments.push({
        id: comment.id,
        type: 'general',
        body: comment.body || '',
        author: comment.user?.login || 'unknown',
        createdAt: new Date(comment.created_at),
        resolved: false,
      });
    }

    // Sort by creation date
    return comments.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private isReviewBot(username: string): boolean {
    const reviewBots = [
      'github-actions',
      'dependabot',
      'renovate',
      'codecov',
      'coveralls',
      'sonarcloud',
    ];
    return reviewBots.some(bot => username.toLowerCase().includes(bot));
  }

  private async parseComment(
    comment: ReviewComment,
    pr: PullRequestContext
  ): Promise<ParsedReview | null> {
    // Skip empty comments
    if (!comment.body.trim()) {
      return null;
    }

    // Build context
    const context = await this.contextBuilder.buildContext(comment, pr);

    // Parse intent and requests
    const intent = this.nlpParser.parseIntent(comment.body);
    const changeRequests = this.nlpParser.extractChangeRequests(comment.body);
    const questions = this.nlpParser.extractQuestions(comment.body);

    // Skip if no actionable content
    if (intent === ReviewIntent.Comment && 
        changeRequests.length === 0 && 
        questions.length === 0) {
      return null;
    }

    // Resolve code locations
    const locations = await this.resolver.resolveReferences(comment, pr);

    // Analyze changes
    const analyzedRequests = changeRequests.map(request => 
      this.analyzer.analyzeRequest(request, context)
    );

    // Process suggestions if applicable
    if (comment.type === 'suggestion' && comment.path && comment.line) {
      const suggestion = {
        id: comment.id,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        side: comment.side || 'RIGHT',
      };

      const processed = await this.suggestionHandler.processSuggestion(suggestion);
      
      // Add suggestion info to change requests
      if (processed.canAutoApply && analyzedRequests.length > 0) {
        analyzedRequests[0].suggestedCode = processed.parsed?.suggestedCode;
      }
    }

    return {
      comment,
      intent,
      changeRequests: analyzedRequests,
      questions,
      context,
      locations,
    };
  }

  private generateSummary(reviews: ParsedReview[]): ReviewSummary {
    const filesAffected = new Set<string>();
    let requiredChanges = 0;
    let suggestions = 0;
    let questions = 0;
    let approvals = 0;
    let totalLOC = 0;

    for (const review of reviews) {
      // Count by intent
      switch (review.intent) {
        case ReviewIntent.RequestChanges:
          requiredChanges++;
          break;
        case ReviewIntent.Suggestion:
          suggestions++;
          break;
        case ReviewIntent.Question:
          questions++;
          break;
        case ReviewIntent.Approval:
          approvals++;
          break;
      }

      // Collect affected files
      for (const location of review.locations) {
        filesAffected.add(location.file);
      }

      // Sum estimated LOC
      for (const request of review.changeRequests) {
        totalLOC += request.estimatedLOC || 0;
      }
    }

    // Estimate work hours (rough heuristic)
    const estimatedWorkHours = this.estimateWorkHours(reviews, totalLOC);

    return {
      totalComments: reviews.length,
      actionableComments: reviews.filter(r => 
        r.changeRequests.length > 0 || r.questions.length > 0
      ).length,
      requiredChanges,
      suggestions,
      questions,
      approvals,
      filesAffected: Array.from(filesAffected).sort(),
      estimatedWorkHours,
    };
  }

  private estimateWorkHours(reviews: ParsedReview[], totalLOC: number): number {
    // Base estimate on LOC
    let hours = totalLOC / 50; // Assume 50 LOC per hour as baseline

    // Adjust for complexity
    const highComplexityCount = reviews
      .flatMap(r => r.changeRequests)
      .filter(r => r.complexity === 'high')
      .length;

    hours += highComplexityCount * 2; // Add 2 hours per high complexity item

    // Add time for questions that need investigation
    const investigationQuestions = reviews
      .flatMap(r => r.questions)
      .filter(q => q.needsResponse)
      .length;

    hours += investigationQuestions * 0.5; // 30 minutes per question

    // Add overhead for context switching between files
    const fileCount = new Set(
      reviews.flatMap(r => r.locations.map(l => l.file))
    ).size;

    if (fileCount > 5) {
      hours += fileCount * 0.25; // 15 minutes per file for context switching
    }

    // Round to nearest 0.5
    return Math.round(hours * 2) / 2;
  }

  async generateActionPlan(reviewSet: ParsedReviewSet): Promise<string> {
    const lines: string[] = [];

    lines.push('# Review Action Plan\n');
    lines.push(`Total: ${reviewSet.summary.totalComments} comments`);
    lines.push(`Actionable: ${reviewSet.summary.actionableComments} comments`);
    lines.push(`Estimated time: ${reviewSet.summary.estimatedWorkHours} hours\n`);

    // Required changes
    if (reviewSet.grouped.required.length > 0) {
      lines.push('## Required Changes\n');
      for (const review of reviewSet.grouped.required) {
        lines.push(`- [ ] **${review.comment.author}**: ${review.comment.body.substring(0, 100)}...`);
        for (const request of review.changeRequests) {
          lines.push(`  - ${request.description}`);
        }
      }
      lines.push('');
    }

    // Suggested changes
    if (reviewSet.grouped.suggested.length > 0) {
      lines.push('## Suggested Changes\n');
      for (const review of reviewSet.grouped.suggested) {
        lines.push(`- [ ] **${review.comment.author}**: ${review.comment.body.substring(0, 100)}...`);
      }
      lines.push('');
    }

    // Questions
    if (reviewSet.grouped.questions.length > 0) {
      lines.push('## Questions to Address\n');
      for (const review of reviewSet.grouped.questions) {
        for (const question of review.questions) {
          if (question.needsResponse) {
            lines.push(`- [ ] ${question.text}`);
          }
        }
      }
      lines.push('');
    }

    // Files affected
    lines.push('## Files Affected\n');
    for (const file of reviewSet.summary.filesAffected) {
      lines.push(`- ${file}`);
    }

    return lines.join('\n');
  }
}