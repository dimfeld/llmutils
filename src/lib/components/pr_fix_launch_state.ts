export const ALREADY_RUNNING_MESSAGE = 'A session is already running for this plan';

export interface FixButtonStateInput {
  refreshing: boolean;
  fixStarting: boolean;
  fixLaunched: boolean;
  sessionActiveForPlan: boolean;
}

export interface FixButtonState {
  disabled: boolean;
  label: 'Starting...' | 'Fix Started' | 'Session Active' | 'Fix Unresolved';
}

export function getFixButtonState({
  refreshing,
  fixStarting,
  fixLaunched,
  sessionActiveForPlan,
}: FixButtonStateInput): FixButtonState {
  if (fixStarting) {
    return { disabled: true, label: 'Starting...' };
  }

  if (fixLaunched) {
    return { disabled: true, label: 'Fix Started' };
  }

  if (sessionActiveForPlan) {
    return { disabled: true, label: 'Session Active' };
  }

  return {
    disabled: refreshing,
    label: 'Fix Unresolved',
  };
}

export function getFixStartResultState(
  status: 'started' | 'already_running'
): { fixLaunched: boolean; message: string | null } {
  if (status === 'already_running') {
    return { fixLaunched: false, message: ALREADY_RUNNING_MESSAGE };
  }

  return { fixLaunched: true, message: null };
}
