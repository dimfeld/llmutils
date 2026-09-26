import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { SessionData } from '$lib/types/session.js';
import { goto } from '$app/navigation';
import {
  getProjectChatFinishInfo,
  startProjectChatFinish,
} from '$lib/remote/project_chat_actions.remote.js';
import ProjectChatFinish from './ProjectChatFinish.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/remote/project_chat_actions.remote.js', () => ({
  startProjectChatFinish: vi.fn(),
  getProjectChatFinishInfo: vi.fn(),
}));
const sessions = new SvelteMap<string, SessionData>();
vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({ sessions }),
}));

const chatId = '11111111-1111-4111-8111-111111111111';
const session = { connectionId: 'chat-session' } as SessionData;

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  vi.mocked(getProjectChatFinishInfo).mockReturnValue({
    current: {
      workflow: 'squash-rebase',
      branch: `chat/${chatId}`,
      trunk: 'main',
      hasPushedChanges: true,
      sessionEnded: true,
    },
    error: null,
    loading: false,
  } as ReturnType<typeof getProjectChatFinishInfo>);
});

describe('ProjectChatFinish', () => {
  test('starts a finish session and opens it after discovery', async () => {
    vi.mocked(startProjectChatFinish).mockResolvedValue({ status: 'started', chatId });
    render(ProjectChatFinish, { props: { session } });

    await page.getByRole('button', { name: 'Finish work' }).click();
    expect(startProjectChatFinish).toHaveBeenCalledWith({ connectionId: 'chat-session' });
    await expect.element(page.getByRole('status')).toHaveTextContent('Waiting for session');
    sessions.set('finish-session', {
      connectionId: 'finish-session',
      projectId: 7,
      status: 'active',
      sessionInfo: { projectChatId: chatId },
    } as SessionData);
    await vi.waitFor(() => {
      expect(goto).toHaveBeenCalledWith('/projects/7/sessions/finish-session');
    });
  });

  test('does not offer Finish work when the chat has no pushed changes', async () => {
    vi.mocked(getProjectChatFinishInfo).mockReturnValue({
      current: {
        workflow: 'trunk-based',
        branch: `chat/${chatId}`,
        trunk: 'main',
        hasPushedChanges: false,
        sessionEnded: true,
      },
      error: null,
      loading: false,
    } as ReturnType<typeof getProjectChatFinishInfo>);
    render(ProjectChatFinish, { props: { session } });
    await expect.element(page.getByText('No changes were pushed')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Finish work' })).not.toBeInTheDocument();
  });
});
