import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildProjectContextSection,
  buildTaskSection,
  buildDocumentationSection,
  buildFileListSection,
  buildExecutionPrompt,
} from './prompt_builder.js';
import type { PlanSchema } from './planSchema.js';
import type { RmplanConfig } from './configSchema.js';

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

      const result = await buildExecutionPrompt({
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

      const result = await buildExecutionPrompt({
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

      const result = await buildExecutionPrompt({
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
  });
});
