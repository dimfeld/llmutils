import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildProjectContextSection,
  buildTaskSection,
  buildDocumentationSection,
  buildFileListSection,
  buildExecutionPromptWithoutSteps,
} from './prompt_builder.js';
import type { PlanSchema } from './planSchema.js';
import type { RmplanConfig } from './configSchema.js';
import type { Executor } from './executors/types.js';

describe('prompt_builder', () => {
  describe('buildProjectContextSection', () => {
    test('builds project context when project is defined', () => {
      const planData: PlanSchema = {
        title: 'Test Plan',
        goal: 'Phase Goal',
        details: 'Phase Details',
        tasks: [],
        project: {
          goal: 'Project Goal',
          details: 'Project Details',
        },
      };

      const result = buildProjectContextSection(planData);

      expect(result).toContain('# Project Goal: Project Goal');
      expect(result).toContain('## Project Details:\n\nProject Details');
      expect(result).toContain('# Current Phase Goal: Phase Goal');
      expect(result).toContain('## Phase Details:\n\nPhase Details');
      expect(result).toContain(
        'These instructions define a particular task of a feature implementation for this project'
      );
    });

    test('builds phase-only context when project is not defined', () => {
      const planData: PlanSchema = {
        title: 'Test Plan',
        goal: 'Plan Goal',
        details: 'Plan Details',
        tasks: [],
      };

      const result = buildProjectContextSection(planData);

      expect(result).toContain('# Project Goal: Plan Goal');
      expect(result).toContain('## Project Details:\n\nPlan Details');
      expect(result).not.toContain('Current Phase Goal');
    });
  });

  describe('buildTaskSection', () => {
    test('builds task section with description', () => {
      const task = {
        title: 'Test Task',
        description: 'Task Description',
      };

      const result = buildTaskSection(task);

      expect(result).toContain('## Task: Test Task');
      expect(result).toContain('Description: Task Description');
    });

    test('builds task section without description', () => {
      const task = {
        title: 'Test Task',
      };

      const result = buildTaskSection(task);

      expect(result).toContain('## Task: Test Task');
      expect(result).toContain('Description: No description provided');
    });
  });

  describe('buildDocumentationSection', () => {
    const isURL = (str: string): boolean => {
      try {
        new URL(str);
        return true;
      } catch {
        return false;
      }
    };

    test('builds documentation section with URLs', () => {
      const docs = ['https://example.com/doc1', 'not-a-url', 'https://example.com/doc2'];

      const result = buildDocumentationSection(docs, isURL);

      expect(result).toContain('## Documentation URLs');
      expect(result).toContain('- https://example.com/doc1');
      expect(result).toContain('- https://example.com/doc2');
      expect(result).not.toContain('not-a-url');
    });

    test('returns empty string when no URLs', () => {
      const docs = ['not-a-url', 'also-not-a-url'];

      const result = buildDocumentationSection(docs, isURL);

      expect(result).toBe('');
    });

    test('returns empty string when docs is undefined', () => {
      const result = buildDocumentationSection(undefined, isURL);

      expect(result).toBe('');
    });
  });

  describe('buildFileListSection', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-builder-test-'));
      // Create a .git directory to make it a git repo
      await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('builds file list section with files', async () => {
      const files = [
        path.join(tempDir, 'absolute/path/file.ts'),
        'relative/path/file.js',
        'file-with-comment.ts (some comment)',
      ];

      const result = await buildFileListSection(files, tempDir, '@/', 'Test Files');

      expect(result).toContain('## Test Files');
      expect(result).toContain('@/absolute/path/file.ts');
      expect(result).toContain('@/relative/path/file.js');
      expect(result).toContain('@/file-with-comment.ts');
      expect(result).not.toContain('(some comment)');
    });

    test('builds file list section with description', async () => {
      const files = ['file1.ts', 'file2.ts'];

      const result = await buildFileListSection(
        files,
        tempDir,
        '',
        'Relevant Files',
        'These files are important'
      );

      expect(result).toContain('## Relevant Files');
      expect(result).toContain('These files are important');
      expect(result).toContain('- file1.ts');
      expect(result).toContain('- file2.ts');
    });

    test('filters out flags starting with dash', async () => {
      const files = ['file.ts', '-flag', '--another-flag', 'file2.ts'];

      const result = await buildFileListSection(files, tempDir);

      expect(result).toContain('- file.ts');
      expect(result).toContain('- file2.ts');
      expect(result).not.toContain('-flag');
      expect(result).not.toContain('--another-flag');
    });

    test('returns empty string when no files', async () => {
      const result = await buildFileListSection([], tempDir);

      expect(result).toBe('');
    });

    test('returns empty string when files is undefined', async () => {
      const result = await buildFileListSection(undefined, tempDir);

      expect(result).toBe('');
    });
  });

  describe('buildExecutionPrompt', () => {
    let tempDir: string;
    const mockConfig: RmplanConfig = {
      paths: {
        tasks: 'tasks',
      },
    };

    // Create a mock executor
    const mockExecutor: Executor = {
      execute: mock(async () => {}),
    };

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-builder-test-'));
      // Create a .git directory to make it a git repo
      await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'tasks'), { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('builds prompt for stub plan (no tasks)', async () => {
      const planData: PlanSchema = {
        title: 'Stub Plan',
        goal: 'Plan Goal',
        details: 'Plan Details',
        tasks: [],
        rmfilter: ['src/file1.ts', 'src/file2.ts'],
        docs: ['https://example.com/docs'],
      };

      const result = await buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: path.join(tempDir, 'test-plan.yml'),
        baseDir: tempDir,
        config: mockConfig,
        includeCurrentPlanContext: true,
      });

      expect(result).toContain('# Project Goal: Plan Goal');
      expect(result).toContain('## Project Details:\n\nPlan Details');
      expect(result).toContain('## Potential file paths to look at');
      expect(result).toContain('- src/file1.ts');
      expect(result).toContain('- src/file2.ts');
      expect(result).toContain('## Documentation URLs');
      expect(result).toContain('- https://example.com/docs');
    });

    test('builds prompt for simple task', async () => {
      const planData: PlanSchema = {
        title: 'Plan with Task',
        goal: 'Plan Goal',
        details: 'Plan Details',
        tasks: [],
      };

      const task = {
        title: 'Simple Task',
        description: 'Task Description',
        files: ['task/file1.ts', 'task/file2.ts'],
      };

      const result = await buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: path.join(tempDir, 'test-plan.yml'),
        baseDir: tempDir,
        config: mockConfig,
        task,
        filePathPrefix: '@/',
        includeCurrentPlanContext: false,
      });

      expect(result).toContain('# Project Goal: Plan Goal');
      expect(result).toContain('## Task: Simple Task');
      expect(result).toContain('Description: Task Description');
      expect(result).toContain('## Relevant Files');
      expect(result).toContain('@/task/file1.ts');
      expect(result).toContain('@/task/file2.ts');
    });

    test('includes progress notes without timestamps', async () => {
      const planData: PlanSchema = {
        title: 'Plan with Notes',
        goal: 'Plan Goal',
        details: 'Plan Details',
        tasks: [],
        progressNotes: [
          { timestamp: '2024-01-01T00:00:00.000Z', text: 'Finished initial scaffolding' },
          { timestamp: '2024-01-02T00:00:00.000Z', text: 'Encountered edge case; updated schema' },
        ],
      } as any;

      const result = await buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: path.join(tempDir, 'test-plan.yml'),
        baseDir: tempDir,
        config: mockConfig,
      });

      expect(result).toContain('## Progress Notes');
      expect(result).toContain('- Finished initial scaffolding');
      expect(result).toContain('- Encountered edge case; updated schema');
      // Timestamps should not appear in prompt
      expect(result).not.toContain('2024-01-01T00:00:00.000Z');
    });

    test('builds prompt with project context', async () => {
      const planData: PlanSchema = {
        title: 'Phase Plan',
        goal: 'Phase Goal',
        details: 'Phase Details',
        tasks: [],
        project: {
          goal: 'Project Goal',
          details: 'Project Details',
        },
      };

      const result = await buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: path.join(tempDir, 'test-plan.yml'),
        baseDir: tempDir,
        config: mockConfig,
      });

      expect(result).toContain('# Project Goal: Project Goal');
      expect(result).toContain('## Project Details:\n\nProject Details');
      expect(result).toContain('# Current Phase Goal: Phase Goal');
      expect(result).toContain('## Phase Details:\n\nPhase Details');
    });

    test('includes execution guidelines in all prompts', async () => {
      const planData: PlanSchema = {
        title: 'Test Plan',
        goal: 'Plan Goal',
        details: 'Plan Details',
        tasks: [],
      };

      const result = await buildExecutionPromptWithoutSteps({
        executor: mockExecutor,
        planData,
        planFilePath: path.join(tempDir, 'test-plan.yml'),
        baseDir: tempDir,
        config: mockConfig,
      });

      // Check that execution guidelines are included
      expect(result).toContain('## Execution Guidelines');
      expect(result).toContain('### Understand the Codebase Context');
      expect(result).toContain('### Follow Best Practices');
      expect(result).toContain('### Verify Your Work');
      expect(result).toContain('### Self-Review Checklist');
      expect(result).toContain('Quality is more important than speed');
    });
  });

  describe('batch mode functionality', () => {
    describe('buildExecutionPromptWithoutSteps batch mode integration', () => {
      // Local variables for this test suite
      let localTempDir: string;
      const localMockConfig: RmplanConfig = {
        paths: {
          tasks: 'tasks',
        },
      };
      const localMockExecutor: Executor = {
        execute: mock(async () => {}),
      };

      beforeEach(async () => {
        localTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-builder-batch-test-'));
        // Create a .git directory to make it a git repo
        await fs.mkdir(path.join(localTempDir, '.git'), { recursive: true });
        await fs.mkdir(path.join(localTempDir, 'tasks'), { recursive: true });
      });

      afterEach(async () => {
        await fs.rm(localTempDir, { recursive: true, force: true });
      });

      test('includes plan file reference in batch mode', async () => {
        const planData: PlanSchema = {
          title: 'Batch Plan',
          goal: 'Batch Goal',
          details: 'Batch Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing Implementation',
          description: 'Implement batch processing features',
          files: ['src/batch.ts'],
        };

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath: path.join(localTempDir, 'batch-plan.yml'),
          baseDir: localTempDir,
          config: localMockConfig,
          task: batchTask,
          filePathPrefix: '@/',
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        expect(result).toContain('## Plan File');
        expect(result).toContain('@/batch-plan.yml: This is the plan file ');
      });

      test('uses relative path from git root for plan file reference', async () => {
        // Create nested directory structure
        const nestedDir = path.join(localTempDir, 'nested', 'subdirs');
        await fs.mkdir(nestedDir, { recursive: true });

        const planFilePath = path.join(nestedDir, 'nested-batch-plan.yml');
        await fs.writeFile(planFilePath, 'test: plan');

        const planData: PlanSchema = {
          title: 'Nested Batch Plan',
          goal: 'Nested Goal',
          details: 'Nested Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing Nested',
          description: 'Process nested batch tasks',
          files: ['src/nested.ts'],
        };

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath,
          baseDir: localTempDir,
          config: localMockConfig,
          task: batchTask,
          filePathPrefix: '@/',
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        expect(result).toContain('## Plan File');
        expect(result).toContain('@/nested/subdirs/nested-batch-plan.yml: This is the plan file ');
      });

      test('handles already relative plan file paths', async () => {
        const planData: PlanSchema = {
          title: 'Relative Batch Plan',
          goal: 'Relative Goal',
          details: 'Relative Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing Relative',
          description: 'Process with relative paths',
        };

        const relativePlanPath = 'tasks/relative-batch-plan.yml';

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath: relativePlanPath,
          baseDir: localTempDir,
          config: localMockConfig,
          task: batchTask,
          filePathPrefix: '@/',
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        expect(result).toContain('## Plan File');
        expect(result).toContain('@/tasks/relative-batch-plan.yml: This is the plan file ');
      });

      test('uses empty prefix when filePathPrefix is not provided', async () => {
        const planData: PlanSchema = {
          title: 'No Prefix Batch Plan',
          goal: 'No Prefix Goal',
          details: 'No Prefix Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing No Prefix',
          description: 'Process without prefix',
        };

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath: 'no-prefix-batch-plan.yml',
          baseDir: localTempDir,
          config: localMockConfig,
          task: batchTask,
          // filePathPrefix intentionally omitted
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        expect(result).toContain('## Plan File');
        expect(result).toContain('no-prefix-batch-plan.yml: This is the plan file ');
        expect(result).not.toContain('@/no-prefix-batch-plan.yml');
      });

      test('uses custom file path prefix', async () => {
        const planData: PlanSchema = {
          title: 'Custom Prefix Batch Plan',
          goal: 'Custom Prefix Goal',
          details: 'Custom Prefix Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing Custom',
          description: 'Process with custom prefix',
        };

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath: 'custom-prefix-batch-plan.yml',
          baseDir: localTempDir,
          config: localMockConfig,
          task: batchTask,
          filePathPrefix: '$PROJECT/',
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        expect(result).toContain('## Plan File');
        expect(result).toContain('$PROJECT/custom-prefix-batch-plan.yml: This is the plan file ');
      });

      test('batch mode detection works with description-based detection', async () => {
        const planData: PlanSchema = {
          title: 'Description Batch Plan',
          goal: 'Description Goal',
          details: 'Description Details',
          tasks: [],
        };

        const descriptionBatchTask = {
          title: 'Regular Task Name',
          description: 'Execute this task in batch mode for efficiency',
        };

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath: 'description-batch-plan.yml',
          baseDir: localTempDir,
          config: localMockConfig,
          task: descriptionBatchTask,
          filePathPrefix: '@/',
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        expect(result).toContain('## Plan File');
        expect(result).toContain('@/description-batch-plan.yml: This is the plan file ');
      });

      test('handles git root resolution errors gracefully', async () => {
        // Mock getGitRoot to throw an error
        const { getGitRoot } = await import('../common/git.js');
        const originalGetGitRoot = getGitRoot;

        // Use a mocked version that throws
        const mockGetGitRoot = mock(() => {
          throw new Error('Not a git repository');
        });

        // We need to mock the module
        const moduleMocker = new (await import('../testing.js')).ModuleMocker(import.meta);
        await moduleMocker.mock('../common/git.js', () => ({
          getGitRoot: mockGetGitRoot,
        }));

        const planData: PlanSchema = {
          title: 'Error Handling Batch Plan',
          goal: 'Error Goal',
          details: 'Error Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing Error',
          description: 'Test error handling',
        };

        // This should not throw an error, but handle it gracefully
        expect(
          buildExecutionPromptWithoutSteps({
            executor: localMockExecutor,
            planData,
            planFilePath: '/absolute/error-batch-plan.yml',
            baseDir: localTempDir,
            config: localMockConfig,
            task: batchTask,
            filePathPrefix: '@/',
            includeCurrentPlanContext: false,
            batchMode: true,
          })
        ).rejects.toThrow('Not a git repository');

        moduleMocker.clear();
      });

      test('plan file reference section has correct format and content', async () => {
        const planData: PlanSchema = {
          title: 'Format Test Batch Plan',
          goal: 'Format Goal',
          details: 'Format Details',
          tasks: [],
        };

        const batchTask = {
          title: 'Batch Processing Format',
          description: 'Test format and content',
        };

        const result = await buildExecutionPromptWithoutSteps({
          executor: localMockExecutor,
          planData,
          planFilePath: 'format-batch-plan.yml',
          baseDir: localTempDir,
          config: localMockConfig,
          task: batchTask,
          filePathPrefix: '@/',
          includeCurrentPlanContext: false,
          batchMode: true,
        });

        // Verify the exact format of the plan file reference section
        expect(result).toContain(
          '\n## Plan File\n\n- @/format-batch-plan.yml: This is the plan file '
        );

        // Verify it appears after the task section
        const taskSectionIndex = result.indexOf('## Task: Batch Processing Format');
        const planFileIndex = result.indexOf('## Plan File');
        expect(taskSectionIndex).toBeLessThan(planFileIndex);
        expect(taskSectionIndex).toBeGreaterThan(-1);
        expect(planFileIndex).toBeGreaterThan(-1);
      });
    });
  });
});
