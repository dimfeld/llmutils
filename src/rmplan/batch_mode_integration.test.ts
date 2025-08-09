import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeExecutor } from './executors/claude_code.ts';
import { buildExecutionPromptWithoutSteps } from './prompt_builder.ts';
import type { ExecutePlanInfo, ExecutorCommonOptions } from './executors/types.ts';
import type { PlanSchema } from './planSchema.ts';
import type { RmplanConfig } from './configSchema.ts';
import { ModuleMocker } from '../testing.js';

describe('Batch Mode Integration Tests', () => {
  let tempDir: string;
  let moduleMocker: ModuleMocker;

  const mockSharedOptions: ExecutorCommonOptions = {
    baseDir: '/test/base',
    model: 'claude-3-opus-20240229',
    interactive: false,
  };

  const mockConfig: RmplanConfig = {
    paths: {
      tasks: 'tasks',
    },
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-mode-integration-test-'));
    // Create a .git directory to make it a git repo
    await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'tasks'), { recursive: true });

    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  test('end-to-end batch mode functionality', async () => {
    // Set up mocks for executor dependencies
    await moduleMocker.mock('../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    await moduleMocker.mock('./executors/claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => line),
    }));

    const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
      return `[ORCHESTRATED: ${planId}, batchMode: ${options.batchMode}] ${content}`;
    });

    await moduleMocker.mock('./executors/claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mockWrapWithOrchestration,
    }));

    // Create executor
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

    // Create plan file
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

    // Create plan data
    const planData: PlanSchema = {
      title: 'Batch Processing Plan',
      goal: 'Test batch mode functionality',
      details: 'This plan tests the batch mode feature',
      tasks: [
        { title: 'Task 1', done: false },
        { title: 'Task 2', done: false }
      ],
    };

    // Create batch task
    const batchTask = {
      title: 'Batch Processing Implementation',
      description: 'Execute multiple tasks in batch mode',
      files: ['src/batch.ts', 'src/utils.ts'],
    };

    // Build prompt with batch mode
    const prompt = await buildExecutionPromptWithoutSteps({
      executor: executor,
      planData,
      planFilePath,
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      filePathPrefix: '@/',
      includeCurrentPlanContext: false,
    });

    // Verify prompt includes batch mode plan file reference
    expect(prompt).toContain('## Plan File for Task Updates');
    expect(prompt).toContain('@/tasks/batch-test-plan.yml: This is the plan file you must edit to mark tasks as done after completing them.');
    expect(prompt).toContain('## Task: Batch Processing Implementation');
    expect(prompt).toContain('Execute multiple tasks in batch mode');

    // Create plan info for batch mode
    const batchPlanInfo: ExecutePlanInfo = {
      planId: 'batch-123',
      planTitle: 'Batch Processing Plan',
      planFilePath,
      batchMode: true,
    };

    // Execute with batch mode
    await executor.execute(prompt, batchPlanInfo);

    // Verify orchestration was called with batch mode context
    expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
      expect.stringContaining(`@${planFilePath}\n\n`),
      'batch-123',
      {
        batchMode: true,
        planFilePath,
      }
    );

    // Verify the content passed to orchestration includes the plan file reference
    const [orchestratedContent] = mockWrapWithOrchestration.mock.calls[0];
    expect(orchestratedContent).toMatch(new RegExp(`^@${planFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n`));
    expect(orchestratedContent).toContain('## Plan File for Task Updates');
    expect(orchestratedContent).toContain('## Task: Batch Processing Implementation');
  });

  test('batch mode detection works correctly in integration', async () => {
    // Set up basic mocks
    await moduleMocker.mock('../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    const mockExecutor = { execute: mock(async () => {}) };

    const planData: PlanSchema = {
      title: 'Integration Test Plan',
      goal: 'Test integration',
      details: 'Integration testing',
      tasks: [],
    };

    // Test different batch mode detection scenarios
    const testCases = [
      {
        name: 'title-based detection',
        task: { title: 'Batch Processing Tasks', description: 'Regular description' },
        shouldDetectBatch: true
      },
      {
        name: 'description-based detection',
        task: { title: 'Regular Task', description: 'Execute in batch mode' },
        shouldDetectBatch: true
      },
      {
        name: 'no batch indicators',
        task: { title: 'Regular Task', description: 'Regular description' },
        shouldDetectBatch: false
      },
      {
        name: 'case sensitive title',
        task: { title: 'batch processing tasks', description: 'Regular description' },
        shouldDetectBatch: false
      },
      {
        name: 'case sensitive description',
        task: { title: 'Regular Task', description: 'Execute in Batch Mode' },
        shouldDetectBatch: false
      }
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
      });

      if (testCase.shouldDetectBatch) {
        expect(result, `${testCase.name} should detect batch mode`).toContain('## Plan File for Task Updates');
      } else {
        expect(result, `${testCase.name} should not detect batch mode`).not.toContain('## Plan File for Task Updates');
      }
    }
  });

  test('plan file path resolution works correctly', async () => {
    // Set up git mock
    await moduleMocker.mock('../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    const mockExecutor = { execute: mock(async () => {}) };

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

    // Test absolute path
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
    });

    expect(absoluteResult).toContain('@/nested/deep/plan.yml: This is the plan file you must edit');

    // Test relative path
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
    });

    expect(relativeResult).toContain('@/tasks/relative-plan.yml: This is the plan file you must edit');

    // Test different prefixes
    const customPrefixResult = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData,
      planFilePath: 'custom-plan.yml',
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      filePathPrefix: '$WORKSPACE/',
      includeCurrentPlanContext: false,
    });

    expect(customPrefixResult).toContain('$WORKSPACE/custom-plan.yml: This is the plan file you must edit');

    // Test no prefix
    const noPrefixResult = await buildExecutionPromptWithoutSteps({
      executor: mockExecutor,
      planData,
      planFilePath: 'no-prefix-plan.yml',
      baseDir: tempDir,
      config: mockConfig,
      task: batchTask,
      // filePathPrefix intentionally omitted
      includeCurrentPlanContext: false,
    });

    expect(noPrefixResult).toContain('no-prefix-plan.yml: This is the plan file you must edit');
  });

  test('batch mode state isolation between executions', async () => {
    // Set up mocks for executor
    await moduleMocker.mock('../common/process.ts', () => ({
      spawnAndLogOutput: mock(() => Promise.resolve({ exitCode: 0 })),
      createLineSplitter: mock(() => (output: string) => output.split('\n')),
      debug: false,
    }));

    await moduleMocker.mock('../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    await moduleMocker.mock('./executors/claude_code/format.ts', () => ({
      formatJsonMessage: mock((line: string) => line),
    }));

    const mockWrapWithOrchestration = mock((content: string, planId: string, options: any) => {
      return content; // Return content as-is to verify isolation
    });

    await moduleMocker.mock('./executors/claude_code/orchestrator_prompt.ts', () => ({
      wrapWithOrchestration: mockWrapWithOrchestration,
    }));

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

    // First execution: batch mode
    const batchPlanInfo: ExecutePlanInfo = {
      planId: 'batch-001',
      planTitle: 'Batch Plan',
      planFilePath: path.join(tempDir, 'batch.yml'),
      batchMode: true,
    };

    await executor.execute('batch content', batchPlanInfo);

    // Verify batch mode execution
    expect(mockWrapWithOrchestration).toHaveBeenCalledWith(
      expect.stringContaining('@'),
      'batch-001',
      expect.objectContaining({ batchMode: true })
    );

    // Second execution: regular mode
    const regularPlanInfo: ExecutePlanInfo = {
      planId: 'regular-001',
      planTitle: 'Regular Plan',
      planFilePath: path.join(tempDir, 'regular.yml'),
      batchMode: false,
    };

    await executor.execute('regular content', regularPlanInfo);

    // Verify regular mode execution does not include @ prefix
    expect(mockWrapWithOrchestration).toHaveBeenLastCalledWith(
      'regular content', // Should not contain @ prefix
      'regular-001',
      expect.objectContaining({ batchMode: false })
    );

    // Third execution: batch mode again
    const batchPlanInfo2: ExecutePlanInfo = {
      planId: 'batch-002',
      planTitle: 'Another Batch Plan',
      planFilePath: path.join(tempDir, 'batch2.yml'),
      batchMode: true,
    };

    await executor.execute('second batch content', batchPlanInfo2);

    // Verify batch mode works again
    expect(mockWrapWithOrchestration).toHaveBeenLastCalledWith(
      expect.stringContaining('@'),
      'batch-002',
      expect.objectContaining({ batchMode: true })
    );

    // Verify all executions were independent
    expect(mockWrapWithOrchestration).toHaveBeenCalledTimes(3);
  });

  test('error handling in batch mode', async () => {
    // Mock git root to throw error
    await moduleMocker.mock('../common/git.ts', () => ({
      getGitRoot: mock(() => {
        throw new Error('Git repository not found');
      }),
    }));

    const mockExecutor = { execute: mock(async () => {}) };

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

    // Should handle git root error gracefully by throwing
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
      })
    ).rejects.toThrow('Git repository not found');
  });

  test('batch mode with complex plan structures', async () => {
    // Set up mocks
    await moduleMocker.mock('../common/git.ts', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    const mockExecutor = { execute: mock(async () => {}) };

    // Complex plan with project context
    const complexPlanData: PlanSchema = {
      title: 'Complex Batch Plan',
      goal: 'Phase Goal',
      details: 'Complex batch processing phase',
      project: {
        goal: 'Overall Project Goal',
        details: 'Project-level context and requirements'
      },
      tasks: [
        { title: 'Complex Task 1', done: false },
        { title: 'Complex Task 2', done: true },
        { title: 'Complex Task 3', done: false }
      ],
      rmfilter: ['src/complex.ts', 'lib/utils.ts'],
      docs: ['https://example.com/api-docs', 'https://example.com/guide']
    };

    const complexBatchTask = {
      title: 'Complex Batch Processing',
      description: 'Execute complex batch mode operations',
      files: ['src/complex.ts', 'lib/utils.ts', 'tests/integration.ts']
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
    });

    // Verify all components are included
    expect(result).toContain('# Project Goal: Overall Project Goal');
    expect(result).toContain('# Current Phase Goal: Phase Goal');
    expect(result).toContain('## Task: Complex Batch Processing');
    expect(result).toContain('Execute complex batch mode operations');
    expect(result).toContain('## Plan File for Task Updates');
    expect(result).toContain('@/complex-plan.yml: This is the plan file you must edit');
    expect(result).toContain('## Relevant Files');
    expect(result).toContain('@/src/complex.ts');
    expect(result).toContain('@/lib/utils.ts');
    expect(result).toContain('@/tests/integration.ts');
    expect(result).toContain('## Execution Guidelines');
  });
});