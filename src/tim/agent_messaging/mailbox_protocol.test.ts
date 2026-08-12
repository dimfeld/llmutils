import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import {
  MAX_AGENT_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  ORCHESTRATOR_AGENT_NAME,
} from './contracts.js';
import {
  MAILBOX_ERROR_CODES,
  MAILBOX_PROTOCOL_VERSION,
  MAX_MAILBOX_FRAME_BYTES,
  MAX_PENDING_MESSAGES_PER_RECIPIENT as MAX_MAILBOX_PENDING_MESSAGES,
  MailboxProtocolError,
  buildMailboxFailureAcknowledgement,
  buildMailboxMessageRequest,
  buildMailboxSuccessAcknowledgement,
  encodeMailboxFrame,
  mailboxAcknowledgementSchema,
  mailboxErrorSchema,
  mailboxMessageRequestSchema,
  parseMailboxAcknowledgement,
  parseMailboxFrame,
  parseMailboxMessageRequest,
} from './mailbox_protocol.js';

const source = { id: 'source-id', name: ORCHESTRATOR_AGENT_NAME } as const;
const requestInput = {
  requestId: 'request-1',
  targetId: 'target-id',
  targetName: 'worker-one',
  content: 'Status update.',
  timestamp: '2026-08-12T00:00:00.000Z',
} as const;

function expectMailboxError(action: () => unknown, code: MailboxProtocolError['code']): void {
  try {
    action();
    throw new Error('Expected mailbox action to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MailboxProtocolError);
    expect((error as MailboxProtocolError).code).toBe(code);
  }
}

describe('mailbox protocol schemas', () => {
  test('re-exports the canonical message and pending-queue limits', () => {
    expect(MAX_MAILBOX_PENDING_MESSAGES).toBe(MAX_PENDING_MESSAGES_PER_RECIPIENT);
    expect(MAX_MAILBOX_PENDING_MESSAGES).toBe(100);
  });

  test('builds a strict request with source fields from the bound identity', () => {
    const request = buildMailboxMessageRequest(source, requestInput);

    expect(request).toEqual({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'message',
      requestId: 'request-1',
      sourceId: 'source-id',
      sourceName: ORCHESTRATOR_AGENT_NAME,
      targetId: 'target-id',
      targetName: 'worker-one',
      content: 'Status update.',
      timestamp: '2026-08-12T00:00:00.000Z',
    });
    expect(mailboxMessageRequestSchema.safeParse(request).success).toBe(true);
    expect(parseMailboxFrame(encodeMailboxFrame(request).slice(0, -1))).toEqual(request);
  });

  test('does not accept model-supplied source fields in the builder input', () => {
    const spoofedInput = { ...requestInput, sourceId: 'spoofed-id', sourceName: 'spoofed-name' };
    expectMailboxError(() => buildMailboxMessageRequest(source, spoofedInput), 'invalid_message');
  });

  test('rejects unknown request fields and unsupported versions', () => {
    const request = buildMailboxMessageRequest(source, requestInput);
    expectMailboxError(
      () => parseMailboxMessageRequest({ ...request, unexpected: true }),
      'invalid_message'
    );
    expectMailboxError(
      () => parseMailboxMessageRequest({ ...request, protocolVersion: 2 }),
      'unsupported_version'
    );
  });

  test('accepts every canonical successful delivery disposition', () => {
    for (const delivery of ['steered', 'queued', 'started-idle-turn'] as const) {
      const acknowledgement = buildMailboxSuccessAcknowledgement('request-1', delivery);
      expect(acknowledgement).toEqual({
        protocolVersion: MAILBOX_PROTOCOL_VERSION,
        kind: 'ack',
        requestId: 'request-1',
        success: true,
        delivery,
      });
      expect(mailboxAcknowledgementSchema.safeParse(acknowledgement).success).toBe(true);
      expect(parseMailboxAcknowledgement(acknowledgement)).toEqual(acknowledgement);
    }
  });

  test('rejects invalid acknowledgements and unknown error fields', () => {
    const invalidDisposition = {
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'ack',
      requestId: 'request-1',
      success: true,
      delivery: 'immediate',
    };
    expectMailboxError(() => parseMailboxAcknowledgement(invalidDisposition), 'invalid_ack');

    const failure = buildMailboxFailureAcknowledgement(
      'request-1',
      'target_stale',
      'The target is no longer ready.'
    );
    expect(failure).toEqual({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      kind: 'ack',
      requestId: 'request-1',
      success: false,
      error: {
        code: 'target_stale',
        message: 'The target is no longer ready.',
      },
    });
    expect(mailboxErrorSchema.safeParse(failure.error).success).toBe(true);
    expectMailboxError(
      () => parseMailboxAcknowledgement({ ...failure, extra: true }),
      'invalid_ack'
    );
    expect(MAILBOX_ERROR_CODES).toContain('invalid_ack');
  });

  test('accepts exact UTF-8 message content and rejects one byte above it', () => {
    const asciiAtLimit = 'a'.repeat(MAX_AGENT_MESSAGE_BYTES);
    const emojiAtLimit = '🚀'.repeat(MAX_AGENT_MESSAGE_BYTES / 4);

    expect(
      buildMailboxMessageRequest(source, { ...requestInput, content: asciiAtLimit }).content
    ).toBe(asciiAtLimit);
    expect(
      buildMailboxMessageRequest(source, { ...requestInput, content: emojiAtLimit }).content
    ).toBe(emojiAtLimit);

    expectMailboxError(
      () =>
        buildMailboxMessageRequest(source, {
          ...requestInput,
          content: `${emojiAtLimit}a`,
        }),
      'message_too_large'
    );

    const validRequest = buildMailboxMessageRequest(source, requestInput);
    expectMailboxError(
      () => parseMailboxMessageRequest({ ...validRequest, content: `${asciiAtLimit}a` }),
      'message_too_large'
    );
  });

  test('keeps the worst valid JSON escaping within the frame bound', () => {
    const controlContent = '\u0000'.repeat(MAX_AGENT_MESSAGE_BYTES);
    const request = buildMailboxMessageRequest(source, {
      ...requestInput,
      content: controlContent,
    });
    const encoded = encodeMailboxFrame(request);

    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_MAILBOX_FRAME_BYTES);
    expect(parseMailboxFrame(encoded.slice(0, -1))).toEqual(request);
  });

  test('rejects oversized complete JSON lines before JSON parsing', () => {
    const oversizedLine = 'a'.repeat(MAX_MAILBOX_FRAME_BYTES);
    expectMailboxError(() => parseMailboxFrame(oversizedLine), 'frame_too_large');
  });
});
