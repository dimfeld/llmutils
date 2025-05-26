import { randomUUID } from 'node:crypto';
import { db, tasks, taskArtifacts, commandHistory as commandHistoryTable } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { log, error, debugLog } from '../../logging.js';
import { generatePlanForIssue } from './plan_generator.js';
import { notifyTaskCreation } from './thread_manager.js';

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
          channelId: options.discordInteraction?.channelId,
          commentId: options.githubCommentId,
        },
        options.repoFullName,
        issueNumber || undefined
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
        `Plan generated for ${options.issueUrl}: ${planYamlPath}`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          channelId: options.discordInteraction?.channelId,
          commentId: options.githubCommentId,
        },
        options.repoFullName,
        issueNumber || undefined
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
      await notifyTaskCreation(
        taskId,
        `Failed to generate plan for ${options.issueUrl}: ${(err as Error).message}`,
        {
          platform: options.platform,
          userId: options.userId,
          repoFullName: options.repoFullName,
          channelId: options.discordInteraction?.channelId,
          commentId: options.githubCommentId,
        },
        options.repoFullName,
        issueNumber || undefined
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

// Export convenience function
export const startPlanGenerationTask = taskManager.startPlanGenerationTask.bind(taskManager);
