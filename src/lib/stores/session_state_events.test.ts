import { describe, expect, test } from 'vitest';

import {
  applySessionEvent,
  MAX_CLIENT_MESSAGES,
  parseSessionEventPayload,
} from './session_state_events.js';
import type { ActivePrompt, DisplayMessage, SessionData } from '$lib/types/session.js';

function createMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  const seq = overrides.seq ?? 0;
  return {
    id: overrides.id ?? `message-${seq}`,
    seq,
    timestamp: overrides.timestamp ?? '2026-03-17T10:00:00.000Z',
    category: overrides.category ?? 'log',
    bodyType: overrides.bodyType ?? 'text',
    body: overrides.body ?? { type: 'text', text: `message-${seq}` },
    rawType: overrides.rawType ?? 'log',
  };
}

function createPrompt(overrides: Partial<ActivePrompt> = {}): ActivePrompt {
  return {
    requestId: overrides.requestId ?? 'prompt-1',
    promptType: overrides.promptType ?? 'confirm',
    promptConfig: overrides.promptConfig ?? {
      message: 'Continue?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No', value: false },
      ],
    },
    timeoutMs: overrides.timeoutMs,
  };
}

function createSession(connectionId = 'conn-1'): SessionData {
  return {
    connectionId,
    sessionInfo: {
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/ws',
    },
    status: 'active',
    projectId: null,
    planContent: null,
    messages: [
      createMessage({ id: `${connectionId}-0`, body: { type: 'text', text: 'existing' } }),
    ],
    activePrompts: [],
    isReplaying: false,
    groupKey: '/tmp/ws',
    connectedAt: '2026-03-17T10:00:00.000Z',
    disconnectedAt: null,
  };
}

function createState(initialSession?: SessionData) {
  const sessions = new Map<string, SessionData>();
  if (initialSession) {
    sessions.set(initialSession.connectionId, initialSession);
  }

  let initialized = false;
  let selectedSessionId: string | null = initialSession?.connectionId ?? null;

  return {
    sessions,
    getInitialized: () => initialized,
    setInitialized: (value: boolean) => {
      initialized = value;
    },
    getSelectedSessionId: () => selectedSessionId,
    setSelectedSessionId: (value: string | null) => {
      selectedSessionId = value;
    },
  };
}

describe('applySessionEvent', () => {
  test('parseSessionEventPayload returns null for invalid json', () => {
    expect(parseSessionEventPayload('{')).toBeNull();
  });

  test('session:list clears existing sessions and repopulates from the snapshot', () => {
    const existingSession = createSession('existing');
    const state = createState(existingSession);
    const replacementA = createSession('conn-a');
    const replacementB = createSession('conn-b');

    applySessionEvent('session:list', { sessions: [replacementA, replacementB] }, state);

    expect([...state.sessions.keys()]).toEqual(['conn-a', 'conn-b']);
    expect(state.sessions.get('existing')).toBeUndefined();
    expect(state.sessions.get('conn-a')).toBe(replacementA);
    expect(state.sessions.get('conn-b')).toBe(replacementB);
    // session:list alone should not mark as initialized; session:sync-complete does that
    expect(state.getInitialized()).toBe(false);
  });

  test('session:sync-complete sets initialized to true', () => {
    const state = createState();

    expect(state.getInitialized()).toBe(false);
    applySessionEvent('session:sync-complete', {}, state);
    expect(state.getInitialized()).toBe(true);
  });

  test('session:new adds a session to the store', () => {
    const state = createState();
    const session = createSession('conn-new');

    applySessionEvent('session:new', { session }, state);

    expect(state.sessions.get(session.connectionId)).toBe(session);
  });

  test('session:message appends without replacing the existing messages array', () => {
    const session = createSession();
    const state = createState(session);
    const previousMessages = session.messages;

    applySessionEvent(
      'session:message',
      {
        connectionId: session.connectionId,
        message: createMessage({
          id: 'conn-1-1',
          seq: 1,
          timestamp: '2026-03-17T10:00:01.000Z',
          category: 'structured',
          bodyType: 'text',
          body: { type: 'text', text: 'next' },
          rawType: 'llm_response',
        }),
      },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated).toBeDefined();
    expect(updated!.messages).toBe(previousMessages);
    expect(updated!.messages).toHaveLength(2);
    expect(updated!.messages[1]).toMatchObject({
      id: 'conn-1-1',
      seq: 1,
      rawType: 'llm_response',
    });
  });

  test('session:message preserves structured bodies for client-side rendering', () => {
    const session = createSession();
    const state = createState(session);

    applySessionEvent(
      'session:message',
      {
        connectionId: session.connectionId,
        message: createMessage({
          id: 'conn-1-structured',
          seq: 2,
          category: 'structured',
          bodyType: 'structured',
          body: {
            type: 'structured',
            message: {
              type: 'review_result',
              verdict: 'NEEDS_FIXES',
              issues: [],
              recommendations: ['Add coverage'],
              actionItems: ['Fix rendering'],
            },
          },
          rawType: 'review_result',
        }),
      },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated?.messages.at(-1)).toEqual(
      expect.objectContaining({
        id: 'conn-1-structured',
        bodyType: 'structured',
        body: {
          type: 'structured',
          message: {
            type: 'review_result',
            verdict: 'NEEDS_FIXES',
            issues: [],
            recommendations: ['Add coverage'],
            actionItems: ['Fix rendering'],
          },
        },
      })
    );
  });

  test('session:message trims to MAX_CLIENT_MESSAGES entries', () => {
    const session = createSession();
    session.messages = [];
    const state = createState(session);

    for (let seq = 1; seq <= MAX_CLIENT_MESSAGES + 5; seq += 1) {
      applySessionEvent(
        'session:message',
        {
          connectionId: session.connectionId,
          message: createMessage({
            id: `msg-${seq}`,
            seq,
            body: { type: 'text', text: `message-${seq}` },
          }),
        },
        state
      );
    }

    const updated = state.sessions.get(session.connectionId);
    expect(updated).toBeDefined();
    expect(updated!.messages).toHaveLength(MAX_CLIENT_MESSAGES);
    expect(updated!.messages[0]).toMatchObject({ id: 'msg-6', seq: 6 });
    expect(updated!.messages.at(-1)).toMatchObject({
      id: `msg-${MAX_CLIENT_MESSAGES + 5}`,
      seq: MAX_CLIENT_MESSAGES + 5,
    });
  });

  test('metadata-only session updates preserve local messages', () => {
    const session = createSession();
    const state = createState(session);

    applySessionEvent(
      'session:update',
      {
        session: {
          ...session,
          status: 'offline',
          activePrompts: [],
          messages: [],
          disconnectedAt: '2026-03-17T10:05:00.000Z',
        },
      },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('offline');
    expect(updated!.messages).toHaveLength(1);
    expect(updated!.messages[0]).toMatchObject({
      id: `${session.connectionId}-0`,
    });
  });

  test('session:update replaces messages when the server sends a non-empty message array', () => {
    const session = createSession();
    const state = createState(session);
    const replacementMessage = createMessage({
      id: 'replacement',
      seq: 9,
      category: 'structured',
      rawType: 'workflow_progress',
    });

    applySessionEvent(
      'session:update',
      {
        session: {
          ...session,
          messages: [replacementMessage],
        },
      },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated).toBeDefined();
    expect(updated!.messages).toEqual([replacementMessage]);
  });

  test('session:disconnect preserves local messages for metadata-only updates', () => {
    const session = createSession();
    const state = createState(session);

    applySessionEvent(
      'session:disconnect',
      {
        session: {
          ...session,
          status: 'offline',
          messages: [],
          disconnectedAt: '2026-03-17T10:05:00.000Z',
        },
      },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('offline');
    expect(updated!.messages).toHaveLength(1);
    expect(updated!.messages[0]?.id).toBe(`${session.connectionId}-0`);
  });

  test('session:prompt sets the active prompt for the session', () => {
    const session = createSession();
    const state = createState(session);
    const prompt = createPrompt({
      requestId: 'prompt-42',
      promptType: 'input',
      promptConfig: {
        message: 'Enter a value',
        default: 'abc',
      },
    });

    applySessionEvent('session:prompt', { connectionId: session.connectionId, prompt }, state);

    const updated = state.sessions.get(session.connectionId);
    expect(updated?.activePrompts).toEqual([prompt]);
  });

  test('session:plan-content updates the session without disturbing messages', () => {
    const session = createSession();
    const previousMessages = session.messages;
    const state = createState(session);

    applySessionEvent(
      'session:plan-content',
      {
        connectionId: session.connectionId,
        planContent: '# current plan',
      },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated?.planContent).toBe('# current plan');
    expect(updated?.messages).toBe(previousMessages);
  });

  test('session:prompt-cleared only clears the matching prompt', () => {
    const session = createSession();
    session.activePrompts = [createPrompt({ requestId: 'prompt-keep' })];
    const state = createState(session);

    applySessionEvent(
      'session:prompt-cleared',
      { connectionId: session.connectionId, requestId: 'different-request' },
      state
    );

    expect(state.sessions.get(session.connectionId)?.activePrompts).toHaveLength(1);
    expect(state.sessions.get(session.connectionId)?.activePrompts[0]?.requestId).toBe(
      'prompt-keep'
    );

    applySessionEvent(
      'session:prompt-cleared',
      { connectionId: session.connectionId, requestId: 'prompt-keep' },
      state
    );

    expect(state.sessions.get(session.connectionId)?.activePrompts).toEqual([]);
  });

  test('session:prompt accumulates multiple prompts in the array', () => {
    const session = createSession();
    const state = createState(session);
    const prompt1 = createPrompt({ requestId: 'prompt-1' });
    const prompt2 = createPrompt({ requestId: 'prompt-2', promptType: 'input' });

    applySessionEvent(
      'session:prompt',
      { connectionId: session.connectionId, prompt: prompt1 },
      state
    );
    applySessionEvent(
      'session:prompt',
      { connectionId: session.connectionId, prompt: prompt2 },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated?.activePrompts).toEqual([prompt1, prompt2]);
  });

  test('session:prompt-cleared removes only the matching prompt from the array', () => {
    const session = createSession();
    const prompt1 = createPrompt({ requestId: 'prompt-1' });
    const prompt2 = createPrompt({ requestId: 'prompt-2' });
    const prompt3 = createPrompt({ requestId: 'prompt-3' });
    session.activePrompts = [prompt1, prompt2, prompt3];
    const state = createState(session);

    applySessionEvent(
      'session:prompt-cleared',
      { connectionId: session.connectionId, requestId: 'prompt-2' },
      state
    );

    const updated = state.sessions.get(session.connectionId);
    expect(updated?.activePrompts).toEqual([prompt1, prompt3]);
  });

  test('session:prompt-cleared is idempotent for unknown requestId', () => {
    const session = createSession();
    const prompt1 = createPrompt({ requestId: 'prompt-1' });
    session.activePrompts = [prompt1];
    const state = createState(session);

    applySessionEvent(
      'session:prompt-cleared',
      { connectionId: session.connectionId, requestId: 'nonexistent' },
      state
    );

    expect(state.sessions.get(session.connectionId)?.activePrompts).toEqual([prompt1]);
  });

  test('session:dismissed deletes the session and clears the selection', () => {
    const session = createSession();
    const state = createState(session);

    applySessionEvent('session:dismissed', { connectionId: session.connectionId }, state);

    expect(state.sessions.has(session.connectionId)).toBe(false);
    expect(state.getSelectedSessionId()).toBeNull();
  });

  test('pr:updated leaves the session store unchanged', () => {
    const session = createSession();
    const state = createState(session);

    applySessionEvent(
      'pr:updated',
      {
        prUrls: ['https://github.com/example/repo/pull/1'],
        projectIds: [12],
      },
      state
    );

    expect(state.sessions.get(session.connectionId)).toBe(session);
    expect(state.getSelectedSessionId()).toBe(session.connectionId);
    expect(state.getInitialized()).toBe(false);
  });
});
