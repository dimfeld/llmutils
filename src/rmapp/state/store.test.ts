import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateStore } from './store.js';
import type { IssueWorkflow, PRReviewWorkflow } from './models.js';

describe('StateStore', () => {
  let tempDir: string;
  let store: StateStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rmapp-state-test-'));
    store = new StateStore(join(tempDir, 'test.db'));
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tempDir, { recursive: true });
  });

  describe('workflow operations', () => {
    it('should create an issue workflow', async () => {
      const metadata: Partial<IssueWorkflow> = {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test issue',
        metadata: { test: true },
      };

      const id = await store.createWorkflow('issue', metadata);
      expect(id).toBeTruthy();

      const workflow = await store.getWorkflow(id);
      expect(workflow).toBeTruthy();
      expect(workflow?.type).toBe('issue');
      expect(workflow?.status).toBe('pending');
      expect((workflow as IssueWorkflow).issueNumber).toBe(123);
    });

    it('should create a PR review workflow', async () => {
      const metadata: Partial<PRReviewWorkflow> = {
        repository: { owner: 'test', name: 'repo' },
        prNumber: 456,
        prTitle: 'Test PR',
      };

      const id = await store.createWorkflow('pr_review', metadata);
      const workflow = (await store.getWorkflow(id)) as PRReviewWorkflow;

      expect(workflow).toBeTruthy();
      expect(workflow.type).toBe('pr_review');
      expect(workflow.prNumber).toBe(456);
      expect(workflow.reviewComments).toEqual([]);
    });

    it('should update workflow status', async () => {
      const id = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      await store.updateWorkflow(id, { status: 'in_progress' });

      const workflow = await store.getWorkflow(id);
      expect(workflow?.status).toBe('in_progress');
    });

    it('should list active workflows', async () => {
      // Create some workflows
      const id1 = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 1,
        issueTitle: 'Test 1',
      });

      const id2 = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 2,
        issueTitle: 'Test 2',
      });

      // Complete one
      await store.updateWorkflow(id2, { status: 'completed' });

      const active = await store.listActiveWorkflows();
      expect(active.length).toBe(1);
      expect(active[0].id).toBe(id1);
    });
  });

  describe('issue workflow operations', () => {
    it('should update issue workflow steps', async () => {
      const id = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      await store.updateIssueWorkflowStep(id, 'analyzed', true);
      await store.updateIssueWorkflowStep(id, 'planGenerated', true);

      const workflow = (await store.getWorkflow(id)) as IssueWorkflow;
      expect(workflow.steps.analyzed).toBe(true);
      expect(workflow.steps.planGenerated).toBe(true);
      expect(workflow.steps.implemented).toBe(false);
    });

    it('should update issue workflow data', async () => {
      const id = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      await store.updateIssueWorkflowData(id, {
        planPath: '/path/to/plan.yml',
        branchName: 'feature/test-123',
        workspaceId: 'workspace-123',
      });

      const workflow = (await store.getWorkflow(id)) as IssueWorkflow;
      expect(workflow.planPath).toBe('/path/to/plan.yml');
      expect(workflow.branchName).toBe('feature/test-123');
      expect(workflow.workspaceId).toBe('workspace-123');
    });
  });

  describe('PR review workflow operations', () => {
    it('should add and update review comments', async () => {
      const id = await store.createWorkflow('pr_review', {
        repository: { owner: 'test', name: 'repo' },
        prNumber: 456,
        prTitle: 'Test PR',
      });

      await store.addReviewComment(id, {
        id: 1,
        body: 'Please add error handling',
        path: 'src/index.ts',
        line: 42,
        action: 'change_requested',
      });

      const workflow = (await store.getWorkflow(id)) as PRReviewWorkflow;
      expect(workflow.reviewComments.length).toBe(1);
      expect(workflow.reviewComments[0].body).toBe('Please add error handling');

      // Update the comment
      await store.updateReviewComment(1, {
        resolved: true,
        response: 'Added error handling',
      });

      const updated = (await store.getWorkflow(id)) as PRReviewWorkflow;
      expect(updated.reviewComments[0].resolved).toBe(true);
      expect(updated.reviewComments[0].response).toBe('Added error handling');
    });
  });

  describe('workspace operations', () => {
    it('should create and update workspace', async () => {
      const workflowId = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      await store.createWorkspace({
        id: 'ws-123',
        path: '/tmp/workspace',
        workflowId,
        status: 'active',
      });

      const workspace = await store.getWorkspaceByWorkflow(workflowId);
      expect(workspace).toBeTruthy();
      expect(workspace?.id).toBe('ws-123');
      expect(workspace?.status).toBe('active');

      await store.updateWorkspaceStatus('ws-123', 'completed');
      const updated = await store.getWorkspaceByWorkflow(workflowId);
      expect(updated?.status).toBe('completed');
    });
  });

  describe('command execution tracking', () => {
    it('should record and update command execution', async () => {
      const workflowId = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      const commandId = await store.recordCommand({
        workflowId,
        command: 'rmplan',
        args: ['generate'],
        options: { verbose: true },
        status: 'running',
      });

      expect(commandId).toBeTruthy();

      await store.updateCommand(commandId, {
        status: 'completed',
        output: 'Plan generated successfully',
      });

      // Verify through events
      const events = await store.getWorkflowEvents(workflowId);
      const commandEvent = events.find((e) => e.type === 'command_executed');
      expect(commandEvent).toBeTruthy();
      expect(commandEvent?.payload.command).toBe('rmplan');
    });
  });

  describe('transaction support', () => {
    it('should rollback on error', async () => {
      const workflowId = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      // Use the raw database transaction to test rollback
      const db = (store as any).db;

      try {
        const tx = db.transaction(() => {
          db.prepare('UPDATE workflows SET status = ? WHERE id = ?').run('in_progress', workflowId);
          throw new Error('Test error');
        });
        tx();
      } catch (e) {
        // Expected
      }

      // Status should not have changed
      const workflow = await store.getWorkflow(workflowId);
      expect(workflow?.status).toBe('pending');
    });
  });

  describe('cleanup operations', () => {
    it('should archive completed workflows', async () => {
      // First clean up any existing completed workflows
      const future = new Date();
      future.setDate(future.getDate() + 1);
      await store.archiveCompletedWorkflows(future);

      const id1 = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 1,
        issueTitle: 'Test 1',
      });

      const id2 = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 2,
        issueTitle: 'Test 2',
      });

      await store.updateWorkflow(id1, { status: 'completed' });
      await store.updateWorkflow(id2, { status: 'failed' });

      // Use a date in the future to ensure workflows are archived
      const archived = await store.archiveCompletedWorkflows(future);
      expect(archived).toBeGreaterThanOrEqual(2);

      const remaining = await store.listActiveWorkflows();
      expect(remaining.length).toBe(0);
    });

    it('should cleanup zombie workspaces', async () => {
      // Get the initial count of zombie workspaces
      const initialCleaned = await store.cleanupZombieWorkspaces();

      const workflowId = await store.createWorkflow('issue', {
        repository: { owner: 'test', name: 'repo' },
        issueNumber: 123,
        issueTitle: 'Test',
      });

      await store.createWorkspace({
        id: 'ws-zombie-test',
        path: '/tmp/workspace',
        workflowId,
        status: 'active',
      });

      await store.updateWorkflow(workflowId, { status: 'failed' });

      const cleaned = await store.cleanupZombieWorkspaces();
      expect(cleaned).toBeGreaterThan(0);

      const workspace = await store.getWorkspaceByWorkflow(workflowId);
      expect(workspace?.status).toBe('failed');
    });
  });
});
