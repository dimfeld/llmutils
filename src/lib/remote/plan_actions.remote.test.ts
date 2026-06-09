import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { claimAssignment, getAssignment } from '$tim/db/assignment.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getPlanByUuid, nonSyncedUpsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { recordWorkspace } from '$tim/db/workspace.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;
let currentManager: SessionManager;
const spawnGenerateProcessMock = vi.fn();
const spawnAgentProcessMock = vi.fn();
const spawnAgentMultiProcessMock = vi.fn();
const spawnChatProcessMock = vi.fn();
const spawnRebaseProcessMock = vi.fn();
const spawnPrCreateProcessMock = vi.fn();
const spawnUpdateDocsProcessMock = vi.fn();
const spawnPlanReviewGuideProcessMock = vi.fn();
const spawnProofProcessMock = vi.fn();
const spawnAutoreviewProcessMock = vi.fn();
const spawnShellProcessMock = vi.fn();
const loadEffectiveConfigMock = vi.fn();

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {
      updateDocs: { mode: 'after-completion', applyLessons: true },
    } as never,
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
  spawnAgentMultiProcess: (...args: Parameters<typeof spawnAgentMultiProcessMock>) =>
    spawnAgentMultiProcessMock(...args),
  spawnChatProcess: (...args: Parameters<typeof spawnChatProcessMock>) =>
    spawnChatProcessMock(...args),
  spawnRebaseProcess: (...args: Parameters<typeof spawnRebaseProcessMock>) =>
    spawnRebaseProcessMock(...args),
  spawnPrCreateProcess: (...args: Parameters<typeof spawnPrCreateProcessMock>) =>
    spawnPrCreateProcessMock(...args),
  spawnUpdateDocsProcess: (...args: Parameters<typeof spawnUpdateDocsProcessMock>) =>
    spawnUpdateDocsProcessMock(...args),
  spawnPlanReviewGuideProcess: (...args: Parameters<typeof spawnPlanReviewGuideProcessMock>) =>
    spawnPlanReviewGuideProcessMock(...args),
  spawnProofProcess: (...args: Parameters<typeof spawnProofProcessMock>) =>
    spawnProofProcessMock(...args),
  spawnAutoreviewProcess: (...args: Parameters<typeof spawnAutoreviewProcessMock>) =>
    spawnAutoreviewProcessMock(...args),
  spawnShellProcess: (...args: Parameters<typeof spawnShellProcessMock>) =>
    spawnShellProcessMock(...args),
}));

vi.mock('$tim/configLoader.js', () => ({
  loadEffectiveConfig: (...args: Parameters<typeof loadEffectiveConfigMock>) =>
    loadEffectiveConfigMock(...args),
}));

import { isPlanLaunching, resetLaunchLockState, setLaunchLock } from '$lib/server/launch_lock.js';
import {
  finishPlanQuick,
  startAgent,
  startAgentMulti,
  startChat,
  startCreatePr,
  startUpdateDocs,
  startGenerate,
  startRebase,
  startPlanReviewGuide,
  startProof,
  startAutoreview,
  startShell,
} from './plan_actions.remote.js';

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
    spawnAgentMultiProcessMock.mockReset();
    spawnChatProcessMock.mockReset();
    spawnRebaseProcessMock.mockReset();
    spawnPrCreateProcessMock.mockReset();
    spawnUpdateDocsProcessMock.mockReset();
    spawnPlanReviewGuideProcessMock.mockReset();
    spawnProofProcessMock.mockReset();
    spawnAutoreviewProcessMock.mockReset();
    spawnShellProcessMock.mockReset();
    loadEffectiveConfigMock.mockReset();

    projectId = getOrCreateProject(currentDb, 'repo-plan-actions', {
      remoteUrl: 'https://example.com/repo-plan-actions.git',
      lastGitRoot: '/tmp/repo-plan-actions',
    }).id;
    secondProjectId = getOrCreateProject(currentDb, 'repo-plan-actions-2', {
      remoteUrl: 'https://example.com/repo-plan-actions-2.git',
      lastGitRoot: '/tmp/repo-plan-actions-2',
    }).id;

    loadEffectiveConfigMock.mockImplementation(async (_overridePath, options) => {
      if (
        options?.cwd === '/tmp/repo-plan-actions' ||
        options?.cwd === '/tmp/primary-workspace' ||
        options?.cwd === undefined
      ) {
        return { updateDocs: { mode: 'after-completion', applyLessons: true } };
      }
      if (
        options?.cwd === '/tmp/repo-plan-actions-2' ||
        options?.cwd === '/tmp/primary-workspace-b'
      ) {
        return { updateDocs: { mode: 'never', applyLessons: false } };
      }
      return {};
    });
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

  test('startGenerate rejects reviewed plans', async () => {
    seedPlan({ uuid: 'plan-reviewed', planId: 1894, status: 'reviewed' });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-reviewed' })).rejects.toMatchObject(
      {
        status: 400,
        body: { message: 'Plan is not eligible for generate' },
      }
    );
    expect(spawnGenerateProcessMock).not.toHaveBeenCalled();
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

    test('rejects reviewed plans', async () => {
      seedPlan({ uuid: 'agent-plan-reviewed', planId: 2099, status: 'reviewed' });

      await expect(
        invokeCommand(startAgent, { planUuid: 'agent-plan-reviewed' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for agent' },
      });
      expect(spawnAgentProcessMock).not.toHaveBeenCalled();
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

  describe('startAgentMulti', () => {
    test('rejects unknown epic plan UUIDs', async () => {
      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'missing-epic',
          childUuids: ['child-a'],
        })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Epic plan not found' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects plans that are not epics', async () => {
      seedPlan({ uuid: 'not-an-epic', planId: 2200 });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'not-an-epic',
          childUuids: ['child-a'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not an epic' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects child UUIDs that do not belong to the epic', async () => {
      seedPlan({ uuid: 'multi-epic', planId: 2201, epic: true });
      seedPlan({
        uuid: 'multi-other-child',
        planId: 2202,
        parentUuid: 'other-epic',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic',
          childUuids: ['multi-other-child'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Child plan multi-other-child does not belong to epic 2201' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects child plans with no tasks', async () => {
      seedPlan({ uuid: 'multi-epic-no-tasks', planId: 2203, epic: true });
      seedPlan({
        uuid: 'multi-child-no-tasks',
        planId: 2204,
        parentUuid: 'multi-epic-no-tasks',
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-no-tasks',
          childUuids: ['multi-child-no-tasks'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Child plan 2204 has no tasks' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects child plans that are already finished or deferred', async () => {
      seedPlan({ uuid: 'multi-epic-ineligible', planId: 2205, epic: true });
      seedPlan({
        uuid: 'multi-child-done',
        planId: 2206,
        parentUuid: 'multi-epic-ineligible',
        status: 'done',
        tasks: [{ title: 'Task', description: 'Done', done: true }],
      });
      seedPlan({
        uuid: 'multi-child-deferred',
        planId: 2207,
        parentUuid: 'multi-epic-ineligible',
        status: 'deferred',
        tasks: [{ title: 'Task', description: 'Deferred', done: false }],
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-ineligible',
          childUuids: ['multi-child-done'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Child plan 2206 is not eligible for agent-multi' },
      });
      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-ineligible',
          childUuids: ['multi-child-deferred'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Child plan 2207 is not eligible for agent-multi' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects selections that omit an unfinished dependency predecessor', async () => {
      seedPlan({ uuid: 'multi-epic-deps', planId: 2208, epic: true });
      seedPlan({
        uuid: 'multi-child-a',
        planId: 2209,
        parentUuid: 'multi-epic-deps',
        tasks: [{ title: 'Task A', description: 'Pending', done: false }],
      });
      seedPlan({
        uuid: 'multi-child-b',
        planId: 2210,
        parentUuid: 'multi-epic-deps',
        tasks: [{ title: 'Task B', description: 'Pending', done: false }],
        dependencyUuids: ['multi-child-a'],
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-deps',
          childUuids: ['multi-child-b'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: {
          message: expect.stringContaining('Plan 2210 depends on unfinished external plan 2209'),
        },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when the epic has an active session', async () => {
      seedPlan({ uuid: 'multi-epic-running', planId: 2211, epic: true });
      seedPlan({
        uuid: 'multi-child-running',
        planId: 2212,
        parentUuid: 'multi-epic-running',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      currentManager.handleWebSocketConnect('conn-agent-multi', () => {});
      currentManager.handleWebSocketMessage('conn-agent-multi', {
        type: 'session_info',
        command: 'agent-multi',
        interactive: false,
        planId: 2211,
        planUuid: 'multi-epic-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-running',
          childUuids: ['multi-child-running'],
        })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-agent-multi',
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when a selected child has an active agent session', async () => {
      seedPlan({ uuid: 'multi-epic-child-running', planId: 2224, epic: true });
      seedPlan({
        uuid: 'multi-child-active-agent',
        planId: 2225,
        parentUuid: 'multi-epic-child-running',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      currentManager.handleWebSocketConnect('conn-child-agent', () => {});
      currentManager.handleWebSocketMessage('conn-child-agent', {
        type: 'session_info',
        command: 'agent',
        interactive: false,
        planId: 2225,
        planUuid: 'multi-child-active-agent',
        workspacePath: '/tmp/child-workspace',
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-child-running',
          childUuids: ['multi-child-active-agent'],
        })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-child-agent',
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when a selected child launch is already in progress', async () => {
      seedPlan({ uuid: 'multi-epic-child-launching', planId: 2226, epic: true });
      seedPlan({
        uuid: 'multi-child-launching',
        planId: 2227,
        parentUuid: 'multi-epic-child-launching',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      setLaunchLock('multi-child-launching');

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-child-launching',
          childUuids: ['multi-child-launching'],
        })
      ).resolves.toEqual({
        status: 'already_running',
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects duplicate child UUIDs', async () => {
      seedPlan({ uuid: 'multi-epic-dup', planId: 2216, epic: true });
      seedPlan({
        uuid: 'multi-child-dup',
        planId: 2217,
        parentUuid: 'multi-epic-dup',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-dup',
          childUuids: ['multi-child-dup', 'multi-child-dup'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Child plan multi-child-dup was selected more than once' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('rejects when epic project has no primary workspace', async () => {
      seedPlan({ uuid: 'multi-epic-no-ws', planId: 2218, epic: true });
      seedPlan({
        uuid: 'multi-child-no-ws',
        planId: 2219,
        parentUuid: 'multi-epic-no-ws',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-no-ws',
          childUuids: ['multi-child-no-ws'],
        })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Project does not have a primary workspace' },
      });
      expect(spawnAgentMultiProcessMock).not.toHaveBeenCalled();
    });

    test('surfaces spawn failure for startAgentMulti', async () => {
      seedPlan({ uuid: 'multi-epic-fail', planId: 2220, epic: true });
      seedPlan({
        uuid: 'multi-child-fail',
        planId: 2221,
        parentUuid: 'multi-epic-fail',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnAgentMultiProcessMock.mockResolvedValue({
        success: false,
        error: 'tim agent-multi failed to start',
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-fail',
          childUuids: ['multi-child-fail'],
        })
      ).rejects.toMatchObject({
        status: 500,
        body: { message: 'tim agent-multi failed to start' },
      });
      expect(isPlanLaunching('multi-epic-fail')).toBe(false);
    });

    test('returns already_running for concurrent starts before the orchestrator session registers', async () => {
      seedPlan({ uuid: 'multi-epic-race', planId: 2222, epic: true });
      seedPlan({
        uuid: 'multi-child-race',
        planId: 2223,
        parentUuid: 'multi-epic-race',
        tasks: [{ title: 'Task', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      let resolveSpawn: ((result: { success: true; planId: number }) => void) | undefined;
      spawnAgentMultiProcessMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSpawn = resolve;
          })
      );

      const firstLaunch = invokeCommand(startAgentMulti, {
        epicPlanUuid: 'multi-epic-race',
        childUuids: ['multi-child-race'],
      });
      await vi.waitFor(() => expect(isPlanLaunching('multi-epic-race')).toBe(true));

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-race',
          childUuids: ['multi-child-race'],
        })
      ).resolves.toEqual({
        status: 'already_running',
      });
      expect(spawnAgentMultiProcessMock).toHaveBeenCalledTimes(1);

      resolveSpawn?.({ success: true, planId: 2222 });
      await expect(firstLaunch).resolves.toEqual({
        status: 'started',
        planId: 2222,
        planIds: [2223],
      });
    });

    test('spawns tim agent-multi with resolved numeric child plan IDs', async () => {
      seedPlan({ uuid: 'multi-epic-start', planId: 2213, epic: true });
      seedPlan({
        uuid: 'multi-child-start-a',
        planId: 2214,
        parentUuid: 'multi-epic-start',
        tasks: [{ title: 'Task A', description: 'Pending', done: false }],
      });
      seedPlan({
        uuid: 'multi-child-start-b',
        planId: 2215,
        parentUuid: 'multi-epic-start',
        tasks: [{ title: 'Task B', description: 'Pending', done: false }],
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnAgentMultiProcessMock.mockResolvedValue({
        success: true,
        planId: 2214,
      });

      await expect(
        invokeCommand(startAgentMulti, {
          epicPlanUuid: 'multi-epic-start',
          childUuids: ['multi-child-start-b', 'multi-child-start-a'],
        })
      ).resolves.toEqual({
        status: 'started',
        planId: 2213,
        planIds: [2215, 2214],
      });
      expect(spawnAgentMultiProcessMock).toHaveBeenCalledWith(
        2213,
        [2215, 2214],
        '/tmp/primary-workspace'
      );
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

  describe('startAutoreview', () => {
    test('spawns tim autoreview from the primary workspace', async () => {
      seedPlan({ uuid: 'autoreview-plan', planId: 2201, status: 'needs_review' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnAutoreviewProcessMock.mockResolvedValue({ success: true, planId: 2201 });

      await expect(
        invokeCommand(startAutoreview, { planUuid: 'autoreview-plan' })
      ).resolves.toEqual({
        status: 'started',
        planId: 2201,
      });
      expect(spawnAutoreviewProcessMock).toHaveBeenCalledWith(2201, '/tmp/primary-workspace');
    });

    test('returns already_running when a session exists on the same plan', async () => {
      seedPlan({ uuid: 'autoreview-plan-running', planId: 2202 });
      currentManager.handleWebSocketConnect('conn-autoreview-running', () => {});
      currentManager.handleWebSocketMessage('conn-autoreview-running', {
        type: 'session_info',
        command: 'autoreview',
        interactive: true,
        planId: 2202,
        planUuid: 'autoreview-plan-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startAutoreview, { planUuid: 'autoreview-plan-running' })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-autoreview-running',
      });
      expect(spawnAutoreviewProcessMock).not.toHaveBeenCalled();
    });
  });

  describe('startShell', () => {
    test('spawns tim shell from the primary workspace', async () => {
      seedPlan({ uuid: 'shell-plan', planId: 2301, status: 'in_progress' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnShellProcessMock.mockResolvedValue({ success: true, planId: 2301 });

      await expect(invokeCommand(startShell, { planUuid: 'shell-plan' })).resolves.toEqual({
        status: 'started',
        planId: 2301,
      });
      expect(spawnShellProcessMock).toHaveBeenCalledWith(2301, '/tmp/primary-workspace');
    });

    test('returns already_running when a session exists on the same plan', async () => {
      seedPlan({ uuid: 'shell-plan-running', planId: 2302 });
      currentManager.handleWebSocketConnect('conn-shell-running', () => {});
      currentManager.handleWebSocketMessage('conn-shell-running', {
        type: 'session_info',
        command: 'shell',
        interactive: true,
        pty: true,
        planId: 2302,
        planUuid: 'shell-plan-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(invokeCommand(startShell, { planUuid: 'shell-plan-running' })).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-shell-running',
      });
      expect(spawnShellProcessMock).not.toHaveBeenCalled();
    });
  });

  describe('startRebase', () => {
    test('rejects missing plans', async () => {
      await expect(invokeCommand(startRebase, { planUuid: 'missing-plan' })).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
    });

    test('rejects plans with ineligible statuses (pending, cancelled, deferred)', async () => {
      seedPlan({ uuid: 'rebase-plan-pending', planId: 3000, status: 'pending' });
      seedPlan({ uuid: 'rebase-plan-cancelled', planId: 3001, status: 'cancelled' });
      seedPlan({ uuid: 'rebase-plan-deferred', planId: 3002, status: 'deferred' });

      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-pending' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for rebase' },
      });
      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-cancelled' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for rebase' },
      });
      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-deferred' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for rebase' },
      });
      expect(spawnRebaseProcessMock).not.toHaveBeenCalled();
    });

    test('allows in_progress, needs_review, reviewed, and done plans', async () => {
      seedPlan({ uuid: 'rebase-plan-in-progress', planId: 3003, status: 'in_progress' });
      seedPlan({ uuid: 'rebase-plan-needs-review', planId: 3004, status: 'needs_review' });
      seedPlan({ uuid: 'rebase-plan-reviewed', planId: 3009, status: 'reviewed' });
      seedPlan({ uuid: 'rebase-plan-done', planId: 3005, status: 'done' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      spawnRebaseProcessMock.mockResolvedValue({ success: true, planId: 3003 });
      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-in-progress' })
      ).resolves.toEqual({ status: 'started', planId: 3003 });

      spawnRebaseProcessMock.mockResolvedValue({ success: true, planId: 3004 });
      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-needs-review' })
      ).resolves.toEqual({ status: 'started', planId: 3004 });

      spawnRebaseProcessMock.mockResolvedValue({ success: true, planId: 3009 });
      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-reviewed' })
      ).resolves.toEqual({ status: 'started', planId: 3009 });

      spawnRebaseProcessMock.mockResolvedValue({ success: true, planId: 3005 });
      await expect(invokeCommand(startRebase, { planUuid: 'rebase-plan-done' })).resolves.toEqual({
        status: 'started',
        planId: 3005,
      });

      expect(spawnRebaseProcessMock).toHaveBeenCalledTimes(4);
    });

    test('returns already_running when a session exists on the same plan', async () => {
      seedPlan({ uuid: 'rebase-plan-running', planId: 3006, status: 'needs_review' });
      currentManager.handleWebSocketConnect('conn-rebase-running', () => {});
      currentManager.handleWebSocketMessage('conn-rebase-running', {
        type: 'session_info',
        command: 'rebase',
        interactive: true,
        planId: 3006,
        planUuid: 'rebase-plan-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-running' })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-rebase-running',
      });
      expect(spawnRebaseProcessMock).not.toHaveBeenCalled();
    });

    test('rejects plans without a primary workspace', async () => {
      seedPlan({ uuid: 'rebase-plan-no-workspace', planId: 3007, status: 'done' });

      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-no-workspace' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Project does not have a primary workspace' },
      });
      expect(spawnRebaseProcessMock).not.toHaveBeenCalled();
    });

    test('spawns tim rebase from the primary workspace', async () => {
      seedPlan({ uuid: 'rebase-plan-start', planId: 3008, status: 'needs_review' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnRebaseProcessMock.mockResolvedValue({ success: true, planId: 3008 });

      await expect(invokeCommand(startRebase, { planUuid: 'rebase-plan-start' })).resolves.toEqual({
        status: 'started',
        planId: 3008,
      });
      expect(spawnRebaseProcessMock).toHaveBeenCalledWith(3008, '/tmp/primary-workspace');
    });

    test('surfaces spawn failures', async () => {
      seedPlan({ uuid: 'rebase-plan-failure', planId: 3009, status: 'done' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnRebaseProcessMock.mockResolvedValue({
        success: false,
        error: 'tim rebase failed to start',
      });

      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-failure' })
      ).rejects.toMatchObject({
        status: 500,
        body: { message: 'tim rebase failed to start' },
      });
      expect(isPlanLaunching('rebase-plan-failure')).toBe(false);
    });

    test('clears launch lock immediately when earlyExit is true', async () => {
      seedPlan({ uuid: 'rebase-plan-early-exit', planId: 3010, status: 'needs_review' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnRebaseProcessMock.mockResolvedValue({
        success: true,
        planId: 3010,
        earlyExit: true,
      });

      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-early-exit' })
      ).resolves.toEqual({ status: 'started', planId: 3010 });

      // Launch lock should be cleared immediately since earlyExit is true
      expect(isPlanLaunching('rebase-plan-early-exit')).toBe(false);
    });

    test('launch lock remains when earlyExit is not set', async () => {
      seedPlan({ uuid: 'rebase-plan-no-early-exit', planId: 3011, status: 'needs_review' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnRebaseProcessMock.mockResolvedValue({
        success: true,
        planId: 3011,
      });

      await expect(
        invokeCommand(startRebase, { planUuid: 'rebase-plan-no-early-exit' })
      ).resolves.toEqual({ status: 'started', planId: 3011 });

      // Launch lock should remain since there was no early exit
      expect(isPlanLaunching('rebase-plan-no-early-exit')).toBe(true);
    });

    test('prevents duplicate launches before any session registers', async () => {
      seedPlan({ uuid: 'rebase-plan-race', planId: 3012, status: 'done' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      let resolveSpawn: ((value: { success: true; planId: number }) => void) | undefined;
      const spawnPromise = new Promise<{ success: true; planId: number }>((resolve) => {
        resolveSpawn = resolve;
      });
      spawnRebaseProcessMock.mockReturnValue(spawnPromise);

      const firstLaunch = invokeCommand(startRebase, { planUuid: 'rebase-plan-race' });
      const secondLaunch = invokeCommand(startRebase, { planUuid: 'rebase-plan-race' });

      await expect(secondLaunch).resolves.toEqual({
        status: 'already_running',
      });
      expect(spawnRebaseProcessMock).toHaveBeenCalledTimes(1);

      resolveSpawn?.({ success: true, planId: 3012 });

      await expect(firstLaunch).resolves.toEqual({
        status: 'started',
        planId: 3012,
      });
    });
  });

  describe('startUpdateDocs', () => {
    test('rejects missing plans', async () => {
      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'missing-plan' })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
    });

    test('allows needs_review plans', async () => {
      seedPlan({ uuid: 'finish-plan-needs-review', planId: 4000, status: 'needs_review' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnUpdateDocsProcessMock.mockResolvedValue({ success: true, planId: 4000 });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-needs-review' })
      ).resolves.toEqual({
        status: 'started',
        planId: 4000,
      });
      expect(spawnUpdateDocsProcessMock).toHaveBeenCalledWith(4000, '/tmp/primary-workspace');
    });

    test('allows done plans when documentation has not been updated', async () => {
      seedPlan({
        uuid: 'finish-plan-missing-docs',
        planId: 4001,
        status: 'done',
        docsUpdatedAt: null,
        lessonsAppliedAt: '2026-02-01T00:00:00.000Z',
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnUpdateDocsProcessMock.mockResolvedValue({ success: true, planId: 4001 });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-missing-docs' })
      ).resolves.toEqual({
        status: 'started',
        planId: 4001,
      });
      expect(spawnUpdateDocsProcessMock).toHaveBeenCalledWith(4001, '/tmp/primary-workspace');
    });

    test('allows done plans when lessons have not been applied', async () => {
      seedPlan({
        uuid: 'finish-plan-missing-lessons',
        planId: 4002,
        status: 'done',
        docsUpdatedAt: '2026-02-01T00:00:00.000Z',
        lessonsAppliedAt: null,
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnUpdateDocsProcessMock.mockResolvedValue({ success: true, planId: 4002 });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-missing-lessons' })
      ).resolves.toEqual({
        status: 'started',
        planId: 4002,
      });
      expect(spawnUpdateDocsProcessMock).toHaveBeenCalledWith(4002, '/tmp/primary-workspace');
    });

    test('rejects done plans when both finish-tracking timestamps are present', async () => {
      seedPlan({
        uuid: 'finish-plan-complete',
        planId: 4003,
        status: 'done',
        docsUpdatedAt: '2026-02-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-02-02T00:00:00.000Z',
      });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-complete' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for finish' },
      });
      expect(spawnUpdateDocsProcessMock).not.toHaveBeenCalled();
    });

    test('uses per-project config for eligibility', async () => {
      seedPlan({
        uuid: 'finish-plan-project2-missing-docs',
        planId: 4007,
        projectId: secondProjectId,
        status: 'done',
        docsUpdatedAt: null,
        lessonsAppliedAt: null,
      });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-project2-missing-docs' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for finish' },
      });
      expect(spawnUpdateDocsProcessMock).not.toHaveBeenCalled();
    });

    test('rejects in-progress plans even when finish work is pending', async () => {
      seedPlan({
        uuid: 'finish-plan-in-progress',
        planId: 4004,
        status: 'in_progress',
        docsUpdatedAt: null,
        lessonsAppliedAt: null,
      });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-in-progress' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for finish' },
      });
      expect(spawnUpdateDocsProcessMock).not.toHaveBeenCalled();
    });

    test('returns already_running when an update-docs session exists on the same plan', async () => {
      seedPlan({ uuid: 'finish-plan-running', planId: 4005, status: 'needs_review' });
      currentManager.handleWebSocketConnect('conn-finish-running', () => {});
      currentManager.handleWebSocketMessage('conn-finish-running', {
        type: 'session_info',
        command: 'update-docs',
        interactive: true,
        planId: 4005,
        planUuid: 'finish-plan-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-running' })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-finish-running',
      });
      expect(spawnUpdateDocsProcessMock).not.toHaveBeenCalled();
    });

    test('rejects plans without a primary workspace', async () => {
      seedPlan({ uuid: 'finish-plan-no-workspace', planId: 4006, status: 'needs_review' });

      await expect(
        invokeCommand(startUpdateDocs, { planUuid: 'finish-plan-no-workspace' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Project does not have a primary workspace' },
      });
      expect(spawnUpdateDocsProcessMock).not.toHaveBeenCalled();
    });
  });

  describe('finishPlanQuick', () => {
    test('rejects missing plans', async () => {
      await expect(
        invokeCommand(finishPlanQuick, { planUuid: 'missing-plan' })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
    });

    test('rejects in_progress plans', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111103',
        planId: 5000,
        status: 'in_progress',
      });

      await expect(
        invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111103' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for finish' },
      });
    });

    test('allows quick finish for taskless epics regardless of status or finish executor needs', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111110',
        planId: 5007,
        status: 'pending',
        epic: true,
        tasks: [],
        docsUpdatedAt: null,
        lessonsAppliedAt: null,
      });

      await expect(
        invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111110' })
      ).resolves.toEqual({ status: 'done' });

      expect(getPlanByUuid(currentDb, '11111111-1111-4111-8111-111111111110')?.status).toBe('done');
    });

    test('allows quick finish when docs or lessons are still pending', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111104',
        planId: 5001,
        status: 'needs_review',
        docsUpdatedAt: null,
        lessonsAppliedAt: null,
      });

      await expect(
        invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111104' })
      ).resolves.toEqual({ status: 'done' });

      expect(getPlanByUuid(currentDb, '11111111-1111-4111-8111-111111111104')?.status).toBe('done');
    });

    test('persists done status directly in the DB when no executor work is needed', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111105',
        planId: 5002,
        status: 'needs_review',
        docsUpdatedAt: '2026-02-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-02-02T00:00:00.000Z',
      });

      await invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111105' });

      expect(getPlanByUuid(currentDb, '11111111-1111-4111-8111-111111111105')?.status).toBe('done');
    });

    test('successfully updates done plan status when no executor work needed', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111102',
        planId: 5003,
        status: 'done',
        docsUpdatedAt: '2026-02-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-02-02T00:00:00.000Z',
      });

      await expect(
        invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111102' })
      ).resolves.toEqual({ status: 'done' });
    });

    test('returns { status: "done" } on success', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111109',
        planId: 5004,
        status: 'needs_review',
        docsUpdatedAt: '2026-02-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-02-02T00:00:00.000Z',
      });

      const result = await invokeCommand(finishPlanQuick, {
        planUuid: '11111111-1111-4111-8111-111111111109',
      });
      expect(result).toEqual({ status: 'done' });
    });

    test('runs completion side effects after finishing and cascades the parent in the DB', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111106',
        planId: 5006,
        status: 'in_progress',
        epic: true,
        tasks: [],
      });
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111101',
        planId: 5005,
        status: 'needs_review',
        parentUuid: '11111111-1111-4111-8111-111111111106',
        docsUpdatedAt: '2026-02-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-02-02T00:00:00.000Z',
      });

      claimAssignment(currentDb, projectId, '11111111-1111-4111-8111-111111111101', 5005);
      expect(
        getAssignment(currentDb, projectId, '11111111-1111-4111-8111-111111111101')
      ).not.toBeNull();

      await invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111101' });

      expect(
        getAssignment(currentDb, projectId, '11111111-1111-4111-8111-111111111101')
      ).toBeNull();
      expect(getPlanByUuid(currentDb, '11111111-1111-4111-8111-111111111101')?.status).toBe('done');
      expect(getPlanByUuid(currentDb, '11111111-1111-4111-8111-111111111106')?.status).toBe(
        'needs_review'
      );
    });

    test('uses per-project config for quick-finish eligibility', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111108',
        planId: 5006,
        projectId: secondProjectId,
        status: 'needs_review',
        docsUpdatedAt: null,
        lessonsAppliedAt: null,
      });

      await expect(
        invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111108' })
      ).resolves.toEqual({ status: 'done' });
    });

    test('prefers the primary workspace path when loading quick-finish side-effect config', async () => {
      seedPlan({
        uuid: '11111111-1111-4111-8111-111111111107',
        planId: 5008,
        status: 'needs_review',
      });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      const cwdCalls: Array<string | undefined> = [];
      loadEffectiveConfigMock.mockImplementation(async (_overridePath, options) => {
        cwdCalls.push(options?.cwd);
        if (options?.cwd === '/tmp/primary-workspace') {
          return { updateDocs: { mode: 'never', applyLessons: false } };
        }
        if (options?.cwd === '/tmp/repo-plan-actions') {
          return { updateDocs: { mode: 'after-completion', applyLessons: true } };
        }
        return {};
      });

      await expect(
        invokeCommand(finishPlanQuick, { planUuid: '11111111-1111-4111-8111-111111111107' })
      ).resolves.toEqual({ status: 'done' });
      expect(cwdCalls).toEqual(['/tmp/primary-workspace']);
    });
  });

  describe('startCreatePr', () => {
    test('rejects missing plans', async () => {
      await expect(
        invokeCommand(startCreatePr, { planUuid: 'missing-plan' })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
    });

    test('rejects plans with ineligible statuses (pending, cancelled, deferred)', async () => {
      seedPlan({ uuid: 'pr-create-pending', planId: 4000, status: 'pending' });
      seedPlan({ uuid: 'pr-create-cancelled', planId: 4001, status: 'cancelled' });
      seedPlan({ uuid: 'pr-create-deferred', planId: 4002, status: 'deferred' });

      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-pending' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for PR creation' },
      });
      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-cancelled' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for PR creation' },
      });
      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-deferred' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for PR creation' },
      });
      expect(spawnPrCreateProcessMock).not.toHaveBeenCalled();
    });

    test('rejects epic plans', async () => {
      seedPlan({ uuid: 'pr-create-epic', planId: 4003, status: 'in_progress', epic: true });

      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-epic' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for PR creation' },
      });
      expect(spawnPrCreateProcessMock).not.toHaveBeenCalled();
    });

    test('rejects plans that already have a pull request', async () => {
      seedPlan({
        uuid: 'pr-create-has-pr',
        planId: 4004,
        status: 'in_progress',
        pullRequest: ['https://github.com/owner/repo/pull/1'],
      });

      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-has-pr' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for PR creation' },
      });
      expect(spawnPrCreateProcessMock).not.toHaveBeenCalled();
    });

    test('rejects plans with auto-linked PR status records', async () => {
      seedPlan({
        uuid: 'pr-create-has-linked-pr-status',
        planId: 4008,
        status: 'in_progress',
      });
      const detail = upsertPrStatus(currentDb, {
        prUrl: 'https://github.com/owner/repo/pull/8',
        owner: 'owner',
        repo: 'repo',
        prNumber: 8,
        author: 'alice',
        title: 'Existing linked PR',
        state: 'open',
        draft: true,
        mergeable: 'UNKNOWN',
        headSha: 'sha-8',
        baseBranch: 'main',
        headBranch: 'feature/8',
        reviewDecision: null,
        checkRollupState: 'pending',
        mergedAt: null,
        lastFetchedAt: new Date().toISOString(),
        checks: [],
        reviews: [],
        labels: [],
      });
      linkPlanToPr(currentDb, 'pr-create-has-linked-pr-status', detail.status.id, 'auto');

      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-has-linked-pr-status' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for PR creation' },
      });
      expect(spawnPrCreateProcessMock).not.toHaveBeenCalled();
    });

    test('allows in_progress, needs_review, reviewed, and done plans without PRs', async () => {
      seedPlan({ uuid: 'pr-create-in-progress', planId: 4005, status: 'in_progress' });
      seedPlan({ uuid: 'pr-create-needs-review', planId: 4006, status: 'needs_review' });
      seedPlan({ uuid: 'pr-create-reviewed', planId: 4009, status: 'reviewed' });
      seedPlan({ uuid: 'pr-create-done', planId: 4007, status: 'done' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      spawnPrCreateProcessMock.mockResolvedValue({ success: true, planId: 4005 });
      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-in-progress' })
      ).resolves.toEqual({ status: 'started', planId: 4005 });

      spawnPrCreateProcessMock.mockResolvedValue({ success: true, planId: 4006 });
      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-needs-review' })
      ).resolves.toEqual({ status: 'started', planId: 4006 });

      spawnPrCreateProcessMock.mockResolvedValue({ success: true, planId: 4009 });
      await expect(
        invokeCommand(startCreatePr, { planUuid: 'pr-create-reviewed' })
      ).resolves.toEqual({ status: 'started', planId: 4009 });

      spawnPrCreateProcessMock.mockResolvedValue({ success: true, planId: 4007 });
      await expect(invokeCommand(startCreatePr, { planUuid: 'pr-create-done' })).resolves.toEqual({
        status: 'started',
        planId: 4007,
      });

      expect(spawnPrCreateProcessMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('startPlanReviewGuide', () => {
    test('returns 404 when plan does not exist in project', async () => {
      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5999 })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found in project' },
      });
      expect(spawnPlanReviewGuideProcessMock).not.toHaveBeenCalled();
    });

    test('returns 400 when project has no primary workspace', async () => {
      seedPlan({ uuid: 'plan-rg-5001', planId: 5001 });
      // No workspace recorded for projectId
      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5001 })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Project does not have a primary workspace' },
      });
      expect(spawnPlanReviewGuideProcessMock).not.toHaveBeenCalled();
    });

    test('spawns the review guide process and returns { status: started }', async () => {
      seedPlan({ uuid: 'plan-rg-5002', planId: 5002 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnPlanReviewGuideProcessMock.mockResolvedValue({ success: true, planId: 5002 });

      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5002 })
      ).resolves.toEqual({ status: 'started', planId: 5002 });

      expect(spawnPlanReviewGuideProcessMock).toHaveBeenCalledWith(5002, '/tmp/primary-workspace');
    });

    test('returns the active session when another session is already running for the plan', async () => {
      seedPlan({ uuid: 'plan-rg-running', planId: 5008 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      currentManager.handleWebSocketConnect('conn-rg-agent', () => {});
      currentManager.handleWebSocketMessage('conn-rg-agent', {
        type: 'session_info',
        command: 'agent',
        interactive: true,
        planId: 5008,
        planUuid: 'plan-rg-running',
        workspacePath: '/tmp/primary-workspace',
      });

      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5008 })
      ).resolves.toEqual({
        status: 'already_running',
        connectionId: 'conn-rg-agent',
      });

      expect(spawnPlanReviewGuideProcessMock).not.toHaveBeenCalled();
    });

    test('returns 409 when a review is already pending or in_progress', async () => {
      seedPlan({ uuid: 'plan-rg-5004', planId: 5004 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      const { createReview } = await import('$tim/db/review.js');
      createReview(currentDb, {
        projectId,
        planUuid: 'plan-rg-5004',
        status: 'in_progress',
      });

      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5004 })
      ).rejects.toMatchObject({
        status: 409,
        body: { message: 'A review guide is already in progress for this plan' },
      });
      expect(spawnPlanReviewGuideProcessMock).not.toHaveBeenCalled();
    });

    test('rejects concurrent invocations via launch lock', async () => {
      seedPlan({ uuid: 'plan-rg-5005', planId: 5005 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });

      let resolveSpawn: (value: { success: true; planId: number }) => void = () => {};
      const spawnPromise = new Promise<{ success: true; planId: number }>((resolve) => {
        resolveSpawn = resolve;
      });
      spawnPlanReviewGuideProcessMock.mockReturnValueOnce(spawnPromise);

      const firstInvocation = invokeCommand(startPlanReviewGuide, {
        projectId,
        planId: 5005,
      });

      // Second concurrent invocation should be deduplicated by the shared launch lock
      // before the first one completes (and before any DB row is inserted).
      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5005 })
      ).resolves.toEqual({ status: 'already_running' });
      expect(spawnPlanReviewGuideProcessMock).toHaveBeenCalledTimes(1);

      resolveSpawn({ success: true, planId: 5005 });
      await expect(firstInvocation).resolves.toEqual({ status: 'started', planId: 5005 });
    });

    test('clears launch lock on spawn failure', async () => {
      seedPlan({ uuid: 'plan-rg-5006', planId: 5006 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnPlanReviewGuideProcessMock.mockResolvedValueOnce({
        success: false,
        error: 'boom',
      });

      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5006 })
      ).rejects.toMatchObject({ status: 500 });

      expect(isPlanLaunching('plan-rg-5006')).toBe(false);

      // Retry should succeed since the lock was cleared.
      spawnPlanReviewGuideProcessMock.mockResolvedValueOnce({ success: true, planId: 5006 });
      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5006 })
      ).resolves.toEqual({ status: 'started', planId: 5006 });
    });

    test('clears launch lock immediately when earlyExit is true', async () => {
      seedPlan({ uuid: 'plan-rg-5007', planId: 5007 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnPlanReviewGuideProcessMock.mockResolvedValueOnce({
        success: true,
        planId: 5007,
        earlyExit: true,
      });

      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5007 })
      ).resolves.toEqual({ status: 'started', planId: 5007 });

      // Launch lock should be cleared immediately since earlyExit is true.
      expect(isPlanLaunching('plan-rg-5007')).toBe(false);
    });

    test('returns 500 when the spawn process reports failure', async () => {
      seedPlan({ uuid: 'plan-rg-5003', planId: 5003 });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      spawnPlanReviewGuideProcessMock.mockResolvedValue({
        success: false,
        error: 'tim binary not found',
      });

      await expect(
        invokeCommand(startPlanReviewGuide, { projectId, planId: 5003 })
      ).rejects.toMatchObject({
        status: 500,
        body: { message: 'tim binary not found' },
      });
    });
  });

  describe('startProof', () => {
    test('rejects missing plans', async () => {
      await expect(
        invokeCommand(startProof, { planUuid: 'missing-proof-plan' })
      ).rejects.toMatchObject({
        status: 404,
        body: { message: 'Plan not found' },
      });
      expect(spawnProofProcessMock).not.toHaveBeenCalled();
    });

    test('reports not configured separately from plan readiness', async () => {
      seedPlan({ uuid: 'proof-not-configured', planId: 5100, status: 'done' });
      loadEffectiveConfigMock.mockResolvedValueOnce({});

      await expect(
        invokeCommand(startProof, { planUuid: 'proof-not-configured' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Proof generation is not configured for this project' },
      });
      expect(spawnProofProcessMock).not.toHaveBeenCalled();
    });

    test('reports ineligible plans when proof generation is configured', async () => {
      seedPlan({ uuid: 'proof-not-ready', planId: 5101, status: 'pending' });
      loadEffectiveConfigMock.mockResolvedValueOnce({
        proofGeneration: { instructions: 'Capture proof artifacts.' },
      });

      await expect(
        invokeCommand(startProof, { planUuid: 'proof-not-ready' })
      ).rejects.toMatchObject({
        status: 400,
        body: { message: 'Plan is not eligible for proof generation' },
      });
      expect(spawnProofProcessMock).not.toHaveBeenCalled();
    });

    test('starts proof generation for configured ready plans', async () => {
      seedPlan({ uuid: 'proof-ready', planId: 5102, status: 'needs_review' });
      recordWorkspace(currentDb, {
        projectId,
        workspacePath: '/tmp/primary-workspace',
        workspaceType: 'primary',
      });
      loadEffectiveConfigMock.mockResolvedValueOnce({
        proofGeneration: { instructions: 'Capture proof artifacts.' },
      });
      spawnProofProcessMock.mockResolvedValue({ success: true, planId: 5102 });

      await expect(invokeCommand(startProof, { planUuid: 'proof-ready' })).resolves.toEqual({
        status: 'started',
        planId: 5102,
      });
      expect(spawnProofProcessMock).toHaveBeenCalledWith(5102, '/tmp/primary-workspace');
    });
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    projectId?: number;
    status?:
      | 'pending'
      | 'in_progress'
      | 'needs_review'
      | 'reviewed'
      | 'done'
      | 'cancelled'
      | 'deferred';
    epic?: boolean;
    parentUuid?: string;
    basePlanUuid?: string | null;
    dependencyUuids?: string[];
    tasks?: Array<{ title: string; description: string; done?: boolean }>;
    docsUpdatedAt?: string | null;
    lessonsAppliedAt?: string | null;
    pullRequest?: string[] | null;
  }): void {
    nonSyncedUpsertPlan(currentDb, options.projectId ?? projectId, {
      uuid: options.uuid,
      planId: options.planId,
      title: `Plan ${options.planId}`,
      status: options.status ?? 'pending',
      priority: 'medium',
      epic: options.epic ?? false,
      parentUuid: options.parentUuid,
      basePlanUuid: options.basePlanUuid,
      filename: `${options.planId}.plan.md`,
      tasks: options.tasks,
      dependencyUuids: options.dependencyUuids,
      sourceDocsUpdatedAt: options.docsUpdatedAt,
      sourceLessonsAppliedAt: options.lessonsAppliedAt,
      pullRequest: options.pullRequest,
    });
  }
});
