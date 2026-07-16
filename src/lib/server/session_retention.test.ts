import { describe, expect, test } from 'vitest';

import type { DisplayMessage } from './session_manager.js';
import { compactSessionMessages, getInactiveSessionRetentionPolicy } from './session_retention.js';

function createMessage(seq: number, overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: overrides.id ?? `conn-1:${seq}`,
    seq,
    timestamp: overrides.timestamp ?? new Date(seq * 1000).toISOString(),
    category: overrides.category ?? 'log',
    bodyType: overrides.bodyType ?? 'text',
    body: overrides.body ?? { type: 'text', text: `message-${seq}` },
    rawType: overrides.rawType ?? 'log',
  };
}

describe('session retention policies', () => {
  test('uses short retention for review comment sessions and longer retention for agents', () => {
    const comment = getInactiveSessionRetentionPolicy('review-guide-comment', 'offline');
    const agent = getInactiveSessionRetentionPolicy('agent', 'offline');

    expect(comment.ttlMs).toBe(30 * 60 * 1000);
    expect(comment.maxMessages).toBe(100);
    expect(agent.ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(agent.maxMessages).toBe(500);
    expect(agent.maxBytes).toBeGreaterThan(comment.maxBytes);
  });

  test('notifications use their dedicated bounded policy', () => {
    const policy = getInactiveSessionRetentionPolicy('anything', 'notification');

    expect(policy).toEqual({
      ttlMs: 24 * 60 * 60 * 1000,
      maxMessages: 200,
      maxBytes: 512 * 1024,
    });
  });
});

describe('compactSessionMessages', () => {
  test('retains important lifecycle messages and the recent tail', () => {
    const messages = [
      createMessage(1, { rawType: 'agent_session_start' }),
      createMessage(2),
      createMessage(3, { category: 'error', rawType: 'stderr' }),
      createMessage(4, { rawType: 'execution_summary' }),
      createMessage(5),
      createMessage(6),
      createMessage(7),
      createMessage(8),
    ];

    const result = compactSessionMessages('conn-1', messages, {
      maxMessages: 6,
      maxBytes: 1024 * 1024,
    });

    expect(result.changed).toBe(true);
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]).toMatchObject({
      rawType: 'session_history_pruned',
    });
    expect(result.messages.map((message) => message.rawType)).toContain('agent_session_start');
    expect(result.messages.map((message) => message.rawType)).toContain('execution_summary');
    expect(result.messages.map((message) => message.id)).toContain('conn-1:3');
    expect(result.messages.at(-1)?.id).toBe('conn-1:8');
  });

  test('uses a byte limit even when the message count is below the limit', () => {
    const messages = [
      createMessage(1, { body: { type: 'text', text: 'a'.repeat(2000) } }),
      createMessage(2, { body: { type: 'text', text: 'b'.repeat(2000) } }),
      createMessage(3, { body: { type: 'text', text: 'small' } }),
    ];

    const result = compactSessionMessages('conn-1', messages, {
      maxMessages: 10,
      maxBytes: 700,
    });

    expect(result.changed).toBe(true);
    expect(result.messages[0]?.rawType).toBe('session_history_pruned');
    expect(result.messages.at(-1)?.id).toBe('conn-1:3');
    expect(result.messages.some((message) => message.id === 'conn-1:1')).toBe(false);
    expect(result.messages.some((message) => message.id === 'conn-1:2')).toBe(false);
  });

  test('does not repeatedly rewrite an already bounded transcript', () => {
    const initial = Array.from({ length: 8 }, (_, index) => createMessage(index + 1));
    const first = compactSessionMessages('conn-1', initial, {
      maxMessages: 4,
      maxBytes: 1024 * 1024,
    });
    const second = compactSessionMessages('conn-1', first.messages, {
      maxMessages: 4,
      maxBytes: 1024 * 1024,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.messages).toEqual(first.messages);
  });
});
