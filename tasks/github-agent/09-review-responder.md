# Review Responder

## Overview
Build a system that applies code changes based on review feedback and responds appropriately to review comments.

## Requirements
- Apply requested changes to the correct code locations
- Generate appropriate commit messages for changes
- Post responses to review comments
- Handle batch changes efficiently
- Provide clear feedback on what was done

## Implementation Steps

### Step 1: Define Response Types
Create types in `src/rmapp/responder/types.ts`:
```typescript
interface ReviewResponse {
  comment: ReviewComment;
  action: ResponseAction;
  changes?: AppliedChange[];
  message: string;
  status: 'success' | 'partial' | 'failed';
  details?: ResponseDetails;
}

interface AppliedChange {
  file: string;
  diff: string;
  description: string;
  type: ChangeType;
  location: CodeLocation;
}

interface ResponseAction {
  type: 'change' | 'reply' | 'clarification' | 'decline';
  reason?: string;
  requiresApproval?: boolean;
}

interface BatchResponse {
  responses: ReviewResponse[];
  commit?: CommitInfo;
  summary: BatchSummary;
}
```

### Step 2: Create Change Applier
Implement `src/rmapp/responder/change_applier.ts`:
```typescript
class ChangeApplier {
  async applyChange(
    request: AnalyzedChange,
    workspace: string
  ): Promise<AppliedChange> {
    // Read current file
    const filePath = path.join(workspace, request.location.file);
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Generate the change
    const modified = await this.generateChange(content, request);
    
    // Validate the change
    const validation = await this.validateChange(modified, request);
    if (!validation.isValid) {
      throw new ChangeApplicationError(validation.errors);
    }
    
    // Apply the change
    await fs.writeFile(filePath, modified);
    
    // Generate diff
    const diff = this.generateDiff(content, modified);
    
    return {
      file: request.location.file,
      diff,
      description: request.description,
      type: request.changeType,
      location: request.location
    };
  }
  
  private async generateChange(
    content: string,
    request: AnalyzedChange
  ): Promise<string> {
    switch (request.changeType) {
      case 'errorHandling':
        return this.addErrorHandling(content, request);
      case 'validation':
        return this.addValidation(content, request);
      case 'logging':
        return this.addLogging(content, request);
      case 'documentation':
        return this.addDocumentation(content, request);
      case 'refactoring':
        return this.refactorCode(content, request);
      default:
        return this.applyGenericChange(content, request);
    }
  }
  
  private async addErrorHandling(
    content: string,
    request: AnalyzedChange
  ): Promise<string> {
    // Parse AST
    const ast = this.parseCode(content);
    
    // Find target function
    const target = this.findNode(ast, request.location);
    
    // Wrap in try-catch if needed
    if (!this.hasErrorHandling(target)) {
      return this.wrapInTryCatch(content, target, request);
    }
    
    // Add error handling to existing structure
    return this.enhanceErrorHandling(content, target, request);
  }
}
```

### Step 3: Build Response Generator
Create `src/rmapp/responder/response_generator.ts`:
```typescript
class ResponseGenerator {
  generateResponse(
    comment: ReviewComment,
    result: ChangeResult
  ): string {
    if (result.status === 'success') {
      return this.generateSuccessResponse(comment, result);
    } else if (result.status === 'partial') {
      return this.generatePartialResponse(comment, result);
    } else {
      return this.generateFailureResponse(comment, result);
    }
  }
  
  private generateSuccessResponse(
    comment: ReviewComment,
    result: ChangeResult
  ): string {
    const templates = {
      errorHandling: `✅ Added error handling as requested. The code now properly handles exceptions and provides meaningful error messages.`,
      validation: `✅ Added validation for ${result.details.validatedFields}. Invalid inputs will now be caught before processing.`,
      logging: `✅ Added logging statements to track ${result.details.loggedEvents}. This will help with debugging and monitoring.`,
      documentation: `✅ Added documentation as requested. The code is now properly commented with JSDoc/docstrings.`,
      test: `✅ Added test coverage for ${result.details.testedFunctions}. All new tests are passing.`,
      refactoring: `✅ Refactored the code as suggested. ${result.details.refactoringDescription}`,
      generic: `✅ Applied the requested changes. ${result.changes.length} file(s) modified.`
    };
    
    let response = templates[result.changeType] || templates.generic;
    
    // Add details if available
    if (result.details.codeSnippet) {
      response += `\n\n<details>\n<summary>View changes</summary>\n\n\`\`\`${result.language}\n${result.details.codeSnippet}\n\`\`\`\n</details>`;
    }
    
    // Add commit reference
    if (result.commit) {
      response += `\n\nChanges applied in ${result.commit.sha}`;
    }
    
    return response;
  }
}
```

### Step 4: Create Batch Processor
Implement `src/rmapp/responder/batch_processor.ts`:
```typescript
class BatchProcessor {
  async processBatch(
    reviews: ParsedReview[],
    workspace: string
  ): Promise<BatchResponse> {
    const responses: ReviewResponse[] = [];
    const changes: AppliedChange[] = [];
    
    // Group by file to minimize conflicts
    const byFile = this.groupByFile(reviews);
    
    // Process each file's changes
    for (const [file, fileReviews] of byFile) {
      const fileChanges = await this.processFileReviews(
        file,
        fileReviews,
        workspace
      );
      changes.push(...fileChanges);
      
      // Generate responses
      for (const review of fileReviews) {
        responses.push(this.createResponse(review, fileChanges));
      }
    }
    
    // Create commit if changes were made
    let commit: CommitInfo | undefined;
    if (changes.length > 0) {
      commit = await this.createCommit(changes, reviews);
    }
    
    return {
      responses,
      commit,
      summary: this.generateSummary(responses, changes)
    };
  }
  
  private async processFileReviews(
    file: string,
    reviews: ParsedReview[],
    workspace: string
  ): Promise<AppliedChange[]> {
    // Sort reviews by line number (bottom to top)
    const sorted = this.sortReviewsByLocation(reviews);
    
    const changes: AppliedChange[] = [];
    
    // Apply changes from bottom to top to avoid line number shifts
    for (const review of sorted) {
      try {
        const change = await this.applier.applyChange(
          review.changeRequest,
          workspace
        );
        changes.push(change);
      } catch (e) {
        console.warn(`Failed to apply change: ${e.message}`);
        // Continue with other changes
      }
    }
    
    return changes;
  }
}
```

### Step 5: Build Comment Poster
Create `src/rmapp/responder/comment_poster.ts`:
```typescript
class CommentPoster {
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
  
  private async replyToThread(
    threadId: string,
    responses: ReviewResponse[],
    pr: PullRequest
  ): Promise<void> {
    // Combine responses for the thread
    const combined = this.combineResponses(responses);
    
    await this.github.createReviewComment({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      in_reply_to: threadId,
      body: combined
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
    if (responses.some(r => r.details)) {
      combined += '\n<details>\n<summary>Details</summary>\n\n';
      for (const response of responses) {
        if (response.details) {
          combined += `### ${response.changeDescription}\n`;
          combined += response.details + '\n\n';
        }
      }
      combined += '</details>';
    }
    
    return combined;
  }
}
```

### Step 6: Create Clarification Handler
Implement `src/rmapp/responder/clarification.ts`:
```typescript
class ClarificationHandler {
  needsClarification(review: ParsedReview): boolean {
    // Ambiguous location
    if (review.locations.length > 1 && review.confidence < 0.7) {
      return true;
    }
    
    // Unclear request
    if (review.changeRequests.length === 0 && review.intent === ReviewIntent.RequestChanges) {
      return true;
    }
    
    // Conflicting changes
    if (this.hasConflictingRequests(review)) {
      return true;
    }
    
    return false;
  }
  
  generateClarificationRequest(review: ParsedReview): string {
    const reasons = this.identifyClarificationReasons(review);
    
    let message = "I'd like to help with this change, but I need some clarification:\n\n";
    
    if (reasons.ambiguousLocation) {
      message += "**Location**: I found multiple possible locations for this change:\n";
      for (const loc of review.locations) {
        message += `- \`${loc.file}:${loc.startLine}\` - ${loc.symbol || 'code block'}\n`;
      }
      message += "\nWhich one should I modify?\n\n";
    }
    
    if (reasons.unclearRequest) {
      message += "**Request**: I'm not sure exactly what changes you'd like. Could you provide more specific details?\n\n";
      message += "For example:\n";
      message += "- What validation should be added?\n";
      message += "- What error should be handled?\n";
      message += "- What should the new behavior be?\n\n";
    }
    
    if (reasons.needsExample) {
      message += "**Example**: Could you provide an example of what you're looking for? This will help me implement it correctly.\n\n";
    }
    
    return message;
  }
}
```

### Step 7: Add Commit Manager
Create `src/rmapp/responder/commit_manager.ts`:
```typescript
class CommitManager {
  async createReviewCommit(
    changes: AppliedChange[],
    reviews: ParsedReview[]
  ): Promise<CommitInfo> {
    // Generate commit message
    const message = this.generateCommitMessage(changes, reviews);
    
    // Stage changes
    await this.stageChanges(changes.map(c => c.file));
    
    // Create commit
    const sha = await this.createCommit(message);
    
    // Push to remote
    await this.pushCommit();
    
    return {
      sha,
      message,
      files: changes.map(c => c.file),
      stats: this.calculateStats(changes)
    };
  }
  
  private generateCommitMessage(
    changes: AppliedChange[],
    reviews: ParsedReview[]
  ): string {
    // Group changes by type
    const byType = this.groupChangesByType(changes);
    
    // Generate title
    const title = this.generateTitle(byType, reviews);
    
    // Generate body
    const body = this.generateBody(changes, reviews);
    
    // Add references
    const references = this.generateReferences(reviews);
    
    return `${title}\n\n${body}\n\n${references}`;
  }
  
  private generateTitle(
    byType: Map<ChangeType, AppliedChange[]>,
    reviews: ParsedReview[]
  ): string {
    // Single type of change
    if (byType.size === 1) {
      const [type, changes] = Array.from(byType.entries())[0];
      return this.getTitleForType(type, changes.length);
    }
    
    // Multiple types
    const prNumber = reviews[0]?.context.prNumber;
    return `Address review feedback${prNumber ? ` for #${prNumber}` : ''}`;
  }
  
  private getTitleForType(type: ChangeType, count: number): string {
    const templates = {
      errorHandling: `Add error handling to ${count} function${count > 1 ? 's' : ''}`,
      validation: `Add input validation`,
      logging: `Add logging for debugging`,
      documentation: `Add documentation and comments`,
      test: `Add test coverage`,
      refactoring: `Refactor code based on review feedback`
    };
    
    return templates[type] || 'Apply review feedback';
  }
}
```

### Step 8: Create Response Pipeline
Combine in `src/rmapp/responder/pipeline.ts`:
```typescript
class ReviewResponsePipeline {
  async respondToReviews(
    pr: PullRequest,
    options: ResponseOptions = {}
  ): Promise<ResponseResult> {
    // Parse all reviews
    const parsed = await this.parser.parseReviews(pr);
    
    // Filter actionable reviews
    const actionable = this.filterActionable(parsed.reviews);
    
    // Check for clarifications needed
    const needsClarification = actionable.filter(r => 
      this.clarificationHandler.needsClarification(r)
    );
    
    if (needsClarification.length > 0 && !options.skipClarifications) {
      // Post clarification requests
      await this.requestClarifications(needsClarification, pr);
      
      // Continue with clear reviews only
      actionable = actionable.filter(r => !needsClarification.includes(r));
    }
    
    // Process changes in batches
    const batches = this.createBatches(actionable, options);
    const results: BatchResponse[] = [];
    
    for (const batch of batches) {
      const result = await this.batchProcessor.processBatch(
        batch,
        pr.workspace
      );
      results.push(result);
      
      // Post responses
      await this.commentPoster.postResponses(result.responses, pr);
      
      // Commit if requested
      if (options.autoCommit && result.changes.length > 0) {
        await this.commitManager.createReviewCommit(
          result.changes,
          batch
        );
      }
    }
    
    return {
      processed: actionable.length,
      succeeded: results.flatMap(r => r.responses).filter(r => r.status === 'success').length,
      failed: results.flatMap(r => r.responses).filter(r => r.status === 'failed').length,
      clarificationsRequested: needsClarification.length,
      commits: results.map(r => r.commit).filter(Boolean)
    };
  }
}
```

## Testing Strategy
1. Test change application accuracy
2. Test response message generation
3. Test batch processing logic
4. Test commit message generation
5. Integration test full response flow
6. Test with real review scenarios

## Success Criteria
- [ ] Applies requested changes correctly
- [ ] Generates helpful response messages
- [ ] Handles batch changes efficiently
- [ ] Creates meaningful commits
- [ ] Properly links responses to reviews