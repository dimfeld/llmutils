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
    // Use Claude Code to apply the requested change
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: ['Read', 'Edit', 'MultiEdit', 'Bash(git diff:*)'],
        includeDefaultTools: false
      },
      { model: 'sonnet' },
      this.rmplanConfig
    );
    
    const prompt = `Apply the following review feedback:

File: ${request.location.file}
Location: Lines ${request.location.startLine}-${request.location.endLine}
Change Type: ${request.changeType}
Request: ${request.description}

Original Review Comment:
${request.originalComment}

Instructions:
1. Read the file and understand the context
2. Apply the requested change:
   - For error handling: Add appropriate try-catch blocks or error checks
   - For validation: Add input validation with clear error messages
   - For logging: Add meaningful log statements for debugging
   - For documentation: Add JSDoc/docstrings as appropriate
   - For refactoring: Improve code structure while maintaining functionality
3. Ensure the change follows project conventions
4. Return the applied change details

Be precise and only make the requested change.`;
    
    const result = await executor.execute(prompt);
    
    // Get the diff
    const diff = await this.getDiff(request.location.file, workspace);
    
    return {
      file: request.location.file,
      diff,
      description: request.description,
      type: request.changeType,
      location: request.location
    };
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
      { model: 'sonnet' },
      this.rmplanConfig
    );
    
    const prompt = `Respond to all review comments on PR #${pr.number}:

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

Workspace: ${pr.workspace}
Base branch: ${pr.baseBranch}`;
    
    const result = await executor.execute(prompt);
    return this.parseResponseResult(result);
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