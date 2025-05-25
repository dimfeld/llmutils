import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { WorkflowEngine } from '../../workflows/engine.js';
import { StateManager } from '../../state/manager.js';
import { IssueAnalyzer } from '../../analysis/issue_analyzer.js';
import { PlanGenerator } from '../../planning/plan_generator.js';
import { PRCreator } from '../../pr/pr_creator.js';
import { fixtures } from '../fixtures.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('Workflow Integration Tests', () => {
  let tempDir: string;
  let workflowEngine: WorkflowEngine;
  let stateManager: StateManager;
  
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'workflow-test-'));
    
    stateManager = new StateManager({
      databasePath: path.join(tempDir, 'test.db')
    });
    await stateManager.initialize();
    
    workflowEngine = new WorkflowEngine(stateManager);
  });
  
  afterEach(async () => {
    await stateManager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  
  describe('Issue Implementation Workflow', () => {
    it('should execute complete issue implementation workflow', async () => {
      // Create workflow
      const workflow = await workflowEngine.createWorkflow({
        type: 'issue_implementation',
        trigger: {
          type: 'command',
          source: 'issue_comment',
          user: 'testuser'
        },
        context: {
          issueNumber: 123,
          repository: 'test/repo'
        }
      });
      
      expect(workflow.id).toBeDefined();
      expect(workflow.status).toBe('pending');
      
      // Execute workflow
      const result = await workflowEngine.executeWorkflow(workflow.id);
      
      expect(result.success).toBe(true);
      expect(result.steps.length).toBeGreaterThan(0);
      
      // Verify steps were executed in order
      const expectedSteps = [
        'fetch_issue',
        'analyze_issue',
        'generate_plan',
        'create_branch',
        'implement_changes',
        'create_pr'
      ];
      
      for (let i = 0; i < expectedSteps.length; i++) {
        expect(result.steps[i].name).toBe(expectedSteps[i]);
        expect(result.steps[i].status).toBe('completed');
      }
      
      // Verify workflow state was updated
      const updatedWorkflow = await stateManager.getWorkflow(workflow.id);
      expect(updatedWorkflow?.status).toBe('completed');
      expect(updatedWorkflow?.completedAt).toBeDefined();
    });
    
    it('should handle step failures and retry', async () => {
      // Configure step to fail first time
      let attemptCount = 0;
      workflowEngine.registerStepHandler('generate_plan', async (context) => {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error('Temporary failure');
        }
        return { plan: fixtures.plans.simple };
      });
      
      const workflow = await workflowEngine.createWorkflow({
        type: 'issue_implementation',
        context: { issueNumber: 123 }
      });
      
      const result = await workflowEngine.executeWorkflow(workflow.id);
      
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(2);
      
      // Verify retry was logged
      const events = await stateManager.getEvents({
        workflowId: workflow.id,
        type: 'step_retry'
      });
      expect(events.length).toBe(1);
    });
    
    it('should support workflow pause and resume', async () => {
      const workflow = await workflowEngine.createWorkflow({
        type: 'issue_implementation',
        context: { issueNumber: 123 }
      });
      
      // Start workflow
      const executePromise = workflowEngine.executeWorkflow(workflow.id);
      
      // Pause after first step
      await new Promise(resolve => setTimeout(resolve, 100));
      await workflowEngine.pauseWorkflow(workflow.id);
      
      // Verify workflow is paused
      const pausedWorkflow = await stateManager.getWorkflow(workflow.id);
      expect(pausedWorkflow?.status).toBe('paused');
      
      // Resume workflow
      await workflowEngine.resumeWorkflow(workflow.id);
      
      // Wait for completion
      const result = await executePromise;
      expect(result.success).toBe(true);
      
      // Verify all steps completed
      const finalWorkflow = await stateManager.getWorkflow(workflow.id);
      expect(finalWorkflow?.status).toBe('completed');
    });
  });
  
  describe('Review Response Workflow', () => {
    beforeEach(async () => {
      // Set up PR state
      await stateManager.savePR({
        number: 124,
        issueNumber: 123,
        title: 'Test PR',
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date()
      });
    });
    
    it('should execute review response workflow', async () => {
      const workflow = await workflowEngine.createWorkflow({
        type: 'review_response',
        context: {
          prNumber: 124,
          repository: 'test/repo'
        }
      });
      
      const result = await workflowEngine.executeWorkflow(workflow.id);
      
      expect(result.success).toBe(true);
      
      // Verify review was processed
      const review = await stateManager.getReview(124);
      expect(review).toBeDefined();
      expect(review?.status).toBe('addressed');
    });
  });
  
  describe('Workflow Concurrency', () => {
    it('should handle concurrent workflows', async () => {
      const workflowIds: string[] = [];
      
      // Create multiple workflows
      for (let i = 0; i < 5; i++) {
        const workflow = await workflowEngine.createWorkflow({
          type: 'issue_implementation',
          context: { issueNumber: 100 + i }
        });
        workflowIds.push(workflow.id);
      }
      
      // Execute all workflows concurrently
      const results = await Promise.all(
        workflowIds.map(id => workflowEngine.executeWorkflow(id))
      );
      
      // Verify all succeeded
      expect(results.every(r => r.success)).toBe(true);
      
      // Verify no data corruption
      for (let i = 0; i < workflowIds.length; i++) {
        const workflow = await stateManager.getWorkflow(workflowIds[i]);
        expect(workflow?.context.issueNumber).toBe(100 + i);
      }
    });
    
    it('should respect concurrency limits', async () => {
      workflowEngine.setConcurrencyLimit(2);
      
      const startTimes: Date[] = [];
      workflowEngine.registerStepHandler('test_step', async () => {
        startTimes.push(new Date());
        await new Promise(resolve => setTimeout(resolve, 100));
        return {};
      });
      
      // Create and execute workflows
      const promises = [];
      for (let i = 0; i < 4; i++) {
        const workflow = await workflowEngine.createWorkflow({
          type: 'test',
          context: { index: i }
        });
        promises.push(workflowEngine.executeWorkflow(workflow.id));
      }
      
      await Promise.all(promises);
      
      // Verify max 2 workflows ran concurrently
      const concurrentStarts = analyzeConcurrency(startTimes);
      expect(concurrentStarts).toBeLessThanOrEqual(2);
    });
  });
  
  describe('Workflow State Persistence', () => {
    it('should persist workflow state across restarts', async () => {
      // Create and partially execute workflow
      const workflow = await workflowEngine.createWorkflow({
        type: 'issue_implementation',
        context: { issueNumber: 123 }
      });
      
      // Simulate engine restart
      workflowEngine = new WorkflowEngine(stateManager);
      
      // Resume workflow
      const result = await workflowEngine.executeWorkflow(workflow.id);
      expect(result.success).toBe(true);
      
      // Verify state was preserved
      const finalWorkflow = await stateManager.getWorkflow(workflow.id);
      expect(finalWorkflow?.status).toBe('completed');
    });
  });
});

// Helper to analyze concurrency
function analyzeConcurrency(timestamps: Date[]): number {
  if (timestamps.length === 0) return 0;
  
  timestamps.sort((a, b) => a.getTime() - b.getTime());
  let maxConcurrent = 1;
  
  for (let i = 0; i < timestamps.length; i++) {
    let concurrent = 1;
    const start = timestamps[i].getTime();
    
    for (let j = i + 1; j < timestamps.length; j++) {
      // If next task started within 50ms, consider concurrent
      if (timestamps[j].getTime() - start < 50) {
        concurrent++;
      } else {
        break;
      }
    }
    
    maxConcurrent = Math.max(maxConcurrent, concurrent);
  }
  
  return maxConcurrent;
}