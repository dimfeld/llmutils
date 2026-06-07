export const ALREADY_RUNNING_MESSAGE = 'A session is already running for this plan';
export const ALREADY_RUNNING_PR_MESSAGE = 'A session is already running for this PR';

export interface FixButtonStateInput {
  refreshing: boolean;
  fixStarting: boolean;
  fixLaunched: boolean;
  sessionActive: boolean;
}

export interface FixButtonState {
  disabled: boolean;
  label: 'Starting...' | 'Fix Started' | 'Session Active' | 'Fix Unresolved';
}

export function getFixButtonState({
  refreshing,
  fixStarting,
  fixLaunched,
  sessionActive,
}: FixButtonStateInput): FixButtonState {
  if (fixStarting) {
    return { disabled: true, label: 'Starting...' };
  }

  if (fixLaunched) {
    return { disabled: true, label: 'Fix Started' };
  }

  if (sessionActive) {
    return { disabled: true, label: 'Session Active' };
  }

  return {
    disabled: refreshing,
    label: 'Fix Unresolved',
  };
}

export function getFixStartResultState(
  status: 'started' | 'already_running',
  target: 'plan' | 'pr' = 'plan'
): {
  fixLaunched: boolean;
  message: string | null;
} {
  if (status === 'already_running') {
    return {
      fixLaunched: false,
      message: target === 'pr' ? ALREADY_RUNNING_PR_MESSAGE : ALREADY_RUNNING_MESSAGE,
    };
  }

  return { fixLaunched: true, message: null };
}
