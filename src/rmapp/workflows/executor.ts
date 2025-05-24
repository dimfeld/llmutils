import type { Octokit } from 'octokit';
import { StateStore } from '../state/store.js';
import type { WebhookEvent } from '../types.js';
import type { IssueWorkflow, PRReviewWorkflow, Workflow } from '../state/models.js';
import { WorkflowRecovery } from '../state/recovery.js';
import { StateObserverManager } from '../state/observers.js';
import { createIssueWorkflow } from './issue_workflow.js';
import type { IssueWorkflowContext, WorkflowEvent } from './types.js';
import { createWorkspace, type Workspace } from '../../rmplan/workspace/workspace_manager.js';
import { getGitRoot } from '../../rmfilter/utils.js';
import { trace } from '@opentelemetry/api';
import { join } from 'path';
import { homedir } from 'os';

export interface WorkflowExecutorConfig {
  dbPath?: string;
  workspacesRoot?: string;
  maxConcurrentWorkflows?: number;
}

export class WorkflowExecutor {
  private store: StateStore;
  private recovery: WorkflowRecovery;
  private observers: StateObserverManager;
  private activeWorkflows: Map<string, any> = new Map();
  private workspacesRoot: string;

  constructor(
    private octokit: Octokit,
    private config: WorkflowExecutorConfig = {}
  ) {
    const dbPath = config.dbPath || join(homedir(), '.rmapp', 'state.db');
    this.store = new StateStore(dbPath);
    this.recovery = new WorkflowRecovery(this.store);
    this.observers = new StateObserverManager(this.store, octokit);

    this.workspacesRoot = config.workspacesRoot || join(homedir(), '.rmapp', 'workspaces');
  }

  async initialize(): Promise<void> {
    await this.store.initialize();

    // Set up default observers
    this.observers.setupDefaultObservers();

    // Start observer polling
    this.observers.start();

    // Recover any interrupted workflows
    await this.recovery.recoverInterruptedWorkflows();
  }

  async shutdown(): Promise<void> {
    this.observers.stop();
    await this.store.close();
  }

  async executeIssue(event: WebhookEvent): Promise<string> {
    const span = trace.getActiveSpan();

    if (!event.issue) {
      throw new Error('No issue in webhook event');
    }

    // Create workflow in database
    const workflowId = await this.store.createWorkflow('issue', {
      repository: {
        owner: event.repository.owner.login,
        name: event.repository.name,
      },
      issueNumber: event.issue.number,
      issueTitle: event.issue.title,
    });

    span?.addEvent('workflow_created', {
      workflowId,
      type: 'issue',
      issueNumber: event.issue.number,
    });

    // Create workspace
    const gitRoot = await getGitRoot();
    const taskId = `issue-${event.issue.number}`;
    const planPath = join(process.cwd(), 'tasks', `${taskId}.yml`);

    const workspace = await createWorkspace(gitRoot, taskId, planPath, {
      workspaceCreation: { cloneLocation: this.workspacesRoot },
    } as any);

    if (!workspace) {
      throw new Error('Failed to create workspace');
    }

    await this.store.createWorkspace({
      id: workspace.taskId,
      path: workspace.path,
      workflowId,
      status: 'active',
    });

    // Create workflow context
    const context: IssueWorkflowContext = {
      workflowId,
      octokit: this.octokit,
      store: this.store,
      webhookEvent: event,
      workspaceDir: workspace.path,
      artifacts: new Map(),
      issueNumber: event.issue.number,
      issueTitle: event.issue.title,
      issueBody: event.issue.body || '',
    };

    // Create state machine persistence
    const persistence = this.createPersistence(workflowId);

    // Create and start workflow
    const workflow = createIssueWorkflow(context, persistence);
    this.activeWorkflows.set(workflowId, workflow);

    // Start workflow execution
    await workflow.initialize();

    // Send start event
    const startEvent: WorkflowEvent = {
      id: `${workflowId}-start`,
      type: 'workflow_start',
      workflowId,
      workflowType: 'issue',
      timestamp: Date.now(),
    };

    // Execute workflow asynchronously
    this.executeWorkflowAsync(workflowId, workflow, [startEvent]).catch((error) => {
      console.error(`Workflow ${workflowId} failed:`, error);
    });

    return workflowId;
  }

  async executePRReview(event: WebhookEvent): Promise<string> {
    // TODO: Implement PR review workflow
    throw new Error('PR review workflow not yet implemented');
  }

  private async executeWorkflowAsync(
    workflowId: string,
    workflow: any,
    events: WorkflowEvent[]
  ): Promise<void> {
    const span = trace.getActiveSpan();

    try {
      await this.store.updateWorkflow(workflowId, { status: 'in_progress' });

      const result = await workflow.handleEvents(events);

      span?.addEvent('workflow_execution_result', {
        workflowId,
        status: result.status,
      });

      if (result.status === 'terminal') {
        this.activeWorkflows.delete(workflowId);
      }
    } catch (error) {
      span?.recordException(error as Error);
      await this.store.updateWorkflow(workflowId, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.activeWorkflows.delete(workflowId);
    }
  }

  async resumeWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.store.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    if (workflow.status !== 'in_progress' && workflow.status !== 'pending') {
      throw new Error(`Workflow ${workflowId} is not resumable (status: ${workflow.status})`);
    }

    // TODO: Reconstruct workflow context and resume
    throw new Error('Workflow resume not yet implemented');
  }

  async cancelWorkflow(workflowId: string, reason: string): Promise<void> {
    const activeWorkflow = this.activeWorkflows.get(workflowId);

    if (activeWorkflow) {
      // Send cancel event
      const cancelEvent: WorkflowEvent = {
        id: `${workflowId}-cancel`,
        type: 'workflow_cancel',
        reason,
        timestamp: Date.now(),
      };

      await activeWorkflow.handleEvents([cancelEvent]);
    }

    await this.store.updateWorkflow(workflowId, {
      status: 'cancelled',
      error: `Cancelled: ${reason}`,
    });

    this.activeWorkflows.delete(workflowId);
  }

  async getWorkflowStatus(workflowId: string): Promise<Workflow | null> {
    return this.store.getWorkflow(workflowId);
  }

  async listActiveWorkflows(): Promise<Workflow[]> {
    return this.store.listActiveWorkflows();
  }

  private createPersistence(workflowId: string) {
    return {
      write: async (state: any) => {
        await this.store.updateWorkflow(workflowId, {
          metadata: { ...state },
        });
      },
      writeEvents: async (events: WorkflowEvent[]) => {
        for (const event of events) {
          await this.store.recordCommand({
            workflowId,
            command: 'event',
            args: [event.type],
            options: event,
            status: 'completed',
          });
        }
      },
      read: async () => {
        const workflow = await this.store.getWorkflow(workflowId);
        return workflow?.metadata || {};
      },
    };
  }
}
