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

  test('keeps only the latest matching rate limit message across hidden messages', () => {
    const rateLimit = (id: string): DisplayMessage => ({
      id,
      seq: Number(id),
      timestamp: '2026-03-25T10:00:00.000Z',
      category: 'structured',
      bodyType: 'structured',
      body: {
        type: 'structured',
        message: {
          type: 'llm_status',
          source: 'claude',
          status: 'Rate limit warning (seven_day)',
          detail: 'Utilization: 77%',
          rateLimitInfo: { utilization: 77, rateLimitType: 'seven_day' },
        },
      },
      rawType: 'llm_status',
    });
    const hiddenToolCall = toolMessage('Bash', 'llm_tool_use');
    const earlierRateLimit = rateLimit('1');
    const laterRateLimit = rateLimit('3');

    expect(
      filterSessionMessages([earlierRateLimit, hiddenToolCall, laterRateLimit], false, false)
    ).toEqual([laterRateLimit]);
  });

  test('keeps rate limit messages when their details differ', () => {
    const messages: DisplayMessage[] = [
      {
        ...structuredMessage({
          type: 'llm_status',
          source: 'claude',
          status: 'Rate limit warning (seven_day)',
          rateLimitInfo: { utilization: 70, rateLimitType: 'seven_day' },
        }),
        id: 'first',
      },
      {
        ...structuredMessage({
          type: 'llm_status',
          source: 'claude',
          status: 'Rate limit warning (seven_day)',
          rateLimitInfo: { utilization: 80, rateLimitType: 'seven_day' },
        }),
        id: 'second',
      },
    ];

    expect(filterSessionMessages(messages, false, false)).toEqual(messages);
  });

  test('keeps only the latest Codex token usage message with matching rate limits', () => {
    const tokenUsage = (id: string, totalTokens: number): DisplayMessage => ({
      ...structuredMessage({
        type: 'token_usage',
        totalTokens,
        rateLimits: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 20, windowDurationMins: 10080 },
          },
        },
      }),
      id,
    });
    const earlier = tokenUsage('earlier', 100);
    const later = tokenUsage('later', 200);
    const hiddenToolCall = toolMessage('Bash', 'llm_tool_use');

    expect(filterSessionMessages([earlier, hiddenToolCall, later], false, false)).toEqual([later]);
  });

  test('keeps Codex token usage messages when their displayed rate limits differ', () => {
    const message = (id: string, usedPercent: number): DisplayMessage => ({
      ...structuredMessage({
        type: 'token_usage',
        rateLimits: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent, windowDurationMins: 10080 },
          },
        },
      }),
      id,
    });
    const messages = [message('first', 20), message('second', 21)];

    expect(filterSessionMessages(messages, false, false)).toEqual(messages);
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
