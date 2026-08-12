import { Buffer } from 'node:buffer';
import * as z from 'zod/v4';
import {
  MAX_AGENT_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  agentAddressSchema,
  agentIdSchema,
  agentMessageContentSchema,
  sendAgentMessageAcknowledgementSchema,
  type SendAgentMessageAcknowledgement,
} from './contracts.js';
import { isRecord } from '../../common/type_guards.js';
import { containsControlCharacters } from './mailbox_helpers.js';

// Re-export the canonical limits for mailbox consumers without defining a
// second transport-specific value.
export { MAX_AGENT_MESSAGE_BYTES, MAX_PENDING_MESSAGES_PER_RECIPIENT };

/** The first version of the provider-neutral mailbox wire protocol. */
export const MAILBOX_PROTOCOL_VERSION = 1 as const;

/**
 * Maximum encoded JSONL frame size, including its trailing newline.
 *
 * A 65,536-byte message can expand when JSON escapes control characters. 512
 * KiB leaves bounded headroom for that expansion and the validated envelope,
 * while keeping an untrusted connection well below the older 1 MiB limit used
 * by the permissions MCP.
 */
export const MAX_MAILBOX_FRAME_BYTES = 512 * 1024;

export const MAX_MAILBOX_AGENT_ID_LENGTH = 128;
export const MAX_MAILBOX_REQUEST_ID_LENGTH = 128;
export const MAX_MAILBOX_TIMESTAMP_LENGTH = 64;
export const MAX_MAILBOX_ERROR_MESSAGE_LENGTH = 512;

export const MAILBOX_ERROR_CODES = [
  'invalid_message',
  'message_too_large',
  'frame_too_large',
  'unknown_source',
  'unknown_target',
  'target_not_ready',
  'target_stale',
  'queue_full',
  'connection_failed',
  'ack_timeout',
  'invalid_ack',
  'runtime_closed',
  'duplicate_message_id',
  'unsupported_version',
  'invalid_utf8',
  'incomplete_frame',
  'unexpected_frame',
] as const;
export type MailboxErrorCode = (typeof MAILBOX_ERROR_CODES)[number];
export const mailboxErrorCodeSchema = z.enum(MAILBOX_ERROR_CODES);

/** A stable protocol error that can be mapped to a model-visible result. */
export class MailboxProtocolError extends Error {
  public readonly code: MailboxErrorCode;

  public constructor(code: MailboxErrorCode, message: string) {
    super(message);
    this.name = 'MailboxProtocolError';
    this.code = code;
  }
}

const mailboxSafeStringSchema = z
  .string()
  .refine(
    (value: string): boolean => !containsControlCharacters(value),
    'Value must not contain control characters'
  );

const mailboxAgentIdSchema = agentIdSchema
  .max(MAX_MAILBOX_AGENT_ID_LENGTH)
  .refine(
    (value: string): boolean => !containsControlCharacters(value),
    'Agent IDs must not contain control characters'
  );

const mailboxRequestIdSchema = mailboxSafeStringSchema.min(1).max(MAX_MAILBOX_REQUEST_ID_LENGTH);

const mailboxTimestampSchema = z.iso.datetime({ offset: true }).max(MAX_MAILBOX_TIMESTAMP_LENGTH);

const mailboxErrorMessageSchema = mailboxSafeStringSchema
  .min(1)
  .max(MAX_MAILBOX_ERROR_MESSAGE_LENGTH);

/** The identity fields carried in a validated mailbox envelope. */
export const mailboxIdentitySchema = z
  .object({
    id: mailboxAgentIdSchema,
    name: agentAddressSchema,
  })
  .strict();
export type MailboxIdentity = z.infer<typeof mailboxIdentitySchema>;

/** A request carrying one message from one trusted identity to another. */
export const mailboxMessageRequestSchema = z
  .object({
    protocolVersion: z.literal(MAILBOX_PROTOCOL_VERSION),
    kind: z.literal('message'),
    requestId: mailboxRequestIdSchema,
    sourceId: mailboxAgentIdSchema,
    sourceName: agentAddressSchema,
    targetId: mailboxAgentIdSchema,
    targetName: agentAddressSchema,
    content: agentMessageContentSchema,
    timestamp: mailboxTimestampSchema,
  })
  .strict();
export type MailboxMessageRequest = z.infer<typeof mailboxMessageRequestSchema>;

export const mailboxErrorSchema = z
  .object({
    code: mailboxErrorCodeSchema,
    message: mailboxErrorMessageSchema,
  })
  .strict();
export type MailboxError = z.infer<typeof mailboxErrorSchema>;

export const mailboxSuccessAcknowledgementSchema = z
  .object({
    protocolVersion: z.literal(MAILBOX_PROTOCOL_VERSION),
    kind: z.literal('ack'),
    requestId: mailboxRequestIdSchema,
    success: z.literal(true),
    delivery: sendAgentMessageAcknowledgementSchema,
  })
  .strict();

export const mailboxFailureAcknowledgementSchema = z
  .object({
    protocolVersion: z.literal(MAILBOX_PROTOCOL_VERSION),
    kind: z.literal('ack'),
    requestId: mailboxRequestIdSchema,
    success: z.literal(false),
    error: mailboxErrorSchema,
  })
  .strict();

/** One correlated success or failure response to a mailbox request. */
export const mailboxAcknowledgementSchema = z.discriminatedUnion('success', [
  mailboxSuccessAcknowledgementSchema,
  mailboxFailureAcknowledgementSchema,
]);
export type MailboxAcknowledgement = z.infer<typeof mailboxAcknowledgementSchema>;

/** Any frame that may appear on a mailbox connection. */
export const mailboxFrameSchema = z.discriminatedUnion('kind', [
  mailboxMessageRequestSchema,
  mailboxAcknowledgementSchema,
]);
export type MailboxFrame = z.infer<typeof mailboxFrameSchema>;

/** The model-facing fields accepted by the mailbox client. */
export const mailboxSendMessageInputSchema = z
  .object({
    content: agentMessageContentSchema,
    requestId: mailboxRequestIdSchema.optional(),
    timestamp: mailboxTimestampSchema.optional(),
  })
  .strict();
export type MailboxSendMessageInput = z.infer<typeof mailboxSendMessageInputSchema>;

export interface MailboxMessageRequestInput {
  requestId: string;
  targetId: string;
  targetName: string;
  content: string;
  timestamp?: string;
}

const mailboxMessageRequestInputSchema = z
  .object({
    requestId: mailboxRequestIdSchema,
    targetId: mailboxAgentIdSchema,
    targetName: agentAddressSchema,
    content: agentMessageContentSchema,
    timestamp: mailboxTimestampSchema.optional(),
  })
  .strict();

function validationMessage(result: { error: { issues: Array<{ message: string }> } }): string {
  return result.error.issues[0]?.message ?? 'Mailbox value failed validation';
}

function throwValidationError(
  code: MailboxErrorCode,
  result: { error: { issues: Array<{ message: string }> } }
): never {
  throw new MailboxProtocolError(code, validationMessage(result));
}

function checkProtocolVersion(value: Record<string, unknown>, errorCode: MailboxErrorCode): void {
  if (
    Object.hasOwn(value, 'protocolVersion') &&
    value.protocolVersion !== MAILBOX_PROTOCOL_VERSION
  ) {
    throw new MailboxProtocolError(
      'unsupported_version',
      `Unsupported mailbox protocol version: ${String(value.protocolVersion)}`
    );
  }

  if (!Object.hasOwn(value, 'protocolVersion')) {
    throw new MailboxProtocolError(errorCode, 'Mailbox frame is missing protocolVersion');
  }
}

function checkMessageContentSize(value: Record<string, unknown>): void {
  if (typeof value.content !== 'string') {
    return;
  }

  const byteLength = Buffer.byteLength(value.content, 'utf8');
  if (byteLength > MAX_AGENT_MESSAGE_BYTES) {
    throw new MailboxProtocolError(
      'message_too_large',
      `Agent message content must be at most ${MAX_AGENT_MESSAGE_BYTES} UTF-8 bytes`
    );
  }
}

/** Parses and strictly validates one mailbox message request object. */
export function parseMailboxMessageRequest(value: unknown): MailboxMessageRequest {
  if (!isRecord(value)) {
    throw new MailboxProtocolError('invalid_message', 'Mailbox message must be a JSON object');
  }

  checkProtocolVersion(value, 'invalid_message');
  checkMessageContentSize(value);

  const result = mailboxMessageRequestSchema.safeParse(value);
  if (!result.success) {
    throwValidationError('invalid_message', result);
  }
  return result.data;
}

/** Parses and strictly validates the public mailbox send input. */
export function parseMailboxSendMessageInput(value: unknown): MailboxSendMessageInput {
  if (!isRecord(value)) {
    throw new MailboxProtocolError('invalid_message', 'Mailbox send input must be an object');
  }

  checkMessageContentSize(value);
  const result = mailboxSendMessageInputSchema.safeParse(value);
  if (!result.success) {
    throwValidationError('invalid_message', result);
  }
  return result.data;
}

/** Parses and strictly validates one mailbox acknowledgement object. */
export function parseMailboxAcknowledgement(value: unknown): MailboxAcknowledgement {
  if (!isRecord(value)) {
    throw new MailboxProtocolError('invalid_ack', 'Mailbox acknowledgement must be a JSON object');
  }

  checkProtocolVersion(value, 'invalid_ack');

  const result = mailboxAcknowledgementSchema.safeParse(value);
  if (!result.success) {
    throwValidationError('invalid_ack', result);
  }
  return result.data;
}

/** Parses either supported JSON object kind without accepting unknown kinds. */
export function parseMailboxFrameValue(value: unknown): MailboxFrame {
  if (!isRecord(value)) {
    throw new MailboxProtocolError('invalid_message', 'Mailbox frame must be a JSON object');
  }

  if (value.kind === 'message') {
    return parseMailboxMessageRequest(value);
  }
  if (value.kind === 'ack') {
    return parseMailboxAcknowledgement(value);
  }

  throw new MailboxProtocolError('invalid_message', 'Mailbox frame has an unsupported kind');
}

/** Parses one complete JSONL line, excluding its trailing newline. */
export function parseMailboxFrame(line: string): MailboxFrame {
  if (typeof line !== 'string' || line.includes('\n') || line.includes('\r')) {
    throw new MailboxProtocolError('invalid_message', 'Mailbox frame must contain one JSON line');
  }

  if (Buffer.byteLength(`${line}\n`, 'utf8') > MAX_MAILBOX_FRAME_BYTES) {
    throw new MailboxProtocolError(
      'frame_too_large',
      `Mailbox frame must be at most ${MAX_MAILBOX_FRAME_BYTES} bytes`
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new MailboxProtocolError('invalid_message', 'Mailbox frame contains invalid JSON');
  }

  return parseMailboxFrameValue(value);
}

/** Encodes one validated mailbox frame as compact JSONL. */
export function encodeMailboxFrame(frame: MailboxFrame): string {
  const validatedFrame = parseMailboxFrameValue(frame);
  const encoded = `${JSON.stringify(validatedFrame)}\n`;
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > MAX_MAILBOX_FRAME_BYTES) {
    throw new MailboxProtocolError(
      'frame_too_large',
      `Mailbox frame must be at most ${MAX_MAILBOX_FRAME_BYTES} bytes`
    );
  }
  return encoded;
}

/**
 * Builds a request from a caller-bound source identity and explicit message
 * fields. The input shape has no source fields, so untrusted arguments cannot
 * replace the source identity that is written to the wire.
 */
export function buildMailboxMessageRequest(
  trustedSource: MailboxIdentity,
  input: MailboxMessageRequestInput
): MailboxMessageRequest {
  const sourceResult = mailboxIdentitySchema.safeParse(trustedSource);
  if (!sourceResult.success) {
    throwValidationError('invalid_message', sourceResult);
  }

  if (isRecord(input) && typeof input.content === 'string') {
    const byteLength = Buffer.byteLength(input.content, 'utf8');
    if (byteLength > MAX_AGENT_MESSAGE_BYTES) {
      throw new MailboxProtocolError(
        'message_too_large',
        `Agent message content must be at most ${MAX_AGENT_MESSAGE_BYTES} UTF-8 bytes`
      );
    }
  }

  const inputResult = mailboxMessageRequestInputSchema.safeParse(input);
  if (!inputResult.success) {
    throwValidationError('invalid_message', inputResult);
  }

  const fields = inputResult.data;
  return parseMailboxMessageRequest({
    protocolVersion: MAILBOX_PROTOCOL_VERSION,
    kind: 'message',
    requestId: fields.requestId,
    sourceId: sourceResult.data.id,
    sourceName: sourceResult.data.name,
    targetId: fields.targetId,
    targetName: fields.targetName,
    content: fields.content,
    timestamp: fields.timestamp ?? new Date().toISOString(),
  });
}

/** Builds a correlated successful mailbox acknowledgement. */
export function buildMailboxSuccessAcknowledgement(
  requestId: string,
  delivery: SendAgentMessageAcknowledgement
): MailboxAcknowledgement {
  return parseMailboxAcknowledgement({
    protocolVersion: MAILBOX_PROTOCOL_VERSION,
    kind: 'ack',
    requestId,
    success: true,
    delivery,
  });
}

/** Builds a correlated stable-error mailbox acknowledgement. */
export function buildMailboxFailureAcknowledgement(
  requestId: string,
  code: MailboxErrorCode,
  message: string
): MailboxAcknowledgement {
  return parseMailboxAcknowledgement({
    protocolVersion: MAILBOX_PROTOCOL_VERSION,
    kind: 'ack',
    requestId,
    success: false,
    error: { code, message },
  });
}
