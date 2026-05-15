import { describe, expect, test } from 'vitest';

import {
  buildSelectionGraph,
  expandSelectionWithPredecessors,
  isAgentEligibleChild,
  isFinishedStatus,
  type RunChildrenPlanChild,
  shrinkSelectionRemovingDependents,
} from './eligibility.js';

function child(uuid: string, overrides: Partial<RunChildrenPlanChild> = {}): RunChildrenPlanChild {
  return {
    uuid,
    status: 'pending',
    taskCount: 2,
    doneTaskCount: 0,
    dependencies: [],
    ...overrides,
  };
}

function sortedValues(map: Map<string, Set<string>>, key: string): string[] {
  return [...(map.get(key) ?? [])].sort();
}

describe('run children eligibility helpers', () => {
  test('isFinishedStatus matches work-complete statuses', () => {
    expect(isFinishedStatus('done')).toBe(true);
    expect(isFinishedStatus('cancelled')).toBe(true);
    expect(isFinishedStatus('needs_review')).toBe(true);
    expect(isFinishedStatus('pending')).toBe(false);
    expect(isFinishedStatus('in_progress')).toBe(false);
    expect(isFinishedStatus('deferred')).toBe(false);
  });

  test('isAgentEligibleChild accepts active children with incomplete tasks', () => {
    expect(isAgentEligibleChild(child('active'))).toBe(true);
  });

  test.each(['done', 'cancelled', 'needs_review', 'deferred'])(
    'isAgentEligibleChild rejects %s children',
    (status: string) => {
      expect(isAgentEligibleChild(child(status, { status }))).toBe(false);
    }
  );

  test('isAgentEligibleChild rejects children with no incomplete tasks', () => {
    expect(isAgentEligibleChild(child('complete', { taskCount: 2, doneTaskCount: 2 }))).toBe(false);
  });
});

describe('buildSelectionGraph', () => {
  test('builds predecessor and dependent maps for a simple chain', () => {
    const graph = buildSelectionGraph(
      [child('a'), child('b', { dependencies: ['a'] }), child('c', { dependencies: ['b'] })],
      {}
    );

    expect(sortedValues(graph.predsByUuid, 'a')).toEqual([]);
    expect(sortedValues(graph.predsByUuid, 'b')).toEqual(['a']);
    expect(sortedValues(graph.predsByUuid, 'c')).toEqual(['b']);
    expect(sortedValues(graph.depsByUuid, 'a')).toEqual(['b']);
    expect(sortedValues(graph.depsByUuid, 'b')).toEqual(['c']);
    expect(sortedValues(graph.depsByUuid, 'c')).toEqual([]);
    expect(graph.externalBlockedByUuid.size).toBe(0);
  });

  test('builds predecessor and dependent maps for a diamond graph', () => {
    const graph = buildSelectionGraph(
      [
        child('root'),
        child('left', { dependencies: ['root'] }),
        child('right', { dependencies: ['root'] }),
        child('join', { dependencies: ['left', 'right'] }),
      ],
      {}
    );

    expect(sortedValues(graph.predsByUuid, 'join')).toEqual(['left', 'right']);
    expect(sortedValues(graph.depsByUuid, 'root')).toEqual(['left', 'right']);
    expect(sortedValues(graph.depsByUuid, 'left')).toEqual(['join']);
    expect(sortedValues(graph.depsByUuid, 'right')).toEqual(['join']);
  });

  test('treats basePlanUuid as a predecessor', () => {
    const graph = buildSelectionGraph(
      [child('base'), child('stacked', { basePlanUuid: 'base' })],
      {}
    );

    expect(sortedValues(graph.predsByUuid, 'stacked')).toEqual(['base']);
    expect(sortedValues(graph.depsByUuid, 'base')).toEqual(['stacked']);
  });

  test('does not block external dependencies that are finished', () => {
    const graph = buildSelectionGraph([child('a', { dependencies: ['external-done'] })], {
      'external-done': 'done',
    });

    expect(graph.externalBlockedByUuid.has('a')).toBe(false);
  });

  test('blocks external dependencies that are unfinished', () => {
    const graph = buildSelectionGraph([child('a', { dependencies: ['external-open'] })], {
      'external-open': 'in_progress',
    });

    expect(graph.externalBlockedByUuid.get('a')).toEqual(['external-open']);
  });

  test('blocks external dependencies with no status entry', () => {
    const graph = buildSelectionGraph([child('a', { dependencies: ['external-unknown'] })], {});

    expect(graph.externalBlockedByUuid.get('a')).toEqual(['external-unknown']);
  });

  test('flags downstream children as transitively blocked when a predecessor has an external block', () => {
    const graph = buildSelectionGraph(
      [
        child('pred', { dependencies: ['ext-open'] }),
        child('mid', { dependencies: ['pred'] }),
        child('leaf', { dependencies: ['mid'] }),
      ],
      { 'ext-open': 'in_progress' }
    );

    expect(graph.transitivelyBlockedByUuid.get('mid')).toEqual({
      blockerUuid: 'pred',
      reason: 'external',
    });
    expect(graph.transitivelyBlockedByUuid.get('leaf')).toEqual({
      blockerUuid: 'pred',
      reason: 'external',
    });
    // The directly-blocked child itself is NOT in the transitively-blocked map.
    expect(graph.transitivelyBlockedByUuid.has('pred')).toBe(false);
  });

  test('flags downstream children as transitively blocked when a predecessor is ineligible', () => {
    const graph = buildSelectionGraph(
      [
        child('deferred-pred', { status: 'deferred' }),
        child('down', { dependencies: ['deferred-pred'] }),
      ],
      {}
    );

    expect(graph.transitivelyBlockedByUuid.get('down')).toEqual({
      blockerUuid: 'deferred-pred',
      reason: 'ineligible',
    });
  });

  test('does not flag downstream children as transitively blocked when blocking predecessor is finished', () => {
    // A finished ancestor (done/cancelled/needs_review) is not auto-selected, so it
    // does not propagate a block downstream.
    const graph = buildSelectionGraph(
      [
        child('done-pred', { status: 'done', taskCount: 1, doneTaskCount: 1 }),
        child('down', { dependencies: ['done-pred'] }),
      ],
      {}
    );

    expect(graph.transitivelyBlockedByUuid.has('down')).toBe(false);
  });
});

describe('selection expansion and shrinking', () => {
  test('expandSelectionWithPredecessors auto-adds unfinished linear predecessors', () => {
    const children = [
      child('a'),
      child('b', { dependencies: ['a'] }),
      child('c', { dependencies: ['b'] }),
    ];
    const graph = buildSelectionGraph(children, {});
    const selected = expandSelectionWithPredecessors(new Set<string>(), children[2], graph);

    expect([...selected].sort()).toEqual(['a', 'b', 'c']);
  });

  test('expandSelectionWithPredecessors auto-adds base-plan predecessors', () => {
    const children = [child('base'), child('stacked', { basePlanUuid: 'base' })];
    const graph = buildSelectionGraph(children, {});
    const selected = expandSelectionWithPredecessors(new Set<string>(), children[1], graph);

    expect([...selected].sort()).toEqual(['base', 'stacked']);
  });

  test('expandSelectionWithPredecessors skips finished predecessors', () => {
    const children = [
      child('finished', { status: 'done', taskCount: 1, doneTaskCount: 1 }),
      child('next', { dependencies: ['finished'] }),
    ];
    const graph = buildSelectionGraph(children, {});
    const selected = expandSelectionWithPredecessors(new Set<string>(), children[1], graph);

    expect([...selected]).toEqual(['next']);
  });

  test('expandSelectionWithPredecessors refuses to expand a transitively-blocked child', () => {
    // predecessor has an unfinished external dep, so it is externally-blocked.
    // The downstream child is therefore transitively-blocked and should not expand.
    const children = [
      child('pred', { dependencies: ['ext-open'] }),
      child('down', { dependencies: ['pred'] }),
    ];
    const graph = buildSelectionGraph(children, { 'ext-open': 'in_progress' });
    const selected = expandSelectionWithPredecessors(new Set<string>(), children[1], graph);

    expect([...selected]).toEqual([]);
  });

  test('expandSelectionWithPredecessors does not auto-add an ineligible predecessor', () => {
    // Defense-in-depth: even if the helper were called on a downstream child whose
    // predecessor is ineligible, it must skip the predecessor rather than blindly
    // adding it. In practice the row is also disabled, so this shouldn't fire.
    const children = [
      child('deferred-pred', { status: 'deferred' }),
      child('down', { dependencies: ['deferred-pred'] }),
    ];
    const graph = buildSelectionGraph(children, {});
    // Force-expand from `down` even though it is transitively-blocked, by clearing
    // the transitive-block entry first to simulate a stale caller. The predecessor
    // must still NOT be auto-added because it is directly ineligible.
    graph.transitivelyBlockedByUuid.delete('down');
    const selected = expandSelectionWithPredecessors(new Set<string>(), children[1], graph);

    expect([...selected]).toEqual(['down']);
  });

  test('shrinkSelectionRemovingDependents removes a leaf only', () => {
    const children = [child('a'), child('b', { dependencies: ['a'] })];
    const graph = buildSelectionGraph(children, {});
    const selected = shrinkSelectionRemovingDependents(new Set(['a', 'b']), 'b', graph.depsByUuid);

    expect([...selected].sort()).toEqual(['a']);
  });

  test('shrinkSelectionRemovingDependents cascades from a middle node to dependents', () => {
    const children = [
      child('a'),
      child('b', { dependencies: ['a'] }),
      child('c', { dependencies: ['b'] }),
      child('independent'),
    ];
    const graph = buildSelectionGraph(children, {});
    const selected = shrinkSelectionRemovingDependents(
      new Set(['a', 'b', 'c', 'independent']),
      'b',
      graph.depsByUuid
    );

    expect([...selected].sort()).toEqual(['a', 'independent']);
  });
});
