import { z } from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types';
import type { RmplanConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step';
import { getGitRoot } from '../../common/git';
import { createLineSplitter, spawnAndLogOutput } from '../../common/process';
import { log, error } from '../../logging';
import { buildCodexOrchestrationPrompt } from './codex_cli/prompt';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';
import { createCodexStdoutFormatter } from './codex_cli/format.ts';
import { getImplementerPrompt } from './claude_code/agent_prompts.ts';
import * as path from 'path';

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
    // Build implementer prompt using the Claude Code agent prompt for consistency
    const gitRoot = await getGitRoot(this.sharedOptions.baseDir);
    const implementerInstructions = await this.loadAgentInstructionsIfConfigured(gitRoot);
    const implementer = getImplementerPrompt(contextContent, implementerInstructions, this.sharedOptions.model);

    // If caller wants to capture what we would send, just return the composed implementer prompt
    if (planInfo.captureOutput && planInfo.captureOutput !== 'none') {
      return implementer.prompt;
    }

    // Execute a single Codex step and capture the final agent message
    const finalMessage = await this.executeCodexStep(implementer.prompt, gitRoot);

    log('Final implementer output captured.');
    log(finalMessage);
  }

  /** Load implementer agent instructions if configured in rmplanConfig */
  private async loadAgentInstructionsIfConfigured(gitRoot: string): Promise<string | undefined> {
    try {
      const p = this.rmplanConfig.agents?.implementer?.instructions;
      if (!p) return undefined;
      const resolved = path.isAbsolute(p) ? p : path.join(gitRoot, p);
      const file = Bun.file(resolved);
      if (!(await file.exists())) return undefined;
      const content = await file.text();
      log(`Including implementer instructions: ${path.relative(gitRoot, resolved)}`);
      return content;
    } catch (e) {
      // Non-fatal
      return undefined;
    }
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
      [
        'codex',
        '--json',
        '--search',
        'exec',
        ...sandboxSettings,
        prompt,
      ],
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
}
