import type { SyncOperationPayload } from './types.js';

export interface SyncOperationPayloadIndexes {
  payloadTaskUuid: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getSyncOperationPayloadIndexes(
  payload: SyncOperationPayload | string
): SyncOperationPayloadIndexes {
  const parsed: unknown = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload;
  if (!isRecord(parsed)) {
    return { payloadTaskUuid: null };
  }
  return {
    payloadTaskUuid: typeof parsed.taskUuid === 'string' ? parsed.taskUuid : null,
  };
}
