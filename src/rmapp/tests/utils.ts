import type { StateManager } from '../state/manager.js';
import type { WorkflowEngine } from '../workflows/engine.js';
import { fixtures } from './fixtures.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Create a test Git repository
 */
export async function createTestRepo(basePath: string): Promise<string> {
  const repoPath = path.join(basePath, 'test-repo');
  await fs.mkdir(repoPath, { recursive: true });
  
  // Initialize git repo
  await execAsync('git init', { cwd: repoPath });
  await execAsync('git config user.email "test@example.com"', { cwd: repoPath });
  await execAsync('git config user.name "Test User"', { cwd: repoPath });
  
  // Create initial files
  await fs.writeFile(
    path.join(repoPath, 'README.md'),
    '# Test Repository\n\nThis is a test repository for GitHub agent tests.'
  );
  
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'src', 'index.ts'),
    'console.log("Hello, world!");'
  );
  
  // Create initial commit
  await execAsync('git add .', { cwd: repoPath });
  await execAsync('git commit -m "Initial commit"', { cwd: repoPath });
  
  return repoPath;
}

/**
 * Create a test workspace with sample files
 */
export async function createTestWorkspace(basePath: string): Promise<string> {
  const workspacePath = path.join(basePath, 'workspace');
  
  // Create directory structure
  const dirs = [
    'src/auth',
    'src/data',
    'src/api',
    'tests',
    'docs'
  ];
  
  for (const dir of dirs) {
    await fs.mkdir(path.join(workspacePath, dir), { recursive: true });
  }
  
  // Create sample files
  const files = {
    'src/auth/jwt.ts': fixtures.files['src/auth/jwt.ts'],
    'src/data/processor.ts': fixtures.files['src/data/processor.ts'],
    'src/api/routes.ts': `export const routes = {\n  auth: '/api/auth',\n  data: '/api/data'\n};`,
    'tests/auth.test.ts': `describe('Auth Tests', () => {\n  it('should pass', () => {});\n});`,
    'docs/README.md': '# Documentation\n\nProject documentation goes here.',
    'package.json': JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      scripts: {
        test: 'jest',
        build: 'tsc',
        dev: 'ts-node src/index.ts'
      }
    }, null, 2)
  };
  
  for (const [filePath, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspacePath, filePath), content);
  }
  
  return workspacePath;
}

/**
 * Mock GitHub API client for testing
 */
export class MockGitHubClient {
  private issues = new Map<number, any>();
  private prs = new Map<number, any>();
  private comments = new Map<string, any[]>();
  
  constructor() {
    // Pre-populate with fixtures
    this.issues.set(123, fixtures.issues.simple);
    this.issues.set(456, fixtures.issues.complex);
  }
  
  async getIssue(number: number): Promise<any> {
    const issue = this.issues.get(number);
    if (!issue) {
      throw new Error(`Issue #${number} not found`);
    }
    return issue;
  }
  
  async createIssue(data: any): Promise<any> {
    const number = Math.max(...this.issues.keys()) + 1;
    const issue = {
      number,
      ...data,
      created_at: new Date().toISOString(),
      html_url: `https://github.com/test/repo/issues/${number}`
    };
    this.issues.set(number, issue);
    return issue;
  }
  
  async createPR(data: any): Promise<any> {
    const number = Math.max(...Array.from(this.prs.keys()), 123) + 1;
    const pr = {
      number,
      ...data,
      state: 'open',
      created_at: new Date().toISOString(),
      html_url: `https://github.com/test/repo/pull/${number}`
    };
    this.prs.set(number, pr);
    return pr;
  }
  
  async updatePR(number: number, data: any): Promise<any> {
    const pr = this.prs.get(number);
    if (!pr) {
      throw new Error(`PR #${number} not found`);
    }
    Object.assign(pr, data, {
      updated_at: new Date().toISOString()
    });
    return pr;
  }
  
  async getReviewComments(pr: number): Promise<any[]> {
    return this.comments.get(`pr-${pr}`) || [];
  }
  
  async createComment(target: { issue?: number; pr?: number }, body: string): Promise<any> {
    const key = target.issue ? `issue-${target.issue}` : `pr-${target.pr}`;
    const comments = this.comments.get(key) || [];
    
    const comment = {
      id: `comment-${Date.now()}`,
      body,
      user: { login: 'ai-agent' },
      created_at: new Date().toISOString()
    };
    
    comments.push(comment);
    this.comments.set(key, comments);
    
    return comment;
  }
}

/**
 * Mock LLM client for testing
 */
export class MockLLMClient {
  private responses = new Map<string, any>();
  
  setResponse(pattern: string | RegExp, response: any): void {
    this.responses.set(pattern.toString(), response);
  }
  
  async complete(prompt: string): Promise<{ content: string }> {
    // Check for matching patterns
    for (const [pattern, response] of this.responses) {
      const regex = pattern.startsWith('/') ? new RegExp(pattern) : new RegExp(pattern, 'i');
      if (regex.test(prompt)) {
        return { content: typeof response === 'string' ? response : JSON.stringify(response) };
      }
    }
    
    // Default responses based on common patterns
    if (prompt.includes('analyze issue')) {
      return { content: JSON.stringify(fixtures.analyzedIssues.simple) };
    }
    if (prompt.includes('generate plan')) {
      return { content: JSON.stringify(fixtures.plans.simple) };
    }
    if (prompt.includes('parse review')) {
      return { content: JSON.stringify(fixtures.parsedReviews.simple) };
    }
    
    return { content: 'Mock LLM response' };
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const start = Date.now();
  
  while (true) {
    if (await condition()) {
      return;
    }
    
    if (Date.now() - start > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/**
 * Create a test state manager with pre-populated data
 */
export async function createTestStateManager(dbPath: string): Promise<StateManager> {
  const stateManager = new StateManager({ databasePath: dbPath });
  await stateManager.initialize();
  
  // Pre-populate with test data
  await stateManager.saveIssue({
    number: 123,
    title: fixtures.issues.simple.title,
    body: fixtures.issues.simple.body,
    status: 'open',
    createdAt: new Date(fixtures.issues.simple.created_at),
    updatedAt: new Date()
  });
  
  return stateManager;
}

/**
 * Assert workflow completed successfully
 */
export async function assertWorkflowSuccess(
  stateManager: StateManager,
  workflowId: string
): Promise<void> {
  const workflow = await stateManager.getWorkflow(workflowId);
  
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }
  
  if (workflow.status !== 'completed') {
    const events = await stateManager.getEvents({ workflowId });
    const errorEvent = events.find(e => e.type === 'workflow_error');
    
    if (errorEvent) {
      throw new Error(`Workflow failed: ${errorEvent.data.error}`);
    }
    
    throw new Error(`Workflow status: ${workflow.status}`);
  }
}

/**
 * Create a snapshot of the current state for comparison
 */
export async function createStateSnapshot(stateManager: StateManager): Promise<any> {
  const [issues, prs, workflows, events] = await Promise.all([
    stateManager.getAllIssues(),
    stateManager.getAllPRs(),
    stateManager.getAllWorkflows(),
    stateManager.getEvents({})
  ]);
  
  return {
    issues: issues.length,
    prs: prs.length,
    workflows: workflows.length,
    events: events.length,
    timestamp: new Date()
  };
}

/**
 * Compare two state snapshots
 */
export function compareSnapshots(before: any, after: any): any {
  return {
    issues: after.issues - before.issues,
    prs: after.prs - before.prs,
    workflows: after.workflows - before.workflows,
    events: after.events - before.events,
    duration: after.timestamp.getTime() - before.timestamp.getTime()
  };
}

/**
 * Clean up test artifacts
 */
export async function cleanupTest(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors during cleanup
    }
  }
}