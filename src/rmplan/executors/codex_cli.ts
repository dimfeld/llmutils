import { z } from 'zod/v4';
// TODO Need to update to latest AI SDK
import { z as z3 } from 'zod/v3';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types';
import type { RmplanConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step';
import { getGitRoot } from '../../common/git';
import { spawnAndLogOutput } from '../../common/process';
import { log, error, warn } from '../../logging';
import { buildCodexOrchestrationPrompt } from './codex_cli/prompt';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';
import { createCodexStdoutFormatter } from './codex_cli/format.ts';
import {
  getImplementerPrompt,
  getTesterPrompt,
  getReviewerPrompt,
  issueAndVerdictFormat,
} from './claude_code/agent_prompts.ts';
import { readPlanFile } from '../plans.ts';
import * as path from 'path';
import { analyzeReviewFeedback } from './codex_cli/review_analysis.ts';
import { generateObject } from 'ai';
import { createModel } from '../../common/model_factory.ts';
import { setTaskDone } from '../plans/mark_done.ts';

export type CodexCliExecutorOptions = z.infer<typeof codexCliOptionsSchema>;

/**
 * Executor that runs the rmplan-generated context through the OpenAI Codex CLI.
 * It composes a single prompt that encapsulates the implement → test → review loop,
 * then invokes `codex exec` with that prompt.
 */
export class CodexCliExecutor implements Executor {
  static name = CodexCliExecutorName;
  static description = 'Executes the plan using OpenAI Codex CLI (codex exec)';
  static optionsSchema = codexCliOptionsSchema;

  constructor(
    public options: CodexCliExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    // Use rmfilter to provide repo context; omit boilerplate instructions to reduce token usage
    return {
      rmfilter: true,
      rmfilterArgs: ['--omit-top-instructions'],
      // Model is not used by Codex CLI directly; it reads its own configuration
    } satisfies Partial<PrepareNextStepOptions>;
  }

  async execute(contextContent: string, planInfo: ExecutePlanInfo): Promise<void | string> {
    // Analyze plan file to understand completed vs pending tasks
    const gitRoot = await getGitRoot(this.sharedOptions.baseDir);
    const planData = await readPlanFile(planInfo.planFilePath);
    const { completed: initiallyCompleted, pending: initiallyPending } =
      this.categorizeTasks(planData);

    this.logTaskStatus('Initial plan analysis', initiallyCompleted, initiallyPending, gitRoot);

    // Build implementer prompt using the Claude Code agent prompt for consistency
    let implementerInstructions = await this.loadAgentInstructionsFor('implementer', gitRoot);

    implementerInstructions += `\n\nIn your final message, be sure to include the titles of the tasks that you completed.\n`;

    const implementer = getImplementerPrompt(
      contextContent,
      implementerInstructions,
      this.sharedOptions.model
    );

    // Execute implementer step and capture its final agent message
    log('Running implementer step...');
    const implementerOutput = await this.executeCodexStep(implementer.prompt, gitRoot);
    log('Implementer output captured.');

    try {
      // Re-read plan file to detect newly-completed tasks (if any)
      let newlyCompletedTitles: string[] = [];
      try {
        const updatedPlan = await readPlanFile(planInfo.planFilePath);
        const { completed: afterCompleted } = this.categorizeTasks(updatedPlan);
        const beforeTitles = new Set(initiallyCompleted.map((t) => t.title));
        newlyCompletedTitles = afterCompleted
          .map((t) => t.title)
          .filter((title) => !beforeTitles.has(title));
      } catch (e) {
        // Non-fatal; proceed without delta if re-read fails
      }

      // Build tester context: include implementer output and focus tasks
      const testerContext = this.composeTesterContext(
        contextContent,
        implementerOutput,
        newlyCompletedTitles
      );
      const testerInstructions = await this.loadAgentInstructionsFor('tester', gitRoot);
      const tester = getTesterPrompt(testerContext, testerInstructions, this.sharedOptions.model);

      // Execute tester step
      log('Running tester step...');
      const testerOutput = await this.executeCodexStep(tester.prompt, gitRoot);
      log('Tester output captured.');

      // Build reviewer context with implementer + tester outputs and task context
      const reviewerContext = this.composeReviewerContext(
        contextContent,
        implementerOutput,
        testerOutput,
        initiallyCompleted.map((t) => t.title),
        initiallyPending.map((t) => t.title)
      );
      const reviewerInstructions = await this.loadAgentInstructionsFor('reviewer', gitRoot);
      const reviewer = getReviewerPrompt(
        reviewerContext,
        reviewerInstructions,
        this.sharedOptions.model
      );

      // Execute reviewer step
      log('Running reviewer step...');
      const reviewerOutput = await this.executeCodexStep(reviewer.prompt, gitRoot);
      log('Reviewer output captured.');

      // Parse and log verdict
      const verdict = this.parseReviewerVerdict(reviewerOutput);
      if (verdict === 'ACCEPTABLE') {
        log('Review verdict: ACCEPTABLE');
        return;
      } else if (verdict === 'NEEDS_FIXES') {
        log('Review verdict: NEEDS_FIXES');
        // Analyze whether the flagged issues are in-scope and require fixes now
        const reviewDoc = await this.loadRepositoryReviewDoc(gitRoot);
        const analysis = await analyzeReviewFeedback({
          reviewerOutput: reviewerOutput,
          completedTasks: initiallyCompleted.map((t) => t.title),
          pendingTasks: initiallyPending.map((t) => t.title),
          implementerOutput,
          repoReviewDoc: reviewDoc,
        });

        if (!analysis.needs_fixes) {
          log('Review analysis: Issues are out-of-scope or non-blocking. Exiting without fixes.');
          return;
        }

        let fixInstructions = analysis.fix_instructions ?? reviewerOutput;

        log('Review analysis: Fixes required.');
        if (analysis.fix_instructions) {
          log(`Fix instructions: ${analysis.fix_instructions}`);
        }

        // Implement fix-and-review loop (up to 5 iterations)
        const maxFixIterations = 5;
        let lastFixerOutput = '';
        for (let iter = 1; iter <= maxFixIterations; iter++) {
          log(`Starting fix iteration ${iter}/${maxFixIterations}...`);

          const fixerPrompt = this.getFixerPrompt({
            implementerOutput,
            testerOutput,
            completedTaskTitles: initiallyCompleted.map((t) => t.title),
            fixInstructions,
          });

          const fixerOutput = await this.executeCodexStep(fixerPrompt, gitRoot);
          lastFixerOutput = fixerOutput;
          log('Fixer output captured. Re-running reviewer...');

          // Re-run reviewer with updated context including fixer output
          const rerunReviewerContext = this.composeFixReviewContext(
            contextContent,
            implementerOutput,
            testerOutput,
            initiallyCompleted.map((t) => t.title),
            initiallyPending.map((t) => t.title),
            fixInstructions,
            fixerOutput,
            reviewerInstructions
          );

          const rerunReviewerOutput = await this.executeCodexStep(rerunReviewerContext, gitRoot);
          const newAnalysis = await analyzeReviewFeedback({
            reviewerOutput: rerunReviewerOutput,
            completedTasks: initiallyCompleted.map((t) => t.title),
            pendingTasks: initiallyPending.map((t) => t.title),
            fixerOutput,
            repoReviewDoc: reviewDoc,
          });

          if (!newAnalysis.needs_fixes) {
            log(`Review verdict after fixes (iteration ${iter}): ACCEPTABLE`);
            return;
          }

          log(`Review verdict after fixes (iteration ${iter}): NEEDS_FIXES`);
          if (analysis.fix_instructions) {
            log(`Fix instructions: ${analysis.fix_instructions}`);
          }

          // Give it the new fix instructions and continue
          fixInstructions = analysis.fix_instructions ?? rerunReviewerOutput;
          continue;
        }

        warn(
          'Maximum fix iterations reached (5) and reviewer still reports issues. Exiting with warnings.'
        );
      } else {
        error('Could not determine review verdict from reviewer output. Treating as NEEDS_FIXES.');
        return;
      }
    } finally {
      await this.markCompletedTasksFromImplementer(implementerOutput, planInfo, gitRoot);
    }
  }

  /** Load agent instructions if configured in rmplanConfig */
  private async loadAgentInstructionsFor(
    agent: 'implementer' | 'tester' | 'reviewer',
    gitRoot: string
  ): Promise<string | undefined> {
    try {
      const p = this.rmplanConfig.agents?.[agent]?.instructions;
      if (!p) return undefined;
      const resolved = path.isAbsolute(p) ? p : path.join(gitRoot, p);
      const file = Bun.file(resolved);
      if (!(await file.exists())) return undefined;
      const content = await file.text();
      log(`Including ${agent} instructions: ${path.relative(gitRoot, resolved)}`);
      return content;
    } catch (e) {
      // Non-fatal
      return undefined;
    }
  }

  /** Categorize tasks in a plan into completed and pending lists */
  private categorizeTasks(plan: { tasks?: Array<{ title: string; done?: boolean }> }): {
    completed: Array<{ title: string }>;
    pending: Array<{ title: string }>;
  } {
    const tasks = plan.tasks ?? [];
    const completed = tasks.filter((t) => t.done === true).map((t) => ({ title: t.title }));
    const pending = tasks.filter((t) => t.done !== true).map((t) => ({ title: t.title }));
    return { completed, pending };
  }

  private logTaskStatus(
    header: string,
    completed: Array<{ title: string }>,
    pending: Array<{ title: string }>,
    gitRoot: string
  ) {
    log(`${header}:`);
    if (completed.length) {
      log(
        `- Completed tasks (${completed.length}):${completed.map((t) => `\n  - ${t.title}`).join('')}`
      );
    } else {
      log('- Completed tasks (0)');
    }
    if (pending.length) {
      log(`- Pending tasks (${pending.length}):${pending.map((t) => `\n  - ${t.title}`).join('')}`);
    } else {
      log('- Pending tasks (0)');
    }
  }

  private composeTesterContext(
    originalContext: string,
    implementerOutput: string,
    newlyCompletedTitles: string[]
  ): string {
    const tasksSection = newlyCompletedTitles.length
      ? `\n\n### Newly Completed Tasks\n- ${newlyCompletedTitles.join('\n- ')}`
      : '';
    return `${originalContext}\n\n### Implementer Output\n${implementerOutput}${tasksSection}`;
  }

  private composeReviewerContext(
    originalContext: string,
    implementerOutput: string,
    testerOutput: string,
    completedTitles: string[],
    pendingTitles: string[]
  ): string {
    const completedSection = completedTitles.length
      ? `\n\n### Completed Tasks\n- ${completedTitles.join('\n- ')}`
      : '';
    const pendingSection = pendingTitles.length
      ? `\n\n### Pending Tasks\n- ${pendingTitles.join('\n- ')}`
      : '';
    const base =
      `${originalContext}` +
      `${completedSection}` +
      `${pendingSection}` +
      `\n\n### Initial Implementation Output\n${implementerOutput}` +
      `\n\n### Initial Testing Output\n${testerOutput}`;
    return base;
  }

  private composeFixReviewContext(
    originalContext: string,
    implementerOutput: string,
    testerOutput: string,
    completedTitles: string[],
    pendingTitles: string[],
    previousReview: string,
    fixerOutput: string,
    customInstructions?: string
  ) {
    const baseContext = this.composeReviewerContext(
      originalContext,
      implementerOutput,
      testerOutput,
      completedTitles,
      pendingTitles
    );

    const customInstructionsSection = customInstructions
      ? `\n\n## Project-Specific Review Guidelines\n\n${customInstructions}`
      : '';

    return `You are a fix verification assistant focused on determining whether previously identified issues have been adequately addressed by the implementer's fixes.

Your job is to verify that specific issues flagged in the previous review have been resolved, NOT to conduct a full new code review. Focus exclusively on whether the fixes address the concerns that were raised.

${baseContext}${customInstructionsSection}

## Previous Review Issues

The following issues were identified in the initial review:

${previousReview}

## Implementer's Response to Review

The implementer attempted to address these issues with the following changes:

${fixerOutput}

## Your Verification Task

For each issue identified in the previous review, determine:

1. **Was the issue actually addressed?**
   - Did the implementer make the requested changes?
   - Are the changes sufficient to resolve the underlying problem?
   - Do the changes align with what was requested in the review?

2. **Are there valid reasons if an issue wasn't addressed?**
   - Technical constraints that make the fix impractical
   - Misunderstanding that should be clarified
   - Issue was actually not applicable to the current scope

3. **Did the fixes introduce new problems?**
   - Breaking changes to existing functionality
   - New bugs or regressions
   - Violations of project patterns or conventions

## Critical Focus Areas

### Issues That MUST Be Addressed (mark as NEEDS_FIXES if not resolved):
- **Security vulnerabilities** that were flagged
- **Correctness bugs** and logic errors
- **Critical performance issues** that affect system stability
- **Resource leaks** (memory, files, connections)
- **Type safety violations** that could cause runtime errors

### Issues That Can Be Acceptable If Explained:
- Style or formatting concerns (if consistent with codebase)
- Minor performance optimizations (if impact is negligible)
- Pattern deviations (if there's a clear justification)
- Documentation gaps (if not critical for functionality)

### Red Flags in Implementer Response:
- Dismissing legitimate security concerns without proper mitigation
- Ignoring correctness issues or claiming they don't matter
- Making changes that don't actually address the root problem
- Introducing new bugs while fixing old ones
- Unclear or evasive explanations for not addressing issues

## Verification Guidelines

- **Be specific**: Reference exact issues from the previous review
- **Check actual fixes**: Verify the implementer actually made the claimed changes
- **Assess completeness**: Ensure fixes address the root cause, not just symptoms
- **Consider scope**: Issues outside the current task scope may be acceptable to defer
- **Validate explanations**: If an issue wasn't fixed, the reason should be technically sound

## Response Format:

For each major issue from the previous review, provide:

**Issue**: [Brief description of the original concern]
**Status**: RESOLVED | NOT_ADDRESSED | PARTIALLY_ADDRESSED
**Assessment**: [Your verification of whether the fix is adequate]

Additional concerns (if any new issues were introduced by the fixes):
- CRITICAL: [Any new critical issues introduced by the fixes]
- MAJOR: [Any new significant problems created]

**VERDICT:** NEEDS_FIXES | ACCEPTABLE

## Response Format Notes:

For the verdict:
- **NEEDS_FIXES**: Use when critical issues remain unresolved or new critical issues were introduced
- **ACCEPTABLE**: Use when all critical issues have been adequately addressed, even if minor issues remain

If NEEDS_FIXES: Focus on what specifically still needs to be resolved from the original review
If ACCEPTABLE: Briefly confirm that the major concerns have been addressed
`;
  }

  /** Parse the reviewer verdict from output text */
  private parseReviewerVerdict(output: string): 'ACCEPTABLE' | 'NEEDS_FIXES' | 'UNKNOWN' {
    // Look for a line like: "VERDICT: ACCEPTABLE" or "VERDICT: NEEDS_FIXES"
    const regex = /\bVERDICT\s*:\s*(ACCEPTABLE|NEEDS_FIXES)\b/i;
    const m = output.match(regex);
    if (!m) return 'UNKNOWN';
    const v = m[1].toUpperCase();
    if (v === 'ACCEPTABLE') return 'ACCEPTABLE';
    if (v === 'NEEDS_FIXES') return 'NEEDS_FIXES';
    return 'UNKNOWN';
  }

  /**
   * Runs a single-step Codex execution with JSON streaming enabled and returns the final agent message.
   */
  private async executeCodexStep(prompt: string, cwd: string): Promise<string> {
    const allowAllTools = process.env.ALLOW_ALL_TOOLS === 'true';
    const sandboxSettings = allowAllTools
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write'];

    const formatter = createCodexStdoutFormatter();

    const { exitCode, stdout, stderr } = await spawnAndLogOutput(
      ['codex', '--search', 'exec', ...sandboxSettings, prompt, '--json'],
      {
        cwd,
        env: {
          ...process.env,
          AGENT: process.env.AGENT || '1',
        },
        formatStdout: (chunk: string) => formatter.formatChunk(chunk),
        // stderr is not JSON – print as-is
      }
    );

    if (exitCode !== 0) {
      throw new Error(`codex exited with code ${exitCode}`);
    }

    const final = formatter.getFinalAgentMessage();
    if (!final) {
      // Provide helpful context for debugging
      error('Codex returned no final agent message. Enable debug logs for details.');
      throw new Error('No final agent message found in Codex output.');
    }

    return final;
  }

  /**
   * Analyze the implementer output with Gemini 2.5 Flash to determine which plan tasks
   * have been fully completed, and mark those tasks as done in the plan file.
   * This is a conservative, best-effort step and will silently skip on any failure.
   */
  private async markCompletedTasksFromImplementer(
    implementerOutput: string,
    planInfo: ExecutePlanInfo,
    gitRoot: string
  ): Promise<void> {
    try {
      // Skip if no Google API key is available to avoid network calls in test/dev
      const hasGoogleKey =
        !!process.env.GOOGLE_API_KEY || !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!hasGoogleKey) {
        warn('Skipping automatic task completion marking due to missing Google API key');
        return;
      }

      const plan = await readPlanFile(planInfo.planFilePath);
      const tasks = (plan.tasks ?? []).map((t: any) => ({
        title: t.title as string,
        description: (t.description as string) ?? '',
        done: t.done === true,
        steps: Array.isArray(t.steps)
          ? t.steps.map((s: any) => ({ prompt: s?.prompt ?? '', done: s?.done === true }))
          : [],
      }));

      const pending = tasks.filter((t) => !t.done);
      if (pending.length === 0) return;

      const model = await createModel('google/gemini-2.5-flash');

      const prompt = `You are given:
- A software project plan consisting of tasks (with titles, optional descriptions, and steps)
- The implementer agent's output (what was implemented)

Goal: Identify which tasks from the plan were FULLY completed by the implementation. Only select a task if the implementer output clearly indicates the task is fully done (not partially). Use EXACT title matching from the provided task list.

Rules:
- Consider a task complete only if the implementation and tests are evidently finished for that task.
- If uncertain, do not select it.
- Return strict JSON with field "completed_titles" as an array of strings (the exact task titles). No commentary.

Plan tasks (pending only):
${JSON.stringify(pending, null, 2)}

Implementer output:
${implementerOutput}

Return JSON only, like: {"completed_titles": ["Task A", "Task B"]}`;

      const CompletedTasksSchema = z3.object({
        completed_titles: z3.array(z3.string()),
      });

      const res = await generateObject({
        model,
        schema: CompletedTasksSchema,
        prompt,
        temperature: 0.1,
      });

      const pendingTitles = new Set(pending.map((t) => t.title));
      for (const title of res.object.completed_titles) {
        if (!pendingTitles.has(title)) continue;
        try {
          await setTaskDone(
            planInfo.planFilePath,
            { taskIdentifier: title, commit: false },
            gitRoot,
            this.rmplanConfig
          );
          log(`Marked task done (from implementer analysis): ${title}`);
        } catch (e) {
          warn(
            `Failed to mark task done for title "${title}": ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    } catch (e) {
      warn(
        `Skipping automatic task completion marking due to error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Build a prompt for the fixer step */
  private getFixerPrompt(input: {
    implementerOutput: string;
    testerOutput: string;
    completedTaskTitles: string[];
    fixInstructions: string;
  }): string {
    const tasks = input.completedTaskTitles.length
      ? `- ${input.completedTaskTitles.join('\n- ')}`
      : '(none)';
    return `You are a fixer agent focused on addressing reviewer-identified issues precisely and minimally.

Context:
## Completed Tasks (in scope)
${tasks}

## Initial Implementation Notes
${input.implementerOutput}

## Testing Agent Output
${input.testerOutput}

## Review Instructions
${input.fixInstructions}

Your job:
1. Make only the changes required to satisfy the fix instructions
2. Follow repository conventions and type safety
3. Prefer small, safe changes; avoid broad refactors
4. Run relevant tests and commands as needed

When complete, summarize what you changed. If you could not address an issue, clearly explain why.`;
  }

  /** Load repository-specific review guidance document if configured */
  private async loadRepositoryReviewDoc(gitRoot: string): Promise<string | undefined> {
    try {
      const p = this.rmplanConfig.review?.customInstructionsPath;
      if (!p) return undefined;
      const resolved = path.isAbsolute(p) ? p : path.join(gitRoot, p);
      const file = Bun.file(resolved);
      if (!(await file.exists())) return undefined;
      const content = await file.text();
      log(`Including repository review guidance: ${path.relative(gitRoot, resolved)}`);
      return content;
    } catch {
      return undefined;
    }
  }
}
