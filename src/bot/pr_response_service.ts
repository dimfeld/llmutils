import { randomUUID } from 'node:crypto';
import { db, tasks, commandHistory as commandHistoryTable } from './db/index.js';
import { eq } from 'drizzle-orm';
import { log, error, debugLog } from '../logging.js';
import { runWithLogger } from '../logging/adapter.js';
import { notifyTaskCreation, notifyTaskProgress } from './core/thread_manager.js';
import { handleRmprCommand } from '../rmpr/main.js';
import { WorkspaceAutoSelector } from '../rmplan/workspace/workspace_auto_selector.js';
import { config as botConfig } from './config.js';
import { loadEffectiveConfig as loadRmplanConfig } from '../rmplan/configLoader.js';
import { DatabaseLoggerAdapter } from './logging/database_adapter.js';

export interface InitiatePrResponseOptions {
  platform: 'github' | 'discord';
  userId: string;
  prNumber: number;
  repoFullName: string;
  originalCommandId?: number;
  githubCommentId?: number;
  discordInteraction?: any;
}

// PR Response lifecycle status constants
export const PR_RESPONSE_STATUS = {
  PENDING: 'pending',
  WORKSPACE_SETUP: 'workspace_setup',
  SELECTING_COMMENTS: 'selecting_comments',
  RESPONDING: 'responding',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/**
 * Initiates a PR response task to address review comments.
 * @param options Configuration for the PR response task
 * @returns The task ID if successful, null otherwise
 */
export async function initiatePrResponseTask(
  options: InitiatePrResponseOptions
): Promise<string | null> {
  const taskId = randomUUID();
  log(
    `[${taskId}] Received request to respond to PR #${options.prNumber} in ${options.repoFullName}`
  );

  let taskRecordId: string | undefined;

  try {
    // 1. Create initial task record
    const insertedTasks = await db
      .insert(tasks)
      .values({
        id: taskId,
        issueNumber: options.prNumber,
        repositoryFullName: options.repoFullName,
        taskType: 'responding',
        status: PR_RESPONSE_STATUS.PENDING,
        createdByPlatform: options.platform,
        createdByUserId: options.userId,
        // For PR responses, we track the PR number instead of issue URL
        prNumber: options.prNumber,
      })
      .returning({ id: tasks.id });

    if (!insertedTasks || insertedTasks.length === 0) {
      throw new Error('Failed to insert task into database.');
    }
    taskRecordId = insertedTasks[0].id;
    log(`[${taskId}] Created PR response task record.`);

    // Update command_history with task_id and set status to 'processing'
    if (options.originalCommandId) {
      await db
        .update(commandHistoryTable)
        .set({ taskId: taskId, status: 'processing' })
        .where(eq(commandHistoryTable.id, options.originalCommandId));
    }

    // 2. Set status to 'workspace_setup'
    await db
      .update(tasks)
      .set({ status: PR_RESPONSE_STATUS.WORKSPACE_SETUP })
      .where(eq(tasks.id, taskId));

    await notifyTaskCreation(
      taskId,
      `Setting up workspace for PR #${options.prNumber} response...`,
      {
        platform: options.platform,
        userId: options.userId,
        repoFullName: options.repoFullName,
        issueNumber: options.prNumber,
        githubCommentId: options.githubCommentId,
        discordInteraction: options.discordInteraction,
        channelId: options.discordInteraction?.channelId,
      },
      options.repoFullName,
      options.prNumber
    );

    // 3. Set up workspace
    const rmplanConfig = await loadRmplanConfig();
    const repoPath = process.env.BOT_REPO_PATH || process.cwd();
    const selector = new WorkspaceAutoSelector(repoPath, rmplanConfig);

    const selectedWorkspace = await selector.selectWorkspace(taskId, undefined, {
      interactive: false,
      preferNewWorkspace: true,
    });

    if (!selectedWorkspace) {
      throw new Error('Failed to select or create workspace');
    }

    const { workspace } = selectedWorkspace;
    log(`[${taskId}] Selected workspace: ${workspace.workspacePath}`);

    // Update task with workspace info
    await db
      .update(tasks)
      .set({
        workspacePath: workspace.workspacePath,
        branch: workspace.branch,
        status: PR_RESPONSE_STATUS.SELECTING_COMMENTS,
      })
      .where(eq(tasks.id, taskId));

    // 4. Execute PR response
    log(`[${taskId}] Starting PR response execution in workspace: ${workspace.workspacePath}`);

    // Notify status
    await notifyTaskProgress(
      taskId,
      'Overall status: Selecting review comments',
      'selecting_comments'
    );

    // Create database logger adapter
    const dbLogger = new DatabaseLoggerAdapter(taskId, db);

    // Construct PR identifier
    const prIdentifier = `${options.repoFullName}#${options.prNumber}`;

    // Run rmpr command with database logging
    await runWithLogger(dbLogger, async () => {
      // Update status to responding
      await db
        .update(tasks)
        .set({ status: PR_RESPONSE_STATUS.RESPONDING })
        .where(eq(tasks.id, taskId));
      await notifyTaskProgress(taskId, 'Overall status: Addressing review comments', 'responding');

      await handleRmprCommand(
        prIdentifier,
        {
          executor: rmplanConfig.defaultExecutor || 'claude-code',
          mode: 'inline-comments',
          yes: true,
          model: rmplanConfig.models?.execution,
          dryRun: false,
          run: true,
          commit: true,
          comment: true,
        },
        { debug: botConfig.DEBUG },
        rmplanConfig
      );
    });

    // 5. Update task status to completed
    await db
      .update(tasks)
      .set({ status: PR_RESPONSE_STATUS.COMPLETED, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    log(`[${taskId}] PR response task completed successfully.`);

    await notifyTaskCreation(
      taskId,
      `✅ Successfully addressed review comments for PR #${options.prNumber}`,
      {
        platform: options.platform,
        userId: options.userId,
        repoFullName: options.repoFullName,
        issueNumber: options.prNumber,
        githubCommentId: options.githubCommentId,
        discordInteraction: options.discordInteraction,
        channelId: options.discordInteraction?.channelId,
      },
      options.repoFullName,
      options.prNumber
    );

    // Notify overall status change
    await notifyTaskProgress(taskId, 'Overall status: Completed', 'completed');

    // Update command_history to success
    if (options.originalCommandId) {
      await db
        .update(commandHistoryTable)
        .set({ status: 'success' })
        .where(eq(commandHistoryTable.id, options.originalCommandId));
    }

    return taskId;
  } catch (err) {
    error(`[${taskId}] Error during PR response task:`, err);

    if (taskRecordId) {
      await db
        .update(tasks)
        .set({
          status: PR_RESPONSE_STATUS.FAILED,
          errorMessage: String(err),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskRecordId));
    }

    const errorMessage = err instanceof Error ? err.message : String(err);

    await notifyTaskCreation(
      taskId,
      `❌ PR response FAILED for PR #${options.prNumber}. Error: ${errorMessage.substring(0, 200)}...`,
      {
        platform: options.platform,
        userId: options.userId,
        repoFullName: options.repoFullName,
        issueNumber: options.prNumber,
        githubCommentId: options.githubCommentId,
        discordInteraction: options.discordInteraction,
        channelId: options.discordInteraction?.channelId,
      },
      options.repoFullName,
      options.prNumber
    );

    // Notify overall status change
    await notifyTaskProgress(taskId, 'Overall status: Failed', 'failed');

    // Update command_history to failed
    if (options.originalCommandId) {
      await db
        .update(commandHistoryTable)
        .set({ status: 'failed', errorMessage: String(err) })
        .where(eq(commandHistoryTable.id, options.originalCommandId));
    }

    return null;
  }
}

/**
 * Resumes a PR response task that was interrupted.
 * @param taskId The task ID to resume
 */
export async function resumePrResponseTask(taskId: string): Promise<void> {
  log(`[${taskId}] Resuming PR response task`);

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task || task.length === 0) {
    error(`[${taskId}] Task not found`);
    return;
  }

  const taskRecord = task[0];

  // Only resume if task is in a resumable state
  if (
    ![
      PR_RESPONSE_STATUS.WORKSPACE_SETUP,
      PR_RESPONSE_STATUS.SELECTING_COMMENTS,
      PR_RESPONSE_STATUS.RESPONDING,
    ].includes(taskRecord.status || '')
  ) {
    log(`[${taskId}] Task not in resumable state (status: ${taskRecord.status})`);
    return;
  }

  // Re-run the PR response with the existing workspace
  if (!taskRecord.workspacePath || !taskRecord.prNumber || !taskRecord.repositoryFullName) {
    error(`[${taskId}] Missing required task data for resumption`);
    await db
      .update(tasks)
      .set({
        status: PR_RESPONSE_STATUS.FAILED,
        errorMessage: 'Missing required task data',
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));
    return;
  }

  try {
    // Create database logger adapter
    const dbLogger = new DatabaseLoggerAdapter(taskId, db);
    const rmplanConfig = await loadRmplanConfig();
    const prIdentifier = `${taskRecord.repositoryFullName}#${taskRecord.prNumber}`;

    // Run rmpr command with database logging
    await runWithLogger(dbLogger, async () => {
      await handleRmprCommand(
        prIdentifier,
        {
          executor: rmplanConfig.defaultExecutor || 'claude-code',
          mode: 'inline-comments',
          yes: true,
          model: rmplanConfig.models?.execution,
          dryRun: false,
          run: true,
          commit: true,
          comment: true,
        },
        { debug: botConfig.DEBUG },
        rmplanConfig
      );
    });

    // Update task status to completed
    await db
      .update(tasks)
      .set({ status: PR_RESPONSE_STATUS.COMPLETED, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    log(`[${taskId}] PR response task resumed and completed successfully.`);
    await notifyTaskProgress(taskId, 'Overall status: Completed (resumed)', 'completed');
  } catch (err) {
    error(`[${taskId}] Error during PR response task resumption:`, err);

    await db
      .update(tasks)
      .set({ status: PR_RESPONSE_STATUS.FAILED, errorMessage: String(err), updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    await notifyTaskProgress(
      taskId,
      `Overall status: Failed - ${String(err).substring(0, 100)}`,
      'failed'
    );
  }
}
