import { z } from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types';
import type { RmplanConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step';
import { getGitRoot } from '../../common/git';
import { spawnAndLogOutput } from '../../common/process';
import { log, error } from '../../logging';
import { buildCodexOrchestrationPrompt } from './codex_cli/prompt';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';
import { createCodexStdoutFormatter } from './codex_cli/format.ts';
import {
  getImplementerPrompt,
  getTesterPrompt,
  getReviewerPrompt,
} from './claude_code/agent_prompts.ts';
import { readPlanFile } from '../plans.ts';
import * as path from 'path';
import { analyzeReviewFeedback } from './codex_cli/review_analysis.ts';

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
    const implementerInstructions = await this.loadAgentInstructionsFor('implementer', gitRoot);
    const implementer = getImplementerPrompt(
      contextContent,
      implementerInstructions,
      this.sharedOptions.model
    );

    // If caller wants to capture what we would send, just return the composed implementer prompt
    if (planInfo.captureOutput && planInfo.captureOutput !== 'none') {
      return implementer.prompt;
    }

    // Execute implementer step and capture its final agent message
    log('Running implementer step...');
    const implementerOutput = await this.executeCodexStep(implementer.prompt, gitRoot);
    log('Implementer output captured.');

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

      log('Review analysis: Fixes required.');
      if (analysis.fix_instructions) {
        log(`Fix instructions: ${analysis.fix_instructions}`);
      }
      // Fix loop to be implemented in subsequent tasks (10/11)
      log('Fix loop not yet implemented in this phase.');
      return;
    } else {
      error('Could not determine review verdict from reviewer output. Treating as NEEDS_FIXES.');
      return;
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
      log(`- Completed tasks (${completed.length}): ${completed.map((t) => t.title).join('; ')}`);
    } else {
      log('- Completed tasks (0)');
    }
    if (pending.length) {
      log(`- Pending tasks (${pending.length}): ${pending.map((t) => t.title).join('; ')}`);
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
    return (
      `${originalContext}` +
      `${completedSection}` +
      `${pendingSection}` +
      `\n\n### Implementer Output\n${implementerOutput}` +
      `\n\n### Tester Output\n${testerOutput}`
    );
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
      ['codex', '--json', '--search', 'exec', ...sandboxSettings, prompt],
      {
        cwd,
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
