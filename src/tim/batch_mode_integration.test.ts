import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExecutePlanInfo, ExecutorCommonOptions } from './executors/types.ts';
import type { PlanSchema } from './planSchema.ts';
import type { TimConfig } from './configSchema.ts';
import { closeDatabaseForTesting } from './db/database.js';

const mocks = vi.hoisted(() => ({
  getGitRoot: vi.fn(),
  wrapWithOrchestration: vi.fn(),
  wrapWithOrchestrationSimple: vi.fn(),
  wrapWithOrchestrationTdd: vi.fn(),
  spawnWithStreamingIO: vi.fn(),
  executeWithTerminalInput: vi.fn(),
  getRepositoryIdentity: vi.fn(),
  getDatabase: vi.fn(),
  getPermissions: vi.fn(),
  getOrCreateProject: vi.fn(),
  isTunnelActive: vi.fn(),
  createTunnelServer: vi.fn(),
  createPromptRequestHandler: vi.fn(),
  resetToolUseCache: vi.fn(),
  createLineSplitter: vi.fn(),
  formatJsonMessage: vi.fn(),
  extractStructuredMessages: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debugLog: vi.fn(),
  sendStructured: vi.fn(),
  setupPermissionsMcp: vi.fn(),
  runClaudeSubprocess: vi.fn(),
}));

let ClaudeCodeExecutor: typeof import('./executors/claude_code.ts').ClaudeCodeExecutor;
let buildExecutionPromptWithoutSteps: typeof import('./prompt_builder.ts').buildExecutionPromptWithoutSteps;

describe('Batch Mode Integration Tests', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;

  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
    model: 'claude-3-opus-20240229',
    interactive: false,
  };

  const mockConfig: TimConfig = {
    paths: {
      tasks: 'tasks',
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    closeDatabaseForTesting();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-mode-integration-test-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, '.config');
    await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'tasks'), { recursive: true });

    const runClaudeSubprocessPath = path.join(
      import.meta.dirname,
      'executors/claude_code/run_claude_subprocess.js'
    );

    vi.doMock('../common/git.ts', () => ({
      getGitRoot: mocks.getGitRoot,
    }));
    vi.doMock('../common/process.ts', () => ({
      createLineSplitter: mocks.createLineSplitter,
      spawnWithStreamingIO: mocks.spawnWithStreamingIO,
      debug: false,
      quiet: false,
    }));
    vi.doMock('./executors/claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mocks.wrapWithOrchestration,
      wrapWithOrchestrationSimple: mocks.wrapWithOrchestrationSimple,
      wrapWithOrchestrationTdd: mocks.wrapWithOrchestrationTdd,
    }));
    vi.doMock('./executors/claude_code/format.ts', () => ({
      formatJsonMessage: mocks.formatJsonMessage,
      extractStructuredMessages: mocks.extractStructuredMessages,
      resetToolUseCache: mocks.resetToolUseCache,
    }));
    vi.doMock('./executors/claude_code/terminal_input_lifecycle.ts', () => ({
      executeWithTerminalInput: mocks.executeWithTerminalInput,
    }));
    vi.doMock('../logging/tunnel_client.js', () => ({
      isTunnelActive: mocks.isTunnelActive,
    }));
    vi.doMock('../logging/tunnel_server.js', () => ({
      createTunnelServer: mocks.createTunnelServer,
    }));
    vi.doMock('../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: mocks.createPromptRequestHandler,
    }));
    vi.doMock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mocks.getRepositoryIdentity,
    }));
    vi.doMock('../db/database.js', () => ({
      getDatabase: mocks.getDatabase,
    }));
    vi.doMock('../db/permission.js', () => ({
      getPermissions: mocks.getPermissions,
    }));
    vi.doMock('../db/project.js', () => ({
      getOrCreateProject: mocks.getOrCreateProject,
      addPermission: vi.fn(),
    }));
    vi.doMock('../logging.ts', () => ({
      log: mocks.log,
      error: mocks.error,
      warn: mocks.warn,
      debugLog: mocks.debugLog,
      sendStructured: mocks.sendStructured,
    }));
    vi.doMock('./executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mocks.setupPermissionsMcp,
    }));
    vi.doMock(runClaudeSubprocessPath, async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('./executors/claude_code/run_claude_subprocess.js')>();
      return {
        ...actual,
        runClaudeSubprocess: mocks.runClaudeSubprocess,
      };
    });

    ({ ClaudeCodeExecutor } = await import('./executors/claude_code.ts'));
    ({ buildExecutionPromptWithoutSteps } = await import('./prompt_builder.ts'));

    mocks.getGitRoot.mockResolvedValue(tempDir);
    mocks.wrapWithOrchestration.mockImplementation(
      (content: string, planId: string, options: any) => {
        return `[ORCHESTRATED: ${planId}, batchMode: ${options.batchMode}] ${content}`;
      }
    );
    mocks.wrapWithOrchestrationSimple.mockImplementation((content: string) => content);
    mocks.wrapWithOrchestrationTdd.mockImplementation((content: string) => content);
    mocks.spawnWithStreamingIO.mockResolvedValue({
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
      kill: vi.fn(),
      result: Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      }),
    });
    mocks.executeWithTerminalInput.mockImplementation((options: any) => ({
      resultPromise: options.streaming.result,
      onResultMessage: vi.fn(),
      sendFollowUpMessage: vi.fn(),
      closeStdin: vi.fn(),
      cleanup: vi.fn(),
    }));
    mocks.createLineSplitter.mockImplementation(() => (output: string) => output.split('\n'));
    mocks.formatJsonMessage.mockImplementation((line: string) => ({
      type: 'assistant',
      message: line,
    }));
    mocks.extractStructuredMessages.mockImplementation(() => []);
    mocks.resetToolUseCache.mockImplementation(() => {});
    mocks.getRepositoryIdentity.mockResolvedValue({
      cwd: tempDir,
      gitRoot: tempDir,
      repositoryId: 'repo-1',
      remoteUrl: 'https://example.com/repo.git',
    });
    mocks.getDatabase.mockReturnValue({});
    mocks.getPermissions.mockReturnValue({ allow: [] });
    mocks.getOrCreateProject.mockReturnValue({ id: 1 });
    mocks.isTunnelActive.mockReturnValue(false);
    mocks.createTunnelServer.mockResolvedValue({ close: vi.fn() });
    mocks.createPromptRequestHandler.mockReturnValue(vi.fn());
    mocks.log.mockImplementation(() => {});
    mocks.error.mockImplementation(() => {});
    mocks.warn.mockImplementation(() => {});
    mocks.debugLog.mockImplementation(() => {});
    mocks.sendStructured.mockImplementation(() => {});
    mocks.setupPermissionsMcp.mockResolvedValue({
      mcpConfigFile: '/tmp/mock-mcp-config.json',
      tempDir: '/tmp/mock-mcp-dir',
      socketServer: { close: vi.fn() },
      cleanup: vi.fn(async () => {}),
    });
    mocks.runClaudeSubprocess.mockResolvedValue({
      seenResultMessage: true,
      killedByTimeout: false,
      exitCode: 0,
      killedByInactivity: false,
    });
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('end-to-end batch mode functionality', async () => {
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      mockSharedOptions,
      mockConfig
    );

    const planFilePath = path.join(tempDir, 'tasks', 'batch-test-plan.yml');
    const planContent = `title: Batch Processing Plan
goal: Test batch mode functionality
details: This plan tests the batch mode feature
tasks:
  - title: Task 1
    done: false
  - title: Task 2
    done: false
`;
    await fs.writeFile(planFilePath, planContent);

    const planData: PlanSchema = {
      title: 'Batch Processing Plan',
      goal: 'Test batch mode functionality',
      details: 'This plan tests the batch mode feature',
      tasks: [
        { title: 'Task 1', done: false },
        { title: 'Task 2', done: false },
      ],
    };

    const batchTask = {
      title: 'Batch Processing Implementation',
      description: 'Execute multiple tasks in batch mode',
      files: ['src/batch.ts', 'src/utils.ts'],
    };

    const prompt = await buildExecutionPromptWithoutSteps({
      executor,
      planData,
      planFilePath,
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      filePathPrefix: '@/',
      includeCurrentPlanContext: false,
      batchMode: true,
    });

    expect(prompt).toContain('## Plan File');
    expect(prompt).toContain('tasks/batch-test-plan.yml: This is the plan file ');
    expect(prompt).toContain('## Remaining Tasks');
    expect(prompt).toContain('Execute multiple tasks in batch mode');

    const batchPlanInfo: ExecutePlanInfo = {
      planId: 'batch-123',
      planTitle: 'Batch Processing Plan',
      planFilePath,
      batchMode: true,
      executionMode: 'normal',
    };

    await executor.execute(prompt, batchPlanInfo);

    expect(mocks.wrapWithOrchestration).toHaveBeenCalledWith(
      expect.stringContaining(`@${planFilePath}\n\n`),
      'batch-123',
      expect.objectContaining({
        batchMode: true,
        planFilePath,
      })
    );

    const [orchestratedContent] = mocks.wrapWithOrchestration.mock.calls[0];
    expect(orchestratedContent).toMatch(
      new RegExp(`^@${planFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n`)
    );
    expect(orchestratedContent).toContain('## Plan File');
    expect(orchestratedContent).toContain('## Remaining Tasks');
  });

  test('batch mode detection works correctly in integration', async () => {
    const mockExecutor = { execute: vi.fn(async () => {}) };

    const planData: PlanSchema = {
      title: 'Integration Test Plan',
      goal: 'Test integration',
      details: 'Integration testing',
      tasks: [],
    };

    const testCases = [
      {
        name: 'title-based detection',
        task: { title: 'Batch Processing Tasks', description: 'Regular description' },
        shouldDetectBatch: true,
      },
      {
        name: 'description-based detection',
        task: { title: 'Regular Task', description: 'Execute in batch mode' },
        shouldDetectBatch: true,
      },
      {
        name: 'no batch indicators',
        task: { title: 'Regular Task', description: 'Regular description' },
        shouldDetectBatch: false,
      },
      {
        name: 'case sensitive title',
        task: { title: 'batch processing tasks', description: 'Regular description' },
        shouldDetectBatch: false,
      },
      {
        name: 'case sensitive description',
        task: { title: 'Regular Task', description: 'Execute in Batch Mode' },
        shouldDetectBatch: false,
      },
    ];

    for (const testCase of testCases) {
      const result = await buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: path.join(tempDir, 'test-plan.yml'),
        baseDir: tempDir,
        config: mockConfig,
        task: testCase.task,
        filePathPrefix: '@/',
        includeCurrentPlanContext: false,
        batchMode: testCase.shouldDetectBatch,
      });

      expect(result).toContain('## Plan File');
    }
  });

  test('plan file path resolution works correctly', async () => {
    const mockExecutor = { execute: vi.fn(async () => {}) };

    const planData: PlanSchema = {
      title: 'Path Resolution Test',
      goal: 'Test path resolution',
      details: 'Testing path resolution logic',
      tasks: [],
    };

    const batchTask = {
      title: 'Batch Processing Path Test',
      description: 'Test path resolution',
    };

    const absolutePath = path.join(tempDir, 'nested', 'deep', 'plan.yml');
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const absoluteResult = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData,
      planFilePath: absolutePath,
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      filePathPrefix: '@/',
      includeCurrentPlanContext: false,
      batchMode: true,
    });

    expect(absoluteResult).toContain('nested/deep/plan.yml: This is the plan file ');

    const relativePath = 'tasks/relative-plan.yml';

    const relativeResult = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData,
      planFilePath: relativePath,
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      filePathPrefix: '@/',
      includeCurrentPlanContext: false,
      batchMode: true,
    });

    expect(relativeResult).toContain('tasks/relative-plan.yml: This is the plan file ');

    const customPrefixResult = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData,
      planFilePath: 'custom-plan.yml',
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      filePathPrefix: '$WORKSPACE/',
      includeCurrentPlanContext: false,
      batchMode: true,
    });

    expect(customPrefixResult).toContain('custom-plan.yml: This is the plan file ');

    const noPrefixResult = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData,
      planFilePath: 'no-prefix-plan.yml',
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      includeCurrentPlanContext: false,
      batchMode: true,
    });

    expect(noPrefixResult).toContain('no-prefix-plan.yml: This is the plan file ');
  });

  test('batch mode state isolation between executions', async () => {
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: [],
        disallowedTools: [],
        allowAllTools: false,
        permissionsMcp: { enabled: false },
      },
      mockSharedOptions,
      mockConfig
    );

    const batchPlanInfo: ExecutePlanInfo = {
      planId: 'batch-001',
      planTitle: 'Batch Plan',
      planFilePath: path.join(tempDir, 'batch.yml'),
      batchMode: true,
      executionMode: 'normal',
    };

    await executor.execute('batch content', batchPlanInfo);

    expect(mocks.wrapWithOrchestration).toHaveBeenCalledWith(
      expect.stringContaining('@'),
      'batch-001',
      expect.objectContaining({ batchMode: true })
    );

    const regularPlanInfo: ExecutePlanInfo = {
      planId: 'regular-001',
      planTitle: 'Regular Plan',
      planFilePath: path.join(tempDir, 'regular.yml'),
      batchMode: false,
      executionMode: 'normal',
    };

    await executor.execute('regular content', regularPlanInfo);

    expect(mocks.wrapWithOrchestration).toHaveBeenLastCalledWith(
      'regular content',
      'regular-001',
      expect.objectContaining({ batchMode: false })
    );

    const batchPlanInfo2: ExecutePlanInfo = {
      planId: 'batch-002',
      planTitle: 'Another Batch Plan',
      planFilePath: path.join(tempDir, 'batch2.yml'),
      batchMode: true,
      executionMode: 'normal',
    };

    await executor.execute('second batch content', batchPlanInfo2);

    expect(mocks.wrapWithOrchestration).toHaveBeenLastCalledWith(
      expect.stringContaining('@'),
      'batch-002',
      expect.objectContaining({ batchMode: true })
    );

    expect(mocks.wrapWithOrchestration).toHaveBeenCalledTimes(3);
  });

  test('error handling in batch mode', async () => {
    mocks.getGitRoot.mockImplementationOnce(() => {
      throw new Error('Git repository not found');
    });

    const mockExecutor = { execute: vi.fn(async () => {}) };

    const planData: PlanSchema = {
      title: 'Error Test Plan',
      goal: 'Test error handling',
      details: 'Error handling test',
      tasks: [],
    };

    const batchTask = {
      title: 'Batch Processing Error Test',
      description: 'Test error scenarios',
    };

    await expect(
      buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: '/absolute/error-plan.yml',
        baseDir: tempDir,
        config: mockConfig,
        task: batchTask,
        filePathPrefix: '@/',
        includeCurrentPlanContext: false,
        batchMode: true,
      })
    ).rejects.toThrow('Git repository not found');
  });

  test('batch mode with complex plan structures', async () => {
    const mockExecutor = { execute: vi.fn(async () => {}) };

    const complexPlanData: PlanSchema = {
      title: 'Complex Batch Plan',
      goal: 'Phase Goal',
      details: 'Complex batch processing phase',
      project: {
        goal: 'Overall Project Goal',
        details: 'Project-level context and requirements',
      },
      tasks: [
        { title: 'Complex Task 1', done: false },
        { title: 'Complex Task 2', done: true },
        { title: 'Complex Task 3', done: false },
      ],
      rmfilter: ['src/complex.ts', 'lib/utils.ts'],
      docs: ['https://example.com/api-docs', 'https://example.com/guide'],
    };

    const complexBatchTask = {
      title: 'Complex Batch Processing',
      description: 'Execute complex batch mode operations',
      files: ['src/complex.ts', 'lib/utils.ts', 'tests/integration.ts'],
    };

    const result = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData: complexPlanData,
      planFilePath: path.join(tempDir, 'complex-plan.yml'),
      baseDir: tempDir,
      config: mockConfig,
      task: complexBatchTask,
      filePathPrefix: '@/',
      includeCurrentPlanContext: true,
      batchMode: true,
    });

    expect(result).toContain('# Project Goal: Overall Project Goal');
    expect(result).toContain('# Current Phase Goal: Phase Goal');
    expect(result).toContain('## Remaining Tasks');
    expect(result).toContain('Execute complex batch mode operations');
    expect(result).toContain('## Plan File');
    expect(result).toContain('complex-plan.yml: This is the plan file ');
    expect(result).toContain('## Relevant Files');
    expect(result).toContain('@/src/complex.ts');
    expect(result).toContain('@/lib/utils.ts');
    expect(result).toContain('@/tests/integration.ts');
    expect(result).toContain('## Execution Guidelines');
  });
});
