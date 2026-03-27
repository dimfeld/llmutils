import { sendStructured } from '../../../logging.js';
import type { TimConfig } from '../../configSchema.js';
import {
  checkAndMarkParentDone as checkAndMarkParentDoneShared,
  markParentInProgress as markParentInProgressShared,
} from '../../plans/parent_cascade.js';
import { timestamp } from './agent_helpers.js';

/**
 * Marks a parent plan as in_progress if it's currently pending.
 * Recursively marks all ancestor plans as in_progress as well.
 */
export async function markParentInProgress(parentId: number, config: TimConfig): Promise<void> {
  await markParentInProgressShared(parentId, config, {
    onParentMarkedInProgress(parentPlan) {
      sendStructured({
        type: 'workflow_progress',
        timestamp: timestamp(),
        phase: 'parent-plan-start',
        message: `Parent plan "${parentPlan.title}" marked as in_progress`,
      });
    },
  });
}

/**
 * Checks if a parent plan's children are all complete and marks the parent as done if so.
 * This function is duplicated here to avoid circular dependencies with actions.ts
 */
export async function checkAndMarkParentDone(
  parentId: number,
  config: TimConfig,
  baseDir?: string
): Promise<void> {
  await checkAndMarkParentDoneShared(parentId, config, {
    baseDir,
    onParentMarkedDone(parentPlan) {
      sendStructured({
        type: 'workflow_progress',
        timestamp: timestamp(),
        phase: 'parent-plan-complete',
        message: `Parent plan "${parentPlan.title}" marked as complete`,
      });
    },
  });
}
