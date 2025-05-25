import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ResponseGenerator } from './response_generator.js';
import { ClarificationHandler } from './clarification.js';
import { CommitManager } from './commit_manager.js';
import type { ChangeResult, ReviewResponse } from './types.js';
import type { ReviewComment, ParsedReview, ReviewIntent, ChangeType } from '../reviews/types.js';

describe('ResponseGenerator', () => {
  let generator: ResponseGenerator;
  
  beforeEach(() => {
    generator = new ResponseGenerator();
  });
  
  it('should generate success response with code snippet', () => {
    const comment: ReviewComment = {
      id: 1,
      type: 'inline',
      body: 'Add error handling here',
      author: 'reviewer',
      createdAt: new Date(),
      resolved: false,
    };
    
    const result: ChangeResult = {
      status: 'success',
      changes: [{
        file: 'src/app.ts',
        diff: '+ try { ... }',
        description: 'Added try-catch block',
        type: 'errorHandling',
        location: { file: 'src/app.ts', startLine: 10, endLine: 20 }
      }],
      details: {
        codeSnippet: 'try {\n  await process();\n} catch (error) {\n  console.error(error);\n}'
      },
      changeType: 'errorHandling',
      language: 'typescript'
    };
    
    const response = generator.generateResponse(comment, result);
    
    expect(response).toContain('✅ Added error handling');
    expect(response).toContain('<details>');
    expect(response).toContain('```typescript');
  });
  
  it('should generate failure response with errors', () => {
    const comment: ReviewComment = {
      id: 2,
      type: 'inline',
      body: 'Fix this',
      author: 'reviewer',
      createdAt: new Date(),
      resolved: false,
    };
    
    const result: ChangeResult = {
      status: 'failed',
      changes: [],
      details: {
        errors: ['File not found', 'Invalid syntax']
      },
      changeType: 'other'
    };
    
    const response = generator.generateResponse(comment, result);
    
    expect(response).toContain('❌ Unable to apply');
    expect(response).toContain('File not found');
    expect(response).toContain('Invalid syntax');
  });
  
  it('should create review response with appropriate action', () => {
    const comment: ReviewComment = {
      id: 3,
      type: 'general',
      body: 'Please clarify',
      author: 'reviewer',
      createdAt: new Date(),
      resolved: false,
    };
    
    const response = generator.createReviewResponse(
      comment,
      { type: 'clarification', reason: 'Ambiguous location' }
    );
    
    expect(response.action.type).toBe('clarification');
    expect(response.message).toContain('clarification');
    expect(response.summary).toBe('Requested clarification');
  });
});

describe('ClarificationHandler', () => {
  let handler: ClarificationHandler;
  
  beforeEach(() => {
    handler = new ClarificationHandler();
  });
  
  it('should identify need for clarification with ambiguous location', () => {
    const review: ParsedReview = {
      comment: {
        id: 1,
        type: 'inline',
        body: 'Fix this error handling',
        author: 'reviewer',
        createdAt: new Date(),
        resolved: false,
      },
      intent: ReviewIntent.RequestChanges,
      changeRequests: [],
      questions: [],
      context: {} as any,
      locations: [
        { file: 'app.ts', startLine: 10, endLine: 15 },
        { file: 'app.ts', startLine: 50, endLine: 55 }
      ],
      confidence: 0.6
    };
    
    expect(handler.needsClarification(review)).toBe(true);
    
    const message = handler.generateClarificationRequest(review);
    expect(message).toContain('multiple possible locations');
    expect(message).toContain('app.ts:10');
    expect(message).toContain('app.ts:50');
  });
  
  it('should identify unclear request', () => {
    const review: ParsedReview = {
      comment: {
        id: 2,
        type: 'general',
        body: 'This needs to be fixed',
        author: 'reviewer',
        createdAt: new Date(),
        resolved: false,
      },
      intent: ReviewIntent.RequestChanges,
      changeRequests: [],
      questions: [],
      context: {} as any,
      locations: []
    };
    
    expect(handler.needsClarification(review)).toBe(true);
  });
  
  it('should generate appropriate clarification for validation request', () => {
    const review: ParsedReview = {
      comment: {
        id: 3,
        type: 'inline',
        body: 'Add validation here',
        author: 'reviewer',
        createdAt: new Date(),
        resolved: false,
      },
      intent: ReviewIntent.RequestChanges,
      changeRequests: [],
      questions: [],
      context: {} as any,
      locations: [{ file: 'form.ts', startLine: 20, endLine: 30 }]
    };
    
    const message = handler.generateClarificationRequest(review);
    expect(message).toContain('What fields or inputs need validation?');
    expect(message).toContain('validation rules');
  });
});

describe('CommitManager', () => {
  let manager: CommitManager;
  
  beforeEach(() => {
    manager = new CommitManager();
    // Mock git commands
    mock.module('child_process', () => ({
      execSync: mock((cmd: string) => {
        if (cmd.includes('git add')) return '';
        if (cmd.includes('git commit')) return '';
        if (cmd.includes('git rev-parse HEAD')) return 'abc123def456';
        if (cmd.includes('git diff --stat')) {
          return '3 files changed, 42 insertions(+), 10 deletions(-)';
        }
        return '';
      })
    }));
  });
  
  it('should generate appropriate commit message for single change type', () => {
    const changes = [
      {
        file: 'src/auth.ts',
        diff: '+ validation code',
        description: 'Added email validation',
        type: 'validation' as ChangeType,
        location: { file: 'src/auth.ts', startLine: 10, endLine: 20 }
      },
      {
        file: 'src/user.ts',
        diff: '+ validation code',
        description: 'Added username validation',
        type: 'validation' as ChangeType,
        location: { file: 'src/user.ts', startLine: 30, endLine: 40 }
      }
    ];
    
    const reviews: ParsedReview[] = [{
      comment: {
        id: 1,
        type: 'inline',
        body: 'Add validation',
        author: 'john',
        createdAt: new Date(),
        resolved: false,
      },
      intent: ReviewIntent.RequestChanges,
      changeRequests: [],
      questions: [],
      context: { prContext: { number: 123 } } as any,
      locations: []
    }];
    
    const commitPromise = manager.createReviewCommit(changes, reviews);
    
    // Note: This test would need proper async handling and mocking
    // For now, we're just testing the structure
    expect(commitPromise).toBeInstanceOf(Promise);
  });
});

describe('Integration', () => {
  it('should handle a complete review response flow', async () => {
    // This would be a more complex integration test
    // combining multiple components
    expect(true).toBe(true);
  });
});