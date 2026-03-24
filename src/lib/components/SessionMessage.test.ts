import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { DisplayMessage } from '$lib/types/session.js';

import SessionMessage from './SessionMessage.svelte';

function createMessage(
  overrides: Omit<Partial<DisplayMessage>, 'category'> &
    Pick<DisplayMessage, 'bodyType' | 'body'> & {
      category:
        | DisplayMessage['category']
        | 'llmOutput'
        | 'toolUse'
        | 'command'
        | 'progress'
        | 'fileChange'
        | 'lifecycle'
        | 'userInput';
    }
): DisplayMessage {
  return {
    id: 'msg-1',
    seq: 1,
    timestamp: '2026-03-17T10:00:00.000Z',
    rawType: 'llm_response',
    ...overrides,
  } as DisplayMessage;
}

describe('SessionMessage', () => {
  test('does not truncate llmOutput messages', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createMessage({
          category: 'llmOutput',
          bodyType: 'text',
          body: { type: 'text', text },
        }),
      },
    });

    expect(body).toContain('line 50');
    expect(body).not.toContain('Show more');
  });

  test('uses the 40-line threshold for tool use key-value entries', () => {
    const input = Array.from({ length: 41 }, (_, i) => `input line ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createMessage({
          category: 'toolUse',
          bodyType: 'keyValuePairs',
          rawType: 'llm_tool_use',
          body: {
            type: 'keyValuePairs',
            entries: [
              { key: 'Tool', value: 'search_query' },
              { key: 'Input', value: input },
            ],
          },
        }),
      },
    });

    expect(body).toContain('Show more');
    expect(body).toContain('input line 40');
    expect(body).not.toContain('input line 41');
  });

  test('uses the 40-line threshold for command output', () => {
    const text = Array.from({ length: 41 }, (_, i) => `output ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createMessage({
          category: 'command',
          bodyType: 'monospaced',
          rawType: 'command_result',
          body: { type: 'monospaced', text },
        }),
      },
    });

    expect(body).toContain('Show more (1 more lines)');
    expect(body).toContain('output 40');
    expect(body).not.toContain('output 41');
  });

  test('does not truncate review results', () => {
    const text = Array.from({ length: 15 }, (_, i) => `issue line ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createMessage({
          category: 'error',
          bodyType: 'monospaced',
          rawType: 'review_result',
          body: { type: 'monospaced', text },
        }),
      },
    });

    expect(body).toContain('issue line 15');
    expect(body).not.toContain('Show more');
  });
});
