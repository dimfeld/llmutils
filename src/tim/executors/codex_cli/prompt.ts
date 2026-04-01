/**
 * @fileoverview Codex CLI prompt building utilities.
 *
 * Provides functions for constructing orchestration prompts used by the
 * Codex CLI executor, including progress guidance and context composition.
 */

import { progressSectionGuidance } from '../claude_code/orchestrator_prompt.ts';

export interface CodexOrchestrationOptions {
  planId: string;
  planTitle: string;
  planFilePath: string;
  batchMode: boolean;
}

/**
 * Builds the full orchestration prompt for the Codex CLI implementer agent.
 *
 * Combines the context content with progress update guidance so the agent
 * knows how to report progress in the plan file.
 */
export function buildCodexOrchestrationPrompt(
  contextContent: string,
  options: CodexOrchestrationOptions
): string {
  const progressGuidance = progressSectionGuidance(options.planFilePath, { useAtPrefix: false });

  return `${contextContent}

${progressGuidance}`;
}
