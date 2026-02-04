/**
 * Represents a parsed task identifier with plan ID and 0-based task index
 */
export interface TaskIdentifier {
  planId: string;
  taskIndex: number;
}

/**
 * Parses task ID arguments into structured task identifiers.
 *
 * Task ID format:
 * - Single task: "PLAN_ID.TASK_INDEX" (e.g., "35.2")
 * - Range: "PLAN_ID.START_INDEX-END_INDEX" (e.g., "35.2-6")
 *
 * Input indices are 1-based but output indices are 0-based for array access.
 *
 * @param taskIds - Array of task ID strings to parse
 * @returns Array of structured task identifiers with 0-based indices
 * @throws Error for invalid input formats or empty arrays
 */
export function parseTaskIds(taskIds: string[]): TaskIdentifier[] {
  if (taskIds.length === 0) {
    throw new Error('No task IDs provided');
  }

  const results: TaskIdentifier[] = [];

  for (const taskId of taskIds) {
    if (!taskId || taskId.trim() === '') {
      throw new Error('Invalid task ID format: empty string');
    }

    // Split by dot to separate plan ID from task part
    const parts = taskId.split('.');
    if (parts.length !== 2) {
      throw new Error(
        `Invalid task ID format: ${taskId}. Expected format: PLAN_ID.TASK_INDEX or PLAN_ID.START_INDEX-END_INDEX`
      );
    }

    const [planId, taskPart] = parts;

    if (!planId) {
      throw new Error(`Invalid task ID format: ${taskId}. Plan ID cannot be empty`);
    }

    if (!taskPart) {
      throw new Error(`Invalid task ID format: ${taskId}. Task part cannot be empty`);
    }

    // Check if this is a range (contains hyphen)
    if (taskPart.includes('-')) {
      const rangeParts = taskPart.split('-');
      if (rangeParts.length !== 2) {
        throw new Error(`Invalid task ID format: ${taskId}. Range must have exactly one hyphen`);
      }

      const [startStr, endStr] = rangeParts;

      if (!startStr || !endStr) {
        throw new Error(`Invalid task ID format: ${taskId}. Range parts cannot be empty`);
      }

      const startIndex = parseInt(startStr, 10);
      const endIndex = parseInt(endStr, 10);

      if (isNaN(startIndex) || isNaN(endIndex)) {
        throw new Error(`Invalid task ID format: ${taskId}. Range indices must be numeric`);
      }

      if (startIndex <= 0 || endIndex <= 0) {
        throw new Error(`Task indices must be 1-based (greater than 0): ${taskId}`);
      }

      if (startIndex > endIndex) {
        throw new Error(`Invalid range: start index cannot be greater than end index in ${taskId}`);
      }

      // Generate all indices in the range (convert to 0-based)
      for (let i = startIndex; i <= endIndex; i++) {
        results.push({
          planId,
          taskIndex: i - 1, // Convert to 0-based
        });
      }
    } else {
      // Single task index
      const taskIndex = parseInt(taskPart, 10);

      if (isNaN(taskIndex)) {
        throw new Error(`Invalid task ID format: ${taskId}. Task index must be numeric`);
      }

      if (taskIndex <= 0) {
        throw new Error(`Task indices must be 1-based (greater than 0): ${taskId}`);
      }

      results.push({
        planId,
        taskIndex: taskIndex - 1, // Convert to 0-based
      });
    }
  }

  return results;
}
