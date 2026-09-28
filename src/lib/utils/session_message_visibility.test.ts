import { describe, expect, test } from 'vitest';
import type { DisplayMessage, StructuredMessagePayload } from '$lib/types/session.js';
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

function structuredMessage(message: StructuredMessagePayload): DisplayMessage {
  return {
    id: message.type,
    seq: 1,
    timestamp: '2026-03-25T10:00:00.000Z',
    category: 'structured',
    bodyType: 'structured',
    body: { type: 'structured', message },
    rawType: message.type,
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

  test('hides specially formatted command and file tool messages', () => {
    const messages = [
      structuredMessage({ type: 'command_exec', command: 'pwd' }),
      structuredMessage({ type: 'command_result', command: 'pwd', exitCode: 0 }),
      structuredMessage({ type: 'file_write', path: 'a.ts', lineCount: 1 }),
      structuredMessage({ type: 'file_edit', path: 'a.ts', diff: '+change' }),
      structuredMessage({
        type: 'file_change_summary',
        changes: [{ path: 'a.ts', kind: 'updated' }],
      }),
      toolMessage('Read', 'llm_tool_use'),
      toolMessage('Read', 'llm_tool_result'),
      output,
    ];

    expect(filterSessionMessages(messages, false, false)).toEqual([output]);
    expect(filterSessionMessages(messages, false, true)).toEqual(messages);
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
