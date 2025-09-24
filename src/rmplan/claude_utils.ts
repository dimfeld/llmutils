import chalk from 'chalk';
import { log } from '../logging.js';
import {
  runClaudeCodeGeneration,
  type ClaudeCodeGenerationResult,
} from './executors/claude_code_orchestrator.js';

/**
 * Invokes Claude Code for two-step generation process (planning + generation).
 * This shared function handles the common logic for calling the Claude Code orchestrator
 * across different commands.
 *
 * @param planningPrompt - The planning prompt for Claude Code to analyze the task
 * @param generationPrompt - The generation prompt for Claude Code to produce the output
 * @param options - Configuration options including model and other settings
 * @returns The generated content from Claude Code
 */
export async function invokeClaudeCodeForGeneration(
  planningPrompt: string,
  generationPrompt: string,
  options: {
    model?: string;
    includeDefaultTools?: boolean;
    researchPrompt?: string;
  }
): Promise<ClaudeCodeGenerationResult> {
  log(chalk.blue('🤖 Using Claude Code for multi-step planning and generation'));

  // Call the orchestrator with both prompts
  const result = await runClaudeCodeGeneration({
    planningPrompt,
    generationPrompt,
    researchPrompt: options.researchPrompt,
    options: {
      includeDefaultTools: options.includeDefaultTools ?? true,
    },
    model: options.model,
  });

  return result;
}
