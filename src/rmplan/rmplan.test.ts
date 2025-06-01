import { beforeEach, afterEach, describe, expect, test, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from './planSchema.js';
import type { RmplanConfig } from './configSchema.js';

describe('rmplan workspace add command - command line interface', () => {
  let tempDir: string;
  let originalArgv: string[];
  let mockProcessExit: ReturnType<typeof mock>;
  let mockConsoleLog: ReturnType<typeof mock>;
  let mockConsoleError: ReturnType<typeof mock>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-cli-test-'));
    originalArgv = process.argv;

    // Mock process.exit to prevent test runner from exiting
    mockProcessExit = mock(() => {
      throw new Error('Process exit called');
    });
    process.exit = mockProcessExit as any;

    // Mock console methods to capture output
    mockConsoleLog = mock(() => {});
    mockConsoleError = mock(() => {});

    // Create a basic config
    const configDir = path.join(tempDir, '.rmfilter');
    await fs.mkdir(configDir, { recursive: true });
    const config: RmplanConfig = {
      workspaceCreation: {
        enabled: true,
        cloneLocation: path.join(tempDir, 'workspaces'),
        repositoryUrl: 'https://github.com/test/repo.git',
      },
    } as RmplanConfig;
    await fs.writeFile(path.join(configDir, 'rmplan.yml'), yaml.stringify(config));

    // Mock the necessary modules
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: () => Promise.resolve(config),
    }));

    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: () => Promise.resolve(tempDir),
      setDebug: () => {},
      setQuiet: () => {},
      spawnAndLogOutput: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    }));

    mock.module('../logging.js', () => ({
      log: mockConsoleLog,
      error: mockConsoleError,
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    mock.module('./workspace/workspace_manager.js', () => ({
      createWorkspace: mock((gitRoot: string, workspaceId: string, planFile?: string) => {
        return Promise.resolve({
          path: path.join(tempDir, 'workspaces', workspaceId),
          taskId: workspaceId,
          originalPlanFilePath: planFile,
          planFilePathInWorkspace: planFile
            ? path.join(tempDir, 'workspaces', workspaceId, 'tasks', path.basename(planFile))
            : undefined,
        });
      }),
    }));

    mock.module('./id_utils.js', () => ({
      generateProjectId: () => 'test-workspace-id',
    }));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.exit = process.exit;
    await fs.rm(tempDir, { recursive: true, force: true });
    mock.restore();
  });

  test('workspace add without arguments creates workspace', async () => {
    process.argv = ['node', 'rmplan.js', 'workspace', 'add'];

    // Import fresh to get mocked dependencies
    const rmplanModule = await import('./rmplan.js');

    // The command should succeed and show success message
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('✓ Workspace created successfully!')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('test-workspace-id'));
  });

  test('workspace add with plan ID', async () => {
    // Create a test plan
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    const planContent: PlanSchema = {
      id: 'test-plan-id',
      title: 'Test Plan',
      goal: 'Test workspace creation',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };

    const planPath = path.join(tasksDir, 'test-plan-id.yml');
    await fs.writeFile(planPath, yaml.stringify(planContent));

    // Mock resolvePlanFile
    mock.module('./plans.js', () => ({
      resolvePlanFile: () => Promise.resolve(planPath),
      setPlanStatus: mock(() => Promise.resolve()),
    }));

    process.argv = ['node', 'rmplan.js', 'workspace', 'add', 'test-plan-id'];

    const rmplanModule = await import('./rmplan.js');

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Using plan: Test Plan'));
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('✓ Workspace created successfully!')
    );
  });

  test('workspace add with custom ID', async () => {
    process.argv = ['node', 'rmplan.js', 'workspace', 'add', '--id', 'my-custom-id'];

    const rmplanModule = await import('./rmplan.js');

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Creating workspace with ID: my-custom-id')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('ID: my-custom-id'));
  });

  test('workspace add with disabled workspace creation', async () => {
    // Override config to disable workspace creation
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: () => Promise.resolve({}),
    }));

    process.argv = ['node', 'rmplan.js', 'workspace', 'add'];

    try {
      const rmplanModule = await import('./rmplan.js');
    } catch (err) {
      expect(err).toBeDefined();
    }

    expect(mockConsoleError).toHaveBeenCalledWith(
      'Workspace creation is not enabled in configuration.'
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  test('workspace add handles plan resolution error', async () => {
    mock.module('./plans.js', () => ({
      resolvePlanFile: () => Promise.reject(new Error('Plan not found')),
      setPlanStatus: mock(() => Promise.resolve()),
    }));

    process.argv = ['node', 'rmplan.js', 'workspace', 'add', 'non-existent-plan'];

    try {
      const rmplanModule = await import('./rmplan.js');
    } catch (err) {
      expect(err).toBeDefined();
    }

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve plan')
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
});
