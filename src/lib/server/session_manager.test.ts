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

import { SessionManager, formatTunnelMessage, sessionGroupKey } from './session_manager.js';

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

  test('formatTunnelMessage passes through all structured message types as structured body', () => {
    const timestamp = '2026-03-17T10:00:00.000Z';
    const messages: StructuredMessage[] = [
      { type: 'agent_session_start', timestamp, executor: 'codex', mode: 'agent', planId: 229 },
      { type: 'agent_session_end', timestamp, success: true, durationMs: 100, turns: 2 },
      { type: 'agent_iteration_start', timestamp, iterationNumber: 1, taskTitle: 'Ship it' },
      { type: 'agent_step_start', timestamp, phase: 'implement', message: 'starting' },
      { type: 'agent_step_end', timestamp, phase: 'implement', success: true, summary: 'done' },
      { type: 'llm_thinking', timestamp, text: 'thinking' },
      { type: 'llm_response', timestamp, text: 'response' },
      {
        type: 'llm_tool_use',
        timestamp,
        toolName: 'search',
        inputSummary: 'query',
        input: { q: 'tim' },
      },
      {
        type: 'llm_tool_result',
        timestamp,
        toolName: 'search',
        resultSummary: 'ok',
        result: { hits: 1 },
      },
      { type: 'llm_status', timestamp, source: 'codex', status: 'running', detail: 'phase' },
      {
        type: 'todo_update',
        timestamp,
        items: [{ label: 'Write tests', status: 'in_progress' }],
        explanation: 'working',
      },
      { type: 'task_completion', timestamp, taskTitle: 'Write tests', planComplete: false },
      { type: 'file_write', timestamp, path: 'src/file.ts', lineCount: 10 },
      { type: 'file_edit', timestamp, path: 'src/file.ts', diff: '+ test' },
      {
        type: 'file_change_summary',
        timestamp,
        changes: [{ path: 'src/file.ts', kind: 'updated' }],
        status: 'completed',
      },
      { type: 'command_exec', timestamp, command: 'bun test', cwd: '/repo' },
      {
        type: 'command_result',
        timestamp,
        command: 'bun test',
        cwd: '/repo',
        exitCode: 0,
        stdout: 'ok',
      },
      { type: 'review_start', timestamp, executor: 'codex', planId: 229 },
      {
        type: 'review_result',
        timestamp,
        verdict: 'NEEDS_FIXES',
        issues: [],
        recommendations: [],
        actionItems: [],
      },
      { type: 'workflow_progress', timestamp, message: 'Working', phase: 'tests' },
      { type: 'failure_report', timestamp, summary: 'Failed', problems: 'Broken' },
      {
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
          metadata: { totalSteps: 1, failedSteps: 0 },
        },
      },
      { type: 'token_usage', timestamp, totalTokens: 50, inputTokens: 20, outputTokens: 30 },
      { type: 'input_required', timestamp, prompt: 'Continue?' },
      { type: 'user_terminal_input', timestamp, content: 'y', source: 'terminal' },
      {
        type: 'prompt_request',
        timestamp,
        requestId: 'req-1',
        promptType: 'confirm',
        promptConfig: { message: 'Confirm?' },
        timeoutMs: 5000,
      },
      {
        type: 'prompt_answered',
        timestamp,
        requestId: 'req-1',
        promptType: 'confirm',
        value: true,
        source: 'terminal',
      },
      { type: 'prompt_cancelled', timestamp, requestId: 'req-1' },
      { type: 'plan_discovery', timestamp, planId: 229, title: 'Sessions view' },
      {
        type: 'workspace_info',
        timestamp,
        workspaceId: 'ws-1',
        path: '/tmp/ws',
        planFile: 'tasks/229.plan.md',
      },
    ];

    for (const msg of messages) {
      const result = formatTunnelMessage('conn-1', 1, {
        type: 'structured',
        message: msg,
      });
      expect(result).toMatchObject({
        category: 'structured',
        bodyType: 'structured',
        rawType: msg.type,
        body: {
          type: 'structured',
          message: expect.objectContaining({ type: msg.type }),
        },
      });
      // timestamp and transportSource should be stripped from the payload
      const payload = (result!.body as { type: 'structured'; message: Record<string, unknown> })
        .message;
      expect(payload).not.toHaveProperty('timestamp');
      expect(payload).not.toHaveProperty('transportSource');
      if (msg.type === 'llm_tool_result') {
        expect(payload).toMatchObject({
          resultSummary: 'ok',
          result: { hits: 1 },
        });
      }
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
      category: 'structured',
      bodyType: 'structured',
      rawType: 'token_usage',
      triggersNotification: false,
      body: {
        type: 'structured',
        message: {
          type: 'token_usage',
          totalTokens: 100,
          inputTokens: 40,
          outputTokens: 60,
        },
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

  test('formatTunnelMessage marks non-tunnel agent_session_end messages as notification-worthy', () => {
    const direct = formatTunnelMessage('conn-1', 1, {
      type: 'structured',
      message: {
        type: 'agent_session_end',
        timestamp: '2026-03-17T10:00:59.000Z',
        success: true,
        turns: 1,
      },
    });

    const tunneled = formatTunnelMessage('conn-1', 2, {
      type: 'structured',
      message: {
        type: 'agent_session_end',
        timestamp: '2026-03-17T10:01:00.000Z',
        success: true,
        turns: 1,
        transportSource: 'tunnel',
      },
    });

    expect(direct).toMatchObject({
      rawType: 'agent_session_end',
      triggersNotification: true,
    });
    expect(tunneled).toMatchObject({
      rawType: 'agent_session_end',
      triggersNotification: false,
    });
  });

  test('formatTunnelMessage passes through unknown structured message types as structured body', () => {
    const message = formatTunnelMessage('conn-1', 9, {
      type: 'structured',
      message: {
        type: 'unexpected_structured_type',
        timestamp: '2026-03-17T10:00:59.000Z',
      } as unknown as StructuredMessage,
    });

    expect(message).toMatchObject({
      id: 'conn-1:9',
      category: 'structured',
      bodyType: 'structured',
      rawType: 'unexpected_structured_type',
      body: {
        type: 'structured',
        message: { type: 'unexpected_structured_type' },
      },
    });
  });

  test('formatTunnelMessage handles malformed structured payloads gracefully', () => {
    const nullMessage = formatTunnelMessage('conn-1', 99, {
      type: 'structured',
      message: null as unknown as StructuredMessage,
    });
    expect(nullMessage).toMatchObject({
      category: 'log',
      bodyType: 'text',
      body: { type: 'text', text: '[malformed structured message]' },
    });

    const undefinedMessage = formatTunnelMessage('conn-1', 100, {
      type: 'structured',
      message: undefined as unknown as StructuredMessage,
    });
    expect(undefinedMessage).toMatchObject({
      category: 'log',
      bodyType: 'text',
      body: { type: 'text', text: '[malformed structured message]' },
    });

    // Array payload should be rejected
    const arrayMessage = formatTunnelMessage('conn-1', 101, {
      type: 'structured',
      message: [] as unknown as StructuredMessage,
    });
    expect(arrayMessage).toMatchObject({
      category: 'log',
      bodyType: 'text',
      body: { type: 'text', text: '[malformed structured message]' },
    });

    // Object without string type should be rejected
    const noTypeMessage = formatTunnelMessage('conn-1', 102, {
      type: 'structured',
      message: { foo: 'bar' } as unknown as StructuredMessage,
    });
    expect(noTypeMessage).toMatchObject({
      category: 'log',
      bodyType: 'text',
      body: { type: 'text', text: '[malformed structured message]' },
    });
  });

  test('formatTunnelMessage includes detailed review issues, suggestions, and follow-up items', () => {
    const message = formatTunnelMessage('conn-1', 10, {
      type: 'structured',
      message: {
        type: 'review_result',
        timestamp: '2026-03-17T10:00:59.000Z',
        verdict: 'NEEDS_FIXES',
        fixInstructions: 'Address the major issues before merging.',
        issues: [
          {
            severity: 'major',
            category: 'correctness',
            content: 'The tool output truncates too aggressively.',
            file: 'src/lib/components/SessionMessage.svelte',
            line: 137,
            suggestion: 'Apply the 40-line threshold used by the console formatter.',
          },
          {
            severity: 'minor',
            category: 'ux',
            content: 'Review results should stay expanded.',
          },
        ],
        recommendations: ['Re-run the web session rendering tests.'],
        actionItems: ['Verify review output stays untruncated in the browser.'],
      },
    });

    expect(message).toMatchObject({
      id: 'conn-1:10',
      category: 'structured',
      bodyType: 'structured',
      rawType: 'review_result',
    });
    expect(message?.body).toEqual({
      type: 'structured',
      message: {
        type: 'review_result',
        verdict: 'NEEDS_FIXES',
        fixInstructions: 'Address the major issues before merging.',
        issues: [
          {
            severity: 'major',
            category: 'correctness',
            content: 'The tool output truncates too aggressively.',
            file: 'src/lib/components/SessionMessage.svelte',
            line: 137,
            suggestion: 'Apply the 40-line threshold used by the console formatter.',
          },
          {
            severity: 'minor',
            category: 'ux',
            content: 'Review results should stay expanded.',
          },
        ],
        recommendations: ['Re-run the web session rendering tests.'],
        actionItems: ['Verify review output stays untruncated in the browser.'],
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
      sessionId: 'session-conn-1',
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
            sessionId: 'session-conn-1',
            planId: 229,
            planTitle: 'Sessions view',
          }),
          projectId: project.id,
          groupKey: 'example.com/repo-1',
        }),
      })
    );
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-1',
        message: expect.objectContaining({
          seq: 1,
          category: 'structured',
          bodyType: 'structured',
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
      sessionInfo: expect.objectContaining({
        sessionId: 'session-conn-1',
      }),
      messages: [
        expect.objectContaining({
          seq: 1,
          rawType: 'llm_response',
        }),
      ],
    });
  });

  test('replaces session metadata and regroups when session_info is re-sent on the same connection', () => {
    const originalProject = getOrCreateProject(db, 'repo-1', {
      remoteUrl: 'https://example.com/repo-1.git',
      lastGitRoot: '/tmp/repo-1',
    });
    const updatedProject = getOrCreateProject(db, 'repo-2', {
      remoteUrl: 'https://example.com/repo-2.git',
      lastGitRoot: '/tmp/repo-2',
    });
    const onUpdate = vi.fn();

    manager.subscribe('session:update', onUpdate);

    manager.handleWebSocketConnect('conn-1', vi.fn());
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 229,
      planTitle: 'Original workspace',
      workspacePath: '/tmp/repo-1',
      gitRemote: 'https://example.com/repo-1.git',
    });
    manager.handleWebSocketMessage('conn-1', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 229,
      planTitle: 'Updated workspace',
      workspacePath: '/tmp/repo-2',
      gitRemote: 'https://example.com/repo-2.git',
    });

    const session = manager.getSessionSnapshot().sessions[0];

    expect(session).toMatchObject({
      connectionId: 'conn-1',
      projectId: updatedProject.id,
      groupKey: 'example.com/repo-2',
      sessionInfo: {
        command: 'agent',
        interactive: true,
        planId: 229,
        planTitle: 'Updated workspace',
        workspacePath: '/tmp/repo-2',
        gitRemote: 'https://example.com/repo-2.git',
      },
    });
    expect(session.projectId).not.toBe(originalProject.id);
    expect(onUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        session: expect.objectContaining({
          projectId: originalProject.id,
          groupKey: 'example.com/repo-1',
        }),
      })
    );
    expect(onUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        session: expect.objectContaining({
          projectId: updatedProject.id,
          groupKey: 'example.com/repo-2',
          sessionInfo: expect.objectContaining({
            workspacePath: '/tmp/repo-2',
            gitRemote: 'https://example.com/repo-2.git',
          }),
        }),
      })
    );
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
          body: expect.objectContaining({
            type: 'structured',
            message: expect.objectContaining({ text: 'live' }),
          }),
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

  test('clears active prompt and emits prompt-cleared when prompt is cancelled', () => {
    const onPromptCleared = vi.fn();

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
          requestId: 'req-cancelled',
          promptType: 'confirm',
          promptConfig: { message: 'Continue?' },
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
          type: 'prompt_cancelled',
          timestamp: '2026-03-17T10:00:02.000Z',
          requestId: 'req-cancelled',
        },
      },
    });

    const session = manager.getSessionSnapshot().sessions[0];

    expect(onPromptCleared).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      requestId: 'req-cancelled',
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
      connectionId: 'notification:example.com/repo-2:wezterm:4',
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
    expect(session?.messages[0]?.id).toBe('notification:example.com/notifications:notif-5');
    expect(session?.messages.at(-1)?.id).toBe('notification:example.com/notifications:notif-204');
  });

  test('sessionGroupKey prefers normalized git remote and falls back to workspace path', () => {
    expect(sessionGroupKey('git', '/tmp/ws')).toBe('git');
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
    expect(manager.getSessionSnapshot().sessions[0]?.groupKey).toBe('github.com/tim/notify');
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

  test('dismissInactiveSessions removes all offline and notification sessions', () => {
    const onDismiss = vi.fn();
    manager.subscribe('session:dismissed', onDismiss);

    manager.handleWebSocketConnect('active-1', vi.fn());
    manager.handleWebSocketConnect('active-2', vi.fn());
    manager.handleWebSocketConnect('offline-1', vi.fn());
    manager.handleWebSocketDisconnect('offline-1');
    manager.handleWebSocketConnect('offline-2', vi.fn());
    manager.handleWebSocketDisconnect('offline-2');
    manager.handleHttpNotification({
      message: 'Alert',
      workspacePath: '/tmp/n1',
      gitRemote: null,
    });

    expect(manager.getSessionSnapshot().sessions).toHaveLength(5);

    const dismissed = manager.dismissInactiveSessions();

    expect(dismissed).toBe(3);
    expect(onDismiss).toHaveBeenCalledTimes(3);
    expect(manager.getSessionSnapshot().sessions).toHaveLength(2);
    const remaining = manager
      .getSessionSnapshot()
      .sessions.map((s) => s.connectionId)
      .sort();
    expect(remaining).toEqual(['active-1', 'active-2']);
  });

  test('dismissInactiveSessions returns 0 when no inactive sessions exist', () => {
    manager.handleWebSocketConnect('active-1', vi.fn());

    const dismissed = manager.dismissInactiveSessions();

    expect(dismissed).toBe(0);
    expect(manager.getSessionSnapshot().sessions).toHaveLength(1);
  });

  test('dismissInactiveSessions returns 0 when no sessions exist', () => {
    const dismissed = manager.dismissInactiveSessions();
    expect(dismissed).toBe(0);
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

  test('endSession delegates to the registered sender', () => {
    const sender = vi.fn<(message: HeadlessServerMessage) => void>();
    manager.handleWebSocketConnect('conn-1', sender);

    const ended = manager.endSession('conn-1');
    const missing = manager.endSession('missing');

    expect(ended).toBe(true);
    expect(missing).toBe(false);
    expect(sender).toHaveBeenCalledWith({
      type: 'end_session',
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

  test('hasActiveSessionForPlan returns only matching active sessions', () => {
    manager.handleWebSocketConnect('generate-active', () => {});
    manager.handleWebSocketMessage('generate-active', {
      type: 'session_info',
      command: 'generate',
      interactive: true,
      planId: 42,
      planUuid: 'plan-42',
      workspacePath: '/tmp/ws-generate',
    });

    manager.handleWebSocketConnect('generate-offline', () => {});
    manager.handleWebSocketMessage('generate-offline', {
      type: 'session_info',
      command: 'generate',
      interactive: true,
      planId: 42,
      planUuid: 'plan-42',
      workspacePath: '/tmp/ws-offline',
    });
    manager.handleWebSocketDisconnect('generate-offline');

    manager.handleWebSocketConnect('agent-active', () => {});
    manager.handleWebSocketMessage('agent-active', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 42,
      planUuid: 'plan-42',
      workspacePath: '/tmp/ws-agent',
    });

    manager.handleWebSocketConnect('other-plan', () => {});
    manager.handleWebSocketMessage('other-plan', {
      type: 'session_info',
      command: 'generate',
      interactive: true,
      planId: 99,
      planUuid: 'plan-99',
      workspacePath: '/tmp/ws-other',
    });

    expect(manager.hasActiveSessionForPlan('plan-42', 'generate')).toEqual({
      active: true,
      connectionId: 'generate-active',
    });
    expect(manager.hasActiveSessionForPlan('plan-42', 'agent')).toEqual({
      active: true,
      connectionId: 'agent-active',
    });
    expect(manager.hasActiveSessionForPlan('plan-43', 'generate')).toEqual({ active: false });

    // Array of commands matches any session with a matching command
    expect(manager.hasActiveSessionForPlan('plan-42', ['generate', 'agent'])).toEqual({
      active: true,
      connectionId: 'generate-active',
    });
    expect(manager.hasActiveSessionForPlan('plan-42', ['chat'])).toEqual({ active: false });

    // Undefined command matches any active session on the plan
    expect(manager.hasActiveSessionForPlan('plan-42')).toEqual({
      active: true,
      connectionId: 'generate-active',
    });
  });
});
