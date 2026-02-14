import { statusSchema } from '../planSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { z } from 'zod/v4';

/**
 * Type for plan status values
 */
export type PlanStatus = z.infer<typeof statusSchema>;

/**
 * Checks if a plan is in 'pending' status.
 * @param plan - The plan to check
 * @returns true if the plan status is 'pending' or not set (defaults to 'pending')
 */
export function isPlanPending(plan: PlanSchema): boolean {
  const status = plan.status || 'pending';
  return status === 'pending';
}

/**
 * Checks if a plan is in 'in_progress' status.
 * @param plan - The plan to check
 * @returns true if the plan status is 'in_progress'
 */
export function isPlanInProgress(plan: PlanSchema): boolean {
  return plan.status === 'in_progress';
}

/**
 * Checks if a plan is in 'done' status.
 * @param plan - The plan to check
 * @returns true if the plan status is 'done'
 */
export function isPlanDone(plan: PlanSchema): boolean {
  return plan.status === 'done';
}

/**
 * Checks if a plan is in 'cancelled' status.
 * @param plan - The plan to check
 * @returns true if the plan status is 'cancelled'
 */
export function isPlanCancelled(plan: PlanSchema): boolean {
  return plan.status === 'cancelled';
}

/**
 * Checks if a plan is in 'deferred' status.
 * @param plan - The plan to check
 * @returns true if the plan status is 'deferred'
 */
export function isPlanDeferred(plan: PlanSchema): boolean {
  return plan.status === 'deferred';
}

/**
 * Checks if a plan is actionable (either 'pending' or 'in_progress').
 * Actionable plans are those that can have work performed on them.
 * @param plan - The plan to check
 * @returns true if the plan status is 'pending' or 'in_progress'
 */
export function isPlanActionable(plan: PlanSchema): boolean {
  return isPlanPending(plan) || isPlanInProgress(plan);
}

/**
 * Checks if a plan is complete (either 'done', 'cancelled', or 'deferred').
 * Complete plans are those that no longer need work.
 * @param plan - The plan to check
 * @returns true if the plan status is 'done', 'cancelled', or 'deferred'
 */
export function isPlanComplete(plan: PlanSchema): boolean {
  const status = plan.status;
  return status === 'done' || status === 'cancelled' || status === 'deferred';
}

/**
 * Gets the display name for a plan status.
 * @param status - The status value
 * @returns A human-readable display name for the status
 */
export function getStatusDisplayName(status: PlanStatus | undefined): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'in_progress':
      return 'In Progress';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'deferred':
      return 'Deferred';
    default:
      return 'Pending'; // Default for undefined status
  }
}

/**
 * Validates if a string is a valid plan status.
 * @param status - The status string to validate
 * @returns true if the status is valid
 */
export function isValidPlanStatus(status: string): status is PlanStatus {
  const result = statusSchema.safeParse(status);
  return result.success;
}

/**
 * Converts nullable/untrusted status text into a valid plan status.
 * @param status - Status value from persisted assignment/workspace records
 * @returns Valid PlanStatus when recognized; otherwise undefined
 */
export function normalizePlanStatus(status: string | null): PlanStatus | undefined {
  if (!status) {
    return undefined;
  }
  return isValidPlanStatus(status) ? status : undefined;
}
