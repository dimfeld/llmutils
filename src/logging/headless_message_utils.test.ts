import { describe, expect, test, vi } from 'vitest';

import {
  parseHeadlessMessage,
  parseHeadlessServerMessage,
  VALID_HEADLESS_SERVER_TYPES,
  VALID_HEADLESS_TYPES,
} from './headless_message_utils.js';

describe('headless_message_utils', () => {
  test('exports the expected headless message type sets', () => {
    expect([...VALID_HEADLESS_TYPES]).toEqual([
      'session_info',
      'replay_start',
      'replay_end',
      'output',
      'session_ended',
    ]);
    expect([...VALID_HEADLESS_SERVER_TYPES]).toEqual([
      'prompt_response',
      'user_input',
      'end_session',
    ]);
  });

  test('parses valid headless messages and rejects malformed payloads', () => {
    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'session_info', command: 'agent' }))
    ).toEqual({
      type: 'session_info',
      command: 'agent',
    });

    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'output', seq: 1, message: { type: 'stdout' } }))
    ).toEqual({
      type: 'output',
      seq: 1,
      message: { type: 'stdout' },
    });

    expect(parseHeadlessMessage(JSON.stringify({ type: 'output', message: {} }))).toBeNull();
    expect(parseHeadlessMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(parseHeadlessMessage('not-json')).toBeNull();
  });

  test('parses valid headless server messages and rejects malformed payloads', () => {
    expect(
      parseHeadlessServerMessage(
        JSON.stringify({ type: 'prompt_response', requestId: 'req-1', value: 'ok' })
      )
    ).toEqual({
      type: 'prompt_response',
      requestId: 'req-1',
      value: 'ok',
    });

    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'user_input', content: 'hello' }))
    ).toEqual({
      type: 'user_input',
      content: 'hello',
    });

    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'end_session' }))).toEqual({
      type: 'end_session',
    });

    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'prompt_response', value: 'missing-id' }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'user_input', content: 123 }))
    ).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'output' }))).toBeNull();
  });
});
