import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type {
  Workflow,
  IssueWorkflow,
  PRReviewWorkflow,
  WorkspaceInfo,
  CommandExecution,
  WorkflowEvent,
  ReviewComment,
} from './models.js';
import { MigrationManager } from './migrations.js';

export interface Transaction {
  commit(): void;
  rollback(): void;
}

export class StateStore {
  private db: Database;
  private migrations: MigrationManager;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database with WAL mode for better concurrency
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    this.migrations = new MigrationManager(this.db);
  }

  async initialize(): Promise<void> {
    await this.migrations.migrate();
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // Workflow operations
  async createWorkflow(
    type: 'issue' | 'pr_review',
    metadata: Partial<IssueWorkflow | PRReviewWorkflow>
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();

    return this.transaction(async () => {
      // Insert base workflow
      const stmt = this.db.prepare(`
        INSERT INTO workflows (id, type, status, repository_owner, repository_name, created_at, updated_at, metadata)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        type,
        metadata.repository!.owner,
        metadata.repository!.name,
        now.toISOString(),
        now.toISOString(),
        JSON.stringify(metadata.metadata || {})
      );

      // Insert type-specific data
      if (type === 'issue' && 'issueNumber' in metadata) {
        const issueStmt = this.db.prepare(`
          INSERT INTO issue_workflows (workflow_id, issue_number, issue_title)
          VALUES (?, ?, ?)
        `);
        issueStmt.run(id, metadata.issueNumber!, metadata.issueTitle!);
      } else if (type === 'pr_review' && 'prNumber' in metadata) {
        const prStmt = this.db.prepare(`
          INSERT INTO pr_review_workflows (workflow_id, pr_number, pr_title)
          VALUES (?, ?, ?)
        `);
        const prMetadata = metadata as Partial<PRReviewWorkflow>;
        prStmt.run(id, prMetadata.prNumber!, prMetadata.prTitle!);
      }

      // Record creation event
      await this.recordEvent(id, 'status_changed', { status: 'pending' });

      return id;
    });
  }

  async updateWorkflow(id: string, updates: Partial<Workflow>): Promise<void> {
    const updateFields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      values.push(updates.status);
    }

    if (updates.metadata !== undefined) {
      updateFields.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }

    if (updates.error !== undefined) {
      updateFields.push('error = ?');
      values.push(updates.error);
    }

    if (updateFields.length === 0) return;

    values.push(id);

    await this.transaction(async () => {
      const stmt = this.db.prepare(`
        UPDATE workflows 
        SET ${updateFields.join(', ')}
        WHERE id = ?
      `);
      stmt.run(...values);

      if (updates.status) {
        await this.recordEvent(id, 'status_changed', { status: updates.status });
      }
    });
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    const baseQuery = this.db.prepare(`
      SELECT * FROM workflows WHERE id = ?
    `);
    const base = baseQuery.get(id) as any;

    if (!base) return null;

    const workflow: Partial<Workflow> = {
      id: base.id,
      type: base.type,
      status: base.status,
      repository: {
        owner: base.repository_owner,
        name: base.repository_name,
      },
      createdAt: new Date(base.created_at),
      updatedAt: new Date(base.updated_at),
      metadata: JSON.parse(base.metadata),
      error: base.error,
    };

    if (base.type === 'issue') {
      const issueQuery = this.db.prepare(`
        SELECT * FROM issue_workflows WHERE workflow_id = ?
      `);
      const issue = issueQuery.get(id) as any;

      if (issue) {
        return {
          ...workflow,
          type: 'issue',
          issueNumber: issue.issue_number,
          issueTitle: issue.issue_title,
          planPath: issue.plan_path,
          workspaceId: issue.workspace_id,
          branchName: issue.branch_name,
          prNumber: issue.pr_number,
          analysis: workflow.metadata?.analysis,
          steps: {
            analyzed: !!issue.analyzed,
            planGenerated: !!issue.plan_generated,
            implemented: !!issue.implemented,
            prCreated: !!issue.pr_created,
          },
        } as IssueWorkflow;
      }
    } else if (base.type === 'pr_review') {
      const prQuery = this.db.prepare(`
        SELECT * FROM pr_review_workflows WHERE workflow_id = ?
      `);
      const pr = prQuery.get(id) as any;

      if (pr) {
        const commentsQuery = this.db.prepare(`
          SELECT * FROM review_comments WHERE workflow_id = ?
        `);
        const comments = commentsQuery.all(id) as any[];

        return {
          ...workflow,
          type: 'pr_review',
          prNumber: pr.pr_number,
          prTitle: pr.pr_title,
          workspaceId: pr.workspace_id,
          reviewComments: comments.map((c) => ({
            id: c.id,
            body: c.body,
            path: c.path,
            line: c.line,
            action: c.action,
            resolved: !!c.resolved,
            response: c.response,
          })),
          steps: {
            commentsParsed: !!pr.comments_parsed,
            changesApplied: !!pr.changes_applied,
            responded: !!pr.responded,
          },
        } as PRReviewWorkflow;
      }
    }

    return workflow as Workflow;
  }

  async listActiveWorkflows(): Promise<Workflow[]> {
    const query = this.db.prepare(`
      SELECT id FROM workflows 
      WHERE status IN ('pending', 'in_progress')
      ORDER BY created_at DESC
    `);
    const ids = query.all() as { id: string }[];

    const workflows = await Promise.all(ids.map(({ id }) => this.getWorkflow(id)));

    return workflows.filter((w) => w !== null) as Workflow[];
  }

  async getWorkflowByIssue(issueNumber: number): Promise<IssueWorkflow | null> {
    const query = this.db.prepare(`
      SELECT w.id FROM workflows w
      JOIN issue_workflows iw ON w.id = iw.workflow_id
      WHERE iw.issue_number = ?
      ORDER BY w.created_at DESC
      LIMIT 1
    `);
    const result = query.get(issueNumber) as { id: string } | undefined;

    if (!result) return null;

    const workflow = await this.getWorkflow(result.id);
    return workflow && workflow.type === 'issue' ? workflow as IssueWorkflow : null;
  }

  async updateWorkflowMetadata(workflowId: string, metadata: Record<string, any>): Promise<void> {
    await this.transaction(async () => {
      // Get current metadata
      const query = this.db.prepare('SELECT metadata FROM workflows WHERE id = ?');
      const result = query.get(workflowId) as { metadata: string | null } | undefined;
      
      if (!result) {
        throw new Error(`Workflow ${workflowId} not found`);
      }

      const currentMetadata = result.metadata ? JSON.parse(result.metadata) : {};
      const updatedMetadata = { ...currentMetadata, ...metadata };

      // Update metadata
      const updateStmt = this.db.prepare(`
        UPDATE workflows 
        SET metadata = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      updateStmt.run(JSON.stringify(updatedMetadata), workflowId);
    });
  }

  // Issue workflow specific operations
  async updateIssueWorkflowStep(
    workflowId: string,
    step: keyof IssueWorkflow['steps'],
    value: boolean
  ): Promise<void> {
    const columnMap: Record<keyof IssueWorkflow['steps'], string> = {
      analyzed: 'analyzed',
      planGenerated: 'plan_generated',
      implemented: 'implemented',
      prCreated: 'pr_created',
    };

    const column = columnMap[step];
    if (!column) throw new Error(`Invalid step: ${step}`);

    await this.transaction(async () => {
      const stmt = this.db.prepare(`
        UPDATE issue_workflows SET ${column} = ? WHERE workflow_id = ?
      `);
      stmt.run(value ? 1 : 0, workflowId);

      await this.recordEvent(workflowId, 'step_completed', { step, completed: value });
    });
  }

  async updateIssueWorkflowData(
    workflowId: string,
    data: Partial<Pick<IssueWorkflow, 'planPath' | 'workspaceId' | 'branchName' | 'prNumber'>>
  ): Promise<void> {
    const updateFields = [];
    const values = [];

    if (data.planPath !== undefined) {
      updateFields.push('plan_path = ?');
      values.push(data.planPath);
    }

    if (data.workspaceId !== undefined) {
      updateFields.push('workspace_id = ?');
      values.push(data.workspaceId);
    }

    if (data.branchName !== undefined) {
      updateFields.push('branch_name = ?');
      values.push(data.branchName);
    }

    if (data.prNumber !== undefined) {
      updateFields.push('pr_number = ?');
      values.push(data.prNumber);
    }

    if (updateFields.length === 0) return;

    values.push(workflowId);

    const stmt = this.db.prepare(`
      UPDATE issue_workflows 
      SET ${updateFields.join(', ')}
      WHERE workflow_id = ?
    `);
    stmt.run(...values);
  }

  // PR Review workflow specific operations
  async updatePRReviewWorkflowStep(
    workflowId: string,
    step: keyof PRReviewWorkflow['steps'],
    value: boolean
  ): Promise<void> {
    const columnMap: Record<keyof PRReviewWorkflow['steps'], string> = {
      commentsParsed: 'comments_parsed',
      changesApplied: 'changes_applied',
      responded: 'responded',
    };

    const column = columnMap[step];
    if (!column) throw new Error(`Invalid step: ${step}`);

    await this.transaction(async () => {
      const stmt = this.db.prepare(`
        UPDATE pr_review_workflows SET ${column} = ? WHERE workflow_id = ?
      `);
      stmt.run(value ? 1 : 0, workflowId);

      await this.recordEvent(workflowId, 'step_completed', { step, completed: value });
    });
  }

  async addReviewComment(
    workflowId: string,
    comment: Omit<ReviewComment, 'resolved' | 'response'>
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO review_comments (id, workflow_id, body, path, line, action)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      comment.id,
      workflowId,
      comment.body,
      comment.path || null,
      comment.line || null,
      comment.action
    );
  }

  async updateReviewComment(
    commentId: number,
    updates: Pick<ReviewComment, 'resolved' | 'response'>
  ): Promise<void> {
    const updateFields = [];
    const values = [];

    if (updates.resolved !== undefined) {
      updateFields.push('resolved = ?');
      values.push(updates.resolved ? 1 : 0);
    }

    if (updates.response !== undefined) {
      updateFields.push('response = ?');
      values.push(updates.response);
    }

    if (updateFields.length === 0) return;

    values.push(commentId);

    const stmt = this.db.prepare(`
      UPDATE review_comments 
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);
  }

  // Workspace operations
  async createWorkspace(workspace: Omit<WorkspaceInfo, 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = new Date();
    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, path, workflow_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      workspace.id,
      workspace.path,
      workspace.workflowId,
      workspace.status,
      now.toISOString(),
      now.toISOString()
    );
  }

  async updateWorkspaceStatus(id: string, status: WorkspaceInfo['status']): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE workspaces SET status = ? WHERE id = ?
    `);
    stmt.run(status, id);
  }

  async getWorkspaceByWorkflow(workflowId: string): Promise<WorkspaceInfo | null> {
    const query = this.db.prepare(`
      SELECT * FROM workspaces WHERE workflow_id = ?
    `);
    const result = query.get(workflowId) as any;

    if (!result) return null;

    return {
      id: result.id,
      path: result.path,
      workflowId: result.workflow_id,
      status: result.status,
      createdAt: new Date(result.created_at),
      updatedAt: new Date(result.updated_at),
    };
  }

  // Command execution tracking
  async recordCommand(
    command: Omit<CommandExecution, 'id' | 'startedAt' | 'completedAt'>
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();

    const stmt = this.db.prepare(`
      INSERT INTO command_executions (id, workflow_id, command, args, options, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      command.workflowId,
      command.command,
      JSON.stringify(command.args),
      JSON.stringify(command.options),
      command.status,
      now.toISOString()
    );

    await this.recordEvent(command.workflowId, 'command_executed', {
      commandId: id,
      command: command.command,
      status: command.status,
    });

    return id;
  }

  async updateCommand(
    id: string,
    updates: Partial<Pick<CommandExecution, 'status' | 'output' | 'error'>>
  ): Promise<void> {
    const updateFields = [];
    const values = [];

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      values.push(updates.status);

      if (updates.status === 'completed' || updates.status === 'failed') {
        updateFields.push('completed_at = ?');
        values.push(new Date().toISOString());
      }
    }

    if (updates.output !== undefined) {
      updateFields.push('output = ?');
      values.push(updates.output);
    }

    if (updates.error !== undefined) {
      updateFields.push('error = ?');
      values.push(updates.error);
    }

    if (updateFields.length === 0) return;

    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE command_executions 
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);
  }

  // Event recording
  private async recordEvent(
    workflowId: string,
    type: WorkflowEvent['type'],
    payload: Record<string, any>
  ): Promise<void> {
    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO workflow_events (id, workflow_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, workflowId, type, JSON.stringify(payload), new Date().toISOString());
  }

  async getWorkflowEvents(workflowId: string, limit: number = 100): Promise<WorkflowEvent[]> {
    const query = this.db.prepare(`
      SELECT * FROM workflow_events 
      WHERE workflow_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    const results = query.all(workflowId, limit) as any[];

    return results.map((r) => ({
      id: r.id,
      workflowId: r.workflow_id,
      type: r.type,
      payload: JSON.parse(r.payload),
      createdAt: new Date(r.created_at),
    }));
  }

  // Transaction support
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    // Check if we're already in a transaction
    if (this.db.inTransaction) {
      // If already in a transaction, just execute the function
      return await fn();
    }

    // Otherwise, create a new transaction
    const transaction = this.db.transaction(fn);
    return transaction() as T;
  }

  // Cleanup operations
  async archiveCompletedWorkflows(olderThan: Date): Promise<number> {
    const stmt = this.db.prepare(`
      DELETE FROM workflows 
      WHERE status IN ('completed', 'failed', 'cancelled') 
      AND updated_at < ?
    `);
    const result = stmt.run(olderThan.toISOString());
    return result.changes;
  }

  async cleanupZombieWorkspaces(): Promise<number> {
    // Find workspaces attached to inactive workflows
    const stmt = this.db.prepare(`
      UPDATE workspaces 
      SET status = 'failed'
      WHERE status = 'active'
      AND workflow_id IN (
        SELECT id FROM workflows 
        WHERE status IN ('failed', 'cancelled')
      )
    `);
    const result = stmt.run();
    return result.changes;
  }
}
