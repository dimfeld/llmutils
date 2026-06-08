import type { HeadlessMessage, HeadlessServerMessage } from './headless_protocol.js';

export const VALID_HEADLESS_TYPES = new Set<HeadlessMessage['type']>([
  'session_info',
  'replay_start',
  'replay_end',
  'plan_content',
  'output',
  'pty_output',
  'session_ended',
]);

export const VALID_HEADLESS_SERVER_TYPES = new Set<HeadlessServerMessage['type']>([
  'prompt_response',
  'user_input',
  'pty_input',
  'pty_resize',
  'end_session',
  'force_end_session',
  'notification_subscribers_changed',
]);

function parseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isStrictBase64(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  if (value.length === 0) {
    return true;
  }

  if (value.length % 4 !== 0) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }

  const firstPadding = value.indexOf('=');
  if (firstPadding !== -1 && firstPadding < value.length - (value.endsWith('==') ? 2 : 1)) {
    return false;
  }

  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function parseHeadlessMessage(payload: string): HeadlessMessage | null {
  const parsed = parseJsonRecord(payload);
  if (!parsed) {
    return null;
  }

  if (
    typeof parsed.type !== 'string' ||
    !VALID_HEADLESS_TYPES.has(parsed.type as HeadlessMessage['type'])
  ) {
    return null;
  }

  if (
    parsed.type === 'output' &&
    (typeof parsed.seq !== 'number' || !('message' in parsed) || parsed.message == null)
  ) {
    return null;
  }

  if (parsed.type === 'session_info') {
    if ('pty' in parsed && typeof parsed.pty !== 'boolean') {
      return null;
    }
    if ('cols' in parsed && !isPositiveInteger(parsed.cols)) {
      return null;
    }
    if ('rows' in parsed && !isPositiveInteger(parsed.rows)) {
      return null;
    }
    if ('hidePlanDetails' in parsed && typeof parsed.hidePlanDetails !== 'boolean') {
      return null;
    }
  }

  if (parsed.type === 'pty_output' && !isStrictBase64(parsed.data)) {
    return null;
  }

  if (parsed.type === 'plan_content' && typeof parsed.content !== 'string') {
    return null;
  }

  if (parsed.type === 'plan_content' && parsed.tasks != null && !Array.isArray(parsed.tasks)) {
    return null;
  }

  return parsed as unknown as HeadlessMessage;
}

export function parseHeadlessServerMessage(payload: string): HeadlessServerMessage | null {
  const parsed = parseJsonRecord(payload);
  if (!parsed) {
    return null;
  }

  if (
    typeof parsed.type !== 'string' ||
    !VALID_HEADLESS_SERVER_TYPES.has(parsed.type as HeadlessServerMessage['type'])
  ) {
    return null;
  }

  switch (parsed.type) {
    case 'prompt_response':
      if (typeof parsed.requestId !== 'string') {
        return null;
      }
      if (parsed.error != null && typeof parsed.error !== 'string') {
        return null;
      }
      return parsed as unknown as HeadlessServerMessage;
    case 'user_input':
      if (typeof parsed.content !== 'string') {
        return null;
      }
      return parsed as unknown as HeadlessServerMessage;
    case 'pty_input':
      if (!isStrictBase64(parsed.data)) {
        return null;
      }
      return parsed as unknown as HeadlessServerMessage;
    case 'pty_resize':
      if (!isPositiveInteger(parsed.cols) || !isPositiveInteger(parsed.rows)) {
        return null;
      }
      return parsed as unknown as HeadlessServerMessage;
    case 'end_session':
      return parsed as unknown as HeadlessServerMessage;
    case 'force_end_session':
      return parsed as unknown as HeadlessServerMessage;
    case 'notification_subscribers_changed':
      if (typeof parsed.hasSubscribers !== 'boolean') {
        return null;
      }
      return parsed as unknown as HeadlessServerMessage;
    default:
      return null;
  }
}
