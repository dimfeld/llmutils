import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { sendUserInput, uiState } = vi.hoisted(() => ({
  sendUserInput: vi.fn<(connectionId: string, content: string) => Promise<boolean>>(),
  uiState: {
    getSessionState: vi.fn((connectionId: string) => ({
      planPaneCollapsed: false,
      messageDraft: connectionId === 'conn-1' ? 'draft one' : '',
      endSessionUsed: false,
    })),
    setSessionState: vi.fn(),
  },
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({
    sendUserInput,
  }),
}));

vi.mock('$lib/stores/ui_state.svelte.js', () => ({
  useUIState: () => uiState,
}));

import MessageInput from './MessageInput.svelte';
import { getMessageDraft, persistMessageDraft, sendMessageDraft } from './message_input.js';

describe('message_input helpers', () => {
  beforeEach(() => {
    sendUserInput.mockReset();
    uiState.setSessionState.mockReset();
    uiState.getSessionState.mockClear();
  });

  test('reads the stored draft for a connection', () => {
    expect(getMessageDraft(uiState as never, 'conn-1')).toBe('draft one');
    expect(uiState.getSessionState).toHaveBeenCalledWith('conn-1');
  });

  test('returns an empty draft when no saved message exists for the session', () => {
    expect(getMessageDraft(uiState as never, 'conn-2')).toBe('');
    expect(uiState.getSessionState).toHaveBeenCalledWith('conn-2');
  });

  test('persists textarea changes as drafts', () => {
    persistMessageDraft(uiState as never, 'conn-2', 'pending reply');
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-2', {
      messageDraft: 'pending reply',
    });
  });

  test('persists clearing a draft', () => {
    persistMessageDraft(uiState as never, 'conn-1', '');
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-1', {
      messageDraft: '',
    });
  });

  test('clears the stored draft after a successful send', async () => {
    sendUserInput.mockResolvedValue(true);

    await expect(
      sendMessageDraft({ sendUserInput }, uiState as never, 'conn-1', 'hello')
    ).resolves.toBe(true);

    expect(sendUserInput).toHaveBeenCalledWith('conn-1', 'hello');
    expect(uiState.setSessionState).toHaveBeenCalledWith('conn-1', { messageDraft: '' });
  });

  test('does not clear the stored draft after a failed send', async () => {
    sendUserInput.mockResolvedValue(false);

    await expect(
      sendMessageDraft({ sendUserInput }, uiState as never, 'conn-1', 'hello')
    ).resolves.toBe(false);

    expect(sendUserInput).toHaveBeenCalledWith('conn-1', 'hello');
    expect(uiState.setSessionState).not.toHaveBeenCalledWith('conn-1', { messageDraft: '' });
  });

  test('skips blank drafts', async () => {
    await expect(
      sendMessageDraft({ sendUserInput }, uiState as never, 'conn-1', '   ')
    ).resolves.toBe(false);

    expect(sendUserInput).not.toHaveBeenCalled();
    expect(uiState.setSessionState).not.toHaveBeenCalled();
  });
});

describe('MessageInput', () => {
  beforeEach(() => {
    uiState.setSessionState.mockReset();
    uiState.getSessionState.mockClear();
  });

  test('renders the saved draft for the current session', async () => {
    const { body } = await render(MessageInput, {
      props: { connectionId: 'conn-1' },
    });

    expect(body).toContain('>draft one</textarea>');
    expect(body).not.toContain('<button type="button" disabled');
  });

  test('renders an empty textarea for sessions without a saved draft', async () => {
    const { body } = await render(MessageInput, {
      props: { connectionId: 'conn-2' },
    });

    expect(body).toContain('<textarea');
    expect(body).not.toContain('>draft one</textarea>');
  });
});
