import { db, tasks, taskArtifacts } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { log, error, debugLog } from '../../logging.js';

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
}

// Export a singleton instance
export const taskManager = new TaskManager();
