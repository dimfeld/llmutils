import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { SessionProcessNode, SessionExecutorTerminationResult } from '$lib/types/session.js';

const terminateExecutor = vi.fn<[string, string], Promise<SessionExecutorTerminationResult>>();

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({
    terminateExecutor,
  }),
}));

vi.mock('svelte-sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import ProcessTree from './ProcessTree.svelte';

function makeNode(overrides: Partial<SessionProcessNode> = {}): SessionProcessNode {
  return {
    processId: overrides.processId ?? 'proc-1',
    kind: overrides.kind ?? 'tim',
    label: overrides.label ?? 'agent',
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    state: overrides.state ?? 'running',
    ...overrides,
  };
}

describe('ProcessTree', () => {
  beforeEach(() => {
    terminateExecutor.mockReset();
  });

  test('shows empty message when processTree is empty and not loading', async () => {
    render(ProcessTree, {
      props: { processTree: [], connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('No active processes')).toBeVisible();
  });

  test('shows accessible loading state when loading prop is true', async () => {
    render(ProcessTree, {
      props: { processTree: [], connectionId: 'conn-1', sessionStatus: 'active', loading: true },
    });

    const loading = page.getByText('Loading processes…');
    await expect.element(loading).toBeVisible();
    await expect.element(loading).toHaveAttribute('role', 'status');
    await expect.element(page.getByText('No active processes')).not.toBeInTheDocument();
  });

  test('renders the tree instead of loading when nodes arrive', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'p1', kind: 'tim', label: 'agent', state: 'running' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active', loading: true },
    });

    await expect.element(page.getByRole('tree', { name: 'Session processes' })).toBeVisible();
    await expect.element(page.getByText('Loading processes…')).not.toBeInTheDocument();
  });

  test('renders a single process with label and state', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'p1', kind: 'tim', label: 'agent', state: 'running' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const item = page.getByRole('treeitem', { name: /tim: agent/ });
    await expect.element(item).toBeVisible();
    await expect.element(page.getByRole('img', { name: 'Running' })).toBeInTheDocument();
  });

  test('renders parent-child hierarchy with indentation', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'root', kind: 'tim', label: 'root agent' }),
      makeNode({
        processId: 'child',
        parentProcessId: 'root',
        kind: 'executor',
        label: 'claude',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const rootItem = page.getByRole('treeitem', { name: /tim: root agent/ });
    const childItem = page.getByRole('treeitem', { name: /Executor: claude/ });
    await expect.element(rootItem).toBeVisible();
    await expect.element(childItem).toBeVisible();
  });

  test('shows PID when present', async () => {
    const nodes: SessionProcessNode[] = [makeNode({ processId: 'p1', label: 'agent', pid: 12345 })];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('12345')).toBeVisible();
  });

  test('shows exit code for exited processes', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'p1', label: 'done', state: 'exited', exitCode: 1 }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('exit 1')).toBeVisible();
  });

  test('shows signal for exited processes', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'p1', label: 'killed', state: 'exited', signal: 'SIGTERM' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('SIGTERM')).toBeVisible();
  });

  test('shows Terminate button only for live executor nodes in active sessions', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'tim1', kind: 'tim', label: 'root', state: 'running' }),
      makeNode({
        processId: 'exec1',
        parentProcessId: 'tim1',
        kind: 'executor',
        label: 'claude streaming',
        state: 'running',
      }),
      makeNode({
        processId: 'exec2',
        parentProcessId: 'tim1',
        kind: 'executor',
        label: 'finished executor',
        state: 'exited',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const terminateButtons = page.getByRole('button', { name: /Terminate/ });
    await expect.element(terminateButtons).toBeVisible();

    const allButtons = page.getByRole('button', { name: /Terminate/ });
    expect(await allButtons.all()).toHaveLength(1);
  });

  test('does not show Terminate for executors in offline sessions', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'exec1',
        kind: 'executor',
        label: 'claude',
        state: 'running',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'offline' },
    });

    const terminateButton = page.getByRole('button', { name: /Terminate/ });
    await expect.element(terminateButton).not.toBeInTheDocument();
  });

  test('Terminate shows confirmation and can be cancelled', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'exec1',
        kind: 'executor',
        label: 'claude',
        state: 'running',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await page.getByRole('button', { name: /Terminate claude/ }).click();

    await expect.element(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.element(page.getByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /Terminate claude/ })).toBeVisible();
  });

  test('Terminate confirmation calls terminateExecutor and shows success', async () => {
    terminateExecutor.mockResolvedValue({
      executorId: 'exec1',
      status: 'terminated',
    });

    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'exec1',
        kind: 'executor',
        label: 'claude',
        state: 'running',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await page.getByRole('button', { name: /Terminate claude/ }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await vi.waitFor(() => {
      expect(terminateExecutor).toHaveBeenCalledWith('conn-1', 'exec1');
    });

    await expect.element(page.getByText('Process terminated')).toBeVisible();
  });

  test('shows stale target message when process identity changed', async () => {
    terminateExecutor.mockResolvedValue({
      executorId: 'exec1',
      status: 'stale_target',
    });

    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'exec1',
        kind: 'executor',
        label: 'claude',
        state: 'running',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await page.getByRole('button', { name: /Terminate claude/ }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect.element(page.getByText('Process identity changed (stale target)')).toBeVisible();
  });

  test('shows error message on signal failure', async () => {
    terminateExecutor.mockResolvedValue({
      executorId: 'exec1',
      status: 'signal_failed',
    });

    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'exec1',
        kind: 'executor',
        label: 'claude',
        state: 'running',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await page.getByRole('button', { name: /Terminate claude/ }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect.element(page.getByText('Failed to send signal')).toBeVisible();
  });

  test('renders a multi-level tree correctly', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'root', kind: 'tim', label: 'root agent' }),
      makeNode({
        processId: 'orch',
        parentProcessId: 'root',
        kind: 'executor',
        label: 'orchestrator',
      }),
      makeNode({
        processId: 'sub-tim',
        parentProcessId: 'orch',
        kind: 'tim',
        label: 'subagent',
      }),
      makeNode({
        processId: 'sub-exec',
        parentProcessId: 'sub-tim',
        kind: 'executor',
        label: 'subagent executor',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const tree = page.getByRole('tree', { name: 'Session processes' });
    await expect.element(tree).toBeVisible();

    const items = page.getByRole('treeitem');
    expect(await items.all()).toHaveLength(4);
  });

  test('renders orphaned state with correct indicator', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'p1',
        kind: 'executor',
        label: 'orphaned exec',
        state: 'orphaned',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByRole('img', { name: 'Orphaned' })).toBeInTheDocument();
  });

  test('handles missing parent gracefully (orphan becomes root)', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'child',
        parentProcessId: 'nonexistent',
        kind: 'executor',
        label: 'orphan child',
        state: 'running',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const items = page.getByRole('treeitem');
    expect(await items.all()).toHaveLength(1);
    await expect.element(page.getByText('orphan child')).toBeVisible();
  });

  test('does not hang and drops nodes involved in a cyclic parent reference', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'a', parentProcessId: 'b', label: 'cyclic a' }),
      makeNode({ processId: 'b', parentProcessId: 'a', label: 'cyclic b' }),
      makeNode({ processId: 'valid-root', label: 'valid root' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const items = page.getByRole('treeitem');
    expect(await items.all()).toHaveLength(1);
    await expect.element(page.getByText('valid root')).toBeVisible();
  });

  test('does not hang on a self-referencing parent', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'self', parentProcessId: 'self', label: 'self cycle' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('No active processes')).toBeVisible();
  });

  test('parallel subagent branches render as sibling subtrees', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'root', kind: 'tim', label: 'root agent' }),
      makeNode({
        processId: 'orch',
        parentProcessId: 'root',
        kind: 'executor',
        label: 'orchestrator',
      }),
      makeNode({
        processId: 'sub-a',
        parentProcessId: 'orch',
        kind: 'tim',
        label: 'subagent a',
      }),
      makeNode({
        processId: 'sub-a-exec',
        parentProcessId: 'sub-a',
        kind: 'executor',
        label: 'subagent a executor',
      }),
      makeNode({
        processId: 'sub-b',
        parentProcessId: 'orch',
        kind: 'tim',
        label: 'subagent b',
      }),
      makeNode({
        processId: 'sub-b-exec',
        parentProcessId: 'sub-b',
        kind: 'executor',
        label: 'subagent b executor',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    const items = page.getByRole('treeitem');
    expect(await items.all()).toHaveLength(6);

    const subA = page.getByRole('treeitem', { name: /tim: subagent a$/ });
    const subB = page.getByRole('treeitem', { name: /tim: subagent b$/ });
    await expect.element(subA).toHaveAttribute('aria-level', '3');
    await expect.element(subB).toHaveAttribute('aria-level', '3');

    const subAExec = page.getByRole('treeitem', { name: /Executor: subagent a executor/ });
    await expect.element(subAExec).toHaveAttribute('aria-level', '4');
  });

  test('reflects live prop updates keyed by process ID (new node appears, exited node updates)', async () => {
    const running: SessionProcessNode[] = [
      makeNode({ processId: 'tim1', kind: 'tim', label: 'root', state: 'running' }),
      makeNode({
        processId: 'exec1',
        parentProcessId: 'tim1',
        kind: 'executor',
        label: 'claude streaming',
        state: 'running',
      }),
    ];

    const { rerender } = render(ProcessTree, {
      props: { processTree: running, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    expect(await page.getByRole('treeitem').all()).toHaveLength(2);
    await expect
      .element(page.getByRole('button', { name: /Terminate claude streaming/ }))
      .toBeVisible();

    const updated: SessionProcessNode[] = [
      makeNode({ processId: 'tim1', kind: 'tim', label: 'root', state: 'running' }),
      makeNode({
        processId: 'exec1',
        parentProcessId: 'tim1',
        kind: 'executor',
        label: 'claude streaming',
        state: 'exited',
        exitCode: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:10.000Z',
      }),
      makeNode({
        processId: 'exec2',
        parentProcessId: 'tim1',
        kind: 'executor',
        label: 'new subagent',
        state: 'starting',
      }),
    ];

    await rerender({ processTree: updated, connectionId: 'conn-1', sessionStatus: 'active' });

    expect(await page.getByRole('treeitem').all()).toHaveLength(3);
    await expect
      .element(page.getByRole('button', { name: /Terminate claude streaming/ }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText('exit 0')).toBeVisible();
    await expect.element(page.getByText('new subagent')).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: /Terminate new subagent/ }))
      .toBeVisible();
  });

  test('removes a process row when it drops out of the tree on the next update', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'exec1', kind: 'executor', label: 'transient', state: 'running' }),
    ];

    const { rerender } = render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('transient')).toBeVisible();

    await rerender({ processTree: [], connectionId: 'conn-1', sessionStatus: 'active' });

    await expect.element(page.getByText('No active processes')).toBeVisible();
    await expect.element(page.getByText('transient')).not.toBeInTheDocument();
  });

  test('shows a deterministic elapsed time for a completed process', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({
        processId: 'p1',
        label: 'done',
        state: 'exited',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:03:15.000Z',
      }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('3m 15s')).toBeVisible();
  });

  test('never shows Terminate for a live tim process, even in an active session', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'tim1', kind: 'tim', label: 'root', state: 'running' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByRole('button', { name: /Terminate/ })).not.toBeInTheDocument();
  });

  test('renders the starting state indicator', async () => {
    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'p1', kind: 'executor', label: 'booting', state: 'starting' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByRole('img', { name: 'Starting' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /Terminate booting/ })).toBeVisible();
  });

  test('pending termination indicator has accessible live status', async () => {
    let resolveTermination: (value: SessionExecutorTerminationResult) => void = () => {};
    terminateExecutor.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTermination = resolve;
        })
    );

    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'exec1', kind: 'executor', label: 'claude', state: 'running' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await page.getByRole('button', { name: /Terminate claude/ }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();

    const pendingStatus = page.getByRole('status');
    await expect.element(pendingStatus).toBeVisible();
    await expect.element(pendingStatus).toHaveAttribute('aria-live', 'polite');

    resolveTermination({ executorId: 'exec1', status: 'terminated' });

    const resultStatus = page.getByRole('status');
    await expect.element(resultStatus).toBeVisible();
    await expect.element(resultStatus).toHaveAttribute('aria-live', 'polite');
  });

  test('does not send a second termination request while one is still pending', async () => {
    let resolveTermination: (value: SessionExecutorTerminationResult) => void = () => {};
    terminateExecutor.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTermination = resolve;
        })
    );

    const nodes: SessionProcessNode[] = [
      makeNode({ processId: 'exec1', kind: 'executor', label: 'claude', state: 'running' }),
    ];

    render(ProcessTree, {
      props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await page.getByRole('button', { name: /Terminate claude/ }).click();
    const confirmButton = page.getByRole('button', { name: 'Confirm' });
    await confirmButton.click();

    // A second click while pending must not fire another request: the confirm
    // button is replaced by a "Terminating..." indicator once pending is true.
    await expect.element(page.getByText('Terminating…')).toBeVisible();
    expect(terminateExecutor).toHaveBeenCalledTimes(1);

    resolveTermination({ executorId: 'exec1', status: 'terminated' });

    await expect.element(page.getByText('Process terminated')).toBeVisible();
    expect(terminateExecutor).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['already_exited', 'success', 'Process already exited'],
    ['requested', 'success', 'Termination requested'],
    ['not_owned', 'error', 'Process not owned by this session'],
    ['not_executor', 'error', 'Not an executor process'],
    ['unknown_process_state', 'stale', 'Process state could not be verified'],
    ['unknown_executor', 'error', 'Executor not found'],
    ['owner_not_registered', 'error', 'Owner process not registered'],
    ['owner_not_connected', 'error', 'Owner process not connected'],
    ['send_failed', 'error', 'Failed to send termination request'],
    ['request_timeout', 'error', 'Termination request timed out'],
    ['offline', 'error', 'Session is offline'],
    ['session_not_found', 'error', 'Session not found'],
    ['request_failed', 'error', 'Request failed'],
  ] as const)(
    'renders the %s termination result (%s) with its message',
    async (status, outcome, message) => {
      terminateExecutor.mockResolvedValue({ executorId: 'exec1', status });

      const nodes: SessionProcessNode[] = [
        makeNode({ processId: 'exec1', kind: 'executor', label: 'claude', state: 'running' }),
      ];

      render(ProcessTree, {
        props: { processTree: nodes, connectionId: 'conn-1', sessionStatus: 'active' },
      });

      await page.getByRole('button', { name: /Terminate claude/ }).click();
      await page.getByRole('button', { name: 'Confirm' }).click();

      const resultText = page.getByText(message);
      await expect.element(resultText).toBeVisible();

      const outcomeClass =
        outcome === 'success'
          ? 'text-green-400'
          : outcome === 'stale'
            ? 'text-amber-400'
            : 'text-red-400';
      await expect.element(resultText).toHaveClass(outcomeClass);
    }
  );
});
