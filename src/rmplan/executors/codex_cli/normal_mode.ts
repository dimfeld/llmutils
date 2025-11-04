import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { RmplanConfig } from '../../configSchema';
import { captureRepositoryState, getGitRoot } from '../../../common/git';
import { log, warn } from '../../../logging';
import {
  getImplementerPrompt,
  getTesterPrompt,
  getReviewerPrompt,
} from '../claude_code/agent_prompts';
import { readPlanFile } from '../../plans';
import { detectPlanningWithoutImplementation, parseFailedReport } from '../failure_detection';
import { implementationNotesGuidance } from '../claude_code/orchestrator_prompt';
import { loadAgentInstructionsFor, loadRepositoryReviewDoc } from './agent_helpers';
import { executeCodexStep } from './codex_runner';
import {
  categorizeTasks,
  logTaskStatus,
  parseCompletedTasksFromImplementer,
  markTasksAsDone,
} from './task_management';
import {
  composeTesterContext,
  composeReviewerContext,
  composeFixReviewContext,
  getFixerPrompt,
} from './context_composition';
import { parseReviewerVerdict } from './verdict_parser';

type AgentType = 'implementer' | 'tester' | 'reviewer' | 'fixer';

export async function executeNormalMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  rmplanConfig: RmplanConfig
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
  const hasPlanFilePath = planInfo.planFilePath.trim().length > 0;
  const hasPlanId = planInfo.planId.trim().length > 0;
  const planContextAvailable = hasPlanFilePath && hasPlanId;

  let initiallyCompleted: Array<{ title: string }> = [];
  let initiallyPending: Array<{ title: string }> = [];

  if (planContextAvailable) {
    const planData = await readPlanFile(planInfo.planFilePath);
    ({ completed: initiallyCompleted, pending: initiallyPending } = categorizeTasks(planData));

    logTaskStatus('Initial plan analysis', initiallyCompleted, initiallyPending, gitRoot);
  }

  // Track failure state across agents
  let hadFailure = false;
  let failureOutput: string | undefined;

  // Build implementer prompt using the Claude Code agent prompt for consistency
  let implementerInstructions = await loadAgentInstructionsFor(
    'implementer',
    gitRoot,
    rmplanConfig
  );
  implementerInstructions =
    (implementerInstructions || '') +
    `\n\nOnce you decide how to go about implementing the tasks, do so immediately. No need to wait for approval.\n\n` +
    implementationNotesGuidance(planInfo.planFilePath, planInfo.planId) +
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
      model
    );

    log(`Running implementer step${attempt > 0 ? ` (attempt ${attemptNumber})` : ''}...`);
    const attemptOutput = await executeCodexStep(implementerPrompt.prompt, gitRoot, rmplanConfig);
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
      model
    );

    // Execute tester step
    log('Running tester step...');
    const testerOutput = await executeCodexStep(tester.prompt, gitRoot, rmplanConfig);
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

    // Build reviewer context with implementer + tester outputs and task context
    const reviewerContext = composeReviewerContext(
      contextContent,
      finalImplementerOutput,
      testerOutput,
      initiallyCompleted.map((t) => t.title),
      initiallyPending.map((t) => t.title)
    );
    const reviewerInstructions = await loadAgentInstructionsFor('reviewer', gitRoot, rmplanConfig);
    const reviewer = getReviewerPrompt(
      reviewerContext,
      planContextAvailable ? planInfo.planId : undefined,
      reviewerInstructions,
      model,
      false, // useSubagents
      true // includeTaskCompletionInstructions
    );

    // Execute reviewer step
    log('Running reviewer step...');
    const reviewerOutput = await executeCodexStep(reviewer.prompt, gitRoot, rmplanConfig);
    events.push({ type: 'reviewer', message: reviewerOutput });
    log('Reviewer output captured.');

    // Failure detection: reviewer
    {
      const parsed = parseFailedReport(reviewerOutput);
      if (parsed.failed) {
        hadFailure = true;
        failureOutput = reviewerOutput;
        const aggregated = buildAggregatedOutput();
        return {
          ...(aggregated ?? { content: reviewerOutput }),
          success: false,
          failureDetails: parsed.details
            ? { ...parsed.details, sourceAgent: 'reviewer' }
            : { requirements: '', problems: parsed.summary || 'FAILED', sourceAgent: 'reviewer' },
        };
      }
    }

    // Parse and log verdict
    const verdict = parseReviewerVerdict(reviewerOutput);
    if (verdict === 'ACCEPTABLE') {
      log('Review verdict: ACCEPTABLE');
      const aggregated = buildAggregatedOutput();
      if (aggregated != null) return aggregated;
      return;
    } else {
      if (verdict === 'NEEDS_FIXES') {
        log('Review verdict: NEEDS_FIXES');
      } else {
        log(`Failed to parse review verdict, treating as 'NEEDS_FIXES'`);
      }

      const reviewDoc = await loadRepositoryReviewDoc(gitRoot, rmplanConfig);

      /*
      // Analyze whether the flagged issues are in-scope and require fixes now
      const analysis = await analyzeReviewFeedback({
        reviewerOutput: reviewerOutput,
        completedTasks: initiallyCompleted.map((t) => t.title),
        pendingTasks: initiallyPending.map((t) => t.title),
        finalImplementerOutput,
        repoReviewDoc: reviewDoc,
      });

      if (!analysis.needs_fixes) {
        log('Review analysis: Issues are out-of-scope or non-blocking. Exiting without fixes.');
        const aggregated = buildAggregatedOutput();
        if (aggregated != null) return aggregated;
        return;
      }

      let fixInstructions = analysis.fix_instructions || reviewerOutput;

      log('Review analysis: Fixes required.');
      if (analysis.fix_instructions) {
        log(`Fix instructions: ${analysis.fix_instructions}`);
      }
      */
      // Disabled the above and we're just using the raw reviewer output for now.
      // The review analysis step is not smart enough and is skipping real feedback.
      let fixInstructions = reviewerOutput;

      // Implement fix-and-review loop (up to 5 iterations)
      const maxFixIterations = 5;
      let lastFixerOutput = '';
      let finalReviewerOutput = reviewerOutput;
      for (let iter = 1; iter <= maxFixIterations; iter++) {
        log(`Starting fix iteration ${iter}/${maxFixIterations}...`);

        const fixerPrompt = getFixerPrompt({
          planPath: planInfo.planFilePath,
          planId: planInfo.planId,
          implementerOutput: finalImplementerOutput,
          testerOutput,
          completedTaskTitles: initiallyCompleted.map((t) => t.title),
          fixInstructions,
        });

        const fixerOutput = await executeCodexStep(fixerPrompt, gitRoot, rmplanConfig);
        lastFixerOutput = fixerOutput;
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

        // Re-run reviewer with updated context including fixer output
        const rerunReviewerContext = composeFixReviewContext(
          contextContent,
          finalImplementerOutput,
          testerOutput,
          initiallyCompleted.map((t) => t.title),
          initiallyPending.map((t) => t.title),
          fixInstructions,
          fixerOutput,
          reviewerInstructions,
          planContextAvailable ? planInfo.planId : undefined
        );

        const rerunReviewerOutput = await executeCodexStep(
          rerunReviewerContext,
          gitRoot,
          rmplanConfig
        );
        finalReviewerOutput = rerunReviewerOutput;
        events.push({ type: 'reviewer', message: rerunReviewerOutput });

        // Parse verdict from the latest reviewer output (not the initial one)
        const verdict = parseReviewerVerdict(rerunReviewerOutput);

        /*
        const newAnalysis =
          verdict === 'ACCEPTABLE'
            ? { needs_fixes: false }
            : await analyzeReviewFeedback({
                reviewerOutput: rerunReviewerOutput,
                completedTasks: initiallyCompleted.map((t) => t.title),
                pendingTasks: initiallyPending.map((t) => t.title),
                fixerOutput,
                repoReviewDoc: reviewDoc,
              });
        */
        // Disabled above for now since review analysis is skipping real issues.

        const newAnalysis = {
          needs_fixes: verdict !== 'ACCEPTABLE',
          fix_instructions: rerunReviewerOutput,
        };

        if (!newAnalysis.needs_fixes) {
          log(`Review verdict after fixes (iteration ${iter}): ACCEPTABLE`);
          const aggregated = buildAggregatedOutput();
          if (aggregated != null) return aggregated;
          return;
        }

        log(`Review verdict after fixes (iteration ${iter}): NEEDS_FIXES`);
        if (newAnalysis.fix_instructions) {
          log(`Fix instructions: ${newAnalysis.fix_instructions}`);
        }

        // Give it the new fix instructions and continue
        fixInstructions = newAnalysis.fix_instructions || rerunReviewerOutput;
        continue;
      }

      warn(
        'Maximum fix iterations reached (5) and reviewer still reports issues. Exiting with warnings.'
      );
      // Even if still needs fixes, provide the latest reviewer output when capturing
      const aggregated = buildAggregatedOutput();
      if (aggregated != null) return aggregated;
    }
  } finally {
    if (!hadFailure && planContextAvailable && newlyCompletedTitles.length > 0) {
      await markTasksAsDone(planInfo.planFilePath, newlyCompletedTitles, gitRoot, rmplanConfig);
    } else if (hadFailure) {
      warn('Skipping automatic task completion marking due to executor failure.');
    }
  }
}
