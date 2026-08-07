import type { HeadlessMessage, HeadlessServerMessage } from './headless_protocol.js';
import {
  isProcessId,
  isSessionProcessTerminationResult,
  type SessionProcessNode,
} from '../common/session_process.js';

export const VALID_HEADLESS_TYPES = new Set<HeadlessMessage['type']>([
  'session_info',
  'replay_start',
  'replay_end',
  'plan_content',
  'output',
  'pty_output',
  'session_ended',
  'process_tree_snapshot',
  'process_tree_update',
  'executor_termination_result',
]);

export const VALID_HEADLESS_SERVER_TYPES = new Set<HeadlessServerMessage['type']>([
  'prompt_response',
  'user_input',
  'pty_input',
  'pty_resize',
  'end_session',
  'force_end_session',
  'terminate_executor',
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

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isOptionalString(value: unknown, maxLength = 2048): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function isProcessNode(value: unknown): value is SessionProcessNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const node = value as Record<string, unknown>;
  return (
    isProcessId(node.processId) &&
    (node.parentProcessId === undefined || isProcessId(node.parentProcessId)) &&
    (node.ownerProcessId === undefined || isProcessId(node.ownerProcessId)) &&
    (node.kind === 'tim' || node.kind === 'executor') &&
    typeof node.label === 'string' &&
    node.label.trim().length > 0 &&
    node.label.length <= 512 &&
    isOptionalPositiveInteger(node.pid) &&
    isOptionalString(node.command) &&
    isOptionalString(node.startIdentity) &&
    typeof node.startedAt === 'string' &&
    node.startedAt.length > 0 &&
    node.startedAt.length <= 512 &&
    (node.state === 'starting' ||
      node.state === 'running' ||
      node.state === 'exited' ||
      node.state === 'orphaned') &&
    isOptionalString(node.endedAt, 512) &&
    (node.exitCode === undefined ||
      node.exitCode === null ||
      (typeof node.exitCode === 'number' && Number.isInteger(node.exitCode))) &&
    isOptionalString(node.signal, 128)
  );
}

function isProcessTree(value: unknown): value is SessionProcessNode[] {
  return Array.isArray(value) && value.every((node) => isProcessNode(node));
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

  if (
    (parsed.type === 'process_tree_snapshot' || parsed.type === 'process_tree_update') &&
    !isProcessTree(parsed.processes)
  ) {
    return null;
  }

  if (parsed.type === 'executor_termination_result') {
    if (
      typeof parsed.requestId !== 'string' ||
      parsed.requestId.length === 0 ||
      parsed.requestId.length > 256 ||
      !isProcessId(parsed.executorId) ||
      !isSessionProcessTerminationResult(parsed.result) ||
      (parsed.error !== undefined && typeof parsed.error !== 'string')
    ) {
      return null;
    }
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
    case 'terminate_executor':
      if (
        typeof parsed.requestId !== 'string' ||
        parsed.requestId.length === 0 ||
        parsed.requestId.length > 256 ||
        !isProcessId(parsed.executorId)
      ) {
        return null;
      }
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
