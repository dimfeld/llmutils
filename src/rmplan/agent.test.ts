import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmplanAgent } from './agent.js';
import { db } from '../bot/db/index.js';
import { workspaces as workspacesTable } from '../bot/db/index.js';
import { eq } from 'drizzle-orm';

// Mock modules
mock.module('./actions.ts', () => ({
  findPendingTask: () => null, // Plan is complete
  markStepDone: async () => ({ planComplete: true, message: 'Done' }),
  prepareNextStep: async () => ({ prompt: 'test', taskIndex: 0, stepIndex: 0 }),
  executePostApplyCommand: async () => true,
}));

mock.module('./configLoader.ts', () => ({
  loadEffectiveConfig: async () => ({
    workspaceCreation: {
      cloneLocation: './.test-workspaces',
    },
  }),
}));

mock.module('../rmfilter/utils.ts', () => ({
  getGitRoot: async () => process.cwd(),
  logSpawn: () => ({ exited: Promise.resolve(0), exitCode: 0 }),
  setDebug: () => {},
  setQuiet: () => {},
}));

mock.module('./executors/index.ts', () => ({
  buildExecutorAndLog: () => ({
    name: 'test',
    execute: async () => {},
  }),
  DEFAULT_EXECUTOR: 'test',
  defaultModelForExecutor: () => 'test-model',
}));

describe('rmplanAgent with botTaskId', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-test-'));

    // Create a test plan file
    planFile = path.join(tempDir, 'test-plan.yml');
    await fs.writeFile(
      planFile,
      `goal: Test plan
details: Test details
tasks:
  - title: Test task
    description: Test description
    files: []
    steps:
      - prompt: Test step
        done: false
`
    );
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Cleanup any test workspaces created during tests
    try {
      await fs.rm('./.test-workspaces', { recursive: true, force: true });
    } catch (e) {
      // Ignore if directory doesn't exist
    }
  });

  test('botTaskId is used to lock workspace when provided', async () => {
    const botTaskId = 'bot-task-123';
    const workspaceId = 'workspace-456';

    // Track workspace operations
    const lockedWorkspaces: string[] = [];
    const unlockedWorkspaces: string[] = [];

    // Mock workspace tracker functions
    mock.module('./workspace/workspace_tracker.ts', () => ({
      findWorkspacesByTaskId: async () => [],
      lockWorkspaceToTask: async (path: string, taskId: string) => {
        lockedWorkspaces.push(taskId);
      },
      unlockWorkspace: async (path: string) => {
        unlockedWorkspaces.push(path);
      },
      recordWorkspace: async () => 'test-workspace-id',
    }));

    // Run agent with botTaskId
    await rmplanAgent(
      planFile,
      {
        workspace: workspaceId,
        newWorkspace: true,
        botTaskId: botTaskId,
        'no-log': true,
      },
      {}
    );

    // Verify botTaskId was used for locking
    expect(lockedWorkspaces).toContain(botTaskId);
  });

  test('workspace is unlocked on completion when botTaskId is provided', async () => {
    const botTaskId = 'bot-task-789';
    const workspaceId = 'workspace-012';

    let workspaceLocked = false;
    let workspaceUnlocked = false;

    // Mock workspace tracker functions
    mock.module('./workspace/workspace_tracker.ts', () => ({
      findWorkspacesByTaskId: async () => [],
      lockWorkspaceToTask: async () => {
        workspaceLocked = true;
      },
      unlockWorkspace: async () => {
        workspaceUnlocked = true;
      },
      recordWorkspace: async () => 'test-workspace-id',
    }));

    // Run agent with botTaskId
    await rmplanAgent(
      planFile,
      {
        workspace: workspaceId,
        newWorkspace: true,
        botTaskId: botTaskId,
        'no-log': true,
      },
      {}
    );

    // Verify workspace was locked and then unlocked
    expect(workspaceLocked).toBe(true);
    expect(workspaceUnlocked).toBe(true);
  });

  test('workspace is not unlocked when botTaskId is not provided', async () => {
    const workspaceId = 'workspace-345';

    let workspaceUnlocked = false;

    // Mock workspace tracker functions
    mock.module('./workspace/workspace_tracker.ts', () => ({
      findWorkspacesByTaskId: async () => [],
      lockWorkspaceToTask: async () => {},
      unlockWorkspace: async () => {
        workspaceUnlocked = true;
      },
      recordWorkspace: async () => 'test-workspace-id',
    }));

    // Run agent without botTaskId
    await rmplanAgent(
      planFile,
      {
        workspace: workspaceId,
        newWorkspace: true,
        'no-log': true,
      },
      {}
    );

    // Verify workspace was NOT unlocked (since no botTaskId)
    expect(workspaceUnlocked).toBe(false);
  });
});
