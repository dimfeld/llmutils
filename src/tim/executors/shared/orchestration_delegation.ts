import type { OrchestrationOptions } from './orchestration_options.js';
import { buildStartAgentMessageContents } from './orchestrator_instruction_mode.js';

export type OrchestratedAgentType = 'implementer' | 'tester' | 'tdd-tests' | 'reviewer';

export interface OrchestrationDelegationRenderer {
  subagentCommand(agentType: OrchestratedAgentType): string;
  startAgentInstruction(agentType: OrchestratedAgentType): string;
}

export function buildSubagentExecutorFlag(options: OrchestrationOptions): string {
  const executor = options.subagentExecutor;
  if (executor === 'codex-cli' || executor === 'claude-code') {
    return ` -x ${executor}`;
  }
  return '';
}

/** Keep role delegation wording in one place for both orchestration modes. */
export function createOrchestrationDelegationRenderer(
  planId: string,
  options: OrchestrationOptions
): OrchestrationDelegationRenderer {
  return {
    subagentCommand: (agentType: OrchestratedAgentType): string =>
      `tim subagent ${agentType} ${planId}${buildSubagentExecutorFlag(options)} --input "<instructions>"`,
    startAgentInstruction: (agentType: OrchestratedAgentType): string =>
      `Call StartTimAgent with type \`${agentType}\`, the selected executor, and ${buildStartAgentMessageContents(
        planId,
        options
      )}`,
  };
}
