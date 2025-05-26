import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  db,
  tasks,
  taskArtifacts,
  commandHistory as commandHistoryTable,
  taskLogs,
} from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { log, error, debugLog, runWithLogger } from '../../logging.js';
import { generatePlanForIssue } from './plan_generator.js';
import { notifyTaskCreation } from './thread_manager.js';
import { parseGitHubIssueUrl } from '../utils/github_utils.js';
import { WorkspaceAutoSelector } from '../../rmplan/workspace/workspace_auto_selector.js';
import { config as botConfig } from '../config.js';
import { loadEffectiveConfig as loadRmplanConfig } from '../../rmplan/configLoader.js';
import { rmplanAgent } from '../../rmplan/agent.js';
import { DatabaseLoggerAdapter } from '../logging/database_adapter.js';

type Task = InferSelectModel<typeof tasks>;
type NewTask = InferInsertModel<typeof tasks>;

export interface CreateTaskOptions {
  issueUrl?: string;
  issueNumber?: number;
  repositoryFullName?: string;
  taskType: string;
  createdByPlatform: string;
  createdByUserId: string;
  workspacePath?: string;
  planFilePath?: string;
  prNumber?: number;
}

export interface UpdateTaskOptions {
  status?: string;
  workspacePath?: string;
  planFilePath?: string;
  prNumber?: number;
  errorMessage?: string;
  branch?: string;
}

export interface CreateArtifactOptions {
  taskId: string;
  artifactType: string;
  filePath: string;
  metadata?: string;
}

export interface StartPlanGenerationOptions {
  platform: 'github' | 'discord';
  userId: string;
  issueUrl: string;
  repoFullName?: string;
  repoPath: string;
  originalCommandId?: number;
  // For GitHub:
  githubCommentId?: number;
  // For Discord:
  discordInteraction?: any;
}

export interface StartImplementationOptions {
  platform: 'github' | 'discord';
  userId: string;
  issueUrl: string;
  repoFullName: string;
  repoPath: string;
  originalCommandId?: number;
  githubCommentId?: number;
  discordInteraction?: any;
}

// Implementation lifecycle status constants
export const IMPLEMENTATION_STATUS = {
  PENDING_IMPLEMENTATION: 'pending_implementation',
  WORKSPACE_SETUP: 'workspace_setup',
  IMPLEMENTING: 'implementing',
  IMPLEMENTATION_COMPLETE: 'implementation_complete',
  IMPLEMENTATION_FAILED: 'implementation_failed',
  PR_PENDING: 'pr_pending',
  PR_CREATED: 'pr_created',
  PR_FAILED: 'pr_failed',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

// Planning lifecycle status constants (already in use)
export const PLANNING_STATUS = {
  PENDING_PLANNING: 'pending_planning',
  PLANNING: 'planning',
  PLAN_GENERATED: 'plan_generated',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/**
 * Manages task records in the database.
 */
export class TaskManager {
  /**
   * Creates a new task in the database.
   */
  async createTask(options: CreateTaskOptions): Promise<Task> {
    const taskId = crypto.randomUUID();

    try {
      const newTask: NewTask = {
        id: taskId,
        issueUrl: options.issueUrl,
        issueNumber: options.issueNumber,
        repositoryFullName: options.repositoryFullName,
        taskType: options.taskType,
        status: 'pending',
        workspacePath: options.workspacePath,
        planFilePath: options.planFilePath,
        prNumber: options.prNumber,
        createdByPlatform: options.createdByPlatform,
        createdByUserId: options.createdByUserId,
        errorMessage: null,
      };

      await db.insert(tasks).values(newTask);

      log(`Created task ${taskId} for ${options.taskType}`);
      debugLog(`Task details:`, newTask);

      // Retrieve the created task
      const [createdTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      return createdTask;
    } catch (err) {
      error(`Failed to create task: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Updates an existing task.
   */
  async updateTask(taskId: string, updates: UpdateTaskOptions): Promise<Task | null> {
    try {
      await db
        .update(tasks)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      log(`Updated task ${taskId} with:`, updates);

      // Retrieve the updated task
      const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      return updatedTask || null;
    } catch (err) {
      error(`Failed to update task ${taskId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Gets a task by ID.
   */
  async getTask(taskId: string): Promise<Task | null> {
    try {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      return task || null;
    } catch (err) {
      error(`Failed to get task ${taskId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Gets tasks by issue URL.
   */
  async getTasksByIssue(issueUrl: string): Promise<Task[]> {
    try {
      const taskList = await db.select().from(tasks).where(eq(tasks.issueUrl, issueUrl));
      return taskList;
    } catch (err) {
      error(`Failed to get tasks for issue ${issueUrl}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Gets tasks by repository.
   */
  async getTasksByRepository(repositoryFullName: string): Promise<Task[]> {
    try {
      const taskList = await db
        .select()
        .from(tasks)
        .where(eq(tasks.repositoryFullName, repositoryFullName));
      return taskList;
    } catch (err) {
      error(`Failed to get tasks for repository ${repositoryFullName}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Gets pending tasks.
   */
  async getPendingTasks(): Promise<Task[]> {
    try {
      const taskList = await db.select().from(tasks).where(eq(tasks.status, 'pending'));
      return taskList;
    } catch (err) {
      error(`Failed to get pending tasks: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Creates a task artifact.
   */
  async createArtifact(options: CreateArtifactOptions): Promise<void> {
    try {
      await db.insert(taskArtifacts).values({
        taskId: options.taskId,
        artifactType: options.artifactType,
        filePath: options.filePath,
        metadata: options.metadata,
      });

      debugLog(
        `Created artifact for task ${options.taskId}: ${options.artifactType} at ${options.filePath}`
      );
    } catch (err) {
      error(`Failed to create artifact for task ${options.taskId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Gets artifacts for a task.
   */
  async getTaskArtifacts(taskId: string) {
    try {
      const artifacts = await db
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.taskId, taskId));
      return artifacts;
    } catch (err) {
      error(`Failed to get artifacts for task ${taskId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Starts a plan generation task for a GitHub issue.
   */
  async startPlanGenerationTask(options: StartPlanGenerationOptions): Promise<string | null> {
    const taskId = randomUUID();
    log(`[${taskId}] Received request to generate plan for issue: ${options.issueUrl}`);

    let taskRecordId: string | undefined;
    // Parse issue number from URL
    const issueNumber = parseInt(options.issueUrl.split('/').pop() || '0', 10);

    try {
      // 1. Create initial task record
      const insertedTasks = await db
        .insert(tasks)
        .values({
          id: taskId,
          issueUrl: options.issueUrl,
          issueNumber: issueNumber || undefined,
          repositoryFullName: options.repoFullName,
          taskType: 'plan',
          status: 'pending_planning',
          createdByPlatform: options.platform,
          createdByUserId: options.userId,
        })
        .returning({ id: tasks.id });

      if (!insertedTasks || insertedTasks.length === 0) {
        throw new Error('Failed to insert task into database.');
      }
      taskRecordId = insertedTasks[0].id;
      log(`[${taskId}] Created task record.`);

      // Update command_history with task_id and set status to 'processing'
      if (options.originalCommandId) {
        await db
          .update(commandHistoryTable)
          .set({ taskId: taskId, status: 'processing' })
          .where(eq(commandHistoryTable.id, options.originalCommandId));
      }

      // 2. Set status to 'planning'
      await db.update(tasks).set({ status: 'planning' }).where(eq(tasks.id, taskId));
      await notifyTaskCreation(
        taskId,
        `Planning started for ${options.issueUrl}...`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          issueNumber: parseGitHubIssueUrl(options.issueUrl)?.issueNumber,
          githubCommentId: options.githubCommentId,
          discordInteraction: options.discordInteraction,
          channelId: options.discordInteraction?.channelId,
        },
        options.repoFullName,
        parseGitHubIssueUrl(options.issueUrl)?.issueNumber
      );

      // 3. Call plan generator
      const { planYamlPath, planMarkdownContent } = await generatePlanForIssue(
        options.issueUrl,
        taskId,
        options.repoPath
      );
      log(`[${taskId}] Plan generation successful. Plan YAML at: ${planYamlPath}`);

      // 4. Update task record with plan_file_path and status 'completed' (for planning task type)
      await db
        .update(tasks)
        .set({ status: 'plan_generated', planFilePath: planYamlPath, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      // 5. Store plan as an artifact
      await db.insert(taskArtifacts).values({
        taskId: taskId,
        artifactType: 'plan_yaml',
        filePath: planYamlPath,
      });
      // Optionally save markdown plan as well
      // const markdownArtifactPath = planYamlPath.replace('.yml', '.md'); // Path where plan_generator saved it
      // await db.insert(taskArtifacts).values({
      //   taskId: taskId,
      //   artifactType: 'plan_markdown',
      //   filePath: markdownArtifactPath,
      // });

      log(`[${taskId}] Planning task completed successfully.`);
      await notifyTaskCreation(
        taskId,
        `Plan successfully generated for ${options.issueUrl}. Plan available at: ${planYamlPath}`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          issueNumber: parseGitHubIssueUrl(options.issueUrl)?.issueNumber,
          githubCommentId: options.githubCommentId,
          discordInteraction: options.discordInteraction,
          channelId: options.discordInteraction?.channelId,
        },
        options.repoFullName,
        parseGitHubIssueUrl(options.issueUrl)?.issueNumber
      );

      // Update command_history to success
      if (options.originalCommandId) {
        await db
          .update(commandHistoryTable)
          .set({ status: 'success' })
          .where(eq(commandHistoryTable.id, options.originalCommandId));
      }
      return taskId;
    } catch (err) {
      error(`[${taskId}] Error during plan generation task for ${options.issueUrl}:`, err);
      if (taskRecordId) {
        await db
          .update(tasks)
          .set({ status: 'failed', errorMessage: String(err), updatedAt: new Date() })
          .where(eq(tasks.id, taskRecordId));
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      await notifyTaskCreation(
        taskId,
        `Plan generation FAILED for ${options.issueUrl}. Error: ${errorMessage.substring(0, 200)}...`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          issueNumber: parseGitHubIssueUrl(options.issueUrl)?.issueNumber,
          githubCommentId: options.githubCommentId,
          discordInteraction: options.discordInteraction,
          channelId: options.discordInteraction?.channelId,
        },
        options.repoFullName,
        parseGitHubIssueUrl(options.issueUrl)?.issueNumber
      );

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
   * Processes an implementation task by setting up workspace and preparing for agent execution
   */
  async processImplementationTask(taskId: string): Promise<void> {
    log(`[${taskId}] Starting implementation task processing`);

    // 1. Fetch the task
    const task = await this.getTask(taskId);
    if (!task) {
      log(`[${taskId}] Task not found`);
      return;
    }

    // Check if it's an implementation task in a runnable state
    if (task.taskType !== 'implement') {
      log(`[${taskId}] Task is not an implementation task (type: ${task.taskType})`);
      return;
    }

    if (
      task.status !== IMPLEMENTATION_STATUS.PENDING_IMPLEMENTATION &&
      task.status !== IMPLEMENTATION_STATUS.WORKSPACE_SETUP
    ) {
      log(`[${taskId}] Task not in runnable state (status: ${task.status})`);
      return;
    }

    try {
      // 2. Update status to workspace_setup
      await this.updateTask(taskId, {
        status: IMPLEMENTATION_STATUS.WORKSPACE_SETUP,
      });

      // Get repository path - for bot operations, this would be passed or configured
      const repoPath = process.env.BOT_REPO_PATH || process.cwd();

      // Use WorkspaceAutoSelector to select or create workspace
      const rmplanConfig = await loadRmplanConfig();
      const selector = new WorkspaceAutoSelector(repoPath, rmplanConfig);

      const selectedWorkspace = await selector.selectWorkspace(taskId, task.planFilePath!, {
        interactive: false,
        preferNewWorkspace: false,
      });

      if (!selectedWorkspace) {
        throw new Error('Failed to select or create workspace');
      }

      const { workspace } = selectedWorkspace;
      log(`[${taskId}] Selected workspace: ${workspace.workspacePath}`);

      // Get branch name from workspace info
      const branchName = workspace.branch;

      // Update task with workspace info
      await this.updateTask(taskId, {
        workspacePath: workspace.workspacePath,
        branch: branchName,
        status: IMPLEMENTATION_STATUS.IMPLEMENTING,
      });

      // Copy plan file to workspace
      const planFileName = path.basename(task.planFilePath!);
      const workspacePlanPath = path.join(workspace.workspacePath, planFileName);

      try {
        await fs.copyFile(task.planFilePath!, workspacePlanPath);
        log(`[${taskId}] Copied plan file to workspace: ${workspacePlanPath}`);
      } catch (err) {
        error(`[${taskId}] Failed to copy plan file: ${err}`);
        throw new Error(`Failed to copy plan file: ${err}`);
      }

      // 3. Invoke rmplan agent
      log(`[${taskId}] Invoking rmplan agent:`);
      log(`[${taskId}]   Workspace: ${workspace.workspacePath}`);
      log(`[${taskId}]   Plan file: ${workspacePlanPath}`);

      // Create database logger adapter to capture agent output
      const dbLogger = new DatabaseLoggerAdapter();

      try {
        // Run rmplanAgent with database logging
        await runWithLogger(dbLogger, async () => {
          await rmplanAgent(
            workspacePlanPath,
            {
              workspace: workspace.workspacePath,
              autoWorkspace: false, // We already have a workspace
              nonInteractive: true, // Bot runs non-interactively
              requireWorkspace: true,
              botTaskId: taskId,
              executor: 'CopyOnlyExecutor', // Default executor for bot
            },
            {} // Global CLI options
          );
        });

        // Save logs to database after successful completion
        await dbLogger.save(taskId, 'agent_complete');
        log(`[${taskId}] Agent execution completed successfully`);

        // Update task status to indicate successful implementation
        await this.updateTask(taskId, {
          status: IMPLEMENTATION_STATUS.IMPLEMENTATION_COMPLETE,
        });
      } catch (agentError) {
        // Save logs even on failure
        await dbLogger.save(taskId, 'agent_failed');
        throw agentError;
      }

      // Notify progress - implementation complete
      await notifyTaskCreation(
        taskId,
        `Implementation completed successfully! Workspace: ${workspace.workspacePath}, branch: ${branchName}`,
        {
          platform: task.createdByPlatform as 'github' | 'discord',
          userId: task.createdByUserId!,
          repoFullName: task.repositoryFullName || undefined,
          issueNumber: task.issueNumber || undefined,
        },
        task.repositoryFullName || undefined,
        task.issueNumber || undefined
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      error(`[${taskId}] Implementation task processing failed: ${errorMessage}`);

      // Update task status to failed
      await this.updateTask(taskId, {
        status: IMPLEMENTATION_STATUS.IMPLEMENTATION_FAILED,
        errorMessage: errorMessage,
      });

      // Notify failure
      await notifyTaskCreation(
        taskId,
        `Implementation setup FAILED: ${errorMessage}`,
        {
          platform: task.createdByPlatform as 'github' | 'discord',
          userId: task.createdByUserId!,
          repoFullName: task.repositoryFullName || undefined,
          issueNumber: task.issueNumber || undefined,
        },
        task.repositoryFullName || undefined,
        task.issueNumber || undefined
      );
    }
  }

  /**
   * Starts an implementation task for a GitHub issue.
   */
  async startImplementationTask(options: StartImplementationOptions): Promise<string | null> {
    const taskId = randomUUID();
    log(`[${taskId}] Received request to implement plan for issue: ${options.issueUrl}`);

    let taskRecordId: string | undefined;
    // Parse issue number from URL
    const issueNumber = parseInt(options.issueUrl.split('/').pop() || '0', 10);

    try {
      // 1. Find the planning task for this issue to get the plan file
      const planningTasks = await this.getTasksByIssue(options.issueUrl);
      const planTask = planningTasks.find(
        (t) =>
          t.taskType === 'plan' && t.status === PLANNING_STATUS.PLAN_GENERATED && t.planFilePath
      );

      if (!planTask || !planTask.planFilePath) {
        throw new Error(`No completed plan found for issue: ${options.issueUrl}`);
      }

      log(`[${taskId}] Found plan at: ${planTask.planFilePath}`);

      // 2. Create initial task record with implementation type
      const insertedTasks = await db
        .insert(tasks)
        .values({
          id: taskId,
          issueUrl: options.issueUrl,
          issueNumber: issueNumber || undefined,
          repositoryFullName: options.repoFullName,
          taskType: 'implement',
          status: IMPLEMENTATION_STATUS.PENDING_IMPLEMENTATION,
          planFilePath: planTask.planFilePath,
          createdByPlatform: options.platform,
          createdByUserId: options.userId,
        })
        .returning({ id: tasks.id });

      if (!insertedTasks || insertedTasks.length === 0) {
        throw new Error('Failed to insert task into database.');
      }
      taskRecordId = insertedTasks[0].id;
      log(`[${taskId}] Created implementation task record.`);

      // Update command_history with task_id and set status to 'processing'
      if (options.originalCommandId) {
        await db
          .update(commandHistoryTable)
          .set({ taskId: taskId, status: 'processing' })
          .where(eq(commandHistoryTable.id, options.originalCommandId));
      }

      // 3. Set status to 'workspace_setup'
      await db
        .update(tasks)
        .set({ status: IMPLEMENTATION_STATUS.WORKSPACE_SETUP })
        .where(eq(tasks.id, taskId));

      await notifyTaskCreation(
        taskId,
        `Setting up workspace for implementation of ${options.issueUrl}...`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          issueNumber: parseGitHubIssueUrl(options.issueUrl)?.issueNumber,
          githubCommentId: options.githubCommentId,
          discordInteraction: options.discordInteraction,
          channelId: options.discordInteraction?.channelId,
        },
        options.repoFullName,
        parseGitHubIssueUrl(options.issueUrl)?.issueNumber
      );

      // TODO: In the next phase, this will set up workspace and invoke rmplanAgent
      // For now, just update status to show the implementation would start
      await db
        .update(tasks)
        .set({
          status: IMPLEMENTATION_STATUS.IMPLEMENTING,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      log(
        `[${taskId}] Implementation task created successfully. Ready for rmplan agent execution.`
      );

      await notifyTaskCreation(
        taskId,
        `Implementation task created for ${options.issueUrl}. Plan: ${planTask.planFilePath}`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          issueNumber: parseGitHubIssueUrl(options.issueUrl)?.issueNumber,
          githubCommentId: options.githubCommentId,
          discordInteraction: options.discordInteraction,
          channelId: options.discordInteraction?.channelId,
        },
        options.repoFullName,
        parseGitHubIssueUrl(options.issueUrl)?.issueNumber
      );

      // Update command_history to success
      if (options.originalCommandId) {
        await db
          .update(commandHistoryTable)
          .set({ status: 'success' })
          .where(eq(commandHistoryTable.id, options.originalCommandId));
      }
      return taskId;
    } catch (err) {
      error(`[${taskId}] Error during implementation task creation for ${options.issueUrl}:`, err);
      if (taskRecordId) {
        await db
          .update(tasks)
          .set({
            status: IMPLEMENTATION_STATUS.FAILED,
            errorMessage: String(err),
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskRecordId));
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      await notifyTaskCreation(
        taskId,
        `Implementation task FAILED for ${options.issueUrl}. Error: ${errorMessage.substring(0, 200)}...`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          issueNumber: parseGitHubIssueUrl(options.issueUrl)?.issueNumber,
          githubCommentId: options.githubCommentId,
          discordInteraction: options.discordInteraction,
          channelId: options.discordInteraction?.channelId,
        },
        options.repoFullName,
        parseGitHubIssueUrl(options.issueUrl)?.issueNumber
      );

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
}

// Export a singleton instance
export const taskManager = new TaskManager();

// Export convenience functions
export const startPlanGenerationTask = taskManager.startPlanGenerationTask.bind(taskManager);
export const startImplementationTask = taskManager.startImplementationTask.bind(taskManager);
export const processImplementationTask = taskManager.processImplementationTask.bind(taskManager);
