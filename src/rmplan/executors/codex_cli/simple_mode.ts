import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { RmplanConfig } from '../../configSchema';
import { captureRepositoryState, getGitRoot } from '../../../common/git';
import { log, warn } from '../../../logging';
import { getImplementerPrompt, getVerifierAgentPrompt } from '../claude_code/agent_prompts';
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
import { composeVerifierContext, getFixerPrompt } from './context_composition';
import { parseReviewerVerdict } from './verdict_parser';

type AgentType = 'implementer' | 'verifier';

export async function executeSimpleMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  rmplanConfig: RmplanConfig
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
  const hasPlanFilePath = planInfo.planFilePath.trim().length > 0;
  const hasPlanId = planInfo.planId.trim().length > 0;
  const planContextAvailable = hasPlanFilePath && hasPlanId;

  let initiallyCompleted: Array<{ title: string }> = [];
  let initiallyPending: Array<{ title: string }> = [];
  if (planContextAvailable) {
    const planData = await readPlanFile(planInfo.planFilePath);
    ({ completed: initiallyCompleted, pending: initiallyPending } = categorizeTasks(planData));

    logTaskStatus(
      'Initial plan analysis (simple mode)',
      initiallyCompleted,
      initiallyPending,
      gitRoot
    );
  }

  let hadFailure = false;

  let implementerInstructions = await loadAgentInstructionsFor(
    'implementer',
    gitRoot,
    rmplanConfig
  );
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

    log(`Running implementer step${attempt > 0 ? ` (attempt ${attemptNumber})` : ''}...`);
    const attemptOutput = await executeCodexStep(implementerPrompt.prompt, gitRoot, rmplanConfig);
    events.push({ type: 'implementer', message: attemptOutput });
    log('Implementer output captured.');

    const parsed = parseFailedReport(attemptOutput);
    if (parsed.failed) {
      hadFailure = true;
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

    const testerInstructions = await loadAgentInstructionsFor('tester', gitRoot, rmplanConfig);
    const reviewerInstructions = await loadAgentInstructionsFor('reviewer', gitRoot, rmplanConfig);
    const verifierInstructions =
      [testerInstructions, reviewerInstructions]
        .map((section) => section?.trim())
        .filter((section): section is string => Boolean(section && section.length > 0))
        .join('\n\n') || undefined;

    const verifierPrompt = getVerifierAgentPrompt(
      composeVerifierContext(
        contextContent,
        finalImplementerOutput,
        newlyCompletedTitles,
        initiallyCompleted.map((t) => t.title),
        initiallyPending.map((t) => t.title)
      ),
      planContextAvailable ? planInfo.planId : undefined,
      verifierInstructions,
      model,
      false, // includeTaskCompletionInstructions - we mark tasks ourselves
      true, // includeVerdictInstructions - request a verdict from verifier
      {
        mode: 'update',
        planFilePath: planContextAvailable ? planInfo.planFilePath : undefined,
        useAtPrefix: false,
      }
    );

    log('Running verifier step...');
    const verifierOutput = await executeCodexStep(verifierPrompt.prompt, gitRoot, rmplanConfig);
    events.push({ type: 'verifier', message: verifierOutput });
    log('Verifier output captured.');

    const parsed = parseFailedReport(verifierOutput);
    if (parsed.failed) {
      hadFailure = true;
      const aggregated = buildAggregatedOutput();
      return {
        ...(aggregated ?? { content: verifierOutput }),
        success: false,
        failureDetails: parsed.details
          ? { ...parsed.details, sourceAgent: 'verifier' }
          : { requirements: '', problems: parsed.summary || 'FAILED', sourceAgent: 'verifier' },
      };
    }

    // Parse and log the verifier verdict
    const verdict = parseReviewerVerdict(verifierOutput);
    if (verdict === 'ACCEPTABLE') {
      log('Verification verdict: ACCEPTABLE');
      const aggregated = buildAggregatedOutput();
      if (aggregated != null) return aggregated;
      return;
    } else {
      if (verdict === 'NEEDS_FIXES') {
        log('Verification verdict: NEEDS_FIXES');
      } else {
        log(`Failed to parse verification verdict, treating as 'NEEDS_FIXES'`);
      }

      let fixInstructions = verifierOutput;

      // Implement fix-and-review loop (up to 5 iterations)
      const maxFixIterations = 5;
      let lastFixerOutput = '';
      let finalVerifierOutput = verifierOutput;
      for (let iter = 1; iter <= maxFixIterations; iter++) {
        log(`Starting fix iteration ${iter}/${maxFixIterations}...`);

        const fixerPrompt = getFixerPrompt({
          planPath: planInfo.planFilePath,
          planId: planInfo.planId,
          implementerOutput: finalImplementerOutput,
          testerOutput: '', // Simple mode has no separate tester output
          completedTaskTitles: initiallyCompleted.map((t) => t.title),
          fixInstructions,
        });

        const fixerOutput = await executeCodexStep(fixerPrompt, gitRoot, rmplanConfig);
        lastFixerOutput = fixerOutput;
        events.push({ type: 'verifier', message: fixerOutput });
        log('Fixer output captured. Re-running verifier...');

        // Failure detection: fixer
        {
          const parsed = parseFailedReport(fixerOutput);
          if (parsed.failed) {
            hadFailure = true;
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

        // Re-run verifier with updated context including fixer output
        const rerunVerifierContext = composeVerifierContext(
          contextContent,
          finalImplementerOutput,
          newlyCompletedTitles,
          initiallyCompleted.map((t) => t.title),
          initiallyPending.map((t) => t.title)
        );

        const rerunVerifierPrompt = getVerifierAgentPrompt(
          `${rerunVerifierContext}\n\n### Previous Review Issues\n\nThe following issues were identified in the initial verification:\n\n${fixInstructions}\n\n### Implementer's Response to Review\n\nThe implementer attempted to address these issues with the following changes:\n\n${fixerOutput}`,
          planContextAvailable ? planInfo.planId : undefined,
          verifierInstructions,
          model,
          false, // includeTaskCompletionInstructions - we mark tasks ourselves
          true, // includeVerdictInstructions - request a verdict from verifier
          {
            mode: 'update',
            planFilePath: planContextAvailable ? planInfo.planFilePath : undefined,
            useAtPrefix: false,
          }
        );

        const rerunVerifierOutput = await executeCodexStep(
          rerunVerifierPrompt.prompt,
          gitRoot,
          rmplanConfig
        );
        finalVerifierOutput = rerunVerifierOutput;
        events.push({ type: 'verifier', message: rerunVerifierOutput });

        // Parse verdict from the latest verifier output
        const newVerdict = parseReviewerVerdict(rerunVerifierOutput);

        const newAnalysis = {
          needs_fixes: newVerdict !== 'ACCEPTABLE',
          fix_instructions: rerunVerifierOutput,
        };

        if (!newAnalysis.needs_fixes) {
          log(`Verification verdict after fixes (iteration ${iter}): ACCEPTABLE`);
          const aggregated = buildAggregatedOutput();
          if (aggregated != null) return aggregated;
          return;
        }

        log(`Verification verdict after fixes (iteration ${iter}): NEEDS_FIXES`);
        if (newAnalysis.fix_instructions) {
          log(`Fix instructions: ${newAnalysis.fix_instructions}`);
        }

        // Give it the new fix instructions and continue
        fixInstructions = newAnalysis.fix_instructions || rerunVerifierOutput;
        continue;
      }

      warn(
        'Maximum fix iterations reached (5) and verifier still reports issues. Exiting with warnings.'
      );
      // Even if still needs fixes, provide the latest verifier output when capturing
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
