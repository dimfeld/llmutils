import { formatHlc, parseHlc, type Hlc } from './hlc.js';
import type { SyncOpRecord } from './op_apply.js';

export const HLC_MIN_PHYSICAL_MS = Date.UTC(2020, 0, 1);
export const HLC_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HLC_TEXT_PATTERN = /^\d{16}\.\d{8}$/;
const SUPPORTED_ENTITY_TYPES = new Set([
  'plan',
  'plan_task',
  'plan_dependency',
  'plan_tag',
  'plan_review_issue',
  'project_setting',
]);

type JsonRecord = Record<string, unknown>;

export type OpValidationResult = { ok: true } | { ok: false; reason: string };

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidNodeId(value: unknown): value is string {
  return isUuid(value);
}

function parsePayload(payload: unknown): JsonRecord | string {
  if (typeof payload !== 'string') {
    return 'payload is not a string';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch (error) {
    return `invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'expected object payload';
  }
  return parsed as JsonRecord;
}

function fieldsFromPayload(payload: JsonRecord): JsonRecord {
  const fields = payload.fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? (fields as JsonRecord)
    : {};
}

function validateHlcText(hlcText: string, nowMs: number): Hlc | string {
  if (!HLC_TEXT_PATTERN.test(hlcText)) {
    return 'malformed HLC';
  }
  let hlc: Hlc;
  try {
    hlc = parseHlc(hlcText);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (formatHlc(hlc) !== hlcText) {
    return 'non-canonical HLC';
  }
  if (hlc.physicalMs < HLC_MIN_PHYSICAL_MS) {
    return 'HLC physical timestamp before lower bound';
  }
  if (hlc.physicalMs > nowMs + HLC_MAX_FUTURE_SKEW_MS) {
    return 'HLC physical timestamp beyond allowed future skew';
  }
  return hlc;
}

function validateLocalCounter(value: unknown): number | string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return 'local_counter is not a non-negative integer';
  }
  return value;
}

function opIdParts(opId: unknown): [string, string, string] | string {
  if (typeof opId !== 'string' || opId.length === 0) {
    return 'op_id is not a non-empty string';
  }
  const parts = opId.split('/');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return 'op_id is not canonical hlc/node_id/local_counter shape';
  }
  return [parts[0], parts[1], parts[2]];
}

function validateIdentityField(
  payload: JsonRecord,
  fields: JsonRecord,
  fieldName: string,
  expected: string
): string | null {
  const payloadValue = payload[fieldName];
  if (payloadValue !== undefined && payloadValue !== expected) {
    return `payload.${fieldName} contradicts entity_id`;
  }
  const fieldValue = fields[fieldName];
  if (fieldValue !== undefined && fieldValue !== expected) {
    return `payload.fields.${fieldName} contradicts entity_id`;
  }
  return null;
}

function splitDependencyEntityId(
  entityId: string
): { planUuid: string; dependsOnUuid: string } | null {
  const marker = entityId.indexOf('->');
  if (marker <= 0 || marker === entityId.length - 2) {
    return null;
  }
  return {
    planUuid: entityId.slice(0, marker),
    dependsOnUuid: entityId.slice(marker + 2),
  };
}

function splitTagEntityId(entityId: string): { planUuid: string; tag: string } | null {
  const marker = entityId.indexOf('#');
  if (marker <= 0 || marker === entityId.length - 1) {
    return null;
  }
  return {
    planUuid: entityId.slice(0, marker),
    tag: entityId.slice(marker + 1),
  };
}

function splitProjectSettingEntityId(
  entityId: string
): { projectIdentity: string; setting: string } | null {
  const marker = entityId.lastIndexOf(':');
  if (marker <= 0 || marker === entityId.length - 1) {
    return null;
  }
  return {
    projectIdentity: entityId.slice(0, marker),
    setting: entityId.slice(marker + 1),
  };
}

function validateEntityIdentity(op: SyncOpRecord, payload: JsonRecord): string | null {
  const fields = fieldsFromPayload(payload);
  const entityId = op.entity_id;
  if (typeof entityId !== 'string' || entityId.length === 0) {
    return 'entity_id is not a non-empty string';
  }

  if (
    op.entity_type === 'plan' ||
    op.entity_type === 'plan_task' ||
    op.entity_type === 'plan_review_issue'
  ) {
    if (!isUuid(entityId)) {
      return `${op.entity_type} entity_id is not a UUID`;
    }
    return (
      validateIdentityField(payload, fields, 'uuid', entityId) ??
      validateIdentityField(payload, fields, 'id', entityId)
    );
  }

  if (op.entity_type === 'plan_dependency') {
    const edge = splitDependencyEntityId(entityId);
    if (!edge || !isUuid(edge.planUuid) || !isUuid(edge.dependsOnUuid)) {
      return 'plan_dependency entity_id is not uuid->uuid';
    }
    if (payload.planUuid !== edge.planUuid || payload.dependsOnUuid !== edge.dependsOnUuid) {
      return 'plan_dependency payload identity contradicts entity_id';
    }
    return null;
  }

  if (op.entity_type === 'plan_tag') {
    const edge = splitTagEntityId(entityId);
    if (!edge || !isUuid(edge.planUuid) || edge.tag.length === 0) {
      return 'plan_tag entity_id is not uuid#tag';
    }
    if (payload.planUuid !== edge.planUuid || payload.tag !== edge.tag) {
      return 'plan_tag payload identity contradicts entity_id';
    }
    return null;
  }

  if (op.entity_type === 'project_setting') {
    const setting = splitProjectSettingEntityId(entityId);
    if (!setting) {
      return 'project_setting entity_id is not projectIdentity:setting';
    }
    if (
      payload.projectIdentity !== setting.projectIdentity ||
      payload.setting !== setting.setting
    ) {
      return 'project_setting payload identity contradicts entity_id';
    }
    return null;
  }

  return null;
}

export function validateOpEnvelope(
  op: SyncOpRecord | unknown,
  options: { nowMs?: number } = {}
): OpValidationResult {
  if (!isRecord(op)) {
    return { ok: false, reason: 'operation is not an object' };
  }
  if (typeof op.op_id !== 'string' || op.op_id.length === 0) {
    return { ok: false, reason: 'op_id is not a non-empty string' };
  }
  if (typeof op.node_id !== 'string') {
    return { ok: false, reason: 'node_id is not a string' };
  }
  if (typeof op.hlc_physical_ms !== 'number' || !Number.isSafeInteger(op.hlc_physical_ms)) {
    return { ok: false, reason: 'hlc_physical_ms is not a safe integer' };
  }
  if (typeof op.hlc_logical !== 'number' || !Number.isSafeInteger(op.hlc_logical)) {
    return { ok: false, reason: 'hlc_logical is not a safe integer' };
  }
  if (typeof op.local_counter !== 'number' || !Number.isSafeInteger(op.local_counter)) {
    return { ok: false, reason: 'local_counter is not a safe integer' };
  }
  if (typeof op.entity_type !== 'string') {
    return { ok: false, reason: 'entity_type is not a string' };
  }
  if (typeof op.entity_id !== 'string') {
    return { ok: false, reason: 'entity_id is not a string' };
  }
  if (typeof op.op_type !== 'string') {
    return { ok: false, reason: 'op_type is not a string' };
  }
  if (typeof op.payload !== 'string') {
    return { ok: false, reason: 'payload is not a string' };
  }

  const syncOp = op as SyncOpRecord;
  const nowMs = options.nowMs ?? Date.now();
  const parts = opIdParts(syncOp.op_id);
  if (typeof parts === 'string') {
    return { ok: false, reason: parts };
  }
  const [opIdHlc, opIdNodeId, opIdLocalCounter] = parts;

  if (!isValidNodeId(syncOp.node_id)) {
    return { ok: false, reason: 'node_id is not a valid sync node id' };
  }
  if (opIdNodeId !== syncOp.node_id) {
    return { ok: false, reason: 'op_id node_id does not match envelope node_id' };
  }

  const parsedHlc = validateHlcText(opIdHlc, nowMs);
  if (typeof parsedHlc === 'string') {
    return { ok: false, reason: parsedHlc };
  }
  if (syncOp.hlc_physical_ms !== parsedHlc.physicalMs || syncOp.hlc_logical !== parsedHlc.logical) {
    return { ok: false, reason: 'op_id HLC does not match envelope HLC' };
  }

  const localCounter = validateLocalCounter(syncOp.local_counter);
  if (typeof localCounter === 'string') {
    return { ok: false, reason: localCounter };
  }
  if (!/^(0|[1-9]\d*)$/.test(opIdLocalCounter)) {
    return { ok: false, reason: 'op_id local_counter is not canonical' };
  }
  if (Number(opIdLocalCounter) !== localCounter) {
    return { ok: false, reason: 'op_id local_counter does not match envelope local_counter' };
  }

  if (typeof syncOp.entity_type !== 'string' || !SUPPORTED_ENTITY_TYPES.has(syncOp.entity_type)) {
    return { ok: false, reason: `unsupported entity_type ${String(syncOp.entity_type)}` };
  }
  if (typeof syncOp.op_type !== 'string' || syncOp.op_type.length === 0) {
    return { ok: false, reason: 'op_type is not a non-empty string' };
  }

  const payload = parsePayload(syncOp.payload);
  if (typeof payload === 'string') {
    return { ok: false, reason: payload };
  }
  const identityError = validateEntityIdentity(syncOp, payload);
  if (identityError) {
    return { ok: false, reason: identityError };
  }
  return { ok: true };
}
