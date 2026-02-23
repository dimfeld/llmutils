import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { TimConfig } from '../../configSchema';
import type { PlanSchema } from '../../planSchema';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas';
import { captureRepositoryState, getGitRoot } from '../../../common/git';
import { log, sendStructured, warn } from '../../../logging';
import { getImplementerPrompt } from '../claude_code/agent_prompts';
import { readPlanFile } from '../../plans';
import { detectPlanningWithoutImplementation, parseFailedReport } from '../failure_detection';
import { loadAgentInstructionsFor, timestamp } from './agent_helpers';
import { executeCodexStep } from './codex_runner';
import { sendStructuredReviewResult } from './review_message';
import {
  categorizeTasks,
  logTaskStatus,
  parseCompletedTasksFromImplementer,
  markTasksAsDone,
  appendReviewNotesToPlan,
} from './task_management';
import { getFixerPrompt } from './context_composition';
import {
  loadReviewHierarchy,
  runExternalReviewForCodex,
  type ReviewHierarchy,
  type ReviewVerdict,
} from './external_review';

type AgentType = 'implementer' | 'verifier';
function emitFailureReport(
  sourceAgent: 'implementer' | 'fixer',
  parsed: Extract<ReturnType<typeof parseFailedReport>, { failed: true }>
): void {
  sendStructured({
    type: 'failure_report',
    timestamp: timestamp(),
    summary: parsed.summary || 'FAILED',
    requirements: parsed.details?.requirements,
    problems: parsed.details?.problems,
    solutions: parsed.details?.solutions,
    sourceAgent,
  });
}

export async function executeSimpleMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  timConfig: TimConfig,
  reviewExecutor?: string
): Promise<void | ExecutorOutput> {
  const events: Array<{ type: AgentType; message: string }> = [];

  const buildAggregatedOutput = (): ExecutorOutput | undefined => {
    if (planInfo.captureOutput !== 'all' && planInfo.captureOutput !== 'result') return undefined;
    const steps: Array<{ title: string; body: string }> = [];
    const counters: Record<AgentType, number> = {
      implementer: 0,
      verifier: 0,
    };
    for (const event of events) {
      counters[event.type]++;
      const attempt = counters[event.type];
      const prettyType = event.type === 'implementer' ? 'Codex Implementer' : 'Codex Verifier';
      const title = attempt === 1 ? prettyType : `${prettyType} #${attempt}`;
      steps.push({ title, body: event.message.trim() });
    }
    const last = events[events.length - 1];
    const content = (last?.message || '').trim();
    return { content, steps };
  };

  const gitRoot = await getGitRoot(baseDir);

  // Get default reasoning level from config
  const codexOptions = timConfig.executors?.[CodexCliExecutorName];
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

    logTaskStatus(
      'Initial plan analysis (simple mode)',
      initiallyCompleted,
      initiallyPending,
      gitRoot
    );

    try {
      reviewHierarchy = await loadReviewHierarchy(planData, planInfo.planFilePath, timConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Warning: Could not load review hierarchy context: ${message}`);
    }
  }

  let hadFailure = false;
  let finalReviewVerdict: ReviewVerdict | undefined;

  let implementerInstructions = await loadAgentInstructionsFor('implementer', gitRoot, timConfig);
  implementerInstructions =
    (implementerInstructions || '') +
    `\n\nCreate a plan for the tasks, and then implement that plan. Once you decide on the plan, implement it immediately. No need to ask for approval.` +
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

    sendStructured({
      type: 'agent_step_start',
      timestamp: timestamp(),
      phase: 'implementer',
      attempt: attemptNumber,
      message: `Running implementer step${attempt > 0 ? ` (attempt ${attemptNumber})` : ''}...`,
    });
    const attemptOutput = await executeCodexStep(implementerPrompt.prompt, gitRoot, timConfig, {
      model,
      reasoningLevel: defaultReasoningLevel,
    });
    events.push({ type: 'implementer', message: attemptOutput });
    const parsed = parseFailedReport(attemptOutput);
    sendStructured({
      type: 'agent_step_end',
      timestamp: timestamp(),
      phase: 'implementer',
      success: !parsed.failed,
      summary: parsed.failed
        ? `Implementer reported failure: ${parsed.summary || 'FAILED'}`
        : 'Implementer output captured.',
    });

    if (parsed.failed) {
      hadFailure = true;
      emitFailureReport('implementer', parsed);
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
        `Implementer planned without executing changes after exhausting ${totalImplementerAttempts} attempts; continuing to verifier.`
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
    // Parse completed tasks from implementer output to pass to verifier
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
      sendStructured({
        type: 'agent_step_start',
        timestamp: timestamp(),
        phase: 'reviewer',
        message: 'Running external review step...',
      });
      reviewOutcome = await runExternalReviewForCodex({
        planInfo,
        gitRoot,
        timConfig,
        model,
        planData,
        parentChain: reviewHierarchy.parentChain,
        completedChildren: reviewHierarchy.completedChildren,
        newlyCompletedTitles,
        initiallyCompletedTitles,
        initiallyPendingTitles,
        implementerOutput: finalImplementerOutput,
        executorSelection: reviewExecutor,
      });
    } catch (error) {
      hadFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      sendStructured({
        type: 'agent_step_end',
        timestamp: timestamp(),
        phase: 'reviewer',
        success: false,
        summary: message,
      });
      const aggregated = buildAggregatedOutput();
      return {
        ...(aggregated ?? { content: message }),
        success: false,
        failureDetails: {
          requirements: '',
          problems: message,
          sourceAgent: 'verifier',
        },
      };
    }

    events.push({ type: 'verifier', message: reviewOutcome.formattedOutput });
    sendStructured({
      type: 'agent_step_end',
      timestamp: timestamp(),
      phase: 'reviewer',
      success: true,
      summary: 'Verifier output captured.',
    });

    if (reviewOutcome.verdict === 'ACCEPTABLE') {
      finalReviewVerdict = 'ACCEPTABLE';
      sendStructuredReviewResult(reviewOutcome);
      const aggregated = buildAggregatedOutput();
      if (aggregated != null) return aggregated;
      return;
    }

    finalReviewVerdict = 'NEEDS_FIXES';
    sendStructuredReviewResult(reviewOutcome);
    log(`Issues: ${reviewOutcome.fixInstructions}`);
    let fixInstructions = reviewOutcome.fixInstructions;

    // Implement fix-and-review loop (up to 5 iterations)
    const maxFixIterations = 5;
    for (let iter = 1; iter <= maxFixIterations; iter++) {
      sendStructured({
        type: 'agent_step_start',
        timestamp: timestamp(),
        phase: 'fixer',
        stepNumber: iter,
        message: `Starting fix iteration ${iter}/${maxFixIterations}...`,
      });

      const fixerPrompt = getFixerPrompt({
        planPath: planInfo.planFilePath,
        planId: planInfo.planId,
        implementerOutput: finalImplementerOutput,
        testerOutput: '', // Simple mode has no separate tester output
        completedTaskTitles: initiallyCompletedTitles,
        fixInstructions,
      });

      const fixerOutput = await executeCodexStep(fixerPrompt, gitRoot, timConfig, {
        model,
        reasoningLevel: defaultReasoningLevel,
      });
      events.push({ type: 'verifier', message: fixerOutput });
      const fixerFailure = parseFailedReport(fixerOutput);
      sendStructured({
        type: 'agent_step_end',
        timestamp: timestamp(),
        phase: 'fixer',
        success: !fixerFailure.failed,
        summary: fixerFailure.failed
          ? `Fixer reported failure: ${fixerFailure.summary || 'FAILED'}`
          : 'Fixer output captured. Re-running verifier...',
      });

      // Failure detection: fixer
      {
        if (fixerFailure.failed) {
          hadFailure = true;
          emitFailureReport('fixer', fixerFailure);
          const aggregated = buildAggregatedOutput();
          return {
            ...(aggregated ?? { content: fixerOutput }),
            success: false,
            failureDetails: fixerFailure.details
              ? { ...fixerFailure.details, sourceAgent: 'fixer' }
              : {
                  requirements: '',
                  problems: fixerFailure.summary || 'FAILED',
                  sourceAgent: 'fixer',
                },
          };
        }
      }

      sendStructured({
        type: 'agent_step_start',
        timestamp: timestamp(),
        phase: 'reviewer',
        message: 'Re-running reviewer after fixer output...',
      });
      try {
        reviewOutcome = await runExternalReviewForCodex({
          planInfo,
          gitRoot,
          timConfig,
          model,
          planData,
          parentChain: reviewHierarchy.parentChain,
          completedChildren: reviewHierarchy.completedChildren,
          newlyCompletedTitles,
          initiallyCompletedTitles,
          initiallyPendingTitles,
          implementerOutput: finalImplementerOutput,
          previousResponse: fixerOutput,
          executorSelection: reviewExecutor,
        });
      } catch (error) {
        hadFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        sendStructured({
          type: 'agent_step_end',
          timestamp: timestamp(),
          phase: 'reviewer',
          success: false,
          summary: message,
        });
        const aggregated = buildAggregatedOutput();
        return {
          ...(aggregated ?? { content: message }),
          success: false,
          failureDetails: {
            requirements: '',
            problems: message,
            sourceAgent: 'verifier',
          },
        };
      }

      events.push({ type: 'verifier', message: reviewOutcome.formattedOutput });
      sendStructured({
        type: 'agent_step_end',
        timestamp: timestamp(),
        phase: 'reviewer',
        success: true,
        summary: 'Verifier output captured.',
      });

      if (reviewOutcome.verdict === 'ACCEPTABLE') {
        finalReviewVerdict = 'ACCEPTABLE';
        sendStructuredReviewResult(reviewOutcome);
        const aggregated = buildAggregatedOutput();
        if (aggregated != null) return aggregated;
        return;
      }

      finalReviewVerdict = 'NEEDS_FIXES';
      sendStructuredReviewResult(reviewOutcome);
      fixInstructions = reviewOutcome.fixInstructions;
      continue;
    }

    warn(
      'Maximum fix iterations reached (5) and verifier still reports issues. Exiting with warnings.'
    );
    finalReviewVerdict = 'NEEDS_FIXES';
    // Even if still needs fixes, provide the latest verifier output when capturing
    const aggregated = buildAggregatedOutput();
    if (aggregated != null) return aggregated;
  } finally {
    if (
      !hadFailure &&
      planContextAvailable &&
      newlyCompletedTitles.length > 0 &&
      (finalReviewVerdict === 'ACCEPTABLE' || finalReviewVerdict === 'NEEDS_FIXES')
    ) {
      await markTasksAsDone(planInfo.planFilePath, newlyCompletedTitles, gitRoot, timConfig);
      if (finalReviewVerdict === 'NEEDS_FIXES') {
        const lastReviewMessage = [...events].reverse().find((e) => e.type === 'verifier')?.message;
        if (lastReviewMessage) {
          await appendReviewNotesToPlan(
            planInfo.planFilePath,
            lastReviewMessage,
            newlyCompletedTitles
          );
        }
      }
    } else if (hadFailure) {
      warn('Skipping automatic task completion marking due to executor failure.');
    }
  }
}
