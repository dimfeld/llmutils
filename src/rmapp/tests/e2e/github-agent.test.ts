import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { GitHubAgent } from '../../agent.js';
import { StateManager } from '../../state/manager.js';
import { WorkflowEngine } from '../../workflows/engine.js';
import { CommandParser } from '../../commands/parser.js';
import { IssueAnalyzer } from '../../analysis/issue_analyzer.js';
import { PlanGenerator } from '../../planning/plan_generator.js';
import { ReviewParser } from '../../reviews/review_parser.js';
import { CodeLocator } from '../../locator/code_locator.js';
import { ReviewResponder } from '../../responder/review_responder.js';
import { ContextPipeline } from '../../context/pipeline.js';
import { LearningPipeline } from '../../learning/pipeline.js';
import { fixtures, createMockIssue } from '../fixtures.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('GitHub Agent End-to-End Tests', () => {
  let tempDir: string;
  let agent: GitHubAgent;
  let stateManager: StateManager;
  let workflowEngine: WorkflowEngine;
  
  // Mock GitHub API
  const mockGitHub = {
    getIssue: mock(() => Promise.resolve(fixtures.issues.simple)),
    createPR: mock(() => Promise.resolve(fixtures.github.createPR)),
    updatePR: mock(() => Promise.resolve(fixtures.github.updatePR)),
    getReviewComments: mock(() => Promise.resolve(fixtures.reviews.simple)),
    createComment: mock(() => Promise.resolve({ id: 'comment-1' })),
    getUser: mock(() => Promise.resolve(fixtures.github.getUser))
  };
  
  // Mock LLM
  const mockLLM = {
    complete: mock((prompt: string) => {
      // Return different responses based on prompt content
      if (prompt.includes('analyze issue')) {
        return Promise.resolve({
          content: JSON.stringify(fixtures.analyzedIssues.simple)
        });
      }
      if (prompt.includes('generate plan')) {
        return Promise.resolve({
          content: JSON.stringify(fixtures.plans.simple)
        });
      }
      if (prompt.includes('parse review')) {
        return Promise.resolve({
          content: JSON.stringify(fixtures.parsedReviews.simple)
        });
      }
      return Promise.resolve({ content: 'Mock response' });
    })
  };
  
  beforeEach(async () => {
    // Create temp directory for test data
    tempDir = await mkdtemp(path.join(tmpdir(), 'agent-test-'));
    
    // Initialize components
    stateManager = new StateManager({
      databasePath: path.join(tempDir, 'test.db')
    });
    await stateManager.initialize();
    
    workflowEngine = new WorkflowEngine(stateManager);
    
    // Create agent with mocked dependencies
    agent = new GitHubAgent({
      stateManager,
      workflowEngine,
      github: mockGitHub as any,
      llm: mockLLM as any,
      workspacePath: tempDir
    });
    
    await agent.initialize();
  });
  
  afterEach(async () => {
    await agent.cleanup();
    await stateManager.close();
    
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  
  describe('Issue Implementation Flow', () => {
    it('should implement a simple issue end-to-end', async () => {
      // 1. Receive implement command
      const command = '@bot implement #123';
      const result = await agent.handleCommand(command, {
        user: 'testuser',
        source: 'issue_comment'
      });
      
      expect(result.success).toBe(true);
      expect(result.workflowId).toBeDefined();
      
      // 2. Verify workflow was created
      const workflow = await stateManager.getWorkflow(result.workflowId!);
      expect(workflow).toBeDefined();
      expect(workflow?.type).toBe('issue_implementation');
      expect(workflow?.status).toBe('completed');
      
      // 3. Verify issue was analyzed
      expect(mockLLM.complete).toHaveBeenCalledWith(
        expect.stringContaining('analyze issue')
      );
      
      // 4. Verify plan was generated
      expect(mockLLM.complete).toHaveBeenCalledWith(
        expect.stringContaining('generate plan')
      );
      
      // 5. Verify PR was created
      expect(mockGitHub.createPR).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('#123'),
          body: expect.stringContaining('Requirements')
        })
      );
      
      // 6. Verify state was persisted
      const issue = await stateManager.getIssue(123);
      expect(issue).toBeDefined();
      expect(issue?.status).toBe('implementing');
      
      const pr = await stateManager.getPR(124);
      expect(pr).toBeDefined();
      expect(pr?.issueNumber).toBe(123);
    });
    
    it('should handle complex issues with references', async () => {
      mockGitHub.getIssue.mockResolvedValueOnce(fixtures.issues.complex);
      
      const result = await agent.handleCommand('@bot implement #456', {
        user: 'leaddev',
        source: 'issue_comment'
      });
      
      expect(result.success).toBe(true);
      
      // Verify references were extracted
      const analysis = await stateManager.getAnalysis(456);
      expect(analysis?.references.issues).toContain(234);
      expect(analysis?.references.issues).toContain(345);
      expect(analysis?.references.prs).toContain(400);
      
      // Verify complexity was assessed
      expect(analysis?.complexity.score).toBeGreaterThan(0.5);
    });
  });
  
  describe('Review Handling Flow', () => {
    beforeEach(async () => {
      // Set up existing PR state
      await stateManager.savePR({
        number: 124,
        issueNumber: 123,
        title: 'Implement user authentication (#123)',
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date()
      });
    });
    
    it('should handle review comments and apply changes', async () => {
      const result = await agent.handleReviewComments(124);
      
      expect(result.success).toBe(true);
      expect(result.changesApplied).toBe(1);
      expect(result.responsesPosted).toBe(1);
      
      // Verify review was parsed
      expect(mockLLM.complete).toHaveBeenCalledWith(
        expect.stringContaining('parse review')
      );
      
      // Verify changes were committed
      const commits = await stateManager.getCommits(124);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits[0].message).toContain('review feedback');
      
      // Verify response was posted
      expect(mockGitHub.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('added error handling')
        })
      );
    });
    
    it('should handle code suggestions', async () => {
      mockGitHub.getReviewComments.mockResolvedValueOnce(
        fixtures.reviews.complex
      );
      
      const result = await agent.handleReviewComments(124);
      
      expect(result.success).toBe(true);
      expect(result.changesApplied).toBeGreaterThan(1);
      
      // Verify suggestion was applied
      const commits = await stateManager.getCommits(124);
      const suggestionCommit = commits.find(c => 
        c.message.includes('suggestion')
      );
      expect(suggestionCommit).toBeDefined();
    });
  });
  
  describe('Batch Operations', () => {
    it('should handle multiple issues in batch', async () => {
      const issues = [123, 456, 789];
      
      const result = await agent.batchImplement(issues, {
        parallel: true,
        maxConcurrent: 2
      });
      
      expect(result.success).toBe(true);
      expect(result.completed).toBe(3);
      expect(result.failed).toBe(0);
      
      // Verify workflows were created
      for (const issueNumber of issues) {
        const workflows = await stateManager.getWorkflowsByIssue(issueNumber);
        expect(workflows.length).toBe(1);
      }
      
      // Verify parallelism was respected
      const events = await stateManager.getEvents({
        type: 'workflow_started'
      });
      
      // Check that no more than 2 workflows ran simultaneously
      const overlaps = countOverlappingTimeRanges(
        events.map(e => ({
          start: e.timestamp,
          end: new Date(e.timestamp.getTime() + 60000) // Assume 1 min
        }))
      );
      expect(overlaps).toBeLessThanOrEqual(2);
    });
  });
  
  describe('Learning System Integration', () => {
    let learningPipeline: LearningPipeline;
    
    beforeEach(async () => {
      learningPipeline = new LearningPipeline({
        storagePath: path.join(tempDir, 'learning')
      });
      
      agent.setLearningPipeline(learningPipeline);
    });
    
    it('should learn from successful implementations', async () => {
      // Implement several issues
      for (let i = 1; i <= 5; i++) {
        await agent.handleCommand(`@bot implement #${100 + i}`, {
          user: 'testuser',
          source: 'issue_comment'
        });
      }
      
      // Get insights
      const insights = learningPipeline.getInsights();
      
      expect(insights.insights.length).toBeGreaterThan(0);
      
      // Verify patterns were detected
      const patternInsight = insights.insights.find(i => 
        i.type === 'pattern'
      );
      expect(patternInsight).toBeDefined();
      
      // Verify preferences were tracked
      const prefInsight = insights.insights.find(i => 
        i.type === 'preferences'
      );
      expect(prefInsight).toBeDefined();
    });
    
    it('should enhance decisions based on learning', async () => {
      // Train the model with some events
      await trainModelWithSampleEvents(learningPipeline);
      
      // Make a decision
      const decision = await agent.makeImplementationDecision(123);
      
      expect(decision.enhanced).toBeDefined();
      expect(decision.recommendations.length).toBeGreaterThan(0);
      expect(decision.confidence).toBeGreaterThan(0.5);
    });
  });
  
  describe('Error Handling and Recovery', () => {
    it('should recover from API failures', async () => {
      // Simulate API failure then success
      mockGitHub.createPR
        .mockRejectedValueOnce(new Error('API rate limit'))
        .mockResolvedValueOnce(fixtures.github.createPR);
      
      const result = await agent.handleCommand('@bot implement #123', {
        user: 'testuser',
        source: 'issue_comment'
      });
      
      expect(result.success).toBe(true);
      expect(result.retries).toBe(1);
      
      // Verify retry was logged
      const events = await stateManager.getEvents({
        type: 'api_retry'
      });
      expect(events.length).toBe(1);
    });
    
    it('should handle workflow failures gracefully', async () => {
      // Simulate LLM failure
      mockLLM.complete.mockRejectedValueOnce(
        new Error('LLM service unavailable')
      );
      
      const result = await agent.handleCommand('@bot implement #123', {
        user: 'testuser',
        source: 'issue_comment'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('service unavailable');
      
      // Verify workflow was marked as failed
      const workflow = await stateManager.getWorkflow(result.workflowId!);
      expect(workflow?.status).toBe('failed');
      
      // Verify error notification was sent
      expect(mockGitHub.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('encountered an error')
        })
      );
    });
  });
  
  describe('Context Gathering', () => {
    it('should gather relevant context for implementation', async () => {
      // Create some test files
      await fs.mkdir(path.join(tempDir, 'src', 'auth'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'src', 'auth', 'existing.ts'),
        'export function existingAuth() { return true; }'
      );
      
      const result = await agent.handleCommand('@bot implement #123', {
        user: 'testuser',
        source: 'issue_comment'
      });
      
      expect(result.success).toBe(true);
      
      // Verify context was gathered
      const plan = await stateManager.getPlan(123);
      expect(plan?.context.relatedFiles).toContain('src/auth/existing.ts');
    });
  });
});

// Helper function to count overlapping time ranges
function countOverlappingTimeRanges(
  ranges: Array<{ start: Date; end: Date }>
): number {
  let maxOverlap = 0;
  
  const events = [];
  for (const range of ranges) {
    events.push({ time: range.start, type: 'start' });
    events.push({ time: range.end, type: 'end' });
  }
  
  events.sort((a, b) => a.time.getTime() - b.time.getTime());
  
  let currentOverlap = 0;
  for (const event of events) {
    if (event.type === 'start') {
      currentOverlap++;
      maxOverlap = Math.max(maxOverlap, currentOverlap);
    } else {
      currentOverlap--;
    }
  }
  
  return maxOverlap;
}

// Helper to train model with sample events
async function trainModelWithSampleEvents(pipeline: LearningPipeline) {
  const sampleEvents = [
    {
      id: 'evt-1',
      type: 'code_generation',
      timestamp: new Date(),
      context: { generatedCode: fixtures.files['src/auth/jwt.ts'] },
      action: { 
        id: 'act-1',
        type: 'generate_code',
        target: 'auth',
        parameters: {},
        timestamp: new Date()
      },
      outcome: { success: true, duration: 1000 },
      feedback: { 
        id: 'fb-1',
        eventId: 'evt-1',
        userId: 'user1',
        sentiment: 'positive',
        timestamp: new Date()
      }
    }
  ];
  
  for (const event of sampleEvents) {
    await pipeline.learn(event as any);
  }
}