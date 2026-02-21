import { describe, expect, test } from 'bun:test';
import { createAppServerFormatter } from './app_server_format';

describe('createAppServerFormatter', () => {
  test('captures thread/session ids from thread/started and emits session start message', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('thread/started', {
      thread: { id: 'thread-123' },
      session: { id: 'session-456' },
    });

    expect(message).toEqual(
      expect.objectContaining({
        type: 'thread/started',
        threadId: 'thread-123',
        sessionId: 'session-456',
        structured: expect.objectContaining({
          type: 'agent_session_start',
          threadId: 'thread-123',
          sessionId: 'session-456',
        }),
      })
    );
    expect(formatter.getThreadId()).toBe('thread-123');
    expect(formatter.getSessionId()).toBe('session-456');
  });

  test('formats turn lifecycle notifications', () => {
    const formatter = createAppServerFormatter();

    const started = formatter.handleNotification('turn/started', {});
    expect(started.structured).toEqual(
      expect.objectContaining({
        type: 'agent_step_start',
        phase: 'turn',
      })
    );

    const completed = formatter.handleNotification('turn/completed', {
      turn: {
        status: 'completed',
        usage: {
          inputTokens: 10,
          cached_input_tokens: 3,
          output_tokens: 5,
          reasoningTokens: 2,
          totalTokens: 20,
        },
      },
    });
    expect(completed.structured).toEqual(
      expect.objectContaining({
        type: 'token_usage',
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 20,
      })
    );
  });

  test('captures agent messages and ignores item/started without content', () => {
    const formatter = createAppServerFormatter();
    const started = formatter.handleNotification('item/started', {
      item: {
        type: 'agentMessage',
      },
    });
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'agentMessage',
        text: 'Final answer',
      },
    });

    expect(started).toEqual({ type: 'item/started' });

    expect(message).toEqual(
      expect.objectContaining({
        type: 'item/completed',
        agentMessage: 'Final answer',
        structured: expect.objectContaining({
          type: 'llm_response',
          text: 'Final answer',
        }),
      })
    );
    expect(formatter.getFinalAgentMessage()).toBe('Final answer');
    expect(formatter.getFailedAgentMessage()).toBeUndefined();
  });

  test('detects FAILED agent message on first content line', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'agentMessage',
        text: '\n  FAILED: unable to proceed',
      },
    });

    expect(message.failed).toBeTrue();
    expect(formatter.getFailedAgentMessage()).toContain('FAILED: unable to proceed');
  });

  test('formats reasoning item notifications', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('item/started', {
      item: {
        type: 'reasoning',
        text: 'Investigating files',
      },
    });

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'llm_thinking',
        text: 'Investigating files',
      })
    );
  });

  test('uses reasoning summary when content is missing', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'reasoning',
        content: [],
        summary: ['**Composing concise universe reflection**'],
      },
    });

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'llm_thinking',
        text: '**Composing concise universe reflection**',
      })
    );
  });

  test('formats command execution notifications', () => {
    const formatter = createAppServerFormatter();
    const started = formatter.handleNotification('item/started', {
      item: {
        type: 'commandExecution',
        command: ['git', 'status'],
        cwd: '/repo',
      },
    });
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'commandExecution',
        command: ['git', 'status'],
        aggregatedOutput: 'ok',
        stderr: 'warn',
        exitCode: 0,
      },
    });

    expect(started.structured).toEqual(
      expect.objectContaining({
        type: 'command_exec',
        command: 'git status',
        cwd: '/repo',
      })
    );

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'command_result',
        command: 'git status',
        stdout: 'ok',
        stderr: 'warn',
        exitCode: 0,
      })
    );
  });

  test('formats file change notifications', () => {
    const formatter = createAppServerFormatter();
    const started = formatter.handleNotification('item/started', {
      item: {
        type: 'fileChange',
        status: 'in_progress',
        changes: [{ path: 'src/a.ts', kind: 'modify', diff: '@@ -1 +1 @@\n-old\n+new' }],
      },
    });
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'fileChange',
        id: 'fc-1',
        status: 'completed',
        changes: [
          { path: 'src/new.ts', kind: 'create', diff: '@@ -0,0 +1 @@\n+new' },
          { path: 'src/old.ts', kind: 'delete', diff: '@@ -1 +0,0 @@\n-old' },
          { path: 'src/edit.ts', kind: 'modify', diff: '@@ -1 +1 @@\n-old\n+new' },
        ],
      },
    });

    expect(started).toEqual({ type: 'item/started' });
    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'file_change_summary',
        id: 'fc-1',
        status: 'completed',
        changes: [
          { path: 'src/new.ts', kind: 'added', diff: '@@ -0,0 +1 @@\n+new' },
          { path: 'src/old.ts', kind: 'removed', diff: '@@ -1 +0,0 @@\n-old' },
          { path: 'src/edit.ts', kind: 'updated', diff: '@@ -1 +1 @@\n-old\n+new' },
        ],
      })
    );
  });

  test('formats plan, mcp tool, and web search items', () => {
    const formatter = createAppServerFormatter();

    const plan = formatter.handleNotification('item/started', {
      item: { type: 'plan', text: '1. Do work' },
    });
    expect(plan.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'codex.plan',
        detail: '1. Do work',
      })
    );

    const mcp = formatter.handleNotification('item/started', {
      item: { type: 'mcpToolCall', toolName: 'tim.manage-plan-task', status: 'completed' },
    });
    expect(mcp.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'codex.mcp_tool.completed',
        detail: 'tim.manage-plan-task',
      })
    );

    const web = formatter.handleNotification('item/started', {
      item: { type: 'webSearch', query: 'codex app-server' },
    });
    expect(web.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        status: 'codex.web_search',
        detail: 'codex app-server',
      })
    );
  });

  test('skips delta methods', () => {
    const formatter = createAppServerFormatter();

    expect(formatter.handleNotification('item/agentMessage/delta', {})).toEqual({
      type: 'item/agentMessage/delta',
    });
    expect(formatter.handleNotification('item/commandExecution/outputDelta', {})).toEqual({
      type: 'item/commandExecution/outputDelta',
    });
    expect(formatter.handleNotification('item/anything/delta', {})).toEqual({
      type: 'item/anything/delta',
    });
    expect(formatter.handleNotification('codex/event/agent_message_delta', {})).toEqual({
      type: 'codex/event/agent_message_delta',
    });
  });

  test('suppresses token/rate-limit updates and summarizes on turn completion', () => {
    const formatter = createAppServerFormatter();
    expect(
      formatter.handleNotification('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 12733,
            inputTokens: 12716,
            cachedInputTokens: 3456,
            outputTokens: 17,
            reasoningOutputTokens: 0,
          },
        },
      })
    ).toEqual({ type: 'thread/tokenUsage/updated' });
    expect(
      formatter.handleNotification('account/rateLimits/updated', {
        rateLimits: {
          limitId: 'codex_bengalfox',
          primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1771665507 },
        },
      })
    ).toEqual({ type: 'account/rateLimits/updated' });

    const completed = formatter.handleNotification('turn/completed', {
      turn: { status: 'completed', usage: {} },
    });

    expect(completed.structured).toEqual(
      expect.objectContaining({
        type: 'token_usage',
        inputTokens: 12716,
        cachedInputTokens: 3456,
        outputTokens: 17,
        reasoningTokens: 0,
        totalTokens: 12733,
        rateLimits: expect.objectContaining({
          codex_bengalfox: expect.objectContaining({ limitId: 'codex_bengalfox' }),
        }),
      })
    );
  });

  test('ignores turn/diff/updated and maps turn/codex plan updates to todo_update items', () => {
    const formatter = createAppServerFormatter();

    const diff = formatter.handleNotification('turn/diff/updated', {
      changes: [{ path: 'src/a.ts', kind: 'add' }],
    });
    expect(diff).toEqual({ type: 'turn/diff/updated' });

    const plan = formatter.handleNotification('turn/plan/updated', {
      turnId: 'turn-1',
      explanation: 'Updated plan after inspection',
      steps: [
        { step: 'inspect', status: 'completed' },
        { step: 'test', status: 'in_progress' },
        { step: 'fix', status: 'pending' },
      ],
    });
    expect(plan.structured).toEqual(
      expect.objectContaining({
        type: 'todo_update',
        turnId: 'turn-1',
        explanation: 'Updated plan after inspection',
        items: [
          { label: 'inspect', status: 'completed' },
          { label: 'test', status: 'in_progress' },
          { label: 'fix', status: 'pending' },
        ],
      })
    );

    const codexPlan = formatter.handleNotification('codex/plan/updated', {
      turn_id: 'turn-2',
      text: 'Narrowed approach',
      plan: [{ text: 'apply patch', completed: true }],
    });
    expect(codexPlan.structured).toEqual(
      expect.objectContaining({
        type: 'todo_update',
        turnId: 'turn-2',
        explanation: 'Narrowed approach',
        items: [{ label: 'apply patch', status: 'completed' }],
      })
    );
  });

  test('formats unknown notifications as generic status', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('custom/unknown', { value: 1 });

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        source: 'codex',
        status: 'llm.custom.unknown',
      })
    );
  });

  test('suppresses userMessage items', () => {
    const formatter = createAppServerFormatter();
    expect(
      formatter.handleNotification('item/started', {
        item: {
          type: 'UserMessage',
          content: [{ type: 'text', text: 'hello' }],
        },
      })
    ).toEqual({ type: 'item/started' });
    expect(
      formatter.handleNotification('item/completed', {
        item: {
          type: 'UserMessage',
          content: [{ type: 'text', text: 'hello' }],
        },
      })
    ).toEqual({ type: 'item/completed' });
  });
});
