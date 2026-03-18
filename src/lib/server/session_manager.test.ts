import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HeadlessServerMessage } from '../../logging/headless_protocol.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import type { TunnelMessage } from '../../logging/tunnel_protocol.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';

import {
  SessionManager,
  categorizeMessage,
  formatTunnelMessage,
  sessionGroupKey,
} from './session_manager.js';

describe('lib/server/session_manager', () => {
  let tempDir: string;
  let db: Database;
  let manager: SessionManager;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-session-manager-test-'));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    manager = new SessionManager(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('categorizeMessage covers all structured message types', () => {
    const timestamp = '2026-03-17T10:00:00.000Z';
    const cases: Array<{
      message: StructuredMessage;
      category: ReturnType<typeof categorizeMessage>['category'];
      bodyType: ReturnType<typeof categorizeMessage>['bodyType'];
    }> = [
      {
        message: {
          type: 'agent_session_start',
          timestamp,
          executor: 'codex',
          mode: 'agent',
          planId: 229,
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'agent_session_end',
          timestamp,
          success: true,
          durationMs: 100,
          turns: 2,
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'agent_iteration_start',
          timestamp,
          iterationNumber: 1,
          taskTitle: 'Ship it',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'agent_step_start',
          timestamp,
          phase: 'implement',
          message: 'starting',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'agent_step_end',
          timestamp,
          phase: 'implement',
          success: true,
          summary: 'done',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'llm_thinking',
          timestamp,
          text: 'thinking',
        },
        category: 'llmOutput',
        bodyType: 'monospaced',
      },
      {
        message: {
          type: 'llm_response',
          timestamp,
          text: 'response',
        },
        category: 'llmOutput',
        bodyType: 'text',
      },
      {
        message: {
          type: 'llm_tool_use',
          timestamp,
          toolName: 'search',
          inputSummary: 'query',
          input: { q: 'tim' },
        },
        category: 'toolUse',
        bodyType: 'keyValuePairs',
      },
      {
        message: {
          type: 'llm_tool_result',
          timestamp,
          toolName: 'search',
          resultSummary: 'ok',
          result: { hits: 1 },
        },
        category: 'toolUse',
        bodyType: 'text',
      },
      {
        message: {
          type: 'llm_status',
          timestamp,
          source: 'codex',
          status: 'running',
          detail: 'phase',
        },
        category: 'progress',
        bodyType: 'text',
      },
      {
        message: {
          type: 'todo_update',
          timestamp,
          items: [{ label: 'Write tests', status: 'in_progress' }],
          explanation: 'working',
        },
        category: 'progress',
        bodyType: 'todoList',
      },
      {
        message: {
          type: 'task_completion',
          timestamp,
          taskTitle: 'Write tests',
          planComplete: false,
        },
        category: 'progress',
        bodyType: 'text',
      },
      {
        message: {
          type: 'file_write',
          timestamp,
          path: 'src/file.ts',
          lineCount: 10,
        },
        category: 'fileChange',
        bodyType: 'text',
      },
      {
        message: {
          type: 'file_edit',
          timestamp,
          path: 'src/file.ts',
          diff: '+ test',
        },
        category: 'fileChange',
        bodyType: 'monospaced',
      },
      {
        message: {
          type: 'file_change_summary',
          timestamp,
          changes: [{ path: 'src/file.ts', kind: 'updated' }],
          status: 'completed',
        },
        category: 'fileChange',
        bodyType: 'fileChanges',
      },
      {
        message: {
          type: 'command_exec',
          timestamp,
          command: 'bun test',
          cwd: '/repo',
        },
        category: 'command',
        bodyType: 'monospaced',
      },
      {
        message: {
          type: 'command_result',
          timestamp,
          command: 'bun test',
          cwd: '/repo',
          exitCode: 0,
          stdout: 'ok',
        },
        category: 'command',
        bodyType: 'monospaced',
      },
      {
        message: {
          type: 'review_start',
          timestamp,
          executor: 'codex',
          planId: 229,
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'review_result',
          timestamp,
          verdict: 'NEEDS_FIXES',
          issues: [],
          recommendations: [],
          actionItems: [],
        },
        category: 'error',
        bodyType: 'text',
      },
      {
        message: {
          type: 'workflow_progress',
          timestamp,
          message: 'Working',
          phase: 'tests',
        },
        category: 'progress',
        bodyType: 'text',
      },
      {
        message: {
          type: 'failure_report',
          timestamp,
          summary: 'Failed',
          problems: 'Broken',
        },
        category: 'error',
        bodyType: 'text',
      },
      {
        message: {
          type: 'execution_summary',
          timestamp,
          summary: {
            planId: '229',
            planTitle: 'Sessions view',
            planFilePath: 'tasks/229.plan.md',
            mode: 'serial',
            startedAt: timestamp,
            durationMs: 123,
            steps: [],
            changedFiles: ['src/a.ts'],
            errors: [],
            metadata: {
              totalSteps: 1,
              failedSteps: 0,
            },
          },
        },
        category: 'lifecycle',
        bodyType: 'keyValuePairs',
      },
      {
        message: {
          type: 'token_usage',
          timestamp,
          totalTokens: 50,
          inputTokens: 20,
          outputTokens: 30,
        },
        category: 'progress',
        bodyType: 'text',
      },
      {
        message: {
          type: 'input_required',
          timestamp,
          prompt: 'Continue?',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'user_terminal_input',
          timestamp,
          content: 'y',
          source: 'terminal',
        },
        category: 'userInput',
        bodyType: 'text',
      },
      {
        message: {
          type: 'prompt_request',
          timestamp,
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Confirm?' },
          timeoutMs: 5000,
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'prompt_answered',
          timestamp,
          requestId: 'req-1',
          promptType: 'confirm',
          value: true,
          source: 'terminal',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'plan_discovery',
          timestamp,
          planId: 229,
          title: 'Sessions view',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
      {
        message: {
          type: 'workspace_info',
          timestamp,
          workspaceId: 'ws-1',
          path: '/tmp/ws',
          planFile: 'tasks/229.plan.md',
        },
        category: 'lifecycle',
        bodyType: 'text',
      },
    ];

    for (const testCase of cases) {
      expect(categorizeMessage(testCase.message)).toEqual({
        category: testCase.category,
        bodyType: testCase.bodyType,
      });
    }
  });

  test('formatTunnelMessage handles structured and non-structured tunnel messages', () => {
    vi.setSystemTime(new Date('2026-03-17T10:01:00.000Z'));

    const structured = formatTunnelMessage('conn-1', 1, {
      type: 'structured',
      message: {
        type: 'token_usage',
        timestamp: '2026-03-17T10:00:59.000Z',
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 60,
      },
    });
    const stdout = formatTunnelMessage('conn-1', 2, { type: 'stdout', data: 'stream\n' });
    const log = formatTunnelMessage('conn-1', 3, { type: 'log', args: ['hello', 'world'] });
    const warn = formatTunnelMessage('conn-1', 4, { type: 'warn', args: ['careful'] });
    const debug = formatTunnelMessage('conn-1', 5, { type: 'debug', args: ['ignore'] });

    expect(structured).toMatchObject({
      id: 'conn-1:1',
      category: 'progress',
      bodyType: 'text',
      rawType: 'token_usage',
      body: {
        type: 'text',
        text: 'tokens=100 | input=40 | output=60',
      },
    });
    expect(stdout).toMatchObject({
      id: 'conn-1:2',
      timestamp: '2026-03-17T10:01:00.000Z',
      category: 'log',
      bodyType: 'monospaced',
      rawType: 'stdout',
      body: {
        type: 'monospaced',
        text: 'stream\n',
      },
    });
    expect(log).toMatchObject({
      category: 'log',
      bodyType: 'text',
      rawType: 'log',
      body: {
        type: 'text',
        text: 'hello world',
      },
    });
    expect(warn).toMatchObject({
      category: 'error',
      bodyType: 'text',
      rawType: 'warn',
      body: {
        type: 'text',
        text: 'careful',
      },
    });
    expect(debug).toBeNull();
  });

  test('formatTunnelMessage falls back for unknown structured message types', () => {
    const message = formatTunnelMessage('conn-1', 9, {
      type: 'structured',
      message: {
        type: 'unexpected_structured_type',
        timestamp: '2026-03-17T10:00:59.000Z',
      } as unknown as StructuredMessage,
    });

    expect(message).toMatchObject({
      id: 'conn-1:9',
      category: 'log',
      bodyType: 'text',
      rawType: 'unexpected_structured_type',
      body: {
        type: 'text',
        text: 'Unsupported structured message type: unexpected_structured_type',
      },
    });
  });

  test('tracks session lifecycle, emits events, and resolves project ids from git remote', () => {
    const project = getOrCreateProject(db, 'repo-1', {
      remoteUrl: 'https://example.com/repo-1.git',
      lastGitRoot: '/tmp/repo-1',
    });
    const onNew = vi.fn();
    const onUpdate = vi.fn();
    const onMessage = vi.fn();
    const onDisconnect = vi.fn();

    manager.subscribe('session:new', onNew);
    manager.subscribe('session:update', onUpdate);
    manager.subscribe('session:message', onMessage);
    manager.subscribe('session:disconnect', onDisconnect);

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 229,
      planTitle: 'Sessions view',
      workspacePath: '/tmp/repo-1',
      gitRemote: 'https://example.com/repo-1.git',
      terminalPaneId: '12',
      terminalType: 'wezterm',
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:01.000Z',
          text: 'hello',
        },
      },
    });
    const disconnected = manager.handleWebSocketDisconnect('conn-1');
    const snapshot = manager.getSessionSnapshot();

    expect(onNew).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          connectionId: 'conn-1',
          status: 'active',
          sessionInfo: { command: 'unknown' },
        }),
      })
    );
    expect(onUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        session: expect.objectContaining({
          connectionId: 'conn-1',
          sessionInfo: expect.objectContaining({
            command: 'agent',
            planId: 229,
            planTitle: 'Sessions view',
          }),
          projectId: project.id,
          groupKey: 'example.com/repo-1|/tmp/repo-1',
        }),
      })
    );
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        message: expect.objectContaining({
          seq: 1,
          category: 'llmOutput',
          bodyType: 'text',
        }),
      })
    );
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          connectionId: 'conn-1',
          status: 'offline',
        }),
      })
    );
    expect(disconnected).toMatchObject({
      connectionId: 'conn-1',
      status: 'offline',
      disconnectedAt: '2026-03-17T10:00:00.000Z',
    });
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      connectionId: 'conn-1',
      projectId: project.id,
      messages: [
        expect.objectContaining({
          seq: 1,
          rawType: 'llm_response',
        }),
      ],
    });
  });

  test('buffers replayed messages, suppresses replay events, and emits deferred prompts after replay ends', () => {
    const onMessage = vi.fn();
    const onPrompt = vi.fn();
    const onUpdate = vi.fn();

    manager.subscribe('session:message', onMessage);
    manager.subscribe('session:prompt', onPrompt);
    manager.subscribe('session:update', onUpdate);

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', { type: 'replay_start' });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:01.000Z',
          text: 'replayed',
        },
      },
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:02.000Z',
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });

    const replaySnapshot = manager.getSessionSnapshot();
    manager.handleWebSocketMessage('conn-1', { type: 'replay_end' });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 3,
      message: {
        type: 'structured',
        message: {
          type: 'llm_response',
          timestamp: '2026-03-17T10:00:03.000Z',
          text: 'live',
        },
      },
    });

    const finalSnapshot = manager.getSessionSnapshot();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        message: expect.objectContaining({
          seq: 3,
          body: expect.objectContaining({ text: 'live' }),
        }),
      })
    );
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      prompt: {
        requestId: 'req-1',
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
        timeoutMs: undefined,
      },
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(replaySnapshot.sessions[0]).toMatchObject({
      isReplaying: true,
      activePrompt: null,
      messages: [
        expect.objectContaining({ seq: 1 }),
        expect.objectContaining({ seq: 2, rawType: 'prompt_request' }),
      ],
    });
    expect(finalSnapshot.sessions[0]).toMatchObject({
      isReplaying: false,
      activePrompt: {
        requestId: 'req-1',
        promptType: 'confirm',
      },
      messages: [
        expect.objectContaining({ seq: 1 }),
        expect.objectContaining({ seq: 2 }),
        expect.objectContaining({ seq: 3 }),
      ],
    });
  });

  test('tracks prompt lifecycle and emits prompt-cleared when answered outside replay', () => {
    const onPrompt = vi.fn();
    const onPromptCleared = vi.fn();

    manager.subscribe('session:prompt', onPrompt);
    manager.subscribe('session:prompt-cleared', onPromptCleared);

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:01.000Z',
          requestId: 'req-2',
          promptType: 'input',
          promptConfig: {
            message: 'Name',
            header: 'Prompt',
            question: 'Enter name',
            validationHint: 'Required',
          },
          timeoutMs: 1000,
        },
      },
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 2,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_answered',
          timestamp: '2026-03-17T10:00:02.000Z',
          requestId: 'req-2',
          promptType: 'input',
          value: 'Alice',
          source: 'terminal',
        },
      },
    });

    const session = manager.getSessionSnapshot().sessions[0];

    expect(onPrompt).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      prompt: {
        requestId: 'req-2',
        promptType: 'input',
        promptConfig: {
          message: 'Name',
          header: 'Prompt',
          question: 'Enter name',
          validationHint: 'Required',
        },
        timeoutMs: 1000,
      },
    });
    expect(onPromptCleared).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      requestId: 'req-2',
    });
    expect(session.activePrompt).toBeNull();
  });

  test('creates and updates notification-only sessions', () => {
    const project = getOrCreateProject(db, 'repo-2', {
      remoteUrl: 'https://example.com/repo-2.git',
    });
    const onNew = vi.fn();
    const onUpdate = vi.fn();
    const onMessage = vi.fn();

    manager.subscribe('session:new', onNew);
    manager.subscribe('session:update', onUpdate);
    manager.subscribe('session:message', onMessage);

    const first = manager.handleHttpNotification({
      message: 'First',
      workspacePath: '/tmp/ws',
      gitRemote: 'https://example.com/repo-2.git',
      terminal: { type: 'wezterm', pane_id: '4' },
    });
    vi.setSystemTime(new Date('2026-03-17T10:05:00.000Z'));
    const second = manager.handleHttpNotification({
      message: 'Second',
      workspacePath: '/tmp/ws',
      gitRemote: 'https://example.com/repo-2.git',
    });

    expect(first).toMatchObject({
      connectionId: 'notification:example.com/repo-2|/tmp/ws:wezterm:4',
      status: 'notification',
      projectId: project.id,
      disconnectedAt: '2026-03-17T10:00:00.000Z',
      sessionInfo: expect.objectContaining({
        command: 'notification',
        workspacePath: '/tmp/ws',
        terminalPaneId: '4',
        terminalType: 'wezterm',
      }),
    });
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toMatchObject({
      seq: 0,
      body: { type: 'text', text: 'Second' },
      rawType: 'log',
    });
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  test('caps active websocket session messages and limits snapshot history', () => {
    manager.handleWebSocketConnect('conn-1', vi.fn());

    for (let seq = 1; seq <= 5_100; seq += 1) {
      manager.handleWebSocketMessage('conn-1', {
        type: 'output',
        seq,
        message: {
          type: 'structured',
          message: {
            type: 'llm_response',
            timestamp: `2026-03-17T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
            text: `message-${seq}`,
          },
        },
      });
    }

    const snapshot = manager.getSessionSnapshot();
    const liveSession = snapshot.sessions.find((item) => item.connectionId === 'conn-1');

    expect(liveSession?.messages).toHaveLength(500);
    expect(liveSession?.messages[0]?.id).toBe('conn-1:4601');
    expect(liveSession?.messages.at(-1)?.id).toBe('conn-1:5100');

    const offline = manager.handleWebSocketDisconnect('conn-1');
    expect(offline?.messages).toHaveLength(5_000);
    expect(offline?.messages[0]?.id).toBe('conn-1:101');
    expect(offline?.messages.at(-1)?.id).toBe('conn-1:5100');
  });

  test('notification-only sessions use monotonic ids even after message cap trimming', () => {
    for (let index = 0; index < 205; index += 1) {
      manager.handleHttpNotification({
        message: `notification-${index}`,
        workspacePath: '/tmp/notifications',
        gitRemote: 'https://example.com/notifications.git',
      });
    }

    const snapshot = manager.getSessionSnapshot();
    const session = snapshot.sessions.find((item) => item.connectionId.startsWith('notification:'));

    expect(session?.messages).toHaveLength(200);
    expect(new Set(session?.messages.map((message) => message.id)).size).toBe(200);
    expect(session?.messages[0]?.id).toBe(
      'notification:example.com/notifications|/tmp/notifications:notif-5'
    );
    expect(session?.messages.at(-1)?.id).toBe(
      'notification:example.com/notifications|/tmp/notifications:notif-204'
    );
  });

  test('sessionGroupKey combines git remote and workspace path safely', () => {
    expect(sessionGroupKey('git', '/tmp/ws')).toBe('git|/tmp/ws');
    expect(sessionGroupKey(undefined, '/tmp/ws')).toBe('|/tmp/ws');
    expect(sessionGroupKey(null, null)).toBe('|');
  });

  test('normalizes equivalent git remotes for project id and group matching', () => {
    const project = getOrCreateProject(db, 'repo-3', {
      remoteUrl: 'git@github.com:tim/notify.git',
      lastGitRoot: '/tmp/repo-3',
    });

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/repo-3',
      gitRemote: 'https://github.com/tim/notify.git',
    });

    const notificationSession = manager.handleHttpNotification({
      message: 'Build queued',
      workspacePath: '/tmp/repo-3',
      gitRemote: 'git@github.com:tim/notify.git',
    });

    expect(notificationSession.connectionId).toBe('conn-1');
    expect(manager.getSessionSnapshot().sessions).toHaveLength(1);
    expect(manager.getSessionSnapshot().sessions[0]?.groupKey).toBe(
      'github.com/tim/notify|/tmp/repo-3'
    );
    expect(manager.getSessionSnapshot().sessions[0]?.projectId).toBe(project.id);
  });

  test('dismissSession only removes offline or notification sessions', () => {
    const onDismiss = vi.fn();
    manager.subscribe('session:dismissed', onDismiss);

    manager.handleWebSocketConnect('active', vi.fn());
    manager.handleWebSocketConnect('offline', vi.fn());
    manager.handleWebSocketDisconnect('offline');
    manager.handleHttpNotification({
      message: 'Heads up',
      workspacePath: '/tmp/notify',
      gitRemote: null,
    });

    const activeDismissed = manager.dismissSession('active');
    const offlineDismissed = manager.dismissSession('offline');
    const notificationDismissed = manager.dismissSession('notification:|/tmp/notify');
    const missingDismissed = manager.dismissSession('missing');

    expect(activeDismissed).toBe(false);
    expect(offlineDismissed).toBe(true);
    expect(notificationDismissed).toBe(true);
    expect(missingDismissed).toBe(false);
    expect(onDismiss).toHaveBeenNthCalledWith(1, { connectionId: 'offline' });
    expect(onDismiss).toHaveBeenNthCalledWith(2, {
      connectionId: 'notification:|/tmp/notify',
    });
    expect(manager.getSessionSnapshot().sessions).toHaveLength(1);
    expect(manager.getSessionSnapshot().sessions[0].connectionId).toBe('active');
  });

  test('sendPromptResponse validates active prompt and delegates to the registered sender', () => {
    const sender = vi.fn<(message: HeadlessServerMessage) => void>();
    manager.handleWebSocketConnect('conn-1', sender);

    // Set up an active prompt via a prompt_request message
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/ws',
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:00.000Z',
          requestId: 'req-1',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });

    // Wrong requestId should fail
    const wrongId = manager.sendPromptResponse('conn-1', 'wrong-id', true);
    expect(wrongId).toBe('no_prompt');

    // Correct requestId should succeed and clear the prompt
    const sentPrompt = manager.sendPromptResponse('conn-1', 'req-1', { approved: true });
    expect(sentPrompt).toBe('sent');
    expect(manager.getSessionSnapshot().sessions[0].activePrompt).toBeNull();

    // Sending again after prompt cleared should fail
    const afterClear = manager.sendPromptResponse('conn-1', 'req-1', true);
    expect(afterClear).toBe('no_prompt');

    // Missing session should fail
    const missingPrompt = manager.sendPromptResponse('missing', 'req-2', false);
    expect(missingPrompt).toBe('no_session');

    expect(sender).toHaveBeenCalledWith({
      type: 'prompt_response',
      requestId: 'req-1',
      value: { approved: true },
    });
  });

  test('keeps replayed prompts out of snapshots and rejects prompt responses before replay ends', () => {
    const sender = vi.fn<(message: HeadlessServerMessage) => void>();
    manager.handleWebSocketConnect('conn-1', sender);
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      workspacePath: '/tmp/ws',
    });
    manager.handleWebSocketMessage('conn-1', { type: 'replay_start' });
    manager.handleWebSocketMessage('conn-1', {
      type: 'output',
      seq: 1,
      message: {
        type: 'structured',
        message: {
          type: 'prompt_request',
          timestamp: '2026-03-17T10:00:00.000Z',
          requestId: 'req-replay',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
        },
      },
    });

    const replaySnapshot = manager.getSessionSnapshot();
    const earlyResponse = manager.sendPromptResponse('conn-1', 'req-replay', true);

    manager.handleWebSocketMessage('conn-1', { type: 'replay_end' });
    const finalSnapshot = manager.getSessionSnapshot();

    expect(replaySnapshot.sessions[0]).toMatchObject({
      isReplaying: true,
      activePrompt: null,
    });
    expect(earlyResponse).toBe('no_prompt');
    expect(sender).not.toHaveBeenCalled();
    expect(finalSnapshot.sessions[0]).toMatchObject({
      isReplaying: false,
      activePrompt: {
        requestId: 'req-replay',
        promptType: 'confirm',
      },
    });
  });

  test('sendUserInput delegates to the registered sender', () => {
    const sender = vi.fn<(message: HeadlessServerMessage) => void>();
    manager.handleWebSocketConnect('conn-1', sender);

    const sentInput = manager.sendUserInput('conn-1', 'continue');
    const missingInput = manager.sendUserInput('missing', 'nope');

    expect(sentInput).toBe(true);
    expect(missingInput).toBe(false);
    expect(sender).toHaveBeenCalledWith({
      type: 'user_input',
      content: 'continue',
    });
  });

  test('getSessionSnapshot returns sessions sorted by connection time and cloned from internal state', () => {
    manager.handleWebSocketConnect('conn-1', vi.fn());
    vi.setSystemTime(new Date('2026-03-17T10:00:02.000Z'));
    manager.handleWebSocketConnect('conn-2', vi.fn());

    const snapshot = manager.getSessionSnapshot();
    snapshot.sessions[0].sessionInfo.command = 'mutated';
    snapshot.sessions[1].messages.push({
      id: 'fake',
      seq: 999,
      timestamp: '2026-03-17T10:00:03.000Z',
      category: 'log',
      bodyType: 'text',
      body: { type: 'text', text: 'fake' },
      rawType: 'log',
    });

    const freshSnapshot = manager.getSessionSnapshot();

    expect(snapshot.sessions.map((session) => session.connectionId)).toEqual(['conn-1', 'conn-2']);
    expect(freshSnapshot.sessions[0].sessionInfo.command).toBe('unknown');
    expect(freshSnapshot.sessions[1].messages).toHaveLength(0);
  });
});
