import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { RmplanConfig } from '../../configSchema';
import type { PlanSchema } from '../../planSchema';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas';
import { captureRepositoryState, getGitRoot } from '../../../common/git';
import { log, warn } from '../../../logging';
import { getImplementerPrompt, getTesterPrompt } from '../claude_code/agent_prompts';
import { readPlanFile } from '../../plans';
import { detectPlanningWithoutImplementation, parseFailedReport } from '../failure_detection';
import { loadAgentInstructionsFor } from './agent_helpers';
import { executeCodexStep } from './codex_runner';
import {
  categorizeTasks,
  logTaskStatus,
  parseCompletedTasksFromImplementer,
  markTasksAsDone,
} from './task_management';
import { composeTesterContext, getFixerPrompt } from './context_composition';
import {
  loadReviewHierarchy,
  runExternalReviewForCodex,
  type ReviewHierarchy,
  type ReviewVerdict,
} from './external_review';

type AgentType = 'implementer' | 'tester' | 'reviewer' | 'fixer';

export async function executeNormalMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  rmplanConfig: RmplanConfig,
  reviewExecutor?: string
): Promise<void | ExecutorOutput> {
  // Accumulate every piece of output across all steps/iterations
  const events: Array<{ type: AgentType; message: string }> = [];

  // Helper to optionally return structured output when captureOutput is enabled
  const buildAggregatedOutput = (): ExecutorOutput | undefined => {
    if (planInfo.captureOutput !== 'all' && planInfo.captureOutput !== 'result') return undefined;
    const steps: Array<{ title: string; body: string }> = [];
    const counters: Record<AgentType, number> = {
      implementer: 0,
      tester: 0,
      reviewer: 0,
      fixer: 0,
    };
    for (const e of events) {
      counters[e.type]++;
      const n = counters[e.type];
      const prettyType =
        e.type === 'implementer'
          ? 'Codex Implementer'
          : e.type === 'tester'
            ? 'Codex Tester'
            : e.type === 'reviewer'
              ? 'Codex Reviewer'
              : 'Codex Fixer';
      const title = n === 1 ? prettyType : `${prettyType} #${n}`;
      steps.push({ title, body: e.message.trim() });
    }
    const lastReviewer = [...events].reverse().find((e) => e.type === 'reviewer');
    const lastAny = events[events.length - 1];
    const content = (lastReviewer?.message || lastAny?.message || '').trim();
    // Provide structured steps preferred by summary; keep `content` as fallback.
    return { content, steps };
  };
  // Analyze plan file to understand completed vs pending tasks
  const gitRoot = await getGitRoot(baseDir);

  // Get default reasoning level from config
  const codexOptions = rmplanConfig.executors?.[CodexCliExecutorName];
  const defaultReasoningLevel: CodexReasoningLevel = codexOptions?.reasoning?.default ?? 'medium';

  const hasPlanFilePath = planInfo.planFilePath.trim().length > 0;
  const hasPlanId = planInfo.planId.trim().length > 0;
  const planContextAvailable = hasPlanFilePath && hasPlanId;

  let initiallyCompleted: Array<{ title: string }> = [];
  let initiallyPending: Array<{ title: string }> = [];
  let planData: PlanSchema | undefined;
  let reviewHierarchy: ReviewHierarchy = { parentChain: [], completedChildren: [] };

  if (planContextAvailable) {
    planData = await readPlanFile(planInfo.planFilePath);
    ({ completed: initiallyCompleted, pending: initiallyPending } = categorizeTasks(planData));

    logTaskStatus('Initial plan analysis', initiallyCompleted, initiallyPending, gitRoot);

    try {
      reviewHierarchy = await loadReviewHierarchy(planData, planInfo.planFilePath, rmplanConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Warning: Could not load review hierarchy context: ${message}`);
    }
  }

  // Track failure state across agents
  let hadFailure = false;
  let failureOutput: string | undefined;
  let finalReviewVerdict: ReviewVerdict | undefined;

  // Build implementer prompt using the Claude Code agent prompt for consistency
  let implementerInstructions = await loadAgentInstructionsFor(
    'implementer',
    gitRoot,
    rmplanConfig
  );
  implementerInstructions =
    (implementerInstructions || '') +
    `\n\nOnce you decide how to go about implementing the tasks, do so immediately. No need to wait for approval.` +
    `\n\nIn your final message, be sure to include the titles of the tasks that you completed.`;

  const retryInstructionSuffixes = [
    'Please implement the changes now, not just plan them.',
    'IMPORTANT: Execute the actual code changes immediately.',
    'CRITICAL: You must write actual code files NOW.',
  ];
  const maxRetries = retryInstructionSuffixes.length;
  const totalImplementerAttempts = maxRetries + 1;
  const planningOnlyAttempts: number[] = [];
  let planningDetectionResolutionLogged = false;

  let implementerOutput: string | undefined;
  let implementerStateBefore = await captureRepositoryState(gitRoot);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptNumber = attempt + 1;
    const extraInstructions =
      attempt === 0
        ? ''
        : `\n\n${retryInstructionSuffixes[Math.min(attempt - 1, retryInstructionSuffixes.length - 1)]}`;
    const implementerPrompt = getImplementerPrompt(
      contextContent,
      planContextAvailable ? planInfo.planId : undefined,
      implementerInstructions + extraInstructions,
      model,
      {
        mode: 'update',
        planFilePath: planContextAvailable ? planInfo.planFilePath : undefined,
        useAtPrefix: false,
      }
    );

    log(`Running implementer step${attempt > 0 ? ` (attempt ${attemptNumber})` : ''}...`);
    const attemptOutput = await executeCodexStep(implementerPrompt.prompt, gitRoot, rmplanConfig, {
      reasoningLevel: defaultReasoningLevel,
    });
    events.push({ type: 'implementer', message: attemptOutput });
    log('Implementer output captured.');

    const parsed = parseFailedReport(attemptOutput);
    if (parsed.failed) {
      hadFailure = true;
      failureOutput = attemptOutput;
      const aggregated = buildAggregatedOutput();
      return {
        ...(aggregated ?? { content: attemptOutput }),
        success: false,
        failureDetails: parsed.details
          ? { ...parsed.details, sourceAgent: 'implementer' }
          : {
              requirements: '',
              problems: parsed.summary || 'FAILED',
              sourceAgent: 'implementer',
            },
      };
    }

    const implementerStateAfter = await captureRepositoryState(gitRoot);
    const planningDetection = detectPlanningWithoutImplementation(
      attemptOutput,
      implementerStateBefore,
      implementerStateAfter
    );

    if (planningDetection.repositoryStatusUnavailable) {
      warn(
        `Could not verify repository state after implementer attempt ${attemptNumber}/${totalImplementerAttempts}; skipping planning-only detection for this attempt.`
      );
    }

    if (planningDetection.detected) {
      planningOnlyAttempts.push(attemptNumber);
      const indicatorPreview = planningDetection.planningIndicators
        .slice(0, 2)
        .map((line) => line.slice(0, 120));
      const indicatorText =
        indicatorPreview.length > 0 ? indicatorPreview.join(' | ') : '<no indicators captured>';
      warn(
        `Implementer attempt ${attemptNumber}/${totalImplementerAttempts} produced planning output without repository changes (commit changed: ${planningDetection.commitChanged}, working tree changed: ${planningDetection.workingTreeChanged}). Indicators: ${indicatorText}`
      );
    }

    if (planningDetection.detected && attempt < maxRetries) {
      log(
        `Retrying implementer with more explicit instructions (attempt ${attemptNumber + 1}/${totalImplementerAttempts})...`
      );
      implementerStateBefore = implementerStateAfter;
      continue;
    }

    if (planningDetection.detected && attempt === maxRetries) {
      warn(
        `Implementer planned without executing changes after exhausting ${totalImplementerAttempts} attempts; continuing to tester.`
      );
    }

    if (
      planningOnlyAttempts.length > 0 &&
      !planningDetection.detected &&
      !planningDetection.repositoryStatusUnavailable &&
      !planningDetectionResolutionLogged
    ) {
      const retriesUsed = planningOnlyAttempts.length;
      const resolvedAttempt = attemptNumber;
      log(
        `Implementer produced repository changes after ${retriesUsed} planning-only attempt${retriesUsed === 1 ? '' : 's'} (resolved on attempt ${resolvedAttempt}/${totalImplementerAttempts}).`
      );
      planningDetectionResolutionLogged = true;
    }

    implementerOutput = attemptOutput;
    implementerStateBefore = implementerStateAfter;
    break;
  }

  const finalImplementerOutput =
    implementerOutput ?? events.filter((e) => e.type === 'implementer').pop()?.message ?? '';

  let newlyCompletedTitles: string[] = [];
  try {
    // Parse completed tasks from implementer output
    if (planContextAvailable) {
      newlyCompletedTitles = await parseCompletedTasksFromImplementer(
        finalImplementerOutput,
        planInfo,
        gitRoot
      );
      if (newlyCompletedTitles.length > 0) {
        log(
          `Identified ${newlyCompletedTitles.length} completed task(s): ${newlyCompletedTitles.join(', ')}`
        );
      }
    }

    // Build tester context: include implementer output and focus tasks
    const testerContext = composeTesterContext(
      contextContent,
      finalImplementerOutput,
      newlyCompletedTitles
    );
    const testerInstructions = await loadAgentInstructionsFor('tester', gitRoot, rmplanConfig);
    const tester = getTesterPrompt(
      testerContext,
      planContextAvailable ? planInfo.planId : undefined,
      testerInstructions,
      model,
      {
        mode: 'update',
        planFilePath: planContextAvailable ? planInfo.planFilePath : undefined,
        useAtPrefix: false,
      }
    );

    // Execute tester step
    log('Running tester step...');
    const testerOutput = await executeCodexStep(tester.prompt, gitRoot, rmplanConfig, {
      reasoningLevel: defaultReasoningLevel,
    });
    events.push({ type: 'tester', message: testerOutput });
    log('Tester output captured.');

    // Failure detection: tester
    {
      const parsed = parseFailedReport(testerOutput);
      if (parsed.failed) {
        hadFailure = true;
        failureOutput = testerOutput;
        const aggregated = buildAggregatedOutput();
        return {
          ...(aggregated ?? { content: testerOutput }),
          success: false,
          failureDetails: parsed.details
            ? { ...parsed.details, sourceAgent: 'tester' }
            : { requirements: '', problems: parsed.summary || 'FAILED', sourceAgent: 'tester' },
        };
      }
    }

    if (!planContextAvailable || !planData) {
      warn('Skipping external review because plan context is unavailable.');
      const aggregated = buildAggregatedOutput();
      if (aggregated != null) return aggregated;
      return;
    }

    const initiallyCompletedTitles = initiallyCompleted.map((t) => t.title);
    const initiallyPendingTitles = initiallyPending.map((t) => t.title);

    let reviewOutcome;
    try {
      log('Running external review step...');
      reviewOutcome = await runExternalReviewForCodex({
        planInfo,
        gitRoot,
        rmplanConfig,
        model,
        planData,
        parentChain: reviewHierarchy.parentChain,
        completedChildren: reviewHierarchy.completedChildren,
        newlyCompletedTitles,
        initiallyCompletedTitles,
        initiallyPendingTitles,
        implementerOutput: finalImplementerOutput,
        testerOutput,
        executorSelection: reviewExecutor,
      });
    } catch (error) {
      hadFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      failureOutput = message;
      const aggregated = buildAggregatedOutput();
      return {
        ...(aggregated ?? { content: message }),
        success: false,
        failureDetails: {
          requirements: '',
          problems: message,
          sourceAgent: 'reviewer',
        },
      };
    }

    events.push({ type: 'reviewer', message: reviewOutcome.formattedOutput });
    log('Reviewer output captured.');

    if (reviewOutcome.verdict === 'ACCEPTABLE') {
      finalReviewVerdict = 'ACCEPTABLE';
      log('Review verdict: ACCEPTABLE');
      const aggregated = buildAggregatedOutput();
      if (aggregated != null) return aggregated;
      return;
    }

    finalReviewVerdict = 'NEEDS_FIXES';
    log('Review verdict: NEEDS_FIXES');
    log(`Issues: ${reviewOutcome.fixInstructions}`);

    let fixInstructions = reviewOutcome.fixInstructions;

    // Implement fix-and-review loop (up to 5 iterations)
    const maxFixIterations = 5;
    for (let iter = 1; iter <= maxFixIterations; iter++) {
      log(`Starting fix iteration ${iter}/${maxFixIterations}...`);

      const fixerPrompt = getFixerPrompt({
        planPath: planInfo.planFilePath,
        planId: planInfo.planId,
        implementerOutput: finalImplementerOutput,
        testerOutput,
        completedTaskTitles: initiallyCompletedTitles,
        fixInstructions,
      });

      const fixerOutput = await executeCodexStep(fixerPrompt, gitRoot, rmplanConfig, {
        reasoningLevel: defaultReasoningLevel,
      });
      events.push({ type: 'fixer', message: fixerOutput });
      log('Fixer output captured. Re-running reviewer...');

      // Failure detection: fixer
      {
        const parsed = parseFailedReport(fixerOutput);
        if (parsed.failed) {
          hadFailure = true;
          failureOutput = fixerOutput;
          const aggregated = buildAggregatedOutput();
          return {
            ...(aggregated ?? { content: fixerOutput }),
            success: false,
            failureDetails: parsed.details
              ? { ...parsed.details, sourceAgent: 'fixer' }
              : {
                  requirements: '',
                  problems: parsed.summary || 'FAILED',
                  sourceAgent: 'fixer',
                },
          };
        }
      }

      try {
        reviewOutcome = await runExternalReviewForCodex({
          planInfo,
          gitRoot,
          rmplanConfig,
          model,
          planData,
          parentChain: reviewHierarchy.parentChain,
          completedChildren: reviewHierarchy.completedChildren,
          newlyCompletedTitles,
          initiallyCompletedTitles,
          initiallyPendingTitles,
          implementerOutput: finalImplementerOutput,
          testerOutput,
          executorSelection: reviewExecutor,
        });
      } catch (error) {
        hadFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        failureOutput = message;
        const aggregated = buildAggregatedOutput();
        return {
          ...(aggregated ?? { content: message }),
          success: false,
          failureDetails: {
            requirements: '',
            problems: message,
            sourceAgent: 'reviewer',
          },
        };
      }

      events.push({ type: 'reviewer', message: reviewOutcome.formattedOutput });

      if (reviewOutcome.verdict === 'ACCEPTABLE') {
        finalReviewVerdict = 'ACCEPTABLE';
        log(`Review verdict after fixes (iteration ${iter}): ACCEPTABLE`);
        const aggregated = buildAggregatedOutput();
        if (aggregated != null) return aggregated;
        return;
      }

      finalReviewVerdict = 'NEEDS_FIXES';
      log(`Review verdict after fixes (iteration ${iter}): NEEDS_FIXES`);
      log(`Issues: ${reviewOutcome.fixInstructions}`);
      fixInstructions = reviewOutcome.fixInstructions;
      continue;
    }

    warn(
      'Maximum fix iterations reached (5) and reviewer still reports issues. Exiting with warnings.'
    );
    finalReviewVerdict = 'NEEDS_FIXES';
    // Even if still needs fixes, provide the latest reviewer output when capturing
    const aggregated = buildAggregatedOutput();
    if (aggregated != null) return aggregated;
  } finally {
    if (
      !hadFailure &&
      planContextAvailable &&
      newlyCompletedTitles.length > 0 &&
      finalReviewVerdict === 'ACCEPTABLE'
    ) {
      await markTasksAsDone(planInfo.planFilePath, newlyCompletedTitles, gitRoot, rmplanConfig);
    } else if (!hadFailure && finalReviewVerdict === 'NEEDS_FIXES') {
      warn('Skipping automatic task completion marking due to unresolved review issues.');
    } else if (hadFailure) {
      warn('Skipping automatic task completion marking due to executor failure.');
    }
  }
}
