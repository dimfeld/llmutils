// Test fixtures for GitHub agent tests
import type { 
  AnalyzedIssue,
  ImplementationPlan,
  ParsedReview,
  ReviewIntent,
  ActionRequest,
  CodeLocation
} from '../types.js';

export const fixtures = {
  // Sample issues
  issues: {
    simple: {
      number: 123,
      title: 'Add user authentication',
      body: `We need to add user authentication to the app.
      
      Requirements:
      - Support email/password login
      - Add JWT tokens
      - Create login/logout endpoints
      
      Please implement in the auth module.`,
      labels: ['enhancement', 'backend'],
      author: 'testuser',
      created_at: '2024-01-15T10:00:00Z',
      html_url: 'https://github.com/test/repo/issues/123'
    },
    
    complex: {
      number: 456,
      title: 'Refactor data processing pipeline',
      body: `The current data processing pipeline has several issues:
      
      1. Performance is slow for large datasets
      2. Memory usage is too high
      3. Error handling is inconsistent
      
      Related to #234, #345, and PR #400.
      
      See the discussion in #789 for more context.
      
      Tasks:
      - [ ] Profile current implementation
      - [ ] Optimize algorithms
      - [ ] Add proper error handling
      - [ ] Update documentation
      
      cc @teammate1 @teammate2`,
      labels: ['bug', 'performance', 'refactor'],
      author: 'leaddev',
      created_at: '2024-01-10T14:30:00Z',
      html_url: 'https://github.com/test/repo/issues/456'
    }
  },
  
  // Sample analyzed issues
  analyzedIssues: {
    simple: {
      issue: {
        number: 123,
        title: 'Add user authentication',
        body: 'Add auth',
        html_url: 'https://github.com/test/repo/issues/123'
      },
      type: 'feature',
      requirements: [
        'Support email/password login',
        'Add JWT tokens',
        'Create login/logout endpoints'
      ],
      tasks: [
        {
          description: 'Create auth module',
          completed: false,
          subtasks: []
        },
        {
          description: 'Implement login endpoint',
          completed: false,
          subtasks: []
        }
      ],
      references: {
        issues: [],
        prs: [],
        commits: [],
        discussions: []
      },
      mentions: ['auth module'],
      complexity: {
        score: 0.3,
        factors: {
          requirementsCount: 3,
          tasksCount: 2,
          referencesCount: 0,
          estimatedLOC: 200,
          riskLevel: 'low'
        }
      },
      metadata: {
        labels: ['enhancement'],
        author: 'testuser',
        assignees: [],
        milestone: null,
        priority: 'medium'
      }
    } as AnalyzedIssue
  },
  
  // Sample implementation plans
  plans: {
    simple: {
      issueNumber: 123,
      title: 'Add user authentication',
      description: 'Implement user authentication with JWT',
      steps: [
        {
          id: 'step-1',
          title: 'Create auth module structure',
          description: 'Set up the basic auth module with types and interfaces',
          order: 1,
          status: 'pending',
          files: ['src/auth/index.ts', 'src/auth/types.ts'],
          dependencies: [],
          estimatedTime: '30m',
          commands: []
        },
        {
          id: 'step-2',
          title: 'Implement JWT service',
          description: 'Create JWT token generation and validation',
          order: 2,
          status: 'pending',
          files: ['src/auth/jwt.ts'],
          dependencies: ['step-1'],
          estimatedTime: '1h',
          commands: ['npm install jsonwebtoken @types/jsonwebtoken']
        }
      ],
      context: {
        relatedFiles: ['src/server.ts', 'src/routes/index.ts'],
        dependencies: ['jsonwebtoken'],
        testStrategy: 'Unit tests for each auth function',
        rollbackPlan: 'Remove auth module and revert route changes'
      },
      metadata: {
        createdAt: new Date('2024-01-15T11:00:00Z'),
        updatedAt: new Date('2024-01-15T11:00:00Z'),
        version: 1,
        author: 'ai-agent'
      }
    } as ImplementationPlan
  },
  
  // Sample review comments
  reviews: {
    simple: [
      {
        id: '1',
        user: { login: 'reviewer1' },
        body: 'Please add error handling here',
        path: 'src/auth/jwt.ts',
        line: 42,
        created_at: '2024-01-16T09:00:00Z'
      },
      {
        id: '2', 
        user: { login: 'reviewer2' },
        body: 'LGTM! Just one small suggestion above.',
        created_at: '2024-01-16T09:30:00Z'
      }
    ],
    
    complex: [
      {
        id: '3',
        user: { login: 'senior-dev' },
        body: 'This needs to be refactored. The function is too long.',
        path: 'src/data/processor.ts',
        line: 150,
        created_at: '2024-01-17T10:00:00Z'
      },
      {
        id: '4',
        user: { login: 'senior-dev' },
        body: '```suggestion\nconst result = await processInBatches(data, BATCH_SIZE);\n```',
        path: 'src/data/processor.ts',
        line: 175,
        created_at: '2024-01-17T10:05:00Z'
      },
      {
        id: '5',
        user: { login: 'teammate' },
        body: 'Can we add tests for this edge case?',
        path: 'src/data/validator.ts',
        line: 88,
        created_at: '2024-01-17T10:30:00Z'
      }
    ]
  },
  
  // Sample parsed reviews
  parsedReviews: {
    simple: {
      id: 'review-1',
      pr: 124,
      comments: [
        {
          id: '1',
          body: 'Please add error handling here',
          intent: 'change_required' as ReviewIntent,
          severity: 'error',
          location: {
            file: 'src/auth/jwt.ts',
            startLine: 42,
            endLine: 42,
            type: 'block'
          } as CodeLocation,
          actionRequest: {
            type: 'code_change',
            description: 'Add error handling',
            specific: true,
            suggestion: undefined
          } as ActionRequest,
          context: {
            reviewer: 'reviewer1',
            isBlocking: true,
            needsResponse: true
          }
        }
      ],
      summary: {
        totalComments: 2,
        byIntent: new Map([
          ['change_required', 1],
          ['approval', 1]
        ]),
        bySeverity: new Map([
          ['error', 1],
          ['info', 1]
        ]),
        blockingCount: 1,
        isApproved: false,
        needsChanges: true
      },
      confidence: 0.9
    } as ParsedReview
  },
  
  // Sample code locations
  locations: {
    simple: {
      file: 'src/auth/jwt.ts',
      startLine: 42,
      endLine: 45,
      type: 'function',
      symbol: 'generateToken'
    } as CodeLocation,
    
    ambiguous: {
      file: 'src/data/processor.ts',
      startLine: 150,
      endLine: 200,
      type: 'function',
      symbol: 'processData'
    } as CodeLocation
  },
  
  // Sample file contents
  files: {
    'src/auth/jwt.ts': `import jwt from 'jsonwebtoken';

export interface TokenPayload {
  userId: string;
  email: string;
}

export function generateToken(payload: TokenPayload): string {
  // TODO: Add error handling
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: '24h'
  });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
}`,
    
    'src/data/processor.ts': `export async function processData(data: any[]): Promise<any[]> {
  const results = [];
  
  // This function is quite long and needs refactoring
  for (const item of data) {
    // Processing logic here...
    // ... many lines of code ...
    results.push(processedItem);
  }
  
  return results;
}`
  },
  
  // Mock GitHub API responses
  github: {
    createPR: {
      number: 124,
      html_url: 'https://github.com/test/repo/pull/124',
      title: 'Implement user authentication (#123)',
      state: 'open',
      created_at: '2024-01-15T12:00:00Z'
    },
    
    updatePR: {
      number: 124,
      state: 'open',
      updated_at: '2024-01-16T10:00:00Z'
    },
    
    getUser: {
      login: 'ai-agent',
      id: 12345,
      type: 'Bot'
    }
  },
  
  // Test contexts
  contexts: {
    code: {
      id: 'ctx-1',
      type: 'code',
      source: { type: 'file', location: 'src/auth/jwt.ts' },
      content: 'JWT implementation',
      metadata: { file: 'src/auth/jwt.ts', language: 'typescript' },
      relevance: 0.9,
      timestamp: new Date()
    },
    
    documentation: {
      id: 'ctx-2',
      type: 'documentation',
      source: { type: 'file', location: 'docs/auth.md' },
      content: '# Authentication Guide',
      metadata: { file: 'docs/auth.md', title: 'Authentication' },
      relevance: 0.8,
      timestamp: new Date()
    }
  }
};

// Helper functions for tests
export function createMockIssue(overrides: any = {}) {
  return {
    ...fixtures.issues.simple,
    ...overrides
  };
}

export function createMockReview(overrides: any = {}) {
  return {
    ...fixtures.parsedReviews.simple,
    ...overrides
  };
}

export function createMockPlan(overrides: any = {}) {
  return {
    ...fixtures.plans.simple,
    ...overrides
  };
}

export function createMockLocation(overrides: any = {}) {
  return {
    ...fixtures.locations.simple,
    ...overrides
  };
}