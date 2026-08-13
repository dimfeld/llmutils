import type { AgentExecutor } from './contracts.js';
import { parseAgentAddress, type AgentName } from './agent_names.js';

export type AgentProcessLabel = string & { readonly __agentProcessLabel: 'AgentProcessLabel' };

/** Format the display label without using it as an identity or control key. */
export function formatAgentProcessLabel(
  executor: AgentExecutor,
  agentName: AgentName | string
): AgentProcessLabel {
  const parsedName = parseAgentAddress(agentName);
  if (parsedName === undefined) {
    throw new TypeError('Agent process labels require a valid agent name');
  }

  const label =
    executor === 'claude-code' ? `Claude agent (${parsedName})` : `Codex thread (${parsedName})`;
  return label as AgentProcessLabel;
}
