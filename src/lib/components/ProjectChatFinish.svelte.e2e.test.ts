import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { SessionData } from '$lib/types/session.js';
import {
  finishProjectChat,
  getProjectChatFinishInfo,
} from '$lib/remote/project_chat_actions.remote.js';
import ProjectChatFinish from './ProjectChatFinish.svelte';

vi.mock('$lib/remote/project_chat_actions.remote.js', () => ({
  finishProjectChat: vi.fn(),
  getProjectChatFinishInfo: vi.fn(),
}));

const session = { connectionId: 'chat-session' } as SessionData;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectChatFinishInfo).mockReturnValue({
    current: {
      workflow: 'pr-based',
      branch: 'chat/one',
      trunk: 'main',
      hasPushedChanges: true,
      sessionEnded: true,
    },
    error: null,
    loading: false,
  } as ReturnType<typeof getProjectChatFinishInfo>);
});

describe('ProjectChatFinish', () => {
  test('requires a summary and creates a PR only after Finish work is selected', async () => {
    vi.mocked(finishProjectChat).mockResolvedValue({
      status: 'pr',
      url: 'https://example.com/pr/1',
    });
    render(ProjectChatFinish, { props: { session } });

    expect(finishProjectChat).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Finish work' }).click();
    await expect
      .element(page.getByText('Create a pull request from chat/one into main.'))
      .toBeVisible();
    await page.getByRole('textbox', { name: 'Change summary' }).fill('Add project chat support');
    await page.getByRole('button', { name: 'Finish work' }).last().click();

    expect(finishProjectChat).toHaveBeenCalledWith({
      connectionId: 'chat-session',
      summary: 'Add project chat support',
    });
    await expect
      .element(page.getByRole('link', { name: 'View PR' }))
      .toHaveAttribute('href', 'https://example.com/pr/1');
  });

  test('does not offer Finish work when the chat has no pushed changes', async () => {
    vi.mocked(getProjectChatFinishInfo).mockReturnValue({
      current: {
        workflow: 'trunk-based',
        branch: 'chat/one',
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
