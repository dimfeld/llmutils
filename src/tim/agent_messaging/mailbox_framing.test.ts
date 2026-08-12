import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import { ORCHESTRATOR_AGENT_NAME } from './contracts.js';
import { MailboxConnectionFramePolicy, MailboxJsonlDecoder } from './mailbox_framing.js';
import {
  MAX_MAILBOX_FRAME_BYTES,
  MailboxProtocolError,
  buildMailboxMessageRequest,
  buildMailboxSuccessAcknowledgement,
  encodeMailboxFrame,
  parseMailboxFrame,
} from './mailbox_protocol.js';

const request = buildMailboxMessageRequest(
  { id: 'source-id', name: ORCHESTRATOR_AGENT_NAME },
  {
    requestId: 'request-1',
    targetId: 'target-id',
    targetName: 'worker-one',
    content: 'Hello 🚀',
    timestamp: '2026-08-12T00:00:00.000Z',
  }
);
const requestLine = encodeMailboxFrame(request);

function expectMailboxError(action: () => unknown, code: MailboxProtocolError['code']): void {
  try {
    action();
    throw new Error('Expected mailbox action to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MailboxProtocolError);
    expect((error as MailboxProtocolError).code).toBe(code);
  }
}

describe('bounded mailbox JSONL framing', () => {
  test('reconstructs one frame split across chunks and a multibyte character', () => {
    const encoded = Buffer.from(requestLine, 'utf8');
    const emojiBytes = Buffer.from('🚀', 'utf8');
    const emojiOffset = encoded.indexOf(emojiBytes);
    const decoder = new MailboxJsonlDecoder();

    expect(decoder.push(encoded.subarray(0, emojiOffset + 1))).toEqual([]);
    expect(decoder.push(encoded.subarray(emojiOffset + 1, emojiOffset + 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(emojiOffset + 2))).toEqual([requestLine.slice(0, -1)]);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.decodedFrameCount).toBe(1);
    decoder.finish();
  });

  test('returns several complete frames from one chunk when explicitly allowed', () => {
    const decoder = new MailboxJsonlDecoder({ maxFrames: 2 });
    expect(decoder.push(Buffer.from(`${requestLine}${requestLine}`, 'utf8'))).toEqual([
      requestLine.slice(0, -1),
      requestLine.slice(0, -1),
    ]);
    decoder.finish();
  });

  test('rejects an extra frame under the one-frame connection default', () => {
    const decoder = new MailboxJsonlDecoder();
    expectMailboxError(
      () => decoder.push(Buffer.from(`${requestLine}${requestLine}`, 'utf8')),
      'unexpected_frame'
    );

    const partialExtraFrameDecoder = new MailboxJsonlDecoder();
    expect(partialExtraFrameDecoder.push(Buffer.from(requestLine, 'utf8'))).toHaveLength(1);
    expectMailboxError(
      () => partialExtraFrameDecoder.push(Buffer.from('{"kind":"message"}', 'utf8')),
      'unexpected_frame'
    );
  });

  test('rejects empty lines instead of silently treating them as messages', () => {
    const decoder = new MailboxJsonlDecoder();
    expectMailboxError(() => decoder.push(Buffer.from('\n', 'utf8')), 'invalid_message');
  });

  test('keeps JSON validation separate and rejects malformed complete lines', () => {
    const decoder = new MailboxJsonlDecoder();
    const [line] = decoder.push(Buffer.from('not-json\n', 'utf8'));
    expect(line).toBe('not-json');
    expectMailboxError(() => parseMailboxFrame(line), 'invalid_message');
  });

  test('rejects invalid UTF-8 after a complete newline-delimited frame arrives', () => {
    const decoder = new MailboxJsonlDecoder();
    expectMailboxError(() => decoder.push(Buffer.from([0xc3, 0x0a])), 'invalid_utf8');
  });

  test('rejects invalid UTF-8 split across chunks and closes the decoder', () => {
    const decoder = new MailboxJsonlDecoder();
    expect(decoder.push(Buffer.from([0xe2]))).toEqual([]);
    expect(decoder.push(Buffer.from([0x28]))).toEqual([]);
    expectMailboxError(() => decoder.push(Buffer.from([0xa1, 0x0a])), 'invalid_utf8');
    expect(decoder.pendingBytes).toBe(0);
    expectMailboxError(() => decoder.push(Buffer.from(requestLine, 'utf8')), 'runtime_closed');
  });

  test('rejects invalid UTF-8 and incomplete valid frames at connection close', () => {
    const invalidDecoder = new MailboxJsonlDecoder();
    invalidDecoder.push(Buffer.from([0xc3]));
    expectMailboxError(() => invalidDecoder.finish(), 'invalid_utf8');
    expectMailboxError(() => invalidDecoder.finish(), 'runtime_closed');
    expectMailboxError(
      () => invalidDecoder.push(Buffer.from(requestLine, 'utf8')),
      'runtime_closed'
    );

    const incompleteDecoder = new MailboxJsonlDecoder();
    incompleteDecoder.push(Buffer.from('{"kind":"message"}', 'utf8'));
    expectMailboxError(() => incompleteDecoder.finish(), 'incomplete_frame');
    expect(incompleteDecoder.pendingBytes).toBe(0);
    expectMailboxError(() => incompleteDecoder.finish(), 'runtime_closed');
    expectMailboxError(
      () => incompleteDecoder.push(Buffer.from(requestLine, 'utf8')),
      'runtime_closed'
    );
  });

  test('supports an explicitly documented empty-line policy', () => {
    const decoder = new MailboxJsonlDecoder({ rejectEmptyLines: false });
    expect(decoder.push(Buffer.from('\n', 'utf8'))).toEqual(['']);
    expect(decoder.decodedFrameCount).toBe(1);
    decoder.finish();
  });

  test('accepts a frame exactly at the configured byte limit and rejects an impossible partial frame', () => {
    const decoder = new MailboxJsonlDecoder({ maxFrameBytes: 8 });
    expect(decoder.push(Buffer.from('1234567', 'utf8'))).toEqual([]);
    expect(decoder.pendingBytes).toBe(7);
    expect(decoder.push(Buffer.from('\n', 'utf8'))).toEqual(['1234567']);
    decoder.finish();

    const oversizedPartialDecoder = new MailboxJsonlDecoder({ maxFrameBytes: 8 });
    expectMailboxError(
      () => oversizedPartialDecoder.push(Buffer.from('12345678', 'utf8')),
      'frame_too_large'
    );
    expect(oversizedPartialDecoder.pendingBytes).toBe(0);
    expectMailboxError(() => oversizedPartialDecoder.finish(), 'runtime_closed');
  });

  test('rejects oversized complete and partial frames before retaining unbounded data', () => {
    const completeDecoder = new MailboxJsonlDecoder();
    expectMailboxError(
      () =>
        completeDecoder.push(
          Buffer.concat([Buffer.alloc(MAX_MAILBOX_FRAME_BYTES, 0x61), Buffer.from('\n')])
        ),
      'frame_too_large'
    );
    expect(completeDecoder.pendingBytes).toBe(0);

    const partialDecoder = new MailboxJsonlDecoder();
    expectMailboxError(
      () => partialDecoder.push(Buffer.alloc(MAX_MAILBOX_FRAME_BYTES + 1, 0x61)),
      'frame_too_large'
    );
    expect(partialDecoder.pendingBytes).toBe(0);
  });

  test('enforces one correctly directed frame with an explicit connection policy', () => {
    const parsedRequest = parseMailboxFrame(requestLine.slice(0, -1));
    const requestPolicy = new MailboxConnectionFramePolicy('message');
    requestPolicy.accept(parsedRequest);
    expect(requestPolicy.hasAcceptedFrame).toBe(true);
    requestPolicy.complete();

    expectMailboxError(() => requestPolicy.accept(parsedRequest), 'unexpected_frame');

    const ackPolicy = new MailboxConnectionFramePolicy('ack');
    expectMailboxError(() => ackPolicy.accept(parsedRequest), 'invalid_ack');
    expectMailboxError(() => ackPolicy.complete(), 'incomplete_frame');

    const acceptedAckPolicy = new MailboxConnectionFramePolicy('ack');
    acceptedAckPolicy.accept(buildMailboxSuccessAcknowledgement('request-1', 'steered'));
    expect(acceptedAckPolicy.hasAcceptedFrame).toBe(true);
    acceptedAckPolicy.complete();
  });

  test('rejects invalid decoder options and frame-policy kinds', () => {
    expect(() => new MailboxJsonlDecoder({ maxFrameBytes: 1 })).toThrow(RangeError);
    expect(() => new MailboxJsonlDecoder({ maxFrameBytes: MAX_MAILBOX_FRAME_BYTES + 1 })).toThrow(
      RangeError
    );
    expect(() => new MailboxJsonlDecoder({ maxFrames: 0 })).toThrow(RangeError);
    expect(() => new MailboxJsonlDecoder({ rejectEmptyLines: 'no' as never })).toThrow(TypeError);
    expect(() => new MailboxConnectionFramePolicy('other' as never)).toThrow(TypeError);
  });
});
