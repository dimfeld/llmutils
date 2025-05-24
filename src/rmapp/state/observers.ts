import type { Octokit } from 'octokit';
import type { Workflow, WorkflowEvent } from './models.js';
import { StateStore } from './store.js';

export type StateObserver = (event: WorkflowEvent, workflow: Workflow) => Promise<void>;

export class StateObserverManager {
  private observers: Map<WorkflowEvent['type'], StateObserver[]> = new Map();
  private pollInterval: Timer | null = null;
  private lastEventId: string | null = null;

  constructor(
    private store: StateStore,
    private octokit?: Octokit
  ) {}

  on(eventType: WorkflowEvent['type'], observer: StateObserver): void {
    const observers = this.observers.get(eventType) || [];
    observers.push(observer);
    this.observers.set(eventType, observers);
  }

  off(eventType: WorkflowEvent['type'], observer: StateObserver): void {
    const observers = this.observers.get(eventType) || [];
    const index = observers.indexOf(observer);
    if (index >= 0) {
      observers.splice(index, 1);
    }
  }

  start(intervalMs: number = 5000): void {
    if (this.pollInterval) {
      this.stop();
    }

    this.pollInterval = setInterval(() => {
      this.pollEvents().catch(error => {
        console.error('Error polling events:', error);
      });
    }, intervalMs);

    // Run immediately
    this.pollEvents().catch(error => {
      console.error('Error in initial poll:', error);
    });
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollEvents(): Promise<void> {
    try {
      // Get all active workflows
      const workflows = await this.store.listActiveWorkflows();

      for (const workflow of workflows) {
        // Get recent events for this workflow
        const events = await this.store.getWorkflowEvents(workflow.id, 10);

        // Process new events
        for (const event of events.reverse()) {
          if (this.lastEventId && event.id <= this.lastEventId) {
            continue;
          }

          await this.notifyObservers(event, workflow);
          this.lastEventId = event.id;
        }
      }
    } catch (error) {
      console.error('Error polling events:', error);
    }
  }

  private async notifyObservers(event: WorkflowEvent, workflow: Workflow): Promise<void> {
    const observers = this.observers.get(event.type) || [];

    for (const observer of observers) {
      try {
        await observer(event, workflow);
      } catch (error) {
        console.error(`Observer error for event ${event.type}:`, error);
      }
    }
  }

  // Built-in observers
  setupDefaultObservers(): void {
    // Post status updates to GitHub
    if (this.octokit) {
      this.on('status_changed', async (event, workflow) => {
        if (!this.octokit) return;

        const status = event.payload.status;
        const message = this.getStatusMessage(workflow, status);

        try {
          if (workflow.type === 'issue') {
            const issueWorkflow = workflow as any;
            await this.octokit.rest.issues.createComment({
              owner: workflow.repository.owner,
              repo: workflow.repository.name,
              issue_number: issueWorkflow.issueNumber,
              body: message,
            });
          } else if (workflow.type === 'pr_review') {
            const prWorkflow = workflow as any;
            await this.octokit.rest.issues.createComment({
              owner: workflow.repository.owner,
              repo: workflow.repository.name,
              issue_number: prWorkflow.prNumber,
              body: message,
            });
          }
        } catch (error) {
          console.error('Failed to post status update:', error);
        }
      });

      // Post step completion updates
      this.on('step_completed', async (event, workflow) => {
        if (!this.octokit) return;

        const { step, completed } = event.payload;
        if (!completed) return;

        const message = this.getStepMessage(workflow, step);
        if (!message) return;

        try {
          if (workflow.type === 'issue') {
            const issueWorkflow = workflow as any;
            await this.octokit.rest.issues.createComment({
              owner: workflow.repository.owner,
              repo: workflow.repository.name,
              issue_number: issueWorkflow.issueNumber,
              body: message,
            });
          }
        } catch (error) {
          console.error('Failed to post step update:', error);
        }
      });
    }

    // Log errors
    this.on('error', async (event, workflow) => {
      console.error(`Workflow ${workflow.id} error:`, event.payload);
    });

    // Clean up on workflow completion
    this.on('status_changed', async (event, workflow) => {
      const status = event.payload.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        // Mark workspace as completed
        const workspace = await this.store.getWorkspaceByWorkflow(workflow.id);
        if (workspace && workspace.status === 'active') {
          await this.store.updateWorkspaceStatus(
            workspace.id,
            status === 'completed' ? 'completed' : 'failed'
          );
        }
      }
    });
  }

  private getStatusMessage(workflow: Workflow, status: string): string {
    const emoji = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
    }[status] || '❓';

    const statusText = status.replace('_', ' ');

    if (workflow.type === 'issue') {
      return `${emoji} Issue implementation ${statusText}`;
    } else if (workflow.type === 'pr_review') {
      return `${emoji} Review response ${statusText}`;
    }

    return `${emoji} Workflow ${statusText}`;
  }

  private getStepMessage(workflow: Workflow, step: string): string | null {
    if (workflow.type === 'issue') {
      const messages: Record<string, string> = {
        analyzed: '📊 Issue analysis complete',
        planGenerated: '📋 Implementation plan generated',
        implemented: '💻 Code implementation complete',
        prCreated: '🎉 Pull request created',
      };
      return messages[step] || null;
    }

    return null;
  }
}