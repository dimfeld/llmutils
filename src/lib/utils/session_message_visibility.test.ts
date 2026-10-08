import { describe, expect, test } from 'vitest';
import type { DisplayMessage, StructuredMessagePayload } from '$lib/types/session.js';
import { filterSessionMessages, summarizeHiddenToolCalls } from './session_message_visibility.js';

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

function thinkingMessage(id: string, status: string): DisplayMessage {
  return {
    ...structuredMessage({ type: 'llm_status', source: 'claude', status }),
    id,
  };
}

describe('filterSessionMessages', () => {
  test('keeps only the latest of consecutive thinking messages', () => {
    const first = thinkingMessage('first', 'Thinking... (100 tokens)');
    const second = thinkingMessage('second', 'Thinking...');
    const third = thinkingMessage('third', 'Thinking... (300 tokens)');
    const fourth = thinkingMessage('fourth', 'Thinking... (50 tokens)');
    const other = thinkingMessage('other', 'Thinking about it');

    expect(
      filterSessionMessages([first, second, third, output, fourth, other], false, false)
    ).toEqual([third, output, fourth, other]);
  });

  test('coalesces thinking messages separated only by hidden messages', () => {
    const first = thinkingMessage('first', 'Thinking... (100 tokens)');
    const second = thinkingMessage('second', 'Thinking... (200 tokens)');
    const call = toolMessage('Bash', 'llm_tool_use');
    const lifecycle = { ...output, id: 'lifecycle', origin: 'lifecycle' as const };

    expect(filterSessionMessages([first, call, lifecycle, second], false, false)).toEqual([second]);
    expect(filterSessionMessages([first, call, second], false, true)).toEqual([
      first,
      call,
      second,
    ]);
  });

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

describe('summarizeHiddenToolCalls', () => {
  test('coalesces consecutive thinking messages without counting them as tool calls', () => {
    const first = thinkingMessage('first', 'Thinking... (100 tokens)');
    const second = thinkingMessage('second', 'Thinking... (200 tokens)');
    const third = thinkingMessage('third', 'Thinking... (300 tokens)');
    const call = toolMessage('Bash', 'llm_tool_use');

    const summarized = summarizeHiddenToolCalls([first, second, call, third], false, false);
    expect(summarized.map((message) => message.body)).toEqual([
      second.body,
      { type: 'text', text: '1 tool call hidden' },
      third.body,
    ]);
    expect(summarizeHiddenToolCalls([first, second, call, third], false, true)).toEqual([
      second,
      call,
      third,
    ]);
  });

  test('counts calls once and separates groups at visible messages', () => {
    const call = toolMessage('Bash', 'llm_tool_use');
    const result = toolMessage('Bash', 'llm_tool_result');
    const second = toolMessage('Read', 'llm_tool_use');
    const messages = [call, result, second, output, { ...call, id: 'last' }];
    const summarized = summarizeHiddenToolCalls(messages, false, false);
    expect(summarized.map((message) => message.body)).toEqual([
      { type: 'text', text: '2 tool calls hidden' },
      output.body,
      { type: 'text', text: '1 tool call hidden' },
    ]);
    expect(summarized[0].id).toBe(`hidden-tools:${call.id}`);
    expect(summarizeHiddenToolCalls(messages, false, true)).toEqual(messages);
  });

  test('keeps Tim agent calls visible and omits lifecycle output', () => {
    const call = toolMessage('Bash', 'llm_tool_use');
    const agent = toolMessage('StartTimAgent', 'llm_tool_use');
    const messages = [
      call,
      { ...output, origin: 'lifecycle' as const },
      agent,
      toolMessage('Read', 'llm_tool_use'),
    ];
    const summarized = summarizeHiddenToolCalls(messages, false, false);
    expect(summarized.map((message) => message.body)).toEqual([
      { type: 'text', text: '1 tool call hidden' },
      agent.body,
      { type: 'text', text: '1 tool call hidden' },
    ]);
  });

  test('counts command and file operations in one hidden group', () => {
    const messages = [
      structuredMessage({ type: 'command_exec', command: 'pwd' }),
      structuredMessage({ type: 'command_result', command: 'pwd', exitCode: 0 }),
      structuredMessage({ type: 'file_edit', path: 'a.ts', diff: '+change' }),
    ];
    expect(summarizeHiddenToolCalls(messages, false, false).map((message) => message.body)).toEqual(
      [{ type: 'text', text: '2 tool calls hidden' }]
    );
  });

  test('shows a count for a result without a retained call', () => {
    expect(
      summarizeHiddenToolCalls([toolMessage('Bash', 'llm_tool_result')], false, false)[0].body
    ).toEqual({ type: 'text', text: '1 tool call hidden' });
    expect(summarizeHiddenToolCalls([], false, false)).toEqual([]);
  });
});
