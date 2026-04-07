import { describe, expect, test } from 'vitest';

import {
  ALREADY_RUNNING_MESSAGE,
  getFixButtonState,
  getFixStartResultState,
} from './pr_fix_launch_state.js';

describe('pr_fix_launch_state', () => {
  test('getFixStartResultState returns launched state for started status', () => {
    expect(getFixStartResultState('started')).toEqual({
      fixLaunched: true,
      message: null,
    });
  });

  test('getFixStartResultState returns user-facing message for already_running status', () => {
    expect(getFixStartResultState('already_running')).toEqual({
      fixLaunched: false,
      message: ALREADY_RUNNING_MESSAGE,
    });
  });

  test('getFixButtonState prioritizes started launch state before active session discovery', () => {
    expect(
      getFixButtonState({
        refreshing: false,
        fixStarting: false,
        fixLaunched: true,
        sessionActiveForPlan: false,
      })
    ).toEqual({
      disabled: true,
      label: 'Fix Started',
    });
  });

  test('getFixButtonState shows Session Active when an agent session is discovered', () => {
    expect(
      getFixButtonState({
        refreshing: false,
        fixStarting: false,
        fixLaunched: false,
        sessionActiveForPlan: true,
      })
    ).toEqual({
      disabled: true,
      label: 'Session Active',
    });
  });
});
