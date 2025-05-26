import { db, tasks } from './index.js';
import type { InferSelectModel } from 'drizzle-orm';
import { and, ne, notInArray, isNotNull } from 'drizzle-orm';

export type Task = InferSelectModel<typeof tasks>;

/**
 * Retrieves all active tasks (not in final states).
 * Final states are: 'completed', 'failed', 'cancelled'
 * @returns Promise<Task[]> Array of active tasks
 */
export async function getAllActiveTasks(): Promise<Task[]> {
  const finalStates = ['completed', 'failed', 'cancelled'];

  try {
    const activeTasks = await db
      .select()
      .from(tasks)
      .where(and(isNotNull(tasks.status), notInArray(tasks.status, finalStates)));

    return activeTasks;
  } catch (error) {
    throw new Error(
      `Failed to retrieve active tasks: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
