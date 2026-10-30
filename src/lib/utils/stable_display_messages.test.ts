import { describe, expect, test } from 'vitest';

import type { DisplayMessage } from '$lib/types/session.js';
import { mergeConsecutiveOutputMessages } from './merge_output_messages.js';
import { reuseUnchangedMessages } from './stable_display_messages.js';

function output(id: string, seq: number, text: string): DisplayMessage {
  return {
    id,
    seq,
    timestamp: '2026-03-17T10:00:00.000Z',
    category: 'log',
    bodyType: 'monospaced',
    body: { type: 'monospaced', text },
    rawType: 'stdout',
  };
}

function text(id: string, seq: number, value: string): DisplayMessage {
  return {
    ...output(id, seq, value),
    bodyType: 'text',
    body: { type: 'text', text: value },
    rawType: 'log',
  };
}

function byId(messages: DisplayMessage[]): Map<string, DisplayMessage> {
  return new Map(messages.map((message) => [message.id, message]));
}

describe('reuseUnchangedMessages', () => {
  test('returns the input array when there is no previous run', () => {
    const messages = [output('a', 1, 'x')];
    expect(reuseUnchangedMessages(messages, new Map())).toBe(messages);
  });

  test('reuses merged output runs that did not change', () => {
    const source = [output('a', 1, 'hello '), output('b', 2, 'world'), text('c', 3, 'done')];
    const first = mergeConsecutiveOutputMessages(source);
    const second = reuseUnchangedMessages(
      mergeConsecutiveOutputMessages([...source, text('d', 4, 'next')]),
      byId(first)
    );

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2].id).toBe('d');
  });

  test('uses the new object when a merged run gets more output', () => {
    const source = [output('a', 1, 'hello ')];
    const first = mergeConsecutiveOutputMessages(source);
    const second = reuseUnchangedMessages(
      mergeConsecutiveOutputMessages([...source, output('b', 2, 'world')]),
      byId(first)
    );

    expect(second[0]).not.toBe(first[0]);
    expect(second[0].body).toEqual({ type: 'monospaced', text: 'hello world' });
  });

  test('uses the new object when other fields change', () => {
    const previous = text('a', 1, 'same');
    const next = {
      ...previous,
      body: { type: 'text' as const, text: 'same' },
      category: 'error' as const,
    };
    expect(reuseUnchangedMessages([next], byId([previous]))[0]).toBe(next);
  });

  test('does not compare non-text bodies by content', () => {
    const previous: DisplayMessage = {
      ...text('a', 1, ''),
      bodyType: 'keyValuePairs',
      body: { type: 'keyValuePairs', entries: [] },
    };
    const next: DisplayMessage = { ...previous, body: { type: 'keyValuePairs', entries: [] } };
    expect(reuseUnchangedMessages([next], byId([previous]))[0]).toBe(next);
  });
});
