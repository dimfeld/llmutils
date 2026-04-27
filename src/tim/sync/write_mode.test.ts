import { describe, expect, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';
import {
  isOperationRouted,
  resolveWriteMode,
  usesPlanIdReserve,
  type WriteMode,
} from './write_mode.js';

describe('write mode resolver', () => {
  test('resolves no sync config as local-operation', () => {
    expect(resolveWriteMode({} as TimConfig)).toBe('local-operation');
  });

  test('resolves sync config without role as local-operation', () => {
    expect(resolveWriteMode({ sync: { nodeId: 'local-node' } } as TimConfig)).toBe(
      'local-operation'
    );
  });

  test('resolves main role as sync-main', () => {
    expect(resolveWriteMode({ sync: { role: 'main', nodeId: 'main-node' } } as TimConfig)).toBe(
      'sync-main'
    );
  });

  test('resolves enabled persistent role as sync-persistent', () => {
    expect(
      resolveWriteMode({
        sync: {
          role: 'persistent',
          nodeId: 'persistent-node',
          mainUrl: 'http://127.0.0.1:29999',
          nodeToken: 'secret',
        },
      } as TimConfig)
    ).toBe('sync-persistent');
  });

  test('resolves disabled persistent role as local-operation', () => {
    expect(
      resolveWriteMode({
        sync: {
          role: 'persistent',
          nodeId: 'persistent-node',
          mainUrl: 'http://127.0.0.1:29999',
          nodeToken: 'secret',
          disabled: true,
        },
      } as TimConfig)
    ).toBe('local-operation');
  });

  test('does not return legacy-direct from the resolver', () => {
    const modes = [
      resolveWriteMode({} as TimConfig),
      resolveWriteMode({ sync: { role: 'main' } } as TimConfig),
      resolveWriteMode({
        sync: { role: 'persistent', mainUrl: 'http://127.0.0.1:29999', nodeToken: 'secret' },
      } as TimConfig),
      resolveWriteMode({ sync: { role: 'persistent', disabled: true } } as TimConfig),
    ];

    expect(modes).not.toContain('legacy-direct');
  });

  test('isOperationRouted is false only for legacy-direct', () => {
    const expectations: Record<WriteMode, boolean> = {
      'local-operation': true,
      'sync-main': true,
      'sync-persistent': true,
      'legacy-direct': false,
    };

    for (const [mode, expected] of Object.entries(expectations) as Array<[WriteMode, boolean]>) {
      expect(isOperationRouted(mode)).toBe(expected);
    }
  });

  test('usesPlanIdReserve reserves for local-operation and sync-persistent only', () => {
    const expectations: Record<WriteMode, boolean> = {
      'local-operation': true,
      'sync-main': false,
      'sync-persistent': true,
      'legacy-direct': false,
    };

    for (const [mode, expected] of Object.entries(expectations) as Array<[WriteMode, boolean]>) {
      expect(usesPlanIdReserve(mode)).toBe(expected);
    }
  });
});
