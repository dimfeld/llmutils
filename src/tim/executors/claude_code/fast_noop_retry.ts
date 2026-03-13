import type { WorkingCopyStatus } from '../../../common/git.ts';

export const FAST_NOOP_ORCHESTRATOR_RETRY_MS = 5 * 60 * 1000;

export interface ClaudeResultInfo {
  durationMs: number;
  turns: number;
  success: boolean;
}

export function workingCopyStatusesMatch(
  beforeStatus: WorkingCopyStatus,
  afterStatus: WorkingCopyStatus
): boolean {
  if (beforeStatus.checkFailed || afterStatus.checkFailed) {
    return false;
  }

  if (beforeStatus.hasChanges !== afterStatus.hasChanges) {
    return false;
  }

  if (!beforeStatus.hasChanges) {
    return true;
  }

  if (beforeStatus.diffHash && afterStatus.diffHash) {
    return beforeStatus.diffHash === afterStatus.diffHash;
  }

  return beforeStatus.output === afterStatus.output;
}

export function shouldRetryFastNoopOrchestratorTurn(
  resultInfo: ClaudeResultInfo | undefined,
  beforeStatus: WorkingCopyStatus | undefined,
  afterStatus: WorkingCopyStatus
): boolean {
  if (!resultInfo?.success || resultInfo.turns !== 1) {
    return false;
  }

  if (resultInfo.durationMs >= FAST_NOOP_ORCHESTRATOR_RETRY_MS) {
    return false;
  }

  if (beforeStatus == null) {
    return false;
  }

  return workingCopyStatusesMatch(beforeStatus, afterStatus);
}
