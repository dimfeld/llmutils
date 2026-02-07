import type { ExecutePlanInfo } from '../types';
import type { TimConfig } from '../../configSchema';
import type { PlanSchema } from '../../planSchema';
import type { DiffResult } from '../../incremental_review';
import type { PlanWithFilename } from '../../utils/hierarchy';
import { resolveTasksDir } from '../../configSchema';
import { readAllPlans } from '../../plans';
import { getParentChain, getCompletedChildren } from '../../utils/hierarchy';
import { generateDiffForReview } from '../../incremental_review';
import { buildReviewPrompt } from '../../commands/review';
import { runReview } from '../../review_runner';
import { createFormatter, type ReviewResult } from '../../formatters/review_formatter';
import { loadRepositoryReviewDoc } from './agent_helpers';
import { warn } from '../../../logging';

export type ReviewVerdict = 'ACCEPTABLE' | 'NEEDS_FIXES';

export interface ReviewHierarchy {
  parentChain: PlanWithFilename[];
  completedChildren: PlanWithFilename[];
}

export interface ExternalReviewOptions {
  planInfo: ExecutePlanInfo;
  gitRoot: string;
  timConfig: TimConfig;
  model?: string;
  planData: PlanSchema;
  parentChain?: PlanWithFilename[];
  completedChildren?: PlanWithFilename[];
  newlyCompletedTitles: string[];
  initiallyCompletedTitles: string[];
  initiallyPendingTitles: string[];
  implementerOutput: string;
  testerOutput?: string;
  executorSelection?: string;
  previousResponse?: string;
}

export interface ExternalReviewResult {
  verdict: ReviewVerdict;
  reviewResult: ReviewResult;
  rawOutput: string;
  formattedOutput: string;
  fixInstructions: string;
  warnings: string[];
}

export async function loadReviewHierarchy(
  planData: PlanSchema,
  planFilePath: string,
  timConfig: TimConfig
): Promise<ReviewHierarchy> {
  const parentChain: PlanWithFilename[] = [];
  const completedChildren: PlanWithFilename[] = [];

  if (!planData.id) {
    return { parentChain, completedChildren };
  }

  const tasksDir = await resolveTasksDir(timConfig);
  const { plans: allPlans } = await readAllPlans(tasksDir);
  const planWithFilename: PlanWithFilename = {
    ...planData,
    filename: planFilePath,
  };

  try {
    parentChain.push(...getParentChain(planWithFilename, allPlans));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Warning: Could not load parent chain for review: ${message}`);
  }

  try {
    completedChildren.push(...getCompletedChildren(planData.id, allPlans));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Warning: Could not load completed child plans for review: ${message}`);
  }

  return { parentChain, completedChildren };
}

export async function runExternalReviewForCodex(
  options: ExternalReviewOptions
): Promise<ExternalReviewResult> {
  const diffResult = await generateDiffForReview(options.gitRoot);
  const { scopedPlanData, taskScopeNote, unmatchedTitles } = applyTaskScope(
    options.planData,
    options.newlyCompletedTitles
  );

  if (unmatchedTitles.length > 0) {
    warn(
      `Review task scope: ${unmatchedTitles.length} task title(s) were not found in the plan and will be ignored: ${unmatchedTitles.join(
        ', '
      )}`
    );
  }

  const executionContext = buildExecutionContextNote({
    implementerOutput: options.implementerOutput,
    testerOutput: options.testerOutput,
    newlyCompletedTitles: options.newlyCompletedTitles,
    initiallyCompletedTitles: options.initiallyCompletedTitles,
    initiallyPendingTitles: options.initiallyPendingTitles,
  });

  const reviewDoc = await loadRepositoryReviewDoc(options.gitRoot, options.timConfig);
  const customInstructions = reviewDoc?.trim() ? reviewDoc.trim() : undefined;

  const parentChain = options.parentChain ?? [];
  const completedChildren = options.completedChildren ?? [];

  const buildPrompt = ({
    includeDiff,
    useSubagents,
  }: {
    includeDiff: boolean;
    useSubagents: boolean;
  }) =>
    buildReviewPrompt(
      scopedPlanData,
      diffResult,
      includeDiff,
      useSubagents,
      parentChain,
      completedChildren,
      customInstructions,
      taskScopeNote,
      executionContext,
      undefined,
      options.previousResponse
    );

  const planInfo = buildPlanInfoForReview(
    options.planInfo,
    scopedPlanData,
    diffResult,
    taskScopeNote
  );

  const shouldSerialBoth =
    options.executorSelection === 'both' ||
    (options.executorSelection == null && options.timConfig.review?.defaultExecutor === 'both');

  const reviewOutput = await runReview({
    executorSelection: options.executorSelection,
    serialBoth: shouldSerialBoth,
    config: options.timConfig,
    sharedExecutorOptions: {
      baseDir: options.gitRoot,
      model: options.model,
    },
    buildPrompt,
    planInfo,
    allowPartialFailures: true,
  });

  if (reviewOutput.warnings.length > 0) {
    reviewOutput.warnings.forEach((warning) => warn(warning));
  }

  const verdict = deriveReviewVerdict(reviewOutput.reviewResult);
  const formattedOutput = formatReviewForDisplay(reviewOutput.reviewResult);
  const fixInstructions = buildFixInstructions(reviewOutput.reviewResult);

  return {
    verdict,
    reviewResult: reviewOutput.reviewResult,
    rawOutput: reviewOutput.rawOutput,
    formattedOutput,
    fixInstructions,
    warnings: reviewOutput.warnings,
  };
}

export function deriveReviewVerdict(reviewResult: ReviewResult): ReviewVerdict {
  const hasBlockingIssues = reviewResult.issues.some((issue) => issue.severity !== 'info');
  return hasBlockingIssues ? 'NEEDS_FIXES' : 'ACCEPTABLE';
}

export function buildFixInstructions(reviewResult: ReviewResult): string {
  if (!reviewResult.issues.length) {
    return 'No issues found.';
  }

  const lines: string[] = ['## Review Issues', ''];

  reviewResult.issues.forEach((issue, index) => {
    const header = `${index + 1}. [${issue.severity.toUpperCase()}][${issue.category}] ${issue.content}`;
    lines.push(header);
    if (issue.file) {
      const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      lines.push(`   File: ${location}`);
    }
    if (issue.suggestion) {
      lines.push(`   Suggestion: ${issue.suggestion}`);
    }
    lines.push('');
  });

  if (reviewResult.recommendations.length > 0) {
    lines.push('## Recommendations');
    reviewResult.recommendations.forEach((rec) => lines.push(`- ${rec}`));
    lines.push('');
  }

  if (reviewResult.actionItems.length > 0) {
    lines.push('## Action Items');
    reviewResult.actionItems.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }

  return lines.join('\n').trim();
}

function formatReviewForDisplay(reviewResult: ReviewResult): string {
  const formatter = createFormatter('markdown');
  return formatter.format(reviewResult, {
    verbosity: 'detailed',
    showFiles: false,
    showSuggestions: true,
  });
}

function buildExecutionContextNote(input: {
  implementerOutput: string;
  testerOutput?: string;
  newlyCompletedTitles: string[];
  initiallyCompletedTitles: string[];
  initiallyPendingTitles: string[];
}): string {
  const sections: string[] = [
    '# Execution Context',
    '',
    'This context summarizes what the Codex implementer/tester reported and the task status at the start of the run.',
    'Use it for reference, but base findings on the plan requirements and code changes.',
    '',
    '## Task Status Before This Run',
    formatTaskList('Completed tasks', input.initiallyCompletedTitles),
    formatTaskList('Pending tasks', input.initiallyPendingTitles),
    '',
    '## Newly Completed Tasks (This Run)',
    formatTaskListInline(input.newlyCompletedTitles),
    '',
    '## Implementer Output',
    input.implementerOutput.trim() || '(no output provided)',
  ];

  if (input.testerOutput !== undefined) {
    sections.push('', '## Tester Output', input.testerOutput.trim() || '(no output provided)');
  } else {
    sections.push('', '## Tester Output', '(tester step not run)');
  }

  return sections.join('\n');
}

function formatTaskList(label: string, titles: string[]): string {
  if (!titles.length) {
    return `- ${label}: (none)`;
  }
  return `- ${label} (${titles.length}):\n  - ${titles.join('\n  - ')}`;
}

function formatTaskListInline(titles: string[]): string {
  if (!titles.length) {
    return '(none)';
  }
  return `- ${titles.join('\n- ')}`;
}

function applyTaskScope(
  planData: PlanSchema,
  newlyCompletedTitles: string[]
): {
  scopedPlanData: PlanSchema;
  taskScopeNote?: string;
  unmatchedTitles: string[];
} {
  if (!newlyCompletedTitles.length || !planData.tasks || planData.tasks.length === 0) {
    return {
      scopedPlanData: planData,
      taskScopeNote: undefined,
      unmatchedTitles: [],
    };
  }

  const normalizedTargets = new Set(newlyCompletedTitles.map((title) => normalizeTitle(title)));
  // Preserve original 1-based indexes when filtering tasks
  const scopedTasks = planData.tasks
    .map((task, index) => ({ ...task, originalIndex: index + 1 }))
    .filter((task) => normalizedTargets.has(normalizeTitle(task.title)));

  const matchedTitles = new Set(scopedTasks.map((task) => normalizeTitle(task.title)));
  const unmatchedTitles = newlyCompletedTitles.filter(
    (title) => !matchedTitles.has(normalizeTitle(title))
  );

  if (scopedTasks.length === 0) {
    return {
      scopedPlanData: planData,
      taskScopeNote: undefined,
      unmatchedTitles,
    };
  }

  const taskScopeNote = `This review is limited to the tasks listed below (${scopedTasks.length} of ${planData.tasks.length}). Other plan tasks are out of scope.`;

  return {
    scopedPlanData: {
      ...planData,
      tasks: scopedTasks,
    },
    taskScopeNote,
    unmatchedTitles,
  };
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function buildPlanInfoForReview(
  planInfo: ExecutePlanInfo,
  planData: PlanSchema,
  diffResult: DiffResult,
  taskScopeNote?: string
) {
  const planId = planData.id?.toString() ?? planInfo.planId ?? 'unknown';
  const planTitle = planData.title ?? planInfo.planTitle ?? 'Untitled Plan';

  return {
    planId,
    planTitle,
    planFilePath: planInfo.planFilePath,
    baseBranch: diffResult.baseBranch,
    changedFiles: diffResult.changedFiles,
    isTaskScoped: !!taskScopeNote,
  };
}
