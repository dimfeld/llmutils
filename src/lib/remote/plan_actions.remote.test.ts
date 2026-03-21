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
}));

import { startGenerate } from './plan_actions.remote.js';

describe('plan remote actions', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-actions-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentManager = new SessionManager(currentDb);
    spawnGenerateProcessMock.mockReset();

    projectId = getOrCreateProject(currentDb, 'repo-plan-actions', {
      remoteUrl: 'https://example.com/repo-plan-actions.git',
      lastGitRoot: '/tmp/repo-plan-actions',
    }).id;
  });

  afterEach(() => {
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

  test('startGenerate rejects stub plans that are already done, cancelled, or deferred', async () => {
    seedPlan({ uuid: 'plan-done', planId: 1891, status: 'done' });
    seedPlan({ uuid: 'plan-cancelled', planId: 1892, status: 'cancelled' });
    seedPlan({ uuid: 'plan-deferred', planId: 1893, status: 'deferred' });

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
    await expect(
      invokeCommand(startGenerate, { planUuid: 'plan-deferred' })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Plan is not eligible for generate' },
    });
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
      workspacePath: '/tmp/primary-workspace',
    });

    await expect(invokeCommand(startGenerate, { planUuid: 'plan-running' })).resolves.toEqual({
      status: 'already_running',
      connectionId: 'conn-generate',
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
  });

  function seedPlan(options: {
    uuid: string;
    planId: number;
    status?: 'pending' | 'done' | 'cancelled' | 'deferred';
    tasks?: Array<{ title: string; description: string }>;
  }): void {
    upsertPlan(currentDb, projectId, {
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
