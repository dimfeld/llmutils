import type { PlanSchema } from './planSchema.js';

/**
 * Combines project title and phase title for display.
 * If both exist, returns "Project Title - Phase Title"
 * Otherwise returns whichever exists, or 'Untitled' if neither exists.
 */
export function getCombinedTitle(plan: PlanSchema): string {
  const projectTitle = plan.project?.title;
  const phaseTitle = plan.title;

  if (projectTitle && phaseTitle) {
    return `${projectTitle} - ${phaseTitle}`;
  } else if (projectTitle) {
    return projectTitle;
  } else if (phaseTitle) {
    return phaseTitle;
  } else {
    return 'Untitled';
  }
}

/**
 * Combines project goal and phase goal for display.
 * If both exist, returns "Project Goal - Phase Goal"
 * Otherwise returns whichever exists.
 */
export function getCombinedGoal(plan: PlanSchema): string {
  const projectGoal = plan.project?.goal;
  const phaseGoal = plan.goal;

  if (projectGoal && phaseGoal && projectGoal !== phaseGoal) {
    return `${projectGoal} - ${phaseGoal}`;
  } else if (phaseGoal) {
    return phaseGoal;
  } else if (projectGoal) {
    return projectGoal;
  } else {
    return '';
  }
}

/**
 * Helper type for plan summaries that might have partial plan data
 */
type PartialPlan = {
  title?: string;
  goal: string;
  project?: {
    title: string;
    goal: string;
    details?: string;
  };
};

/**
 * Combines project title and phase title for display from partial plan data.
 * If both exist, returns "Project Title - Phase Title"
 * Otherwise returns whichever exists, or falls back to goal if no title.
 */
export function getCombinedTitleFromSummary(plan: PartialPlan): string {
  const projectTitle = plan.project?.title;
  const phaseTitle = plan.title;

  if (projectTitle && phaseTitle) {
    return `${projectTitle} - ${phaseTitle}`;
  } else if (projectTitle) {
    return projectTitle;
  } else if (phaseTitle) {
    return phaseTitle;
  } else {
    // Fallback to goal if no title exists
    return plan.goal || 'Untitled';
  }
}

/**
 * Combines project goal and phase goal for display from partial plan data.
 * If both exist and are different, returns "Project Goal - Phase Goal"
 * Otherwise returns whichever exists.
 */
export function getCombinedGoalFromSummary(plan: PartialPlan): string {
  const projectGoal = plan.project?.goal;
  const phaseGoal = plan.goal;

  if (projectGoal && phaseGoal && projectGoal !== phaseGoal) {
    return `${projectGoal} - ${phaseGoal}`;
  } else if (phaseGoal) {
    return phaseGoal;
  } else if (projectGoal) {
    return projectGoal;
  } else {
    return '';
  }
}
