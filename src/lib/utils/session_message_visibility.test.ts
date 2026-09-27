import { describe, expect, test } from 'vitest';
import type { DisplayMessage } from '$lib/types/session.js';
import { filterSessionMessages } from './session_message_visibility.js';

function toolMessage(toolName: string, type: 'llm_tool_use' | 'llm_tool_result'): DisplayMessage {
  return {
    id: `${toolName}:${type}`,
    seq: 1,
    timestamp: '2026-03-25T10:00:00.000Z',
    category: 'structured',
    bodyType: 'structured',
    body: { type: 'structured', message: { type, toolName } },
    rawType: type,
  };
}

const output: DisplayMessage = {
  id: 'output',
  seq: 2,
  timestamp: '2026-03-25T10:00:00.000Z',
  category: 'log',
  bodyType: 'text',
  body: { type: 'text', text: 'Agent output' },
  rawType: 'stdout',
};

describe('filterSessionMessages', () => {
  test('filters lifecycle output and ordinary tool calls independently', () => {
    const lifecycle = { ...output, id: 'lifecycle', origin: 'lifecycle' as const };
    const call = toolMessage('Bash', 'llm_tool_use');
    const result = toolMessage('Bash', 'llm_tool_result');
    const messages = [output, lifecycle, call, result];
    expect(filterSessionMessages(messages, false, false)).toEqual([output]);
    expect(filterSessionMessages(messages, true, false)).toEqual([output, lifecycle]);
    expect(filterSessionMessages(messages, false, true)).toEqual([output, call, result]);
    expect(filterSessionMessages(messages, true, true)).toEqual(messages);
  });

  for (const name of [
    'StartTimAgent',
    'ListTimAgents',
    'SendTimAgentMessage',
    'StopTimAgent',
    'FinishTimAgent',
  ]) {
    for (const prefix of ['', 'tim.', 'mcp__tim__']) {
      test(`always shows ${prefix}${name} calls and results`, () => {
        const messages = [
          toolMessage(prefix + name, 'llm_tool_use'),
          toolMessage(prefix + name, 'llm_tool_result'),
        ];
        expect(filterSessionMessages(messages, false, false)).toEqual(messages);
      });
    }
  }
});
