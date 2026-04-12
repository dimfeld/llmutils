import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import type { PlanSchema } from '../planSchema.js';
import { readPlanFile, writePlanFile, writePlanToDb } from '../plans.js';
import { handleUpdateDocsCommand, runUpdateDocs } from './update-docs.js';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'codex-cli',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

describe('update-docs command', () => {
  let tempDir: string;
  let otherDir: string;
  let planFile: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-update-docs-test-'));
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-update-docs-other-'));
    planFile = path.join(tempDir, 'test-plan.yaml');
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  test('handleUpdateDocsCommand requires planFile parameter', async () => {
    const mockCommand = {
      parent: {
        opts: () => ({ config: undefined }),
      },
    };

    await expect(handleUpdateDocsCommand(undefined, {}, mockCommand)).rejects.toThrow(
      'A numeric plan ID is required'
    );
  });

  test('handleUpdateDocsCommand reads plan file successfully', async () => {
    const planData: PlanSchema = {
      id: 1,
      title: 'Test Feature Implementation',
      goal: 'Implement a new authentication system',
      details: 'Add OAuth2 support with Google and GitHub providers',
      status: 'in_progress',
      tasks: [
        {
          title: 'Create OAuth2 provider interface',
          description: 'Define the interface for OAuth2 providers',
          done: true,
        },
        {
          title: 'Implement Google provider',
          description: 'Add Google OAuth2 implementation',
          done: true,
        },
        {
          title: 'Add tests',
          description: 'Write comprehensive tests',
          done: false,
        },
      ],
    };

    await writePlanFile(planFile, planData);

    // Verify the plan was written correctly
    const readData = await readPlanFile(planFile);
    expect(readData.title).toBe('Test Feature Implementation');
    expect(readData.tasks?.length).toBe(3);
    expect(readData.tasks?.filter((t) => t.done).length).toBe(2);
  });

  test('plan with completed tasks can be read', async () => {
    const planData: PlanSchema = {
      id: 2,
      title: 'Config Test Plan',
      details: 'Testing config-based executor selection',
      status: 'done',
      tasks: [
        {
          title: 'Completed Task',
          description: 'A completed task',
          done: true,
        },
      ],
    };

    await writePlanFile(planFile, planData);

    const readData = await readPlanFile(planFile);
    expect(readData.tasks?.[0].done).toBe(true);
    expect(readData.tasks?.[0].title).toBe('Completed Task');
  });

  test('plan with no completed tasks can be read', async () => {
    const planData: PlanSchema = {
      id: 4,
      title: 'No Completed Tasks',
      details: 'Plan with only pending tasks',
      status: 'in_progress',
      tasks: [
        {
          title: 'Pending Task 1',
          description: 'Not done yet',
          done: false,
        },
        {
          title: 'Pending Task 2',
          description: 'Also not done',
          done: false,
        },
      ],
    };

    await writePlanFile(planFile, planData);

    const readData = await readPlanFile(planFile);
    expect(readData.tasks?.filter((t) => t.done).length).toBe(0);
  });

  test('handleUpdateDocsCommand uses resolved repoRoot as executor baseDir for cross-repo config', async () => {
    const configPath = path.join(tempDir, '.tim.yml');
    await fs.writeFile(configPath, 'defaultExecutor: codex-cli\n');
    await writePlanToDb(
      {
        id: 7,
        title: 'Cross-repo docs update',
        goal: 'Run docs update in the target repo',
        tasks: [],
      },
      { cwdForIdentity: tempDir }
    );

    const executeSpy = vi.fn(async () => undefined);
    const buildExecutorAndLogSpy = vi.fn((_executor: string, options: { baseDir: string }) => {
      expect(options.baseDir).toBe(tempDir);
      return { execute: executeSpy };
    });

    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
      updateDocs: {},
      isUsingExternalStorage: true,
    } as any);

    const executorsModule = await import('../executors/index.js');
    vi.mocked(executorsModule.buildExecutorAndLog).mockImplementation(buildExecutorAndLogSpy);

    process.chdir(otherDir);

    const mockCommand = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await handleUpdateDocsCommand('7', {}, mockCommand);

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]?.planFilePath).toBe(
      path.join(tempDir, '.tim', 'plans', '7.plan.md')
    );
  });

  test('runUpdateDocs resolves repoRoot for string plan args when baseDir is omitted', async () => {
    const helperPlanFile = path.join(tempDir, 'helper-plan.md');
    await writePlanFile(helperPlanFile, {
      id: 9,
      title: 'Cross-repo helper docs update',
      goal: 'Run helper in target repo',
      tasks: [],
    });

    const executeSpy = vi.fn(async () => undefined);
    const buildExecutorAndLogSpy = vi.fn((_executor: string, options: { baseDir: string }) => {
      expect(options.baseDir).toBe(tempDir);
      return { execute: executeSpy };
    });

    const executorsModule = await import('../executors/index.js');
    vi.mocked(executorsModule.buildExecutorAndLog).mockImplementation(buildExecutorAndLogSpy);

    process.chdir(otherDir);

    await runUpdateDocs(
      helperPlanFile,
      {
        defaultExecutor: 'codex-cli',
        updateDocs: {},
        isUsingExternalStorage: true,
      } as any,
      {}
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]?.planFilePath).toBe(helperPlanFile);
  });

  test('runUpdateDocs uses configPath to resolve target repo for string plan IDs', async () => {
    const configPath = path.join(tempDir, '.tim.yml');
    await fs.writeFile(configPath, 'defaultExecutor: codex-cli\n');
    await writePlanToDb(
      {
        id: 17,
        title: 'Helper config-path docs update',
        goal: 'Resolve repo from config path',
        tasks: [],
      },
      { cwdForIdentity: tempDir }
    );

    const executeSpy = vi.fn(async () => undefined);
    const buildExecutorAndLogSpy = vi.fn((_executor: string, options: { baseDir: string }) => {
      expect(options.baseDir).toBe(tempDir);
      return { execute: executeSpy };
    });

    const executorsModule = await import('../executors/index.js');
    vi.mocked(executorsModule.buildExecutorAndLog).mockImplementation(buildExecutorAndLogSpy);

    process.chdir(otherDir);

    await runUpdateDocs(
      '17',
      {
        defaultExecutor: 'codex-cli',
        updateDocs: {},
        isUsingExternalStorage: true,
      } as any,
      { configPath }
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[1]?.planFilePath).toBe(
      path.join(tempDir, '.tim', 'plans', '17.plan.md')
    );
  });
});
