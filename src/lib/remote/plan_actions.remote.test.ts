import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { recordWorkspace } from '$tim/db/workspace.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;
let currentManager: SessionManager;
const spawnGenerateProcessMock = vi.fn();
const spawnAgentProcessMock = vi.fn();
const spawnChatProcessMock = vi.fn();

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

vi.mock('$lib/server/session_context.js', () => ({
  getSessionManager: () => currentManager,
}));

vi.mock('$lib/server/plan_actions.js', () => ({
  spawnGenerateProcess: (...args: Parameters<typeof spawnGenerateProcessMock>) =>
    spawnGenerateProcessMock(...args),
  spawnAgentProcess: (...args: Parameters<typeof spawnAgentProcessMock>) =>
    spawnAgentProcessMock(...args),
  spawnChatProcess: (...args: Parameters<typeof spawnChatProcessMock>) =>
    spawnChatProcessMock(...args),
}));

import { isPlanLaunching, resetLaunchLockState, setLaunchLock } from '$lib/server/launch_lock.js';
import { startAgent, startChat, startGenerate } from './plan_actions.remote.js';

describe('plan remote actions', () => {
  let tempDir: string;
  let projectId: number;
  let secondProjectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-actions-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentManager = new SessionManager(currentDb);
    spawnGenerateProcessMock.mockReset();
    spawnAgentProcessMock.mockReset();
    spawnChatProcessMock.mockReset();

    projectId = getOrCreateProject(currentDb, 'repo-plan-actions', {
      remoteUrl: 'https://example.com/repo-plan-actions.git',
      lastGitRoot: '/tmp/repo-plan-actions',
    }).id;
    secondProjectId = getOrCreateProject(currentDb, 'repo-plan-actions-2', {
      remoteUrl: 'https://example.com/repo-plan-actions-2.git',
      lastGitRoot: '/tmp/repo-plan-actions-2',
    }).id;
  });

  afterEach(() => {
    resetLaunchLockState();
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('startGenerate rejects missing plans', async () => {
    await expect(invokeCommand(startGenerate, { planUuid: 'missing-plan' })).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('startGenerate rejects plans that already have tasks', async () => {
    seedPlan({
      uuid: 'plan-with-tasks',
      planId: 189,
      tasks: [{ title: 'Existing task', description: 'Already generated' }],
    });

    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-with-tasks' })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Plan is not eligible for generate' },
    });
  });

  test('startGenerate rejects stub plans that are already needs_review, done, cancelled, or deferred', async () => {
    seedPlan({ uuid: 'plan-needs-review', planId: 1890, status: 'needs_review' });
    seedPlan({ uuid: 'plan-done', planId: 1891, status: 'done' });
    seedPlan({ uuid: 'plan-cancelled', planId: 1892, status: 'cancelled' });
    seedPlan({ uuid: 'plan-deferred', planId: 1893, status: 'deferred' });

    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-needs-review' })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Plan is not eligible for generate' },
    });
    await expect(invokeCommand(startGenerate, { planUuid: 'plan-done' })).rejects.toMatchObject({
      status: 400,
      body: { message: 'Plan is not eligible for generate' },
    });
    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-cancelled' })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Plan is not eligible for generate' },
    });
    await expect(invokeCommand(startGenerate, { planUuid: 'plan-deferred' })).rejects.toMatchObject(
      {
        status: 400,
        body: { message: 'Plan is not eligible for generate' },
      }
    );
    expect(spawnGenerateProcessMock).not.toHaveBeenCalled();
  });

  test('startGenerate returns the active session when generate is already running', async () => {
    seedPlan({ uuid: 'plan-running', planId: 190 });
    currentManager.handleWebSocketConnect('conn-generate', () => {});
    currentManager.handleWebSocketMessage('conn-generate', {
      type: 'session_info',
      command: 'generate',
      interactive: true,
      planId: 190,
      planUuid: 'plan-running',
      workspacePath: '/tmp/primary-workspace',
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-running' })).resolves.toEqual({
      status: 'already_running',
      connectionId: 'conn-generate',
    });
    expect(spawnGenerateProcessMock).not.toHaveBeenCalled();
  });

  test('startGenerate returns the active session when an agent session is already running', async () => {
    seedPlan({ uuid: 'plan-running-agent', planId: 1902 });
    currentManager.handleWebSocketConnect('conn-agent', () => {});
    currentManager.handleWebSocketMessage('conn-agent', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 1902,
      planUuid: 'plan-running-agent',
      workspacePath: '/tmp/primary-workspace',
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-running-agent' })).resolves.toEqual(
      {
        status: 'already_running',
        connectionId: 'conn-agent',
      }
    );
    expect(spawnGenerateProcessMock).not.toHaveBeenCalled();
  });

  test('startGenerate returns the active session when a chat session is already running', async () => {
    seedPlan({ uuid: 'plan-running-chat', planId: 1903 });
    currentManager.handleWebSocketConnect('conn-chat', () => {});
    currentManager.handleWebSocketMessage('conn-chat', {
      type: 'session_info',
      command: 'chat',
      interactive: true,
      planId: 1903,
      planUuid: 'plan-running-chat',
      workspacePath: '/tmp/primary-workspace',
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-running-chat' })).resolves.toEqual({
      status: 'already_running',
      connectionId: 'conn-chat',
    });
    expect(spawnGenerateProcessMock).not.toHaveBeenCalled();
  });

  test('startGenerate returns the active session when a review session is already running', async () => {
    seedPlan({ uuid: 'plan-running-review', planId: 1904 });
    currentManager.handleWebSocketConnect('conn-review', () => {});
    currentManager.handleWebSocketMessage('conn-review', {
      type: 'session_info',
      command: 'review',
      interactive: true,
      planId: 1904,
      planUuid: 'plan-running-review',
      workspacePath: '/tmp/primary-workspace',
    });

    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-running-review' })
    ).resolves.toEqual({
      status: 'already_running',
      connectionId: 'conn-review',
    });
    expect(spawnGenerateProcessMock).not.toHaveBeenCalled();
  });

  test('startGenerate ignores offline generate sessions and starts a new process', async () => {
    seedPlan({ uuid: 'plan-offline-session', planId: 1901 });
    recordWorkspace(currentDb, {
      projectId,
      workspacePath: '/tmp/primary-workspace',
      workspaceType: 'primary',
    });
    currentManager.handleWebSocketConnect('conn-offline', () => {});
    currentManager.handleWebSocketMessage('conn-offline', {
      type: 'session_info',
      command: 'generate',
      interactive: true,
      planId: 1901,
      planUuid: 'plan-offline-session',
      workspacePath: '/tmp/primary-workspace',
    });
    currentManager.handleWebSocketDisconnect('conn-offline');
    spawnGenerateProcessMock.mockResolvedValue({
      success: true,
      planId: 1901,
    });

    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-offline-session' })
    ).resolves.toEqual({
      status: 'started',
      planId: 1901,
    });
    expect(spawnGenerateProcessMock).toHaveBeenCalledWith(1901, '/tmp/primary-workspace');
  });

  test('startGenerate rejects plans without a primary workspace', async () => {
    seedPlan({ uuid: 'plan-no-workspace', planId: 191 });

    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-no-workspace' })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Project does not have a primary workspace' },
    });
  });

  test('startGenerate spawns tim generate from the primary workspace', async () => {
    seedPlan({ uuid: 'plan-start', planId: 192 });
    recordWorkspace(currentDb, {
      projectId,
      workspacePath: '/tmp/primary-workspace',
      workspaceType: 'primary',
    });
    spawnGenerateProcessMock.mockResolvedValue({
      success: true,
      planId: 192,
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-start' })).resolves.toEqual({
      status: 'started',
      planId: 192,
    });
    expect(spawnGenerateProcessMock).toHaveBeenCalledWith(192, '/tmp/primary-workspace');
  });

  test('startGenerate surfaces spawn failures', async () => {
    seedPlan({ uuid: 'plan-failure', planId: 193 });
    recordWorkspace(currentDb, {
      projectId,
      workspacePath: '/tmp/primary-workspace',
      workspaceType: 'primary',
    });
    spawnGenerateProcessMock.mockResolvedValue({
      success: false,
      error: 'tim binary not found',
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-failure' })).rejects.toMatchObject({
      status: 500,
      body: { message: 'tim binary not found' },
    });
    expect(isPlanLaunching('plan-failure')).toBe(false);
  });

  test('startGenerate does not block on a session for a different plan UUID with the same numeric planId', async () => {
    seedPlan({ uuid: 'plan-generate-a', planId: 194, projectId });
    seedPlan({ uuid: 'plan-generate-b', planId: 194, projectId: secondProjectId });
    recordWorkspace(currentDb, {
      projectId: secondProjectId,
      workspacePath: '/tmp/primary-workspace-b',
      workspaceType: 'primary',
    });
    currentManager.handleWebSocketConnect('conn-other-project-generate', () => {});
    currentManager.handleWebSocketMessage('conn-other-project-generate', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 194,
      planUuid: 'plan-generate-a',
      workspacePath: '/tmp/primary-workspace',
    });
    spawnGenerateProcessMock.mockResolvedValue({
      success: true,
      planId: 194,
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-generate-b' })).resolves.toEqual({
      status: 'started',
      planId: 194,
    });
    expect(spawnGenerateProcessMock).toHaveBeenCalledWith(194, '/tmp/primary-workspace-b');
  });

  describe('startAgent', () => {
    test('rejects missing plans', async () => {
      await expect(invokeCommand(startAgent, { planUuid: 'missing-plan' })).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
    });

    test('rejects needs_review, done, cancelled, or deferred plans', async () => {
      seedPlan({ uuid: 'agent-plan-needs-review', planId: 2000, status: 'needs_review' });
      seedPlan({ uuid: 'agent-plan-done', planId: 2001, status: 'done' });
      seedPlan({ uuid: 'agent-plan-cancelled', planId: 2002, status: 'cancelled' });
      seedPlan({ uuid: 'agent-plan-deferred', planId: 2003, status: 'deferred' });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-needs-review' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for agent' },
      });
      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-done' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for agent' },
      });
      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-cancelled' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for agent' },
      });
      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-deferred' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for agent' },
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('rejects plans where all tasks are done', async () => {
      seedPlan({
        uuid: 'agent-plan-all-done',
        planId: 2004,
        tasks: [
          { title: 'Task 1', description: 'Done already', done: true },
          { title: 'Task 2', description: 'Also done', done: true },
        ],
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-all-done' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for agent' },
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('allows plans without tasks', async () => {
      seedPlan({ uuid: 'agent-plan-no-tasks', planId: 2005 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnAgentProcessMock.mockResolvedValue({
        success: true,
        planId: 2005,
      });

      await expect(invokeCommand(startAgent, { planUuid: 'agent-plan-no-tasks' })).resolves.toEqual(
        {
          status: 'started',
          planId: 2005,
        }
      );
      expect(spawnAgentProcessMock).toHaveBeenCalledWith(2005, '/tmp/primary-workspace');
    });

    test('returns already_running when an agent session exists', async () => {
      seedPlan({
        uuid: 'agent-plan-running',
        planId: 2006,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      currentManager.handleWebSocketConnect('conn-agent-running', () => {});
      currentManager.handleWebSocketMessage('conn-agent-running', {
        type: 'session_info',
        command: 'agent',
        interactive: true,
        planId: 2006,
        planUuid: 'agent-plan-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(invokeCommand(startAgent, { planUuid: 'agent-plan-running' })).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-agent-running',
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when a generate session exists on the same plan', async () => {
      seedPlan({ uuid: 'agent-plan-generate-running', planId: 2007 });
      currentManager.handleWebSocketConnect('conn-generate-running', () => {});
      currentManager.handleWebSocketMessage('conn-generate-running', {
        type: 'session_info',
        command: 'generate',
        interactive: true,
        planId: 2007,
        planUuid: 'agent-plan-generate-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-generate-running' })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-generate-running',
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when a chat session exists on the same plan', async () => {
      seedPlan({ uuid: 'agent-plan-chat-running', planId: 2012 });
      currentManager.handleWebSocketConnect('conn-chat-running', () => {});
      currentManager.handleWebSocketMessage('conn-chat-running', {
        type: 'session_info',
        command: 'chat',
        interactive: true,
        planId: 2012,
        planUuid: 'agent-plan-chat-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-chat-running' })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-chat-running',
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when a review session exists on the same plan', async () => {
      seedPlan({ uuid: 'agent-plan-review-running', planId: 2013 });
      currentManager.handleWebSocketConnect('conn-review-running', () => {});
      currentManager.handleWebSocketMessage('conn-review-running', {
        type: 'session_info',
        command: 'review',
        interactive: true,
        planId: 2013,
        planUuid: 'agent-plan-review-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-review-running' })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-review-running',
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('ignores offline sessions and starts a new process', async () => {
      seedPlan({
        uuid: 'agent-plan-offline-session',
        planId: 2008,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      currentManager.handleWebSocketConnect('conn-agent-offline', () => {});
      currentManager.handleWebSocketMessage('conn-agent-offline', {
        type: 'session_info',
        command: 'agent',
        interactive: true,
        planId: 2008,
        planUuid: 'agent-plan-offline-session',
        workspacePath: '/tmp/primary-workspace',
      });
      currentManager.handleWebSocketDisconnect('conn-agent-offline');
      spawnAgentProcessMock.mockResolvedValue({
        success: true,
        planId: 2008,
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-offline-session' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2008,
      });
      expect(spawnAgentProcessMock).toHaveBeenCalledWith(2008, '/tmp/primary-workspace');
    });

    test('rejects plans without a primary workspace', async () => {
      seedPlan({
        uuid: 'agent-plan-no-workspace',
        planId: 2009,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-no-workspace' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Project does not have a primary workspace' },
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
    });

    test('spawns tim agent from the primary workspace', async () => {
      seedPlan({
        uuid: 'agent-plan-start',
        planId: 2010,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnAgentProcessMock.mockResolvedValue({
        success: true,
        planId: 2010,
      });

      await expect(invokeCommand(startAgent, { planUuid: 'agent-plan-start' })).resolves.toEqual({
        status: 'started',
        planId: 2010,
      });
      expect(spawnAgentProcessMock).toHaveBeenCalledWith(2010, '/tmp/primary-workspace');
    });

    test('does not block on a session for a different plan UUID with the same numeric planId', async () => {
      seedPlan({
        uuid: 'agent-plan-project-a',
        planId: 2016,
        projectId,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      seedPlan({
        uuid: 'agent-plan-project-b',
        planId: 2016,
        projectId: secondProjectId,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId: secondProjectId,
        workspacePath: '/tmp/primary-workspace-b',
        workspaceType: 'primary',
      });
      currentManager.handleWebSocketConnect('conn-other-project-agent', () => {});
      currentManager.handleWebSocketMessage('conn-other-project-agent', {
        type: 'session_info',
        command: 'agent',
        interactive: true,
        planId: 2016,
        planUuid: 'agent-plan-project-a',
        workspacePath: '/tmp/primary-workspace',
      });
      spawnAgentProcessMock.mockResolvedValue({
        success: true,
        planId: 2016,
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-project-b' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2016,
      });
      expect(spawnAgentProcessMock).toHaveBeenCalledWith(2016, '/tmp/primary-workspace-b');
    });

    test('surfaces spawn failures', async () => {
      seedPlan({
        uuid: 'agent-plan-failure',
        planId: 2011,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnAgentProcessMock.mockResolvedValue({
        success: false,
        error: 'tim agent failed to start',
      });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-failure' })
      ).rejects.toMatchObject({
        status: 500,
        body: { message: 'tim agent failed to start' },
      });
      expect(isPlanLaunching('agent-plan-failure')).toBe(false);
    });

    test('launch lock is cleared when session registers for the plan', async () => {
      seedPlan({
        uuid: 'agent-plan-lock-clear',
        planId: 2015,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      spawnAgentProcessMock.mockResolvedValue({ success: true, planId: 2015 });

      // First launch sets the lock
      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-lock-clear' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2015,
      });
      expect(isPlanLaunching('agent-plan-lock-clear')).toBe(true);

      // Simulate session registration by emitting session_info through the session manager
      currentManager.handleWebSocketConnect('conn-lock-clear', () => {});
      currentManager.handleWebSocketMessage('conn-lock-clear', {
        type: 'session_info',
        command: 'agent',
        planId: 2015,
        planUuid: 'agent-plan-lock-clear',
      });

      // Lock should be cleared by the session listener
      expect(isPlanLaunching('agent-plan-lock-clear')).toBe(false);

      // Disconnect the session so hasActiveSessionForPlan returns false
      currentManager.handleWebSocketDisconnect('conn-lock-clear');

      // Second launch should succeed since both lock and session are cleared
      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-lock-clear' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2015,
      });
      expect(spawnAgentProcessMock).toHaveBeenCalledTimes(2);
    });

    test('launch lock does not block a different plan UUID with the same numeric planId', async () => {
      seedPlan({
        uuid: 'agent-plan-lock-a',
        planId: 2017,
        projectId,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      seedPlan({
        uuid: 'agent-plan-lock-b',
        planId: 2017,
        projectId: secondProjectId,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId: secondProjectId,
        workspacePath: '/tmp/primary-workspace-b',
        workspaceType: 'primary',
      });

      setLaunchLock('agent-plan-lock-a');
      spawnAgentProcessMock.mockResolvedValue({ success: true, planId: 2017 });

      await expect(invokeCommand(startAgent, { planUuid: 'agent-plan-lock-b' })).resolves.toEqual({
        status: 'started',
        planId: 2017,
      });
      expect(spawnAgentProcessMock).toHaveBeenCalledWith(2017, '/tmp/primary-workspace-b');
      expect(isPlanLaunching('agent-plan-lock-a')).toBe(true);
    });

    test('session listener clears only the matching plan UUID lock', async () => {
      seedPlan({
        uuid: 'agent-plan-lock-listener-a',
        planId: 2018,
        projectId,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      seedPlan({
        uuid: 'agent-plan-lock-listener-b',
        planId: 2018,
        projectId: secondProjectId,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      spawnAgentProcessMock.mockResolvedValue({ success: true, planId: 2018 });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-lock-listener-a' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2018,
      });
      expect(isPlanLaunching('agent-plan-lock-listener-a')).toBe(true);

      currentManager.handleWebSocketConnect('conn-lock-listener-b', () => {});
      currentManager.handleWebSocketMessage('conn-lock-listener-b', {
        type: 'session_info',
        command: 'agent',
        planId: 2018,
        planUuid: 'agent-plan-lock-listener-b',
      });
      expect(isPlanLaunching('agent-plan-lock-listener-a')).toBe(true);

      currentManager.handleWebSocketConnect('conn-lock-listener-a', () => {});
      currentManager.handleWebSocketMessage('conn-lock-listener-a', {
        type: 'session_info',
        command: 'agent',
        planId: 2018,
        planUuid: 'agent-plan-lock-listener-a',
      });
      expect(isPlanLaunching('agent-plan-lock-listener-a')).toBe(false);
    });

    test('prevents duplicate launches before any session registers', async () => {
      seedPlan({
        uuid: 'agent-plan-race',
        planId: 2014,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      let resolveSpawn: ((value: { success: true; planId: number }) => void) | undefined;
      const spawnPromise = new Promise<{ success: true; planId: number }>((resolve) => {
        resolveSpawn = resolve;
      });
      spawnAgentProcessMock.mockReturnValue(spawnPromise);

      const firstLaunch = invokeCommand(startAgent, { planUuid: 'agent-plan-race' });
      const secondLaunch = invokeCommand(startAgent, { planUuid: 'agent-plan-race' });

      await expect(secondLaunch).resolves.toEqual({
        status: 'already_running',
      });
      expect(spawnAgentProcessMock).toHaveBeenCalledTimes(1);

      resolveSpawn?.({ success: true, planId: 2014 });

      await expect(firstLaunch).resolves.toEqual({
        status: 'started',
        planId: 2014,
      });
    });
  });

  describe('startChat', () => {
    test('rejects missing plans', async () => {
      await expect(
        invokeCommand(startChat, { planUuid: 'missing-plan', executor: 'claude' })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
    });

    test('allows done, cancelled, and deferred plans', async () => {
      seedPlan({ uuid: 'chat-plan-done', planId: 2101, status: 'done' });
      seedPlan({ uuid: 'chat-plan-cancelled', planId: 2102, status: 'cancelled' });
      seedPlan({ uuid: 'chat-plan-deferred', planId: 2103, status: 'deferred' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2101 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-done', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2101,
      });

      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2102 });
      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-cancelled', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2102,
      });

      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2103 });
      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-deferred', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2103,
      });

      expect(spawnChatProcessMock).toHaveBeenNthCalledWith(
        1,
        2101,
        '/tmp/primary-workspace',
        'claude'
      );
      expect(spawnChatProcessMock).toHaveBeenNthCalledWith(
        2,
        2102,
        '/tmp/primary-workspace',
        'claude'
      );
      expect(spawnChatProcessMock).toHaveBeenNthCalledWith(
        3,
        2103,
        '/tmp/primary-workspace',
        'claude'
      );
    });

    test('allows plans with tasks', async () => {
      seedPlan({
        uuid: 'chat-plan-with-tasks',
        planId: 2104,
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2104 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-with-tasks', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2104,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2104, '/tmp/primary-workspace', 'claude');
    });

    test('allows plans without tasks', async () => {
      seedPlan({ uuid: 'chat-plan-no-tasks', planId: 2105 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2105 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-no-tasks', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2105,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2105, '/tmp/primary-workspace', 'claude');
    });

    test.each([
      ['agent', 'conn-chat-agent-running'],
      ['generate', 'conn-chat-generate-running'],
      ['chat', 'conn-chat-chat-running'],
      ['review', 'conn-chat-review-running'],
    ] as const)(
      'returns already_running when a %s session exists on the same plan',
      async (command, connectionId) => {
        seedPlan({ uuid: `chat-plan-${command}-running`, planId: 2106 });
        currentManager.handleWebSocketConnect(connectionId, () => {});
        currentManager.handleWebSocketMessage(connectionId, {
          type: 'session_info',
          command,
          interactive: true,
          planId: 2106,
          planUuid: `chat-plan-${command}-running`,
          workspacePath: '/tmp/primary-workspace',
        });

        await expect(
          invokeCommand(startChat, {
            planUuid: `chat-plan-${command}-running`,
            executor: 'claude',
          })
        ).resolves.toEqual({
          status: 'already_running',
          connectionId,
        });
        expect(spawnChatProcessMock).not.toHaveBeenCalled();
      }
    );

    test('ignores offline sessions and starts a new process', async () => {
      seedPlan({ uuid: 'chat-plan-offline-session', planId: 2107 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      currentManager.handleWebSocketConnect('conn-chat-offline', () => {});
      currentManager.handleWebSocketMessage('conn-chat-offline', {
        type: 'session_info',
        command: 'chat',
        interactive: true,
        planId: 2107,
        planUuid: 'chat-plan-offline-session',
        workspacePath: '/tmp/primary-workspace',
      });
      currentManager.handleWebSocketDisconnect('conn-chat-offline');
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2107 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-offline-session', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2107,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2107, '/tmp/primary-workspace', 'claude');
    });

    test('rejects plans without a primary workspace', async () => {
      seedPlan({ uuid: 'chat-plan-no-workspace', planId: 2108 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-no-workspace', executor: 'claude' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Project does not have a primary workspace' },
      });
      expect(spawnChatProcessMock).not.toHaveBeenCalled();
    });

    test('spawns tim chat from the primary workspace with the claude executor', async () => {
      seedPlan({ uuid: 'chat-plan-claude', planId: 2109 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2109 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-claude', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2109,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2109, '/tmp/primary-workspace', 'claude');
    });

    test('spawns tim chat from the primary workspace with the codex executor', async () => {
      seedPlan({ uuid: 'chat-plan-codex', planId: 2110 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2110 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-codex', executor: 'codex' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2110,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2110, '/tmp/primary-workspace', 'codex');
    });

    test('surfaces spawn failures', async () => {
      seedPlan({ uuid: 'chat-plan-failure', planId: 2111 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnChatProcessMock.mockResolvedValue({
        success: false,
        error: 'tim chat failed to start',
      });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-failure', executor: 'claude' })
      ).rejects.toMatchObject({
        status: 500,
        body: { message: 'tim chat failed to start' },
      });
      expect(isPlanLaunching('chat-plan-failure')).toBe(false);
    });

    test('prevents duplicate launches before any session registers', async () => {
      seedPlan({ uuid: 'chat-plan-race', planId: 2112 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      let resolveSpawn: ((value: { success: true; planId: number }) => void) | undefined;
      const spawnPromise = new Promise<{ success: true; planId: number }>((resolve) => {
        resolveSpawn = resolve;
      });
      spawnChatProcessMock.mockReturnValue(spawnPromise);

      const firstLaunch = invokeCommand(startChat, {
        planUuid: 'chat-plan-race',
        executor: 'claude',
      });
      const secondLaunch = invokeCommand(startChat, {
        planUuid: 'chat-plan-race',
        executor: 'claude',
      });

      await expect(secondLaunch).resolves.toEqual({
        status: 'already_running',
      });
      expect(spawnChatProcessMock).toHaveBeenCalledTimes(1);

      resolveSpawn?.({ success: true, planId: 2112 });

      await expect(firstLaunch).resolves.toEqual({
        status: 'started',
        planId: 2112,
      });
    });

    test('does not block on a session for a different plan UUID with the same numeric planId', async () => {
      seedPlan({ uuid: 'chat-plan-project-a', planId: 2113, projectId });
      seedPlan({ uuid: 'chat-plan-project-b', planId: 2113, projectId: secondProjectId });
      recordWorkspace(currentDb, {
        projectId: secondProjectId,
        workspacePath: '/tmp/primary-workspace-b',
        workspaceType: 'primary',
      });
      currentManager.handleWebSocketConnect('conn-other-project-chat', () => {});
      currentManager.handleWebSocketMessage('conn-other-project-chat', {
        type: 'session_info',
        command: 'chat',
        interactive: true,
        planId: 2113,
        planUuid: 'chat-plan-project-a',
        workspacePath: '/tmp/primary-workspace',
      });
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2113 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-project-b', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2113,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2113, '/tmp/primary-workspace-b', 'claude');
    });

    test('launch lock does not block a different plan UUID with the same numeric planId', async () => {
      seedPlan({ uuid: 'chat-plan-lock-a', planId: 2114, projectId });
      seedPlan({ uuid: 'chat-plan-lock-b', planId: 2114, projectId: secondProjectId });
      recordWorkspace(currentDb, {
        projectId: secondProjectId,
        workspacePath: '/tmp/primary-workspace-b',
        workspaceType: 'primary',
      });

      setLaunchLock('chat-plan-lock-a');
      spawnChatProcessMock.mockResolvedValue({ success: true, planId: 2114 });

      await expect(
        invokeCommand(startChat, { planUuid: 'chat-plan-lock-b', executor: 'claude' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2114,
      });
      expect(spawnChatProcessMock).toHaveBeenCalledWith(2114, '/tmp/primary-workspace-b', 'claude');
      expect(isPlanLaunching('chat-plan-lock-a')).toBe(true);
    });
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    projectId?: number;
    status?: 'pending' | 'needs_review' | 'done' | 'cancelled' | 'deferred';
    tasks?: Array<{ title: string; description: string; done?: boolean }>;
  }): void {
    upsertPlan(currentDb, options.projectId ?? projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: `Plan ${options.planId}`,
      status: options.status ?? 'pending',
      priority: 'medium',
      filename: `${options.planId}.plan.md`,
      tasks: options.tasks,
    });
  }
});
