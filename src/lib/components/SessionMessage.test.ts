import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { DisplayMessage, StructuredMessagePayload } from '$lib/types/session.js';

import SessionMessage from './SessionMessage.svelte';

function createMessage(
  overrides: Partial<DisplayMessage> & Pick<DisplayMessage, 'bodyType' | 'body'>
): DisplayMessage {
  return {
    id: 'msg-1',
    seq: 1,
    timestamp: '2026-03-17T10:00:00.000Z',
    category: 'log',
    rawType: 'llm_response',
    ...overrides,
  } as DisplayMessage;
}

function createStructuredMessage(
  structuredMessage: StructuredMessagePayload,
  overrides?: Partial<DisplayMessage>
): DisplayMessage {
  return createMessage({
    category: 'structured',
    bodyType: 'structured',
    rawType: structuredMessage.type,
    body: { type: 'structured', message: structuredMessage },
    ...overrides,
  });
}

describe('SessionMessage', () => {
  test('does not truncate llmOutput messages (structured)', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createStructuredMessage({ type: 'llm_response', text }),
      },
    });

    expect(body).toContain('line 50');
    expect(body).not.toContain('Show more');
  });

  test('uses the 40-line threshold for tool use key-value entries (structured)', () => {
    const input = Array.from({ length: 41 }, (_, i) => `input line ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createStructuredMessage({
          type: 'llm_tool_use',
          toolName: 'search_query',
          toolUseId: 'tu-1',
          input,
        }),
      },
    });

    expect(body).toContain('Show more');
    expect(body).toContain('input line 40');
    expect(body).not.toContain('input line 41');
  });

  test('uses the 40-line threshold for command output (structured)', () => {
    const stdout = Array.from({ length: 41 }, (_, i) => `output ${i + 1}`).join('\n');
    const { body } = render(SessionMessage, {
      props: {
        message: createStructuredMessage({
          type: 'command_result',
          command: 'ls',
          exitCode: 0,
          stdout,
        }),
      },
    });

    expect(body).toContain('Show more');
    // The command_result formatter outputs "$ ls\n\nexit 0\n\nstdout:\n..." so the line count
    // includes the header lines. The stdout content starts after those lines.
    expect(body).not.toContain('output 41');
  });

  test('renders review_result with ReviewResultDisplay', () => {
    const { body } = render(SessionMessage, {
      props: {
        message: createStructuredMessage({
          type: 'review_result',
          verdict: 'NEEDS_FIXES',
          issues: [
            {
              severity: 'critical',
              category: 'bug',
              content: 'Null pointer dereference',
              file: 'src/main.ts',
              line: '42',
              suggestion: 'Add null check',
            },
            {
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/utils.ts',
              line: '10',
              suggestion: 'Use camelCase',
            },
          ],
          recommendations: ['Add more tests'],
          actionItems: ['Fix the critical bug'],
        }),
      },
    });

    // Verify rich rendering elements
    expect(body).toContain('NEEDS FIXES');
    expect(body).toContain('Null pointer dereference');
    expect(body).toContain('src/main.ts');
    expect(body).toContain('42');
    expect(body).toContain('Add null check');
    expect(body).toContain('Critical');
    expect(body).toContain('Minor');
    expect(body).toContain('Add more tests');
    expect(body).toContain('Fix the critical bug');
    // Should NOT contain "Show more" — review results are not truncated
    expect(body).not.toContain('Show more');
  });

  test('renders review_result with ACCEPTABLE verdict', () => {
    const { body } = render(SessionMessage, {
      props: {
        message: createStructuredMessage({
          type: 'review_result',
          verdict: 'ACCEPTABLE',
          issues: [],
          recommendations: [],
          actionItems: [],
        }),
      },
    });

    expect(body).toContain('ACCEPTABLE');
  });

  test('renders plain text messages', () => {
    const { body } = render(SessionMessage, {
      props: {
        message: createMessage({
          category: 'log',
          bodyType: 'text',
          body: { type: 'text', text: 'Hello world' },
        }),
      },
    });

    expect(body).toContain('Hello world');
  });

  test('renders monospaced messages', () => {
    const { body } = render(SessionMessage, {
      props: {
        message: createMessage({
          category: 'log',
          bodyType: 'monospaced',
          body: { type: 'monospaced', text: 'some output' },
        }),
      },
    });

    expect(body).toContain('some output');
  });
});
