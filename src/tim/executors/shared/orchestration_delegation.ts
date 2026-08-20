import type { OrchestrationOptions } from './orchestration_options.js';

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
      `Call StartAgent with type \`${agentType}\`, the selected executor, and an initial message containing plan \`${planId}\`, the exact task and file scope, constraints, and expected handoff.`,
  };
}
