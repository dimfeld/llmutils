import type { ReviewComment, ChangeType } from '../reviews/types.js';
import type { ChangeResult, ReviewResponse, ResponseAction, ResponseDetails } from './types.js';

export class ResponseGenerator {
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
  
  generateSuccessMessage(
    changeType: ChangeType,
    details?: ResponseDetails
  ): string {
    const templates: Record<ChangeType, string> = {
      errorHandling: `✅ Added error handling as requested. The code now properly handles exceptions and provides meaningful error messages.`,
      validation: `✅ Added validation for ${details?.validatedFields?.join(', ') || 'input fields'}. Invalid inputs will now be caught before processing.`,
      logging: `✅ Added logging statements to track ${details?.loggedEvents?.join(', ') || 'key events'}. This will help with debugging and monitoring.`,
      documentation: `✅ Added documentation as requested. The code is now properly commented with JSDoc/docstrings.`,
      test: `✅ Added test coverage for ${details?.testedFunctions?.join(', ') || 'the requested functionality'}. All new tests are passing.`,
      refactoring: `✅ Refactored the code as suggested. ${details?.refactoringDescription || 'Code structure has been improved.'}`,
      typefix: `✅ Fixed type issues as requested. The code now has proper type annotations.`,
      performance: `✅ Applied performance optimizations as suggested. The code should now run more efficiently.`,
      security: `✅ Addressed security concerns as requested. The code now follows secure coding practices.`,
      other: `✅ Applied the requested changes. ${details?.refactoringDescription || ''}`
    };
    
    return templates[changeType] || templates.other;
  }
  
  private generateSuccessResponse(
    comment: ReviewComment,
    result: ChangeResult
  ): string {
    let response = this.generateSuccessMessage(result.changeType, result.details);
    
    // Add details if available
    if (result.details.codeSnippet) {
      response += `\n\n<details>\n<summary>View changes</summary>\n\n\`\`\`${result.language || 'diff'}\n${result.details.codeSnippet}\n\`\`\`\n</details>`;
    }
    
    // Add commit reference
    if (result.commit) {
      response += `\n\nChanges applied in ${result.commit.sha.substring(0, 7)}`;
    }
    
    return response;
  }
  
  private generatePartialResponse(
    comment: ReviewComment,
    result: ChangeResult
  ): string {
    let response = `⚠️ Partially applied the requested changes. `;
    
    if (result.changes.length > 0) {
      response += `Successfully modified ${result.changes.length} file(s):\n`;
      for (const change of result.changes) {
        response += `- ${change.file}\n`;
      }
    }
    
    if (result.details.errors?.length) {
      response += `\nSome changes could not be applied:\n`;
      for (const error of result.details.errors) {
        response += `- ${error}\n`;
      }
    }
    
    response += `\nPlease review the changes and let me know if you need further modifications.`;
    
    return response;
  }
  
  private generateFailureResponse(
    comment: ReviewComment,
    result: ChangeResult
  ): string {
    let response = `❌ Unable to apply the requested changes.\n\n`;
    
    if (result.details.errors?.length) {
      response += `Errors encountered:\n`;
      for (const error of result.details.errors) {
        response += `- ${error}\n`;
      }
    } else {
      response += `The change could not be applied automatically. This might be due to:\n`;
      response += `- File or code location not found\n`;
      response += `- Conflicting changes\n`;
      response += `- Syntax or type errors\n`;
    }
    
    response += `\nPlease provide more specific details about the change you'd like, or apply it manually.`;
    
    return response;
  }
  
  createReviewResponse(
    comment: ReviewComment,
    action: ResponseAction,
    result?: ChangeResult,
    message?: string
  ): ReviewResponse {
    const response: ReviewResponse = {
      comment,
      action,
      status: result?.status || 'success',
      message: message || '',
      changes: result?.changes,
      details: result?.details,
    };
    
    // Generate message if not provided
    if (!response.message) {
      switch (action.type) {
        case 'change':
          response.message = result ? this.generateResponse(comment, result) : 
                            '✅ Changes applied successfully.';
          break;
        case 'clarification':
          response.message = this.generateClarificationMessage(action.reason);
          break;
        case 'decline':
          response.message = this.generateDeclineMessage(action.reason);
          break;
        case 'reply':
          response.message = message || 'Thank you for your feedback.';
          break;
      }
    }
    
    // Add summary
    response.summary = this.generateSummary(response);
    
    return response;
  }
  
  private generateClarificationMessage(reason?: string): string {
    if (reason) {
      return `❓ I need some clarification: ${reason}`;
    }
    
    return "❓ I'd like to help with this change, but I need some clarification. Could you provide more specific details about what you'd like me to do?";
  }
  
  private generateDeclineMessage(reason?: string): string {
    if (reason) {
      return `ℹ️ Unable to apply this change: ${reason}`;
    }
    
    return "ℹ️ I'm unable to apply this change automatically. This might require manual intervention or is outside the scope of automated changes.";
  }
  
  private generateSummary(response: ReviewResponse): string {
    switch (response.action.type) {
      case 'change':
        if (response.status === 'success') {
          return `Applied ${response.changes?.length || 0} change(s)`;
        } else if (response.status === 'partial') {
          return `Partially applied (${response.changes?.length || 0} of requested changes)`;
        } else {
          return 'Failed to apply changes';
        }
      case 'clarification':
        return 'Requested clarification';
      case 'decline':
        return 'Declined (requires manual intervention)';
      case 'reply':
        return 'Responded to comment';
      default:
        return 'Processed comment';
    }
  }
  
  formatBatchSummary(responses: ReviewResponse[]): string {
    const summary = {
      total: responses.length,
      successful: responses.filter(r => r.status === 'success').length,
      partial: responses.filter(r => r.status === 'partial').length,
      failed: responses.filter(r => r.status === 'failed').length,
      clarifications: responses.filter(r => r.action.type === 'clarification').length,
    };
    
    let message = `## Review Response Summary\n\n`;
    message += `- Total comments processed: ${summary.total}\n`;
    message += `- Successfully applied: ${summary.successful}\n`;
    
    if (summary.partial > 0) {
      message += `- Partially applied: ${summary.partial}\n`;
    }
    
    if (summary.failed > 0) {
      message += `- Failed to apply: ${summary.failed}\n`;
    }
    
    if (summary.clarifications > 0) {
      message += `- Clarifications needed: ${summary.clarifications}\n`;
    }
    
    // Add file summary
    const files = new Set<string>();
    for (const response of responses) {
      if (response.changes) {
        for (const change of response.changes) {
          files.add(change.file);
        }
      }
    }
    
    if (files.size > 0) {
      message += `\n### Files Modified\n`;
      for (const file of Array.from(files).sort()) {
        message += `- ${file}\n`;
      }
    }
    
    return message;
  }
}