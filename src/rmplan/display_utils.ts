import * as os from 'node:os';
import * as path from 'node:path';

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
  goal?: string;
  project?: {
    title: string;
    goal?: string;
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

function normalizeForComparison(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function abbreviateHomeDirectory(p: string): string {
  const homeDir = os.homedir();
  if (!homeDir) {
    return p;
  }

  const normalizedHome = process.platform === 'win32' ? homeDir.toLowerCase() : homeDir;
  const normalizedPath = process.platform === 'win32' ? p.toLowerCase() : p;

  if (normalizedPath === normalizedHome) {
    return '~';
  }

  if (normalizedPath.startsWith(normalizedHome + path.sep.toLowerCase())) {
    const suffix = p.slice(homeDir.length + 1);
    return `~${path.sep}${suffix}`;
  }

  return p;
}

export interface FormatWorkspacePathOptions {
  currentWorkspace?: string | null;
}

export function formatWorkspacePath(
  workspacePath: string,
  options: FormatWorkspacePathOptions = {}
): string {
  const currentWorkspace = options.currentWorkspace ?? null;
  const normalizedTarget = normalizeForComparison(workspacePath);

  if (currentWorkspace) {
    const normalizedCurrent = normalizeForComparison(currentWorkspace);
    if (normalizedCurrent === normalizedTarget) {
      return 'this workspace';
    }
  }

  let displayPath = workspacePath;

  if (currentWorkspace) {
    const relative = path.relative(currentWorkspace, workspacePath);
    if (relative === '') {
      return 'this workspace';
    }

    if (relative.length > 0 && relative.length < displayPath.length) {
      displayPath = relative;
    }
  }

  if (path.isAbsolute(displayPath)) {
    displayPath = abbreviateHomeDirectory(displayPath);
  }

  return displayPath;
}
