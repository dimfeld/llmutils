import { describe, expect, test } from 'vitest';

import type { HeadlessMessage, HeadlessServerMessage } from './headless_protocol.js';

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
      'plan_content',
      'output',
      'pty_output',
      'session_ended',
    ]);
    expect([...VALID_HEADLESS_SERVER_TYPES]).toEqual([
      'prompt_response',
      'user_input',
      'pty_input',
      'pty_resize',
      'end_session',
      'force_end_session',
      'notification_subscribers_changed',
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
      parseHeadlessMessage(
        JSON.stringify({ type: 'session_info', command: 'shell', pty: true, cols: 120, rows: 40 })
      )
    ).toEqual({
      type: 'session_info',
      command: 'shell',
      pty: true,
      cols: 120,
      rows: 40,
    });
    expect(
      parseHeadlessMessage(
        JSON.stringify({ type: 'session_info', command: 'shell', hidePlanDetails: true })
      )
    ).toEqual({
      type: 'session_info',
      command: 'shell',
      hidePlanDetails: true,
    });

    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'plan_content', content: '# body' }))
    ).toEqual({
      type: 'plan_content',
      content: '# body',
    });

    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'output', seq: 1, message: { type: 'stdout' } }))
    ).toEqual({
      type: 'output',
      seq: 1,
      message: { type: 'stdout' },
    });

    const ptyOutput = {
      type: 'pty_output',
      data: Buffer.from('hello\r\n').toString('base64'),
    } satisfies HeadlessMessage;
    expect(parseHeadlessMessage(JSON.stringify(ptyOutput))).toEqual(ptyOutput);

    expect(parseHeadlessMessage(JSON.stringify({ type: 'output', message: {} }))).toBeNull();
    expect(parseHeadlessMessage(JSON.stringify({ type: 'pty_output' }))).toBeNull();
    expect(parseHeadlessMessage(JSON.stringify({ type: 'pty_output', data: 123 }))).toBeNull();
    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'pty_output', data: 'not-base64!!!' }))
    ).toBeNull();
    expect(parseHeadlessMessage(JSON.stringify({ type: 'pty_output', data: 'abc' }))).toBeNull();
    expect(parseHeadlessMessage(JSON.stringify({ type: 'pty_output', data: 'abcd=' }))).toBeNull();
    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'session_info', command: 'shell', pty: 'yes' }))
    ).toBeNull();
    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'session_info', command: 'shell', cols: 0 }))
    ).toBeNull();
    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'session_info', command: 'shell', cols: 80.5 }))
    ).toBeNull();
    expect(
      parseHeadlessMessage(JSON.stringify({ type: 'session_info', command: 'shell', rows: -1 }))
    ).toBeNull();
    expect(
      parseHeadlessMessage(
        JSON.stringify({ type: 'session_info', command: 'shell', rows: Number.POSITIVE_INFINITY })
      )
    ).toBeNull();
    expect(
      parseHeadlessMessage(
        JSON.stringify({ type: 'session_info', command: 'shell', hidePlanDetails: 'yes' })
      )
    ).toBeNull();
    expect(parseHeadlessMessage(JSON.stringify({ type: 'plan_content', content: 123 }))).toBeNull();
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

    const ptyInput = {
      type: 'pty_input',
      data: Buffer.from('pwd\r').toString('base64'),
    } satisfies HeadlessServerMessage;
    expect(parseHeadlessServerMessage(JSON.stringify(ptyInput))).toEqual(ptyInput);
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: 120, rows: 36 }))
    ).toEqual({
      type: 'pty_resize',
      cols: 120,
      rows: 36,
    });

    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'end_session' }))).toEqual({
      type: 'end_session',
    });
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'force_end_session' }))).toEqual({
      type: 'force_end_session',
    });
    expect(
      parseHeadlessServerMessage(
        JSON.stringify({ type: 'notification_subscribers_changed', hasSubscribers: true })
      )
    ).toEqual({
      type: 'notification_subscribers_changed',
      hasSubscribers: true,
    });

    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'prompt_response', value: 'missing-id' }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'user_input', content: 123 }))
    ).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'pty_input' }))).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'pty_input', data: 123 }))).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_input', data: 'not-base64!!!' }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_input', data: 'abc' }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_input', data: 'abcd=' }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: '80', rows: 24 }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: 80, rows: '24' }))
    ).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: 80 }))).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', rows: 24 }))).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize' }))).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: 0, rows: 24 }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: -1, rows: 24 }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: 80.5, rows: 24 }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(JSON.stringify({ type: 'pty_resize', cols: Number.NaN, rows: 24 }))
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(
        JSON.stringify({ type: 'pty_resize', cols: Number.POSITIVE_INFINITY, rows: 24 })
      )
    ).toBeNull();
    expect(
      parseHeadlessServerMessage(
        JSON.stringify({ type: 'notification_subscribers_changed', hasSubscribers: 'yes' })
      )
    ).toBeNull();
    expect(parseHeadlessServerMessage(JSON.stringify({ type: 'output' }))).toBeNull();
  });
});
