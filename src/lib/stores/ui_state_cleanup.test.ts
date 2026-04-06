import { describe, expect, test, vi } from 'vitest';

import { registerDismissedSessionCleanup } from './ui_state_cleanup.js';

describe('registerDismissedSessionCleanup', () => {
  test('clears UI state when a session is dismissed', () => {
    const clearSessionState = vi.fn();
    let callback:
      | ((
          eventName: 'session:dismissed' | 'session:update',
          payload: { connectionId: string }
        ) => void)
      | undefined;

    const removeListener = vi.fn();
    const cleanup = registerDismissedSessionCleanup(
      {
        onEvent(cb) {
          callback = cb as typeof callback;
          return removeListener;
        },
      },
      { clearSessionState } as never
    );

    callback?.('session:update', { connectionId: 'conn-ignored' });
    expect(clearSessionState).not.toHaveBeenCalled();

    callback?.('session:dismissed', { connectionId: 'conn-1' });
    expect(clearSessionState).toHaveBeenCalledWith('conn-1');

    cleanup();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});
