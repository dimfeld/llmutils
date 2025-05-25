import type { ParsedReview, CodeLocation } from '../reviews/types.js';
import { ReviewIntent } from '../reviews/types.js';
import type { ClarificationReason } from './types.js';

export class ClarificationHandler {
  needsClarification(review: ParsedReview): boolean {
    // Ambiguous location
    if (review.locations.length > 1 && (review.confidence || 1) < 0.7) {
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
    
    // Low confidence
    if ((review.confidence || 1) < 0.5) {
      return true;
    }
    
    // Missing critical information
    if (this.isMissingCriticalInfo(review)) {
      return true;
    }
    
    return false;
  }
  
  generateClarificationRequest(review: ParsedReview): string {
    const reasons = this.identifyClarificationReasons(review);
    
    let message = "I'd like to help with this change, but I need some clarification:\n\n";
    
    if (reasons.ambiguousLocation) {
      message += this.generateLocationClarification(review.locations);
    }
    
    if (reasons.unclearRequest) {
      message += this.generateRequestClarification(review);
    }
    
    if (reasons.needsExample) {
      message += this.generateExampleRequest(review);
    }
    
    if (reasons.conflictingRequests) {
      message += this.generateConflictClarification(review);
    }
    
    if (reasons.missingContext) {
      message += this.generateContextRequest(review);
    }
    
    // Add helpful closing
    message += "\nOnce you provide these details, I'll be happy to implement the changes for you!";
    
    return message;
  }
  
  private hasConflictingRequests(review: ParsedReview): boolean {
    if (review.changeRequests.length < 2) return false;
    
    // Check for conflicting locations
    const locations = review.changeRequests
      .map(r => r.location)
      .filter(Boolean) as CodeLocation[];
      
    for (let i = 0; i < locations.length; i++) {
      for (let j = i + 1; j < locations.length; j++) {
        if (this.locationsOverlap(locations[i], locations[j])) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  private locationsOverlap(loc1: CodeLocation, loc2: CodeLocation): boolean {
    if (loc1.file !== loc2.file) return false;
    
    const start1 = loc1.startLine;
    const end1 = loc1.endLine || loc1.startLine;
    const start2 = loc2.startLine;
    const end2 = loc2.endLine || loc2.startLine;
    
    return start1 <= end2 && start2 <= end1;
  }
  
  private isMissingCriticalInfo(review: ParsedReview): boolean {
    // Check for vague change requests
    const vagueTerms = [
      'fix this',
      'improve',
      'make better',
      'optimize',
      'clean up',
      'refactor this'
    ];
    
    const commentLower = review.comment.body.toLowerCase();
    
    // If comment contains only vague terms without specifics
    if (vagueTerms.some(term => commentLower.includes(term))) {
      // Check if there are specific details
      const hasSpecifics = /\b(should|must|need to|please|try to)\s+\w+/.test(commentLower);
      return !hasSpecifics;
    }
    
    return false;
  }
  
  private identifyClarificationReasons(review: ParsedReview): ClarificationReason {
    return {
      ambiguousLocation: review.locations.length > 1 && (review.confidence || 1) < 0.7,
      unclearRequest: review.changeRequests.length === 0 && review.intent === ReviewIntent.RequestChanges,
      needsExample: this.needsExample(review),
      conflictingRequests: this.hasConflictingRequests(review),
      missingContext: this.isMissingCriticalInfo(review)
    };
  }
  
  private needsExample(review: ParsedReview): boolean {
    const exampleIndicators = [
      'should be like',
      'similar to',
      'for example',
      'e.g.',
      'such as'
    ];
    
    const commentLower = review.comment.body.toLowerCase();
    
    // Check if reviewer is asking for something but hasn't provided an example
    const askingForSomething = review.intent === ReviewIntent.RequestChanges;
    const mentionsExample = exampleIndicators.some(ind => commentLower.includes(ind));
    const hasCodeBlock = /```[\s\S]*```/.test(review.comment.body);
    
    return askingForSomething && mentionsExample && !hasCodeBlock;
  }
  
  private generateLocationClarification(locations: CodeLocation[]): string {
    let message = "**Location**: I found multiple possible locations for this change:\n\n";
    
    for (const [index, loc] of locations.entries()) {
      const symbol = loc.symbol || 'code block';
      message += `${index + 1}. \`${loc.file}:${loc.startLine}\` - ${symbol}\n`;
    }
    
    message += "\nWhich location should I modify? (Please specify the number or provide more context)\n\n";
    
    return message;
  }
  
  private generateRequestClarification(review: ParsedReview): string {
    let message = "**Request**: I understand you'd like changes made, but I need more specific details:\n\n";
    
    // Provide context-specific prompts
    const comment = review.comment.body.toLowerCase();
    
    if (comment.includes('error') || comment.includes('exception')) {
      message += "- What specific errors should be handled?\n";
      message += "- How should the errors be handled (log, throw, return default)?\n";
    } else if (comment.includes('validat')) {
      message += "- What fields or inputs need validation?\n";
      message += "- What are the validation rules?\n";
      message += "- What should happen when validation fails?\n";
    } else if (comment.includes('test')) {
      message += "- What scenarios should be tested?\n";
      message += "- Should I add unit tests, integration tests, or both?\n";
    } else if (comment.includes('document')) {
      message += "- What level of documentation is needed (inline comments, JSDoc, README)?\n";
      message += "- Any specific aspects that need documenting?\n";
    } else {
      message += "- What specific behavior should be changed?\n";
      message += "- What should the new behavior be?\n";
    }
    
    message += "\n";
    
    return message;
  }
  
  private generateExampleRequest(review: ParsedReview): string {
    return "**Example**: Could you provide a code example of what you're looking for? This will help me implement it correctly.\n\n";
  }
  
  private generateConflictClarification(review: ParsedReview): string {
    let message = "**Conflicting Changes**: I noticed multiple changes that might conflict:\n\n";
    
    for (const [index, req] of review.changeRequests.entries()) {
      message += `${index + 1}. ${req.description}\n`;
    }
    
    message += "\nShould I apply all of these changes, or would you prefer a specific approach?\n\n";
    
    return message;
  }
  
  private generateContextRequest(review: ParsedReview): string {
    return "**Context**: The request seems a bit general. Could you provide more context about:\n" +
           "- The specific problem you're trying to solve\n" +
           "- The expected outcome after the change\n" +
           "- Any constraints or requirements I should be aware of\n\n";
  }
  
  suggestAlternatives(review: ParsedReview): string[] {
    const suggestions: string[] = [];
    
    // Based on the comment content, suggest common improvements
    const comment = review.comment.body.toLowerCase();
    
    if (comment.includes('performance')) {
      suggestions.push(
        'Consider memoization for expensive calculations',
        'Use lazy loading for large data sets',
        'Implement caching where appropriate'
      );
    }
    
    if (comment.includes('readability') || comment.includes('clean')) {
      suggestions.push(
        'Extract complex logic into well-named functions',
        'Add descriptive variable names',
        'Break down long functions into smaller ones'
      );
    }
    
    if (comment.includes('error') && !comment.includes('handling')) {
      suggestions.push(
        'Add try-catch blocks for async operations',
        'Validate inputs before processing',
        'Return meaningful error messages'
      );
    }
    
    return suggestions.slice(0, 3);
  }
}