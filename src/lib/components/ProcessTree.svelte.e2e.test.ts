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

  test('shows empty message when processTree is empty', async () => {
    render(ProcessTree, {
      props: { processTree: [], connectionId: 'conn-1', sessionStatus: 'active' },
    });

    await expect.element(page.getByText('No active processes')).toBeVisible();
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
});
