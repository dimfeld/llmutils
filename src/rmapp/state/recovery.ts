import { StateStore } from './store.js';
import type { Workflow } from './models.js';
import { trace } from '@opentelemetry/api';

export interface RecoveryOptions {
  maxAge?: number; // Maximum age in hours for workflows to recover
  dryRun?: boolean; // Don't actually modify anything
}

export class WorkflowRecovery {
  constructor(private store: StateStore) {}

  async recoverInterruptedWorkflows(options: RecoveryOptions = {}): Promise<void> {
    const { maxAge = 24, dryRun = false } = options;
    const span = trace.getActiveSpan();

    span?.addEvent('workflow_recovery_started', {
      maxAge,
      dryRun,
    });

    try {
      // Get all active workflows
      const activeWorkflows = await this.store.listActiveWorkflows();
      const now = Date.now();
      const maxAgeMs = maxAge * 60 * 60 * 1000;

      let recoveredCount = 0;
      let failedCount = 0;

      for (const workflow of activeWorkflows) {
        const age = now - workflow.updatedAt.getTime();

        if (age > maxAgeMs) {
          // Workflow is too old, mark as failed
          if (!dryRun) {
            await this.store.updateWorkflow(workflow.id, {
              status: 'failed',
              error: 'Workflow timed out',
            });

            // Clean up associated workspace
            const workspace = await this.store.getWorkspaceByWorkflow(workflow.id);
            if (workspace && workspace.status === 'active') {
              await this.store.updateWorkspaceStatus(workspace.id, 'failed');
            }
          }

          failedCount++;
          span?.addEvent('workflow_timed_out', {
            workflowId: workflow.id,
            type: workflow.type,
            age: Math.floor(age / 1000 / 60), // minutes
          });
        } else {
          // Attempt to recover workflow
          const recovered = await this.recoverWorkflow(workflow, dryRun);
          if (recovered) {
            recoveredCount++;
          }
        }
      }

      // Clean up zombie workspaces
      if (!dryRun) {
        const cleanedWorkspaces = await this.store.cleanupZombieWorkspaces();
        span?.addEvent('zombie_workspaces_cleaned', {
          count: cleanedWorkspaces,
        });
      }

      span?.addEvent('workflow_recovery_completed', {
        recoveredCount,
        failedCount,
        totalProcessed: activeWorkflows.length,
      });

      console.log(`Recovery complete: ${recoveredCount} recovered, ${failedCount} failed`);
    } catch (error) {
      span?.recordException(error as Error);
      throw error;
    }
  }

  private async recoverWorkflow(workflow: Workflow, dryRun: boolean): Promise<boolean> {
    const span = trace.getActiveSpan();

    try {
      span?.addEvent('recovering_workflow', {
        workflowId: workflow.id,
        type: workflow.type,
        status: workflow.status,
      });

      // Check if workflow has a workspace
      const workspace = await this.store.getWorkspaceByWorkflow(workflow.id);

      if (workflow.status === 'in_progress') {
        // Workflow was actively running
        if (workspace && workspace.status === 'active') {
          // We can potentially resume this workflow
          console.log(`Workflow ${workflow.id} can potentially be resumed`);

          // For now, we'll just log it. In a real implementation,
          // we would check the state and determine if we can continue
          // or need to restart from a checkpoint.
          return true;
        } else {
          // No active workspace, mark as failed
          if (!dryRun) {
            await this.store.updateWorkflow(workflow.id, {
              status: 'failed',
              error: 'Workflow interrupted without active workspace',
            });
          }
          return false;
        }
      } else if (workflow.status === 'pending') {
        // Workflow never started, we can leave it as is
        // It will be picked up by the next run
        console.log(`Workflow ${workflow.id} is pending and can be started`);
        return true;
      }

      return false;
    } catch (error) {
      span?.recordException(error as Error);
      console.error(`Failed to recover workflow ${workflow.id}:`, error);
      return false;
    }
  }

  async getRecoveryStatus(): Promise<{
    activeWorkflows: number;
    staleWorkflows: number;
    zombieWorkspaces: number;
  }> {
    const activeWorkflows = await this.store.listActiveWorkflows();
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

    const staleWorkflows = activeWorkflows.filter(
      (w) => now - w.updatedAt.getTime() > maxAgeMs
    ).length;

    // Count zombie workspaces (this is a simplified check)
    // In a real implementation, we'd have a more sophisticated query
    const zombieWorkspaces = 0; // Would need to implement a method in store

    return {
      activeWorkflows: activeWorkflows.length,
      staleWorkflows,
      zombieWorkspaces,
    };
  }
}
