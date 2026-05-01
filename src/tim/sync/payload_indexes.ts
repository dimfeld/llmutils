import type { SyncOperationPayload } from './types.js';

export interface SyncOperationPayloadIndexes {
  payloadPlanUuid: string | null;
  payloadSecondaryPlanUuid: string | null;
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
    return { payloadPlanUuid: null, payloadSecondaryPlanUuid: null, payloadTaskUuid: null };
  }
  // `plan.promote_task` doesn't have a literal `planUuid` — it has `sourcePlanUuid`
  // and `newPlanUuid`. Index `newPlanUuid` as the primary plan UUID (matches its
  // target_key) and `sourcePlanUuid` as the secondary, so cleanup queries triggered
  // by deletion/never_existed of either plan can reject the queued promote.
  const planUuid =
    typeof parsed.planUuid === 'string'
      ? parsed.planUuid
      : typeof parsed.newPlanUuid === 'string'
        ? parsed.newPlanUuid
        : null;
  return {
    payloadPlanUuid: planUuid,
    payloadSecondaryPlanUuid:
      typeof parsed.sourcePlanUuid === 'string' ? parsed.sourcePlanUuid : null,
    payloadTaskUuid: typeof parsed.taskUuid === 'string' ? parsed.taskUuid : null,
  };
}
