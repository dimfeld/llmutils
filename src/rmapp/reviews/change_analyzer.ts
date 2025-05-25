import type {
  ChangeRequest,
  AnalyzedChange,
  ChangeType,
  ReviewContext,
  CodePattern,
  ImplementationApproach,
} from './types';

export class ChangeRequestAnalyzer {
  analyzeRequest(
    request: ChangeRequest,
    context: ReviewContext
  ): AnalyzedChange {
    // Determine change type
    const changeType = this.inferChangeType(request);

    // Estimate complexity
    const complexity = this.estimateComplexity(request, context);

    // Find similar patterns
    const patterns = this.findPatterns(request, context);

    // Generate implementation approach
    const approach = this.suggestApproach(request, patterns, changeType);

    // Estimate lines of code
    const estimatedLOC = this.estimateLinesOfChange(request, changeType);

    return {
      ...request,
      changeType,
      complexity,
      patterns,
      approach,
      estimatedLOC,
    };
  }

  private inferChangeType(request: ChangeRequest): ChangeType {
    const keywords = {
      errorHandling: ['error', 'exception', 'try', 'catch', 'handle', 'throw', 'err'],
      validation: ['validate', 'check', 'verify', 'ensure', 'assert', 'valid'],
      logging: ['log', 'debug', 'trace', 'console', 'logger', 'print'],
      test: ['test', 'spec', 'assert', 'expect', 'mock', 'fixture', 'it(', 'describe('],
      documentation: ['comment', 'doc', 'jsdoc', 'readme', 'document', '/**', '//'],
      refactoring: ['refactor', 'extract', 'rename', 'move', 'split', 'combine', 'simplify'],
      performance: ['performance', 'optimize', 'speed', 'fast', 'slow', 'cache', 'memo'],
      security: ['security', 'auth', 'password', 'token', 'encrypt', 'secure', 'vulnerability'],
    };

    const lowerDesc = request.description.toLowerCase();
    const lowerCode = (request.suggestedCode || '').toLowerCase();
    const combined = `${lowerDesc} ${lowerCode}`;

    // Count keyword matches for each type
    const scores: Record<string, number> = {};

    for (const [type, words] of Object.entries(keywords)) {
      scores[type] = words.reduce((count, word) => {
        return count + (combined.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length;
      }, 0);
    }

    // Find the type with highest score
    let maxScore = 0;
    let bestType: ChangeType = 'other';

    for (const [type, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        bestType = type as ChangeType;
      }
    }

    return bestType;
  }

  private estimateComplexity(
    request: ChangeRequest,
    context: ReviewContext
  ): 'low' | 'medium' | 'high' {
    let score = 0;

    // Priority affects complexity
    if (request.priority === 'required') score += 1;
    if (request.priority === 'optional') score -= 1;

    // Type of change
    if (request.type === 'add') score += 1;
    if (request.type === 'refactor') score += 2;
    if (request.type === 'remove') score -= 1;

    // Specific change types have different complexities
    const changeType = request.changeType || this.inferChangeType(request);
    const complexTypes = ['refactoring', 'performance', 'security', 'errorHandling'];
    if (complexTypes.includes(changeType)) score += 2;

    // Check if multiple files affected
    if (context.files.length > 1) score += 1;
    if (context.files.length > 3) score += 1;

    // Check if suggested code is complex
    if (request.suggestedCode) {
      const lines = request.suggestedCode.split('\n').length;
      if (lines > 10) score += 1;
      if (lines > 30) score += 1;
    }

    // Thread discussion indicates complexity
    if (context.thread && context.thread.comments.length > 3) score += 1;

    // Map score to complexity
    if (score <= 1) return 'low';
    if (score <= 4) return 'medium';
    return 'high';
  }

  private findPatterns(
    request: ChangeRequest,
    context: ReviewContext
  ): CodePattern[] {
    const patterns: CodePattern[] = [];

    // Find patterns based on change type
    const changeType = request.changeType || this.inferChangeType(request);

    switch (changeType) {
      case 'errorHandling':
        patterns.push({
          name: 'Try-Catch Pattern',
          description: 'Wrap operations in try-catch blocks',
          example: 'try { /* operation */ } catch (error) { /* handle */ }',
          files: this.findFilesWithPattern(context, /try\s*{/),
        });
        break;

      case 'validation':
        patterns.push({
          name: 'Input Validation',
          description: 'Validate inputs before processing',
          example: 'if (!isValid(input)) throw new Error("Invalid input");',
          files: this.findFilesWithPattern(context, /validate|isValid/),
        });
        break;

      case 'logging':
        patterns.push({
          name: 'Structured Logging',
          description: 'Use consistent logging patterns',
          example: 'logger.info("Operation completed", { context });',
          files: this.findFilesWithPattern(context, /log\.|logger\./),
        });
        break;

      case 'test':
        patterns.push({
          name: 'Test Structure',
          description: 'Follow existing test patterns',
          example: 'describe("Feature", () => { it("should...", () => {}); });',
          files: this.findFilesWithPattern(context, /describe\(|it\(/),
        });
        break;

      case 'refactoring':
        patterns.push({
          name: 'Extract Method',
          description: 'Extract complex logic into separate functions',
          example: 'function extractedMethod() { /* logic */ }',
          files: [],
        });
        break;

      default:
        // Look for general patterns in the codebase
        if (request.suggestedCode) {
          patterns.push({
            name: 'Similar Code Pattern',
            description: 'Found similar code in the codebase',
            example: request.suggestedCode.substring(0, 100) + '...',
            files: this.findSimilarCode(context, request.suggestedCode),
          });
        }
    }

    return patterns;
  }

  private findFilesWithPattern(
    context: ReviewContext,
    pattern: RegExp
  ): string[] {
    return context.files
      .filter(file => pattern.test(file.content))
      .map(file => file.path);
  }

  private findSimilarCode(
    context: ReviewContext,
    code: string
  ): string[] {
    // Simple similarity check - in production, use AST or more sophisticated matching
    const codeTokens = this.tokenize(code);
    const threshold = 0.6; // 60% similarity

    return context.files
      .filter(file => {
        const fileTokens = this.tokenize(file.content);
        const similarity = this.calculateSimilarity(codeTokens, fileTokens);
        return similarity > threshold;
      })
      .map(file => file.path);
  }

  private tokenize(code: string): Set<string> {
    // Simple tokenization - extract meaningful tokens
    const tokens = code
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .toLowerCase()
      .split(/\s+/)
      .filter(token => token.length > 2); // Skip short tokens
    
    return new Set(tokens);
  }

  private calculateSimilarity(tokens1: Set<string>, tokens2: Set<string>): number {
    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);
    return intersection.size / union.size;
  }

  private suggestApproach(
    request: ChangeRequest,
    patterns: CodePattern[],
    changeType: ChangeType
  ): ImplementationApproach {
    const steps: string[] = [];
    const considerations: string[] = [];
    const risks: string[] = [];
    const alternatives: string[] = [];

    // Base steps for all changes
    steps.push('Review the existing code and understand the context');

    // Type-specific steps
    switch (request.type) {
      case 'add':
        steps.push('Identify the appropriate location for the new code');
        steps.push('Implement the requested functionality');
        steps.push('Add necessary imports or dependencies');
        break;
      
      case 'modify':
        steps.push('Locate the code to be modified');
        steps.push('Apply the requested changes');
        steps.push('Update any dependent code');
        break;
      
      case 'remove':
        steps.push('Identify all references to the code to be removed');
        steps.push('Remove the code and update references');
        steps.push('Clean up any unused imports');
        risks.push('Ensure no critical functionality depends on removed code');
        break;
      
      case 'refactor':
        steps.push('Analyze the current implementation');
        steps.push('Plan the refactoring approach');
        steps.push('Implement changes incrementally');
        steps.push('Ensure all tests still pass');
        considerations.push('Maintain backward compatibility if needed');
        break;
    }

    // Change type specific guidance
    switch (changeType) {
      case 'errorHandling':
        steps.push('Add appropriate error handling mechanisms');
        considerations.push('Consider different error scenarios');
        considerations.push('Ensure errors are logged appropriately');
        break;
      
      case 'validation':
        steps.push('Implement input validation logic');
        considerations.push('Handle edge cases and invalid inputs');
        risks.push('Avoid breaking existing valid inputs');
        break;
      
      case 'test':
        steps.push('Write test cases covering the new/modified functionality');
        considerations.push('Include edge cases and error scenarios');
        alternatives.push('Consider using test-driven development (TDD)');
        break;
      
      case 'performance':
        steps.push('Profile the current implementation');
        steps.push('Identify performance bottlenecks');
        steps.push('Implement optimizations');
        steps.push('Measure performance improvements');
        risks.push('Ensure optimizations don\'t break functionality');
        break;
      
      case 'security':
        steps.push('Identify security vulnerabilities');
        steps.push('Implement security best practices');
        considerations.push('Consider OWASP guidelines');
        risks.push('Test thoroughly to avoid introducing new vulnerabilities');
        break;
    }

    // Add pattern-based suggestions
    if (patterns.length > 0) {
      steps.push(`Follow existing patterns: ${patterns[0].name}`);
      if (patterns[0].files.length > 0) {
        considerations.push(`Reference implementation in: ${patterns[0].files[0]}`);
      }
    }

    // Final steps
    steps.push('Test the changes thoroughly');
    steps.push('Update documentation if needed');

    return {
      steps,
      considerations,
      risks,
      alternatives,
    };
  }

  private estimateLinesOfChange(
    request: ChangeRequest,
    changeType: ChangeType
  ): number {
    let baseEstimate = 10;

    // Adjust based on request type
    switch (request.type) {
      case 'add':
        baseEstimate = 20;
        break;
      case 'modify':
        baseEstimate = 10;
        break;
      case 'remove':
        baseEstimate = 5;
        break;
      case 'refactor':
        baseEstimate = 30;
        break;
    }

    // Adjust based on change type
    const typeMultipliers: Record<ChangeType, number> = {
      errorHandling: 1.5,
      validation: 1.3,
      logging: 0.8,
      test: 2.0,
      documentation: 0.5,
      refactoring: 2.5,
      typefix: 1.2,
      performance: 2.0,
      security: 1.8,
      other: 1.0,
    };

    baseEstimate *= typeMultipliers[changeType];

    // If suggested code provided, use its line count as reference
    if (request.suggestedCode) {
      const suggestedLines = request.suggestedCode.split('\n').length;
      baseEstimate = Math.max(baseEstimate, suggestedLines * 1.5);
    }

    // Complexity adjustment
    const complexity = request.complexity || 'medium';
    if (complexity === 'low') baseEstimate *= 0.7;
    if (complexity === 'high') baseEstimate *= 1.5;

    return Math.round(baseEstimate);
  }
}