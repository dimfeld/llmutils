import { describe, expect, test } from 'vitest';
import type { SessionProcessNode } from '$lib/types/session.js';
import {
  buildProcessTree,
  flattenTree,
  formatElapsedTime,
  processStateLabel,
  processKindLabel,
  canTerminate,
  classifyTerminationStatus,
  terminationStatusMessage,
} from './process_tree.js';

function makeNode(overrides: Partial<SessionProcessNode> = {}): SessionProcessNode {
  return {
    processId: overrides.processId ?? 'p1',
    kind: overrides.kind ?? 'tim',
    label: overrides.label ?? 'test',
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    state: overrides.state ?? 'running',
    ...overrides,
  };
}

describe('buildProcessTree', () => {
  test('returns empty array for empty input', () => {
    expect(buildProcessTree([])).toEqual([]);
  });

  test('returns single root for a node with no parent', () => {
    const nodes = [makeNode({ processId: 'root' })];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].process.processId).toBe('root');
    expect(roots[0].depth).toBe(0);
    expect(roots[0].children).toHaveLength(0);
  });

  test('nests child under parent', () => {
    const nodes = [
      makeNode({ processId: 'root' }),
      makeNode({ processId: 'child', parentProcessId: 'root' }),
    ];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].process.processId).toBe('child');
    expect(roots[0].children[0].depth).toBe(1);
  });

  test('handles multi-level nesting', () => {
    const nodes = [
      makeNode({ processId: 'a' }),
      makeNode({ processId: 'b', parentProcessId: 'a' }),
      makeNode({ processId: 'c', parentProcessId: 'b' }),
    ];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].children[0].children[0].process.processId).toBe('c');
    expect(roots[0].children[0].children[0].depth).toBe(2);
  });

  test('missing parent becomes a root', () => {
    const nodes = [makeNode({ processId: 'orphan', parentProcessId: 'nonexistent' })];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].process.processId).toBe('orphan');
    expect(roots[0].depth).toBe(0);
  });

  test('parallel siblings at same level', () => {
    const nodes = [
      makeNode({ processId: 'root' }),
      makeNode({ processId: 'a', parentProcessId: 'root' }),
      makeNode({ processId: 'b', parentProcessId: 'root' }),
    ];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(2);
  });

  test('self-referencing parent does not hang and drops the node from the tree', () => {
    const nodes = [makeNode({ processId: 'a', parentProcessId: 'a' })];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(0);
    expect(flattenTree(roots)).toHaveLength(0);
  });

  test('mutual parent cycle does not hang and produces no roots', () => {
    const nodes = [
      makeNode({ processId: 'a', parentProcessId: 'b' }),
      makeNode({ processId: 'b', parentProcessId: 'a' }),
    ];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(0);
    expect(flattenTree(roots)).toHaveLength(0);
  });

  test('cyclic pair does not affect an unrelated valid root', () => {
    const nodes = [
      makeNode({ processId: 'a', parentProcessId: 'b' }),
      makeNode({ processId: 'b', parentProcessId: 'a' }),
      makeNode({ processId: 'root', label: 'valid root' }),
    ];
    const roots = buildProcessTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].process.processId).toBe('root');
    expect(flattenTree(roots)).toHaveLength(1);
  });
});

describe('flattenTree', () => {
  test('flattens in depth-first order', () => {
    const nodes = [
      makeNode({ processId: 'root' }),
      makeNode({ processId: 'a', parentProcessId: 'root' }),
      makeNode({ processId: 'a1', parentProcessId: 'a' }),
      makeNode({ processId: 'b', parentProcessId: 'root' }),
    ];
    const roots = buildProcessTree(nodes);
    const flat = flattenTree(roots);
    expect(flat.map((n) => n.process.processId)).toEqual(['root', 'a', 'a1', 'b']);
  });
});

describe('formatElapsedTime', () => {
  test('formats seconds only', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-01-01T00:00:45.000Z';
    expect(formatElapsedTime(start, end)).toBe('45s');
  });

  test('formats minutes and seconds', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-01-01T00:03:15.000Z';
    expect(formatElapsedTime(start, end)).toBe('3m 15s');
  });

  test('formats hours and minutes', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-01-01T02:30:00.000Z';
    expect(formatElapsedTime(start, end)).toBe('2h 30m');
  });

  test('returns empty string for invalid start', () => {
    expect(formatElapsedTime('invalid', '2026-01-01T00:00:00.000Z')).toBe('');
  });

  test('returns empty string for invalid end', () => {
    expect(formatElapsedTime('2026-01-01T00:00:00.000Z', 'invalid')).toBe('');
  });

  test('handles zero elapsed time', () => {
    const t = '2026-01-01T00:00:00.000Z';
    expect(formatElapsedTime(t, t)).toBe('0s');
  });
});

describe('processStateLabel', () => {
  test('maps known states', () => {
    expect(processStateLabel('starting')).toBe('Starting');
    expect(processStateLabel('running')).toBe('Running');
    expect(processStateLabel('exited')).toBe('Exited');
    expect(processStateLabel('orphaned')).toBe('Orphaned');
  });
});

describe('processKindLabel', () => {
  test('maps known kinds', () => {
    expect(processKindLabel('tim')).toBe('tim');
    expect(processKindLabel('executor')).toBe('Executor');
  });
});

describe('canTerminate', () => {
  test('returns true for live executors', () => {
    expect(canTerminate(makeNode({ kind: 'executor', state: 'running' }))).toBe(true);
    expect(canTerminate(makeNode({ kind: 'executor', state: 'starting' }))).toBe(true);
  });

  test('returns false for exited executors', () => {
    expect(canTerminate(makeNode({ kind: 'executor', state: 'exited' }))).toBe(false);
  });

  test('returns false for orphaned executors', () => {
    expect(canTerminate(makeNode({ kind: 'executor', state: 'orphaned' }))).toBe(false);
  });

  test('returns false for tim processes regardless of state', () => {
    expect(canTerminate(makeNode({ kind: 'tim', state: 'running' }))).toBe(false);
  });
});

describe('classifyTerminationStatus', () => {
  test('success statuses', () => {
    expect(classifyTerminationStatus('terminated')).toBe('success');
    expect(classifyTerminationStatus('requested')).toBe('success');
    expect(classifyTerminationStatus('already_exited')).toBe('success');
  });

  test('stale statuses', () => {
    expect(classifyTerminationStatus('stale_target')).toBe('stale');
    expect(classifyTerminationStatus('unknown_process_state')).toBe('stale');
  });

  test('error statuses', () => {
    expect(classifyTerminationStatus('signal_failed')).toBe('error');
    expect(classifyTerminationStatus('owner_not_connected')).toBe('error');
    expect(classifyTerminationStatus('request_timeout')).toBe('error');
    expect(classifyTerminationStatus('offline')).toBe('error');
    expect(classifyTerminationStatus('request_failed')).toBe('error');
  });

  test('every known status maps to exactly one outcome', () => {
    const expected: Record<string, 'success' | 'stale' | 'error'> = {
      terminated: 'success',
      requested: 'success',
      already_exited: 'success',
      not_owned: 'error',
      not_executor: 'error',
      stale_target: 'stale',
      unknown_process_state: 'stale',
      signal_failed: 'error',
      unknown_executor: 'error',
      owner_not_registered: 'error',
      owner_not_connected: 'error',
      send_failed: 'error',
      request_timeout: 'error',
      offline: 'error',
      session_not_found: 'error',
      request_failed: 'error',
    };

    for (const [status, outcome] of Object.entries(expected)) {
      expect(classifyTerminationStatus(status as never)).toBe(outcome);
    }
  });
});

describe('terminationStatusMessage', () => {
  test('returns a message for every known status', () => {
    const statuses = [
      'terminated',
      'requested',
      'already_exited',
      'not_owned',
      'not_executor',
      'stale_target',
      'unknown_process_state',
      'signal_failed',
      'unknown_executor',
      'owner_not_registered',
      'owner_not_connected',
      'send_failed',
      'request_timeout',
      'offline',
      'session_not_found',
      'request_failed',
    ] as const;

    for (const status of statuses) {
      const message = terminationStatusMessage(status);
      expect(message).toBeTruthy();
      expect(message).not.toContain('Unknown status');
    }
  });
});
