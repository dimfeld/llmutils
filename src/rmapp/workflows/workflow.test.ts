import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { StateMachine } from '../../state_machine/index.js';
import { issueWorkflowConfig } from './issue_workflow.js';
import type { IssueWorkflowContext, WorkflowEvent } from './types.js';
import { StateStore } from '../state/store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Issue Workflow', () => {
  let tempDir: string;
  let store: StateStore;
  let context: IssueWorkflowContext;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-test-'));
    store = new StateStore(join(tempDir, 'test.db'));
    await store.initialize();

    context = {
      workflowId: 'test-workflow',
      octokit: {} as any,
      store,
      webhookEvent: {
        action: 'opened',
        issue: {
          number: 123,
          title: 'Test issue',
          body: 'Test body',
          html_url: 'https://github.com/test/repo/issues/123',
        },
        repository: {
          owner: { login: 'test' },
          name: 'repo',
          clone_url: 'https://github.com/test/repo.git',
        },
      },
      workspaceDir: tempDir,
      artifacts: new Map(),
      issueNumber: 123,
      issueTitle: 'Test issue',
      issueBody: 'Test body',
    };
  });

  afterEach(async () => {
    await store.close();
    rmSync(tempDir, { recursive: true });
  });

  it('should create state machine with correct initial state', async () => {
    const persistence = {
      write: mock(() => Promise.resolve()),
      writeEvents: mock(() => Promise.resolve()),
      read: mock(() => Promise.resolve({})),
    };

    const machine = new StateMachine(issueWorkflowConfig, persistence, context, 'test-instance');

    await machine.initialize();

    // Check initial state
    const initialState = machine.store.getCurrentState();
    expect(initialState).toBe(undefined); // No state until workflow starts

    // Verify state machine is initialized
    expect(machine['initialized']).toBe(true);
  });

  it('should have correct node configuration', () => {
    expect(issueWorkflowConfig.initialState).toBe('analyzing');
    expect(issueWorkflowConfig.errorState).toBe('failed');
    expect(issueWorkflowConfig.nodes).toHaveLength(7);

    const nodeIds = issueWorkflowConfig.nodes.map((node) => node.id);
    expect(nodeIds).toContain('analyzing');
    expect(nodeIds).toContain('planning');
    expect(nodeIds).toContain('implementing');
    expect(nodeIds).toContain('testing');
    expect(nodeIds).toContain('creating_pr');
    expect(nodeIds).toContain('complete');
    expect(nodeIds).toContain('failed');
  });
});
