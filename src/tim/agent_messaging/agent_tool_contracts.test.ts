import { describe, expect, test } from 'vitest';

import {
  AGENT_ARGUMENT_SCHEMAS,
  AGENT_TOOL_NAMES,
  ORCHESTRATOR_AGENT_TOOL_NAMES,
  SUBAGENT_AGENT_TOOL_NAMES,
  getAgentToolNames,
} from './contracts.js';
import {
  CLAUDE_AGENT_ARGUMENT_SCHEMAS,
  CLAUDE_AGENT_TOOL_NAMES,
  CLAUDE_ORCHESTRATOR_TOOL_NAMES,
  CLAUDE_SUBAGENT_TOOL_NAMES,
  getClaudeAgentToolNames,
} from '../executors/claude_code/claude_mcp_protocol.js';
import {
  CODEX_AGENT_ARGUMENT_SCHEMAS,
  CODEX_AGENT_TOOL_NAMES,
  CODEX_ORCHESTRATOR_TOOL_NAMES,
  CODEX_SUBAGENT_TOOL_NAMES,
  getCodexAgentToolNames,
} from '../executors/codex_cli/codex_agent_tools.js';

describe('shared agent tool contracts', () => {
  test('keeps both transports on the canonical tool names and role sets', () => {
    expect(CLAUDE_AGENT_TOOL_NAMES).toBe(AGENT_TOOL_NAMES);
    expect(CODEX_AGENT_TOOL_NAMES).toBe(AGENT_TOOL_NAMES);
    expect(CLAUDE_ORCHESTRATOR_TOOL_NAMES).toBe(ORCHESTRATOR_AGENT_TOOL_NAMES);
    expect(CODEX_ORCHESTRATOR_TOOL_NAMES).toBe(ORCHESTRATOR_AGENT_TOOL_NAMES);
    expect(CLAUDE_SUBAGENT_TOOL_NAMES).toBe(SUBAGENT_AGENT_TOOL_NAMES);
    expect(CODEX_SUBAGENT_TOOL_NAMES).toBe(SUBAGENT_AGENT_TOOL_NAMES);
    expect(getClaudeAgentToolNames('orchestrator')).toBe(getAgentToolNames('orchestrator'));
    expect(getCodexAgentToolNames('subagent')).toBe(getAgentToolNames('subagent'));
  });

  test('keeps both transports on the canonical strict argument schemas', () => {
    expect(CLAUDE_AGENT_ARGUMENT_SCHEMAS).toBe(AGENT_ARGUMENT_SCHEMAS);
    expect(CODEX_AGENT_ARGUMENT_SCHEMAS).toBe(AGENT_ARGUMENT_SCHEMAS);
    for (const toolName of AGENT_TOOL_NAMES) {
      expect(CLAUDE_AGENT_ARGUMENT_SCHEMAS[toolName]).toBe(AGENT_ARGUMENT_SCHEMAS[toolName]);
      expect(CODEX_AGENT_ARGUMENT_SCHEMAS[toolName]).toBe(AGENT_ARGUMENT_SCHEMAS[toolName]);
    }
  });
});
