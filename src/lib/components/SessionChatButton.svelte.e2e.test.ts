import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { SessionData } from '$lib/types/session.js';
import { startChat } from '$lib/remote/plan_actions.remote.js';
import { startPrChat } from '$lib/remote/review_thread_actions.remote.js';
import { startProjectChat } from '$lib/remote/project_chat_actions.remote.js';
import SessionChatButton from './SessionChatButton.svelte';

vi.mock('$lib/remote/plan_actions.remote.js', () => ({ startChat: vi.fn() }));
vi.mock('$lib/remote/review_thread_actions.remote.js', () => ({ startPrChat: vi.fn() }));
vi.mock('$lib/remote/project_chat_actions.remote.js', () => ({ startProjectChat: vi.fn() }));
vi.mock('$lib/stores/session_windows.svelte.js', () => ({
  useSessionWindows: () => ({ open }),
}));
vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessions,
}));

const open = vi.fn();
const sessions = {
  sessions: new SvelteMap<string, Partial<SessionData>>(),
  sessionsByPlanUuid: new SvelteMap<string, Partial<SessionData>[]>(),
  sessionsByPrUrl: new SvelteMap<string, Partial<SessionData>[]>(),
};

beforeEach(() => {
  vi.clearAllMocks();
  sessions.sessionsByPlanUuid.clear();
  sessions.sessionsByPrUrl.clear();
  sessions.sessions.clear();
});

describe('review guide chat button', () => {
  test('shows the model first and starts the numbered choice from the keyboard', async () => {
    vi.mocked(startChat).mockResolvedValue({ status: 'started', planId: 42 });
    render(SessionChatButton, {
      props: {
        target: { planUuid: 'plan-uuid' },
        chatExecutorOptions: [
          { executor: 'claude-code', model: 'sonnet-test' },
          { executor: 'codex-cli', model: 'gpt-test' },
        ],
      },
    });
    await page.getByRole('button', { name: 'Chat with plan' }).click();
    await expect.element(page.getByRole('button', { name: /gpt-test Codex CLI 2/ })).toBeVisible();
    await userEvent.keyboard('2');
    expect(startChat).toHaveBeenCalledWith({
      planUuid: 'plan-uuid',
      executor: 'codex-cli',
      model: 'gpt-test',
    });
  });

  test('starts a plan chat with the selected executor and opens it after discovery', async () => {
    vi.mocked(startChat).mockResolvedValue({ status: 'started', planId: 42 });
    render(SessionChatButton, {
      props: {
        target: { planUuid: 'plan-uuid' },
        chatExecutorOptions: [
          { executor: 'claude-code' },
          { executor: 'codex-cli', model: 'gpt-test' },
        ],
      },
    });
    await page.getByRole('button', { name: 'Chat with plan' }).click();
    await page.getByRole('button', { name: /Codex CLI/ }).click();
    expect(startChat).toHaveBeenCalledWith({
      planUuid: 'plan-uuid',
      executor: 'codex-cli',
      model: 'gpt-test',
    });
    await expect.element(page.getByRole('status')).toHaveTextContent('Waiting for session');
    expect(open).not.toHaveBeenCalled();
    sessions.sessionsByPlanUuid.set('plan-uuid', [
      { connectionId: 'plan-session', status: 'active' },
    ]);
    await expect.poll(() => open.mock.calls).toEqual([['plan-session']]);
    await expect.element(page.getByRole('button', { name: 'Chat with plan' })).toBeVisible();
    expect(startPrChat).not.toHaveBeenCalled();
  });

  test('opens an existing plan session', async () => {
    vi.mocked(startChat).mockResolvedValue({ status: 'already_running', connectionId: 'existing' });
    render(SessionChatButton, { props: { target: { planUuid: 'plan-uuid' } } });
    await page.getByRole('button', { name: 'Chat with plan' }).click();
    await page.getByRole('button', { name: /Claude Code/ }).click();
    expect(open).toHaveBeenCalledWith('existing');
  });

  test('shows a launch error and permits retry', async () => {
    vi.mocked(startChat).mockRejectedValueOnce(new Error('Workspace is unavailable'));
    render(SessionChatButton, { props: { target: { planUuid: 'plan-uuid' } } });
    await page.getByRole('button', { name: 'Chat with plan' }).click();
    await page.getByRole('button', { name: /Claude Code/ }).click();
    await expect.element(page.getByRole('alert')).toHaveTextContent('Workspace is unavailable');
    await expect.element(page.getByRole('button', { name: 'Chat with plan' })).toBeEnabled();
    expect(open).not.toHaveBeenCalled();
  });

  test('keeps PR chat linked to the selected PR', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/42';
    vi.mocked(startPrChat).mockResolvedValue({ status: 'started', prUrl });
    render(SessionChatButton, { props: { target: { projectId: '7', prNumber: 42 } } });
    await page.getByRole('button', { name: 'Chat with PR' }).click();
    await page.getByRole('button', { name: /Claude Code/ }).click();
    expect(startPrChat).toHaveBeenCalledWith({
      projectId: 7,
      prNumber: 42,
      executor: 'claude-code',
      model: undefined,
    });
    sessions.sessionsByPrUrl.set(prUrl, [{ connectionId: 'pr-session', status: 'active' }]);
    await expect.poll(() => open.mock.calls).toEqual([['pr-session']]);
    expect(startChat).not.toHaveBeenCalled();
  });

  test('opens the project chat that was just started', async () => {
    const chatId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(startProjectChat).mockResolvedValue({ status: 'started', chatId });
    render(SessionChatButton, { props: { target: { projectId: '7', projectChat: true } } });
    await page.getByRole('button', { name: 'Chat with project' }).click();
    await page.getByRole('button', { name: /Claude Code/ }).click();
    expect(startProjectChat).toHaveBeenCalledWith({
      projectId: 7,
      executor: 'claude-code',
      model: undefined,
    });
    sessions.sessions.set('other', {
      connectionId: 'other',
      sessionInfo: { projectChatId: '22222222-2222-4222-8222-222222222222' },
    });
    expect(open).not.toHaveBeenCalled();
    sessions.sessions.set('new', {
      connectionId: 'new',
      sessionInfo: { projectChatId: chatId },
    });
    await expect.poll(() => open.mock.calls).toEqual([['new']]);
  });
});
