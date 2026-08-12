import type { AgentInputMessage } from './agent_manager_types.js';

/** Add provider-visible runtime-trusted sender attribution. */
export function formatAgentInputForProvider(
  message: Pick<AgentInputMessage, 'source' | 'content'>
): string {
  const sender =
    message.source.role === 'subagent'
      ? `${message.source.name} [id: ${message.source.id}]`
      : message.source.name;
  return `Agent message from ${sender}:\n${message.content}`;
}
