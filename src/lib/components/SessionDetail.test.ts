import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionData } from '$lib/types/session.js';

const { sessionManager, uiState } = vi.hoisted(() => ({
  sessionManager: {
    initialized: true,
    sessions: new Map(),
    selectSession: vi.fn(),
    activateTerminalPane: vi.fn(),
    openNewTerminal: vi.fn(),
    endSession: vi.fn(),
    acknowledgeSessionAttention: vi.fn(),
  },
  uiState: {
    getSessionState: vi.fn(() => ({
      planPaneCollapsed: false,
      messageDraft: '',
      endSessionUsed: false,
    })),
    setSessionState: vi.fn(),
  },
}));

const { getPlanAttentionState } = vi.hoisted(() => ({
  getPlanAttentionState: vi.fn(),
}));

const { getPlanTaskCounts } = vi.hoisted(() => ({
  getPlanTaskCounts: vi.fn(),
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
}));

vi.mock('$app/state', () => ({
  get page() {
    return { params: { projectId: '3' } };
  },
}));

vi.mock('$app/paths', () => ({
  resolve: (_path: string, params?: Record<string, string>) => {
    if (!params) return _path;
    let result = _path;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`[${key}]`, value);
    }
    return result;
  },
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

vi.mock('$lib/stores/ui_state.svelte.js', () => ({
  useUIState: () => uiState,
}));

vi.mock('$lib/remote/plan_task_counts.remote.js', () => ({
  getPlanTaskCounts: (...args: unknown[]) => getPlanTaskCounts(...args),
}));

vi.mock('$lib/remote/plan_attention_state.remote.js', () => ({
  getPlanAttentionState: (...args: unknown[]) => getPlanAttentionState(...args),
}));
import SessionDetail from './SessionDetailTooltipWrapper.svelte';

function createSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    connectionId: overrides.connectionId ?? 'conn-1',
    sessionInfo: {
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/workspaces/test',
      ...overrides.sessionInfo,
    },
    status: overrides.status ?? 'active',
    projectId: overrides.projectId ?? 3,
    planContent: overrides.planContent ?? null,
    messages: overrides.messages ?? [],
    activePrompts: overrides.activePrompts ?? [],
    isReplaying: overrides.isReplaying ?? false,
    groupKey: overrides.groupKey ?? 'github.com/tim/test',
    connectedAt: overrides.connectedAt ?? '2026-03-25T10:00:00.000Z',
    disconnectedAt: overrides.disconnectedAt ?? null,
  };
}

describe('SessionDetail', () => {
  beforeEach(() => {
    sessionManager.endSession.mockReset();
    uiState.getSessionState.mockReset();
    uiState.getSessionState.mockReturnValue({
      planPaneCollapsed: false,
      messageDraft: '',
      endSessionUsed: false,
    });
    uiState.setSessionState.mockReset();
    getPlanAttentionState.mockReset();
    getPlanAttentionState.mockResolvedValue(null);
    getPlanTaskCounts.mockReset();
    getPlanTaskCounts.mockResolvedValue(null);
  });

  test('renders status dot with role="img" and aria-label for active session', async () => {
    const session = createSession({ status: 'active' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('role="img"');
    expect(body).toContain('aria-label="Active"');
  });

  test('renders status dot with aria-label for offline session', async () => {
    const session = createSession({ status: 'offline' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('aria-label="Offline"');
  });

  test('renders end-session trigger button for interactive active sessions', async () => {
    const session = createSession({ status: 'active' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('End Session');
    // Confirmation dialog should NOT be present initially
    expect(body).not.toContain('role="alertdialog"');
    expect(body).not.toContain('End this running session?');
  });

  test('does not show end-session button for offline sessions', async () => {
    const session = createSession({ status: 'offline' });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).not.toContain('End Session');
  });

  test('renders message input with aria-label when session has active freeform prompt', async () => {
    const session = createSession({
      status: 'active',
      activePrompts: [
        {
          requestId: 'prompt-1',
          promptType: 'freeform',
          promptConfig: {
            message: 'Enter something',
          },
        },
      ],
    });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('aria-label="Send input to session"');
  });

  test('renders message input with aria-label for sessions with no active prompt', async () => {
    const session = createSession({ status: 'active' });
    const { body } = await render(SessionDetail, { props: { session } });

    // Input area should still be present for interactive active sessions
    expect(body).toContain('aria-label="Send input to session"');
  });

  test('renders a Run Agent button for offline ready plans with incomplete tasks', async () => {
    const session = createSession({
      status: 'offline',
      sessionInfo: {
        planId: 302,
        planUuid: 'plan-302',
      },
    });
    getPlanAttentionState.mockResolvedValue({
      displayStatus: 'ready',
      reviewIssueCount: 0,
      canUpdateDocs: false,
      hasPr: false,
      epic: false,
      developmentWorkflow: 'pr-based',
    });
    getPlanTaskCounts.mockResolvedValue({ done: 1, total: 3 });

    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('Run Agent');
  });

  test('renders a Run Agent button for offline in-progress plans with incomplete tasks', async () => {
    const session = createSession({
      status: 'offline',
      sessionInfo: {
        planId: 302,
        planUuid: 'plan-302',
      },
    });
    getPlanAttentionState.mockResolvedValue({
      displayStatus: 'in_progress',
      reviewIssueCount: 0,
      canUpdateDocs: false,
      hasPr: false,
      epic: false,
      developmentWorkflow: 'pr-based',
    });
    getPlanTaskCounts.mockResolvedValue({ done: 1, total: 3 });

    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('Run Agent');
  });

  test('does not render Run Agent for offline plans without incomplete tasks', async () => {
    const session = createSession({
      status: 'offline',
      sessionInfo: {
        planId: 302,
        planUuid: 'plan-302',
      },
    });
    getPlanAttentionState.mockResolvedValue({
      displayStatus: 'ready',
      reviewIssueCount: 0,
      canUpdateDocs: false,
      hasPr: false,
      epic: false,
      developmentWorkflow: 'pr-based',
    });
    getPlanTaskCounts.mockResolvedValue({ done: 3, total: 3 });

    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).not.toContain('Run Agent');
  });

  test('renders the plan split pane with placeholder when the session has a plan but no content yet', async () => {
    const session = createSession({
      sessionInfo: {
        planId: 302,
      },
      planContent: null,
    });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('Waiting for plan content...');
    expect(body).toContain('flex-col lg:flex-row');
    expect(body).toContain('lg:w-1/2');
    expect(body).toContain('aria-label="Hide plan pane"');
  });

  test('renders streamed plan content when the session has a plan', async () => {
    const session = createSession({
      sessionInfo: {
        planId: 302,
      },
      planContent: '## Current Plan\n\n- Task 1',
    });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).toContain('aria-label="Plan content"');
    expect(body).toContain('<h2 id="current-plan">Current Plan</h2>');
    expect(body).toContain('Task 1');
    expect(body).not.toContain('Waiting for plan content...');
  });

  test('does not render the plan split pane when the session has no plan id', async () => {
    const session = createSession({
      sessionInfo: {
        planId: undefined,
      },
      planContent: '## Should not be shown in a plan pane',
    });
    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).not.toContain('class="flex min-h-0 flex-1 flex-row"');
    expect(body).not.toContain('class="w-1/2 min-w-0 border-r border-border"');
    expect(body).not.toContain('Waiting for plan content...');
    expect(body).not.toContain('Hide plan pane');
  });

  test('renders messages full width when the stored UI state collapses the plan pane', async () => {
    uiState.getSessionState.mockReturnValue({
      planPaneCollapsed: true,
      messageDraft: '',
      endSessionUsed: false,
    });
    const session = createSession({
      sessionInfo: {
        planId: 302,
      },
      planContent: '## Current Plan\n\n- Task 1',
    });

    const { body } = await render(SessionDetail, { props: { session } });

    expect(body).not.toContain('lg:flex-row');
    expect(body).not.toContain('Waiting for plan content...');
    expect(body).toContain('aria-label="Show plan pane"');
    expect(body).toContain('No messages yet');
  });
});
