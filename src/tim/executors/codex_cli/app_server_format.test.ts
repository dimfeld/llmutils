import { describe, expect, test } from 'vitest';
import { createAppServerFormatter } from './app_server_format';

describe('createAppServerFormatter', () => {
  test('captures thread/session ids from thread/started and emits session start message', () => {
    const formatter = createAppServerFormatter('gpt-5.6-terra');
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
          model: 'gpt-5.6-terra',
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

  test('formats thread idle status changes as status only', () => {
    const formatter = createAppServerFormatter();
    const idle = formatter.handleNotification('thread/status/changed', {
      status: { type: 'idle' },
    });

    expect(idle.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        source: 'codex',
        status: 'codex.thread.idle',
      })
    );
  });

  test('formats non-idle thread status changes as status only', () => {
    const formatter = createAppServerFormatter();
    const running = formatter.handleNotification('thread/status/changed', {
      status: { type: 'running' },
    });

    expect(running.structured).toEqual(
      expect.objectContaining({
        type: 'llm_status',
        source: 'codex',
        status: 'codex.thread.running',
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

    expect(message.failed).toBe(true);
    expect(formatter.getFailedAgentMessage()).toContain('FAILED: unable to proceed');
  });

  test('clears stale failed message when a later agent message succeeds', () => {
    const formatter = createAppServerFormatter();

    formatter.handleNotification('item/completed', {
      item: {
        type: 'agentMessage',
        text: 'FAILED: malformed schema output',
      },
    });
    formatter.handleNotification('item/completed', {
      item: {
        type: 'agentMessage',
        text: '{"status":"ok"}',
      },
    });

    expect(formatter.getFinalAgentMessage()).toBe('{"status":"ok"}');
    expect(formatter.getFailedAgentMessage()).toBeUndefined();
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
    expect(mcp).toEqual({
      type: 'item/started',
      structured: {
        type: 'llm_status',
        timestamp: expect.any(String),
        source: 'codex',
        status: 'codex.mcp_tool.completed',
        detail: 'tim.manage-plan-task',
      },
    });

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

  test('formats automatic approval review events without repeating the command', () => {
    const formatter = createAppServerFormatter();
    const command = 'gh api graphql -f query=submitPullRequestReview';

    const started = formatter.handleNotification('llm/item/autoApprovalReview/started', {
      reviewId: 'review-1',
      review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null },
      action: {
        type: 'command',
        source: 'unifiedExec',
        command,
        cwd: '/repo',
      },
    });
    expect(started.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_use',
        toolName: 'Automatic Approval Review',
        inputSummary: [
          'Action: command',
          'Source: unifiedExec',
          `Command:\n${command}`,
          'Working directory: /repo',
        ].join('\n'),
      })
    );
    expect(started.structured).not.toEqual(expect.objectContaining({ input: expect.anything() }));

    const completed = formatter.handleNotification('llm/item/autoApprovalReview/completed', {
      reviewId: 'review-1',
      decisionSource: 'agent',
      review: {
        status: 'approved',
        riskLevel: 'medium',
        userAuthorization: 'high',
        rationale: 'The user authorized this scoped PR review comment.',
      },
      action: { type: 'command', command, cwd: '/repo' },
    });
    expect(completed.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_result',
        toolName: 'Automatic Approval Review',
        resultSummary: [
          'Status: approved',
          'Decision source: agent',
          'Risk level: medium',
          'User authorization: high',
          'Rationale: The user authorized this scoped PR review comment.',
        ].join('\n'),
        result: {
          status: 'approved',
          riskLevel: 'medium',
          userAuthorization: 'high',
          rationale: 'The user authorized this scoped PR review comment.',
        },
      })
    );
    expect(JSON.stringify(completed.structured)).not.toContain(command);
  });

  test('suppresses guardian warnings that duplicate automatic approval review results', () => {
    const formatter = createAppServerFormatter();

    expect(
      formatter.handleNotification('llm/guardianWarning', {
        message: 'Automatic approval review approved.',
      })
    ).toEqual({ type: 'llm/guardianWarning' });
  });

  test('formats started dynamic tool calls with safe arguments and namespace display', () => {
    const formatter = createAppServerFormatter();
    const circularArguments: Record<string, unknown> = { task: 'inspect' };
    circularArguments.self = circularArguments;

    const namespaced = formatter.handleNotification('item/started', {
      item: {
        type: 'dynamicToolCall',
        namespace: 'tim',
        tool: 'StartAgent',
        arguments: circularArguments,
        futureField: { retained: true },
      },
    });

    expect(namespaced.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_use',
        toolName: 'tim.StartAgent',
        inputSummary: 'Arguments: {"self":"[Circular]","task":"inspect"}',
        input: { task: 'inspect', self: '[Circular]' },
      })
    );

    const topLevel = formatter.handleNotification('item/started', {
      item: {
        type: 'dynamicToolCall',
        namespace: null,
        tool: 'ListAgents',
        arguments: {},
      },
    });
    expect(topLevel.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_use',
        toolName: 'ListAgents',
        inputSummary: 'Arguments: {}',
        input: {},
      })
    );

    const omittedArguments = formatter.handleNotification('item/started', {
      item: {
        type: 'dynamicToolCall',
        namespace: '   ',
        tool: 'ListAgents',
      },
    });
    expect(omittedArguments.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_use',
        toolName: 'ListAgents',
        inputSummary: 'Arguments were not provided.',
        input: null,
      })
    );
  });

  test('formats completed dynamic tool calls without expanding media or future content', () => {
    const formatter = createAppServerFormatter();
    const imageData = 'data:image/png;base64,inline-image';
    const audioData = 'data:audio/wav;base64,inline-audio';
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'dynamicToolCall',
        tool: 'SendAgentMessage',
        status: 'completed',
        success: true,
        contentItems: [
          { type: 'inputText', text: 'Message delivered.' },
          { type: 'inputImage', imageUrl: imageData },
          { type: 'inputAudio', audioUrl: audioData },
          { type: 'futureContent', value: 'future payload' },
        ],
        result: { delivery: 'steered' },
      },
    });

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_result',
        toolName: 'SendAgentMessage',
        resultSummary: [
          'Status: completed',
          'Success: true',
          'Result:',
          'Message delivered.',
          '(3 non-text content item(s) omitted.)',
        ].join('\n'),
        result: {
          status: 'completed',
          success: true,
          contentItems: [
            { type: 'inputText', text: 'Message delivered.' },
            { type: 'inputImage', imageUrl: imageData },
            { type: 'inputAudio', audioUrl: audioData },
            { type: 'futureContent', value: 'future payload' },
          ],
          result: { delivery: 'steered' },
        },
      })
    );
    expect(message.structured).toEqual(
      expect.objectContaining({
        resultSummary: expect.not.stringContaining(imageData),
      })
    );
    expect(message.structured).toEqual(
      expect.objectContaining({
        resultSummary: expect.not.stringContaining(audioData),
      })
    );
    expect(message.structured).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          contentItems: expect.arrayContaining([
            { type: 'inputImage', imageUrl: imageData },
            { type: 'inputAudio', audioUrl: audioData },
          ]),
        }),
      })
    );
  });

  test('tolerates malformed dynamic tool lifecycle fields and preserves safe result data', () => {
    const formatter = createAppServerFormatter();
    const circularResult: Record<string, unknown> = { ok: true };
    circularResult.self = circularResult;

    expect(() =>
      formatter.handleNotification('item/started', {
        item: {
          type: 'dynamicToolCall',
          namespace: 42,
          tool: null,
          arguments: undefined,
        },
      })
    ).not.toThrow();

    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'dynamicToolCall',
        tool: null,
        status: { future: true },
        success: 'yes',
        contentItems: null,
        result: circularResult,
        futureField: { ignoredByFormatter: true },
      },
    });

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_result',
        toolName: 'unknown',
        resultSummary: [
          'Status: unknown',
          'Success: unknown',
          'Result:',
          'No text result was provided.',
        ].join('\n'),
        result: {
          status: 'unknown',
          success: null,
          contentItems: null,
          result: { ok: true, self: '[Circular]' },
        },
      })
    );
    expect(() => JSON.stringify(message.structured)).not.toThrow();
  });

  test('concatenates text results and gives stable fallbacks for incomplete calls', () => {
    const formatter = createAppServerFormatter();
    const failed = formatter.handleNotification('item/completed', {
      item: {
        type: 'dynamicToolCall',
        tool: 'SendAgentMessage',
        status: 'failed',
        success: false,
        contentItems: [
          { type: 'inputText', text: 'First line.' },
          { type: 'inputText', text: 'Second line.' },
          { type: 'inputImage' },
          { type: 'inputAudio' },
          { type: 'futureContent', payload: { value: 1 } },
        ],
      },
    });

    expect(failed.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_result',
        toolName: 'SendAgentMessage',
        resultSummary: [
          'Status: failed',
          'Success: false',
          'Result:',
          'First line.',
          'Second line.',
          '(3 non-text content item(s) omitted.)',
        ].join('\n'),
        result: {
          status: 'failed',
          success: false,
          contentItems: [
            { type: 'inputText', text: 'First line.' },
            { type: 'inputText', text: 'Second line.' },
            { type: 'inputImage' },
            { type: 'inputAudio' },
            { type: 'futureContent', payload: { value: 1 } },
          ],
        },
      })
    );

    const incomplete = formatter.handleNotification('item/completed', {
      item: {
        type: 'dynamicToolCall',
        tool: 'ListAgents',
        status: 'incomplete',
      },
    });
    expect(incomplete.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_result',
        toolName: 'ListAgents',
        resultSummary: [
          'Status: incomplete',
          'Success: unknown',
          'Result:',
          'No text result was provided.',
        ].join('\n'),
        result: {
          status: 'incomplete',
          success: null,
          contentItems: [],
        },
      })
    );
  });

  test('converts malformed nested input values to bounded JSON-safe display data', () => {
    const formatter = createAppServerFormatter();
    const throwingNested: Record<string, unknown> = {};
    Object.defineProperty(throwingNested, 'bad', {
      enumerable: true,
      get(): never {
        throw new Error('getter should not escape the formatter');
      },
    });
    const malformedArguments: Record<string, unknown> = {
      bigint: 9n,
      fn: (): string => 'not JSON',
      infinity: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
      nested: throwingNested,
      symbol: Symbol('not JSON'),
      undefined: undefined,
    };

    const message = formatter.handleNotification('item/started', {
      item: {
        type: 'dynamicToolCall',
        tool: 'StartAgent',
        arguments: malformedArguments,
      },
    });

    expect(message.structured).toEqual(
      expect.objectContaining({
        type: 'llm_tool_use',
        input: {
          bigint: '9',
          fn: null,
          infinity: null,
          nan: null,
          nested: { bad: '[Unreadable]' },
          symbol: null,
          undefined: null,
        },
      })
    );
    expect(message.structured).toEqual(
      expect.objectContaining({
        inputSummary: expect.stringContaining('"bigint":"9"'),
      })
    );
    expect(() => JSON.stringify(message.structured)).not.toThrow();
  });

  test('bounds readable dynamic tool summaries without truncating raw JSON-safe data', () => {
    const formatter = createAppServerFormatter();
    const hugeText = 'x'.repeat(20_000);
    const hugeArguments = { message: hugeText };

    const started = formatter.handleNotification('item/started', {
      item: {
        type: 'dynamicToolCall',
        tool: 'SendAgentMessage',
        arguments: hugeArguments,
      },
    });
    expect(started.structured).toEqual(
      expect.objectContaining({
        input: hugeArguments,
        inputSummary: expect.any(String),
      })
    );
    const startedStructured = started.structured as { inputSummary?: string };
    expect(startedStructured.inputSummary?.length).toBeLessThanOrEqual(4_096);

    const completed = formatter.handleNotification('item/completed', {
      item: {
        type: 'dynamicToolCall',
        tool: 'SendAgentMessage',
        status: 'completed',
        success: true,
        contentItems: [{ type: 'inputText', text: hugeText }],
      },
    });
    expect(completed.structured).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          contentItems: [{ type: 'inputText', text: hugeText }],
        }),
        resultSummary: expect.any(String),
      })
    );
    const completedStructured = completed.structured as { resultSummary?: string };
    expect(completedStructured.resultSummary?.length).toBeLessThanOrEqual(4_096);
  });

  test('formats in-progress collab agent tool call items as tool use', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('item/started', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_kd4QFNWL9HhJbFC62SdMqhmR',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: '019e8604-87f5-7053-9ac7-92453886d7f8',
        receiverThreadIds: [],
        prompt: 'Review the diff.',
        model: '',
        reasoningEffort: 'medium',
        agentsStates: {},
      },
    });

    expect(message).toEqual({
      type: 'item/started',
      structured: {
        type: 'llm_tool_use',
        timestamp: expect.any(String),
        toolName: 'spawnAgent',
        inputSummary: [
          'status: inProgress',
          'sender: 019e8604-87f5-7053-9ac7-92453886d7f8',
          'reasoning: medium',
        ].join('\n'),
        input: {
          id: 'call_kd4QFNWL9HhJbFC62SdMqhmR',
          status: 'inProgress',
          senderThreadId: '019e8604-87f5-7053-9ac7-92453886d7f8',
          prompt: 'Review the diff.',
          model: '',
          reasoningEffort: 'medium',
          agentStatuses: [],
        },
      },
    });
  });

  test('formats completed collab agent tool call items as tool results', () => {
    const formatter = createAppServerFormatter();
    const message = formatter.handleNotification('item/completed', {
      item: {
        type: 'collabAgentToolCall',
        id: 'call_kd4QFNWL9HhJbFC62SdMqhmR',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: '019e8604-87f5-7053-9ac7-92453886d7f8',
        receiverThreadIds: ['019e8604-cb34-79f0-ab36-9af1a9bf47ac'],
        prompt: 'Review the diff.',
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
        agentsStates: {
          '019e8604-cb34-79f0-ab36-9af1a9bf47ac': {
            status: 'pendingInit',
            message: null,
          },
        },
      },
    });

    expect(message).toEqual({
      type: 'item/completed',
      structured: {
        type: 'llm_tool_result',
        timestamp: expect.any(String),
        toolName: 'spawnAgent',
        resultSummary: [
          'status: completed',
          'sender: 019e8604-87f5-7053-9ac7-92453886d7f8',
          'model: gpt-5.5',
          'reasoning: medium',
        ].join('\n'),
        result: {
          id: 'call_kd4QFNWL9HhJbFC62SdMqhmR',
          status: 'completed',
          senderThreadId: '019e8604-87f5-7053-9ac7-92453886d7f8',
          prompt: 'Review the diff.',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          agentStatuses: [
            {
              status: 'pendingInit',
              message: null,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(message.structured)).not.toContain(
      '019e8604-cb34-79f0-ab36-9af1a9bf47ac'
    );
    expect(message.structured).not.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          receiverThreadIds: expect.anything(),
        }),
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
    expect(formatter.handleNotification('item/commandExecution/terminalInteraction', {})).toEqual({
      type: 'item/commandExecution/terminalInteraction',
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
    ).toEqual(
      expect.objectContaining({
        type: 'account/rateLimits/updated',
        structured: expect.objectContaining({
          type: 'token_usage',
          rateLimits: expect.objectContaining({
            codex_bengalfox: expect.objectContaining({ limitId: 'codex_bengalfox' }),
          }),
        }),
      })
    );

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
