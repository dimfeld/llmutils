import { describe, expect, test } from 'vitest';

import type {
  EntitySyncStatus,
  GlobalSyncStatus,
  GlobalSyncStatusEnabled,
} from '$lib/remote/sync_status.remote.js';
import {
  getEntityBadgeState,
  getGlobalIndicatorState,
  getSettingsBannerState,
} from './sync_indicator_state.js';

function enabled(overrides: Partial<GlobalSyncStatusEnabled> = {}): GlobalSyncStatus {
  return {
    enabled: true,
    role: 'persistent',
    connectionState: 'online',
    pending: 0,
    sending: 0,
    failedRetryable: 0,
    conflict: 0,
    rejected: 0,
    oldestPendingAt: null,
    hasActivity: false,
    ...overrides,
  };
}

function entity(overrides: Partial<EntitySyncStatus> = {}): EntitySyncStatus {
  return {
    pending: 0,
    sending: 0,
    failedRetryable: 0,
    conflict: 0,
    rejected: 0,
    ...overrides,
  };
}

describe('getGlobalIndicatorState', () => {
  test('hidden when sync disabled', () => {
    const result = getGlobalIndicatorState({ enabled: false });
    expect(result.visible).toBe(false);
    expect(result.tone).toBe('neutral');
  });

  test('hidden when online with zero counts', () => {
    const result = getGlobalIndicatorState(enabled());
    expect(result.visible).toBe(false);
    expect(result.tone).toBe('neutral');
  });

  test('rejected-only state is visible with error tone and includes rejected count', () => {
    const result = getGlobalIndicatorState(enabled({ rejected: 2, hasActivity: true }));
    expect(result.visible).toBe(true);
    expect(result.tone).toBe('error');
    expect(result.label).toContain('2 rejected');
    expect(result.count).toBe(2);
  });

  test('rejected + conflict combines counts in label and stays error tone', () => {
    const result = getGlobalIndicatorState(
      enabled({ rejected: 1, conflict: 3, hasActivity: true })
    );
    expect(result.tone).toBe('error');
    expect(result.label).toContain('1 rejected');
    expect(result.label).toContain('3 conflict');
    expect(result.count).toBe(4);
  });

  test('conflict-only state surfaces error tone', () => {
    const result = getGlobalIndicatorState(enabled({ conflict: 1, hasActivity: true }));
    expect(result.tone).toBe('error');
    expect(result.label).toBe('1 sync conflict');
  });

  test('pending state surfaces info tone', () => {
    const result = getGlobalIndicatorState(enabled({ pending: 5, hasActivity: true }));
    expect(result.tone).toBe('info');
    expect(result.label).toBe('5 pending');
  });

  test('failedRetryable surfaces warning tone', () => {
    const result = getGlobalIndicatorState(enabled({ failedRetryable: 2, hasActivity: true }));
    expect(result.tone).toBe('warning');
    expect(result.label).toBe('2 retrying');
  });

  test('sync_error connection surfaces error tone', () => {
    const result = getGlobalIndicatorState(
      enabled({ connectionState: 'sync_error', hasActivity: true, failedRetryable: 1 })
    );
    expect(result.tone).toBe('error');
  });

  test('offline connection surfaces warning tone with offline label', () => {
    const result = getGlobalIndicatorState(
      enabled({ connectionState: 'offline', hasActivity: true })
    );
    expect(result.tone).toBe('warning');
    expect(result.label).toBe('Offline');
  });
});

describe('getEntityBadgeState', () => {
  test('returns null when nothing is queued or failed', () => {
    expect(getEntityBadgeState(entity())).toBeNull();
    expect(getEntityBadgeState(null)).toBeNull();
  });

  test('rejected ops surface as error badge', () => {
    expect(getEntityBadgeState(entity({ rejected: 2 }))).toEqual({
      tone: 'error',
      label: '2 rejected',
      title: expect.stringContaining('rejected'),
    });
  });

  test('conflict ops surface as error badge', () => {
    expect(getEntityBadgeState(entity({ conflict: 1 }))?.tone).toBe('error');
  });

  test('queued ops surface as info badge with custom noun', () => {
    const state = getEntityBadgeState(entity({ pending: 3 }), 'unsynced');
    expect(state?.tone).toBe('info');
    expect(state?.label).toBe('3 unsynced');
  });

  test('rejected wins over conflict and queued', () => {
    const state = getEntityBadgeState(entity({ rejected: 1, conflict: 2, pending: 4 }));
    expect(state?.tone).toBe('error');
    expect(state?.label).toBe('1 rejected');
  });
});

describe('getSettingsBannerState', () => {
  test('rejected surfaces as error banner', () => {
    expect(getSettingsBannerState(entity({ rejected: 1 }))?.tone).toBe('error');
  });

  test('queued surfaces as info banner', () => {
    expect(getSettingsBannerState(entity({ pending: 2 }))?.tone).toBe('info');
  });

  test('returns null when nothing is queued', () => {
    expect(getSettingsBannerState(entity())).toBeNull();
  });
});
