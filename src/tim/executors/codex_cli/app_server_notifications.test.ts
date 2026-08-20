import { describe, expect, it } from 'vitest';
import { normalizeCodexAppServerNotification } from './app_server_notifications.js';

describe('Codex app-server notification normalization', () => {
  it('normalizes nested and snake-case thread and turn identifiers', () => {
    expect(
      normalizeCodexAppServerNotification('turn/completed', {
        turn: { id: 'turn-1', status: 'completed', thread_id: 'thread-1' },
      })
    ).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      turnStatus: 'completed',
    });
  });

  it('normalizes the guarded flat turn identifier fallback', () => {
    expect(
      normalizeCodexAppServerNotification('turn/completed', {
        id: 'turn-flat',
        status: 'completed',
      })
    ).toMatchObject({
      turnId: 'turn-flat',
      turnStatus: 'completed',
    });

    expect(
      normalizeCodexAppServerNotification('turn/completed', {
        id: 'outer-id',
        turn: { status: 'completed' },
      }).turnId
    ).toBeUndefined();
  });

  it('normalizes status and item metadata for activity filtering', () => {
    expect(
      normalizeCodexAppServerNotification('thread/status/changed', {
        threadId: 'thread-1',
        status: { type: 'idle' },
      })
    ).toMatchObject({
      threadId: 'thread-1',
      threadStatusType: 'idle',
      isUserMessageItem: false,
    });

    expect(
      normalizeCodexAppServerNotification('item/completed', {
        item: { type: 'userMessage', threadId: 'thread-1' },
      })
    ).toMatchObject({
      threadId: 'thread-1',
      itemType: 'userMessage',
      isUserMessageItem: true,
    });
  });
});
