import { describe, expect, test } from 'vitest';

import type { DisplayMessage } from '$lib/types/session.js';
import type { OutputOrigin } from '../../logging/tunnel_protocol.js';

import { mergeConsecutiveOutputMessages } from './merge_output_messages.js';

let seq = 0;

function output(rawType: 'stdout' | 'stderr', text: string, origin?: OutputOrigin): DisplayMessage {
  seq += 1;
  return {
    id: `conn:${seq}`,
    seq,
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    category: 'log',
    bodyType: 'monospaced',
    body: { type: 'monospaced', text },
    rawType,
    origin,
  };
}

function structured(): DisplayMessage {
  seq += 1;
  return {
    id: `conn:${seq}`,
    seq,
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    category: 'structured',
    bodyType: 'structured',
    body: { type: 'structured', message: { type: 'agent_session_start' } },
    rawType: 'agent_session_start',
  };
}

describe('mergeConsecutiveOutputMessages', () => {
  test('joins consecutive stdout chunks into one message', () => {
    const result = mergeConsecutiveOutputMessages([
      output('stdout', 'hello wo'),
      output('stdout', 'rld\n'),
      output('stdout', 'next line\n'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].body).toEqual({ type: 'monospaced', text: 'hello world\nnext line\n' });
  });

  test('keeps the first message id and metadata for a merged run', () => {
    const first = output('stdout', 'a');
    const result = mergeConsecutiveOutputMessages([first, output('stdout', 'b')]);

    expect(result[0].id).toBe(first.id);
    expect(result[0].seq).toBe(first.seq);
    expect(result[0].timestamp).toBe(first.timestamp);
  });

  test('does not merge across different streams', () => {
    const result = mergeConsecutiveOutputMessages([
      output('stdout', 'out'),
      output('stderr', 'err'),
      output('stdout', 'out2'),
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((m) => (m.body.type === 'monospaced' ? m.body.text : ''))).toEqual([
      'out',
      'err',
      'out2',
    ]);
  });

  test('does not merge across different origins', () => {
    const result = mergeConsecutiveOutputMessages([
      output('stdout', 'a', 'lifecycle'),
      output('stdout', 'b'),
    ]);

    expect(result).toHaveLength(2);
  });

  test('does not merge non-output messages and resets runs around them', () => {
    const result = mergeConsecutiveOutputMessages([
      output('stdout', 'a'),
      output('stdout', 'b'),
      structured(),
      output('stdout', 'c'),
      output('stdout', 'd'),
    ]);

    expect(result).toHaveLength(3);
    expect(result[0].body).toEqual({ type: 'monospaced', text: 'ab' });
    expect(result[1].category).toBe('structured');
    expect(result[2].body).toEqual({ type: 'monospaced', text: 'cd' });
  });

  test('does not mutate the input messages', () => {
    const first = output('stdout', 'a');
    const second = output('stdout', 'b');
    mergeConsecutiveOutputMessages([first, second]);

    expect(first.body).toEqual({ type: 'monospaced', text: 'a' });
    expect(second.body).toEqual({ type: 'monospaced', text: 'b' });
  });

  test('returns an empty array for no messages', () => {
    expect(mergeConsecutiveOutputMessages([])).toEqual([]);
  });
});
