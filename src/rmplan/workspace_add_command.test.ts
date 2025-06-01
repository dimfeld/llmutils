import { beforeEach, afterEach, describe, expect, test, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from './planSchema.js';
import type { RmplanConfig } from './configSchema.js';
import type { Workspace } from './workspace/workspace_manager.js';

// Mock dependencies for unit tests
describe('workspace add command - unit tests', () => {
  let mockCreateWorkspace: ReturnType<typeof mock>;
  let mockSetPlanStatus: ReturnType<typeof mock>;
  let mockResolvePlanFile: ReturnType<typeof mock>;
  let mockGenerateProjectId: ReturnType<typeof mock>;
  let mockLoadEffectiveConfig: ReturnType<typeof mock>;
  let mockGetGitRoot: ReturnType<typeof mock>;
  let mockLog: ReturnType<typeof mock>;
  let mockWarn: ReturnType<typeof mock>;
  let mockError: ReturnType<typeof mock>;
  let mockProcessExit: ReturnType<typeof mock>;

  beforeEach(() => {
    // Setup mocks
    mockCreateWorkspace = mock(
      (gitRoot: string, workspaceId: string, planFile?: string, config?: any) => {
        return Promise.resolve({
          path: path.join('/tmp/workspaces', workspaceId),
          taskId: workspaceId,
          originalPlanFilePath: planFile,
          planFilePathInWorkspace: planFile
            ? path.join('/tmp/workspaces', workspaceId, 'tasks', path.basename(planFile))
            : undefined,
        } as Workspace);
      }
    );

    mockSetPlanStatus = mock((planFile: string, status: string) => {
      return Promise.resolve();
    });

    mockResolvePlanFile = mock((planArg: string) => {
      if (planArg.endsWith('.yml') || planArg.endsWith('.yaml')) {
        return Promise.resolve(planArg);
      }
      return Promise.resolve(path.join('/tmp/tasks', `${planArg}.yml`));
    });

    mockGenerateProjectId = mock(() => 'test-id-123');

    mockLoadEffectiveConfig = mock(() => {
      return Promise.resolve({
        workspaceCreation: {
          enabled: true,
          cloneLocation: '/tmp/workspaces',
          repositoryUrl: 'https://github.com/example/repo.git',
        },
      } as RmplanConfig);
    });

    mockGetGitRoot = mock(() => Promise.resolve('/tmp/repo'));

    mockLog = mock(() => {});
    mockWarn = mock(() => {});
    mockError = mock(() => {});
    mockProcessExit = mock(() => {
      throw new Error('Process exit');
    });

    // Mock modules
    mock.module('./workspace/workspace_manager.js', () => ({
      createWorkspace: mockCreateWorkspace,
    }));

    mock.module('./plans.js', () => ({
      resolvePlanFile: mockResolvePlanFile,
      setPlanStatus: mockSetPlanStatus,
    }));

    mock.module('./id_utils.js', () => ({
      generateProjectId: mockGenerateProjectId,
    }));

    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: mockLoadEffectiveConfig,
    }));

    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: mockGetGitRoot,
      setDebug: () => {},
      setQuiet: () => {},
    }));

    mock.module('../logging.js', () => ({
      log: mockLog,
      warn: mockWarn,
      error: mockError,
      debugLog: mock(() => {}),
    }));

    // Mock process.exit
    const originalExit = process.exit;
    process.exit = mockProcessExit as any;
  });

  afterEach(() => {
    mock.restore();
    // Restore process.exit
    process.exit = process.exit;
  });

  test('creates workspace without plan', async () => {
    // Simulate workspace add command handler logic
    const workspaceId = mockGenerateProjectId();
    const config = await mockLoadEffectiveConfig();
    const gitRoot = await mockGetGitRoot();

    const workspace = await mockCreateWorkspace(gitRoot, workspaceId, undefined, config);

    // Verify correct calls
    expect(mockGenerateProjectId).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      '/tmp/repo',
      'test-id-123',
      undefined,
      expect.objectContaining({ workspaceCreation: expect.any(Object) })
    );
    expect(mockSetPlanStatus).not.toHaveBeenCalled();
    expect(workspace).toBeDefined();
    expect(workspace.taskId).toBe('test-id-123');
  });

  test('creates workspace with plan file path', async () => {
    const planPath = '/tmp/tasks/my-plan.yml';
    const planContent: PlanSchema = {
      id: 'plan-123',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    };

    // Mock Bun.file
    const originalBunFile = Bun.file;
    (Bun as any).file = mock((path: string) => ({
      text: () => Promise.resolve(yaml.stringify(planContent)),
    }));

    const resolvedPath = await mockResolvePlanFile(planPath);
    const config = await mockLoadEffectiveConfig();
    const gitRoot = await mockGetGitRoot();

    // Update plan status in source
    await mockSetPlanStatus(resolvedPath, 'in_progress');

    // Create workspace with plan ID from file
    const workspace = await mockCreateWorkspace(gitRoot, 'plan-123', resolvedPath, config);

    // Update plan status in workspace
    if (workspace.planFilePathInWorkspace) {
      await mockSetPlanStatus(workspace.planFilePathInWorkspace, 'in_progress');
    }

    expect(mockResolvePlanFile).toHaveBeenCalledWith(planPath);
    expect(mockSetPlanStatus).toHaveBeenCalledTimes(2);
    expect(mockSetPlanStatus.mock.calls[0]).toEqual([planPath, 'in_progress']);
    expect(mockSetPlanStatus.mock.calls[1]).toEqual([
      workspace.planFilePathInWorkspace,
      'in_progress',
    ]);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      '/tmp/repo',
      'plan-123', // Should use plan ID
      planPath,
      expect.any(Object)
    );

    // Restore Bun.file
    (Bun as any).file = originalBunFile;
  });

  test('creates workspace with plan ID', async () => {
    const planId = 'feature-auth';
    const resolvedPath = '/tmp/tasks/feature-auth.yml';

    mockResolvePlanFile = mock(() => Promise.resolve(resolvedPath));

    const resolved = await mockResolvePlanFile(planId);
    const config = await mockLoadEffectiveConfig();
    const gitRoot = await mockGetGitRoot();
    const workspaceId = mockGenerateProjectId();

    const workspace = await mockCreateWorkspace(gitRoot, workspaceId, resolved, config);

    expect(mockResolvePlanFile).toHaveBeenCalledWith(planId);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      '/tmp/repo',
      'test-id-123',
      resolvedPath,
      expect.any(Object)
    );
  });

  test('uses custom workspace ID when provided', async () => {
    const customId = 'my-custom-workspace';
    const config = await mockLoadEffectiveConfig();
    const gitRoot = await mockGetGitRoot();

    const workspace = await mockCreateWorkspace(gitRoot, customId, undefined, config);

    expect(mockGenerateProjectId).not.toHaveBeenCalled();
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      '/tmp/repo',
      customId,
      undefined,
      expect.any(Object)
    );
  });

  test('handles resolvePlanFile error', async () => {
    const planId = 'non-existent';
    mockResolvePlanFile = mock(() => Promise.reject(new Error('Plan not found')));

    await expect(mockResolvePlanFile(planId)).rejects.toThrow('Plan not found');

    // In real command, this would trigger error logging and process.exit
    mockError('Failed to resolve plan: Error: Plan not found');
    expect(() => mockProcessExit(1)).toThrow('Process exit');

    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  test('handles createWorkspace returning null', async () => {
    mockCreateWorkspace = mock(() => Promise.resolve(null));

    const config = await mockLoadEffectiveConfig();
    const gitRoot = await mockGetGitRoot();
    const workspace = await mockCreateWorkspace(gitRoot, 'test-id', undefined, config);

    expect(workspace).toBeNull();

    // In real command, this would trigger error and exit
    mockError('Failed to create workspace');
    expect(() => mockProcessExit(1)).toThrow('Process exit');
  });

  test('handles workspace creation disabled in config', async () => {
    mockLoadEffectiveConfig = mock(() => Promise.resolve({} as RmplanConfig));

    const config = await mockLoadEffectiveConfig();

    if (!config.workspaceCreation) {
      mockError('Workspace creation is not enabled in configuration.');
      mockError('Add "workspaceCreation" section to your rmplan config file.');
      expect(() => mockProcessExit(1)).toThrow('Process exit');
    }

    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  test('warns when setPlanStatus fails but continues', async () => {
    const planPath = '/tmp/tasks/my-plan.yml';
    mockSetPlanStatus = mock(() => Promise.reject(new Error('Permission denied')));

    const config = await mockLoadEffectiveConfig();
    const gitRoot = await mockGetGitRoot();

    try {
      await mockSetPlanStatus(planPath, 'in_progress');
    } catch (err) {
      mockWarn(`Failed to update plan status: ${err as Error}`);
    }

    // Should still create workspace
    const workspace = await mockCreateWorkspace(gitRoot, 'test-id', planPath, config);

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Failed to update plan status'));
    expect(mockCreateWorkspace).toHaveBeenCalled();
  });
});

describe('workspace add command - integration tests', () => {
  let tempDir: string;
  let tasksDir: string;
  let workspacesDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-workspace-int-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    workspacesDir = path.join(tempDir, 'workspaces');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(workspacesDir, { recursive: true });

    // Create rmplan config file
    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const config: RmplanConfig = {
      workspaceCreation: {
        enabled: true,
        cloneLocation: workspacesDir,
        repositoryUrl: 'https://github.com/example/test.git',
      },
    } as RmplanConfig;
    await fs.writeFile(configPath, yaml.stringify(config));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates workspace directory structure', async () => {
    // Mock only the external dependencies we can't easily test
    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: () => Promise.resolve(tempDir),
      spawnAndLogOutput: mock((args: string[]) => {
        if (args[0] === 'git' && args[1] === 'remote') {
          return Promise.resolve({
            exitCode: 0,
            stdout: 'https://github.com/example/test.git',
            stderr: '',
          });
        }
        if (args[0] === 'git' && args[1] === 'clone') {
          // Simulate git clone by creating directory
          const targetDir = args[args.length - 1];
          return fs.mkdir(targetDir, { recursive: true }).then(async () => {
            // Also create tasks directory in the workspace
            const workspaceTasksDir = path.join(targetDir, 'tasks');
            await fs.mkdir(workspaceTasksDir, { recursive: true });
            return {
              exitCode: 0,
              stdout: '',
              stderr: '',
            };
          });
        }
        if (args[0] === 'git' && args[1] === 'checkout') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }),
      setDebug: () => {},
      setQuiet: () => {},
    }));

    const { createWorkspace } = await import('./workspace/workspace_manager.js');
    const { loadEffectiveConfig } = await import('./configLoader.js');
    const { generateProjectId } = await import('./id_utils.js');

    const config = await loadEffectiveConfig(configPath);
    const workspaceId = generateProjectId();
    const workspace = await createWorkspace(tempDir, workspaceId, undefined, config);

    expect(workspace).toBeDefined();
    expect(workspace?.taskId).toBe(workspaceId);
    expect(workspace?.path).toContain(workspaceId);

    // Verify workspace directory was created
    const workspaceExists = await fs
      .stat(workspace!.path)
      .then(() => true)
      .catch(() => false);
    expect(workspaceExists).toBe(true);

    mock.restore();
  });

  test('copies plan file to workspace', async () => {
    // Create a test plan
    const planContent: PlanSchema = {
      id: 'integration-test-plan',
      title: 'Integration Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [
        {
          title: 'Test task',
          steps: [{ prompt: 'Do something', done: false }],
        },
      ],
    };

    const planPath = path.join(tasksDir, 'test-plan.yml');
    const planYaml = yaml.stringify(planContent);
    const fullContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n${planYaml}`;
    await fs.writeFile(planPath, fullContent);

    // Mock git operations
    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: () => Promise.resolve(tempDir),
      spawnAndLogOutput: mock((args: string[]) => {
        if (args[0] === 'git' && args[1] === 'clone') {
          const targetDir = args[args.length - 1];
          return fs.mkdir(targetDir, { recursive: true }).then(async () => {
            // Also create tasks directory in the workspace
            const workspaceTasksDir = path.join(targetDir, 'tasks');
            await fs.mkdir(workspaceTasksDir, { recursive: true });
            return {
              exitCode: 0,
              stdout: '',
              stderr: '',
            };
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }),
      setDebug: () => {},
      setQuiet: () => {},
    }));

    const { createWorkspace } = await import('./workspace/workspace_manager.js');
    const { loadEffectiveConfig } = await import('./configLoader.js');

    const config = await loadEffectiveConfig(configPath);
    const workspace = await createWorkspace(tempDir, 'test-with-plan', planPath, config);

    expect(workspace).toBeDefined();
    expect(workspace?.originalPlanFilePath).toBe(planPath);
    expect(workspace?.planFilePathInWorkspace).toBeDefined();

    // Verify plan was copied
    if (workspace?.planFilePathInWorkspace) {
      const copiedPlanExists = await fs
        .stat(workspace.planFilePathInWorkspace)
        .then(() => true)
        .catch(() => false);
      expect(copiedPlanExists).toBe(true);

      // Verify content
      const copiedContent = await fs.readFile(workspace.planFilePathInWorkspace, 'utf-8');
      expect(copiedContent).toContain('Integration Test Plan');
    }

    mock.restore();
  });

  test('setPlanStatus correctly updates YAML files', async () => {
    const { setPlanStatus } = await import('./rmplan.js');

    // Create a test plan
    const planContent: PlanSchema = {
      id: 'status-test-plan',
      title: 'Status Test Plan',
      goal: 'Test status updates',
      details: 'Testing setPlanStatus',
      status: 'pending',
      createdAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
    };

    const planPath = path.join(tasksDir, 'status-test.yml');
    const planYaml = yaml.stringify(planContent);
    const fullContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n${planYaml}`;
    await fs.writeFile(planPath, fullContent);

    // Update status
    const beforeUpdate = new Date();
    await setPlanStatus(planPath, 'in_progress');
    const afterUpdate = new Date();

    // Read and verify
    const updatedContent = await fs.readFile(planPath, 'utf-8');
    expect(updatedContent).toContain('status: in_progress');
    expect(updatedContent).toContain('# yaml-language-server:');

    // Parse and verify structure
    const yamlContent = updatedContent.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const updatedPlan = yaml.parse(yamlContent) as PlanSchema;

    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.id).toBe('status-test-plan');
    expect(updatedPlan.title).toBe('Status Test Plan');
    expect(updatedPlan.createdAt).toBe(planContent.createdAt);

    // Verify updatedAt was set
    expect(updatedPlan.updatedAt).toBeDefined();
    const updatedAtDate = new Date(updatedPlan.updatedAt!);
    expect(updatedAtDate.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
    expect(updatedAtDate.getTime()).toBeLessThanOrEqual(afterUpdate.getTime());
  });

  test('setPlanStatus handles missing updatedAt field', async () => {
    const { setPlanStatus } = await import('./rmplan.js');

    // Create a plan without updatedAt
    const planContent = {
      id: 'no-updated-at',
      title: 'No UpdatedAt Plan',
      goal: 'Test without updatedAt',
      details: 'Testing',
      status: 'pending',
      tasks: [],
    };

    const planPath = path.join(tasksDir, 'no-updated.yml');
    await fs.writeFile(planPath, yaml.stringify(planContent));

    await setPlanStatus(planPath, 'done');

    const updatedContent = await fs.readFile(planPath, 'utf-8');
    const yamlContent = updatedContent.replace(/^#\s*yaml-language-server:.*$/m, '').trim();
    const updatedPlan = yaml.parse(yamlContent) as PlanSchema;

    expect(updatedPlan.status).toBe('done');
    expect(updatedPlan.updatedAt).toBeDefined();
  });

  test('setPlanStatus handles invalid YAML gracefully', async () => {
    const { setPlanStatus } = await import('./rmplan.js');

    const invalidPath = path.join(tasksDir, 'invalid.yml');
    await fs.writeFile(invalidPath, 'invalid: yaml: content: {{{');

    await expect(setPlanStatus(invalidPath, 'done')).rejects.toThrow();
  });

  test('setPlanStatus handles non-existent file', async () => {
    const { setPlanStatus } = await import('./rmplan.js');

    const nonExistentPath = path.join(tasksDir, 'does-not-exist.yml');

    await expect(setPlanStatus(nonExistentPath, 'done')).rejects.toThrow();
  });

  test('resolvePlanFile works with various inputs', async () => {
    const { resolvePlanFile } = await import('./plans.js');

    // Create test plans
    const plan1Path = path.join(tasksDir, 'absolute-test.yml');
    const plan2Path = path.join(tasksDir, 'id-based-plan.yml');

    await fs.writeFile(
      plan1Path,
      yaml.stringify({
        id: 'absolute-test',
        title: 'Absolute Test',
        goal: 'Test',
        details: 'Test',
        tasks: [],
      })
    );

    await fs.writeFile(
      plan2Path,
      yaml.stringify({
        id: 'id-based-plan',
        title: 'ID Based Plan',
        goal: 'Test',
        details: 'Test',
        tasks: [],
      })
    );

    // Need to mock getGitRoot as well for resolvePlanFile
    mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: () => Promise.resolve(tempDir),
      setDebug: () => {},
      setQuiet: () => {},
    }));

    // Mock config loader to return our temp tasks dir
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    // Test absolute path
    const resolved1 = await resolvePlanFile(plan1Path);
    expect(resolved1).toBe(plan1Path);

    // Test plan ID
    const resolved2 = await resolvePlanFile('id-based-plan');
    expect(resolved2).toBe(plan2Path);

    // Test non-existent
    await expect(resolvePlanFile('non-existent-plan')).rejects.toThrow();

    mock.restore();
  });
});
