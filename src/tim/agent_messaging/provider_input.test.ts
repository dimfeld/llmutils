import { describe, expect, test } from 'vitest';

import type { AgentInputMessage, SubagentIdentity } from './agent_manager_types.js';
import { formatAgentInputForProvider } from './provider_input.js';

function subagentIdentity(id: string): SubagentIdentity {
  return {
    id: id as SubagentIdentity['id'],
    name: 'reused-name' as SubagentIdentity['name'],
    role: 'subagent',
    type: 'tester',
    executor: 'codex-cli',
  };
}

function message(source: SubagentIdentity, content: string): AgentInputMessage {
  return {
    messageId: `message-${source.id}`,
    source,
    content,
  };
}

describe('formatAgentInputForProvider', () => {
  test('keeps reused subagent names distinct with the opaque sender ID', () => {
    const oldGeneration = formatAgentInputForProvider(
      message(subagentIdentity('old-agent-id'), 'queued before exit')
    );
    const newGeneration = formatAgentInputForProvider(
      message(subagentIdentity('new-agent-id'), 'sent after restart')
    );

    expect(oldGeneration).toBe(
      'Agent message from reused-name [id: old-agent-id]:\nqueued before exit'
    );
    expect(newGeneration).toBe(
      'Agent message from reused-name [id: new-agent-id]:\nsent after restart'
    );
    expect(oldGeneration).not.toBe(newGeneration);
  });
});
