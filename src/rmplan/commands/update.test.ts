import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const warnSpy = mock(() => {});

// Mock process spawn
const mockLogSpawn = mock(() => ({
  exited: Promise.resolve(0),
}));

// Mock prompt generation functions
const mockConvertYamlToMarkdown = mock(() => '# Test Plan\n## Goal\nTest goal');
const mockGenerateUpdatePrompt = mock(() => 'Update prompt content');

describe('handleUpdateCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let handleUpdateCommand: any;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    mockLogSpawn.mockClear();
    mockConvertYamlToMarkdown.mockClear();
    mockGenerateUpdatePrompt.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-update-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock all modules before importing
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: mockLogSpawn,
    }));

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
    }));

    await moduleMocker.mock('../prompt.js', () => ({
      generateUpdatePrompt: mockGenerateUpdatePrompt,
    }));

    // Import the module after all mocks are set up
    const updateModule = await import('./update.js');
    handleUpdateCommand = updateModule.handleUpdateCommand;
  });

  afterEach(async () => {
    // Clear mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('should use description from command line when provided', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          files: [],
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const testDescription = 'Add authentication feature to the plan';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call the update command
    await handleUpdateCommand('1', options, command);

    // Verify that log was called with update description
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Update description: Add authentication feature to the plan')
    );

    // Verify the conversion and prompt generation were called
    expect(mockConvertYamlToMarkdown).toHaveBeenCalled();
    expect(mockGenerateUpdatePrompt).toHaveBeenCalledWith(
      '# Test Plan\n## Goal\nTest goal',
      testDescription
    );
  });

  test('should open editor when description not provided', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock Bun.write and Bun.file for temp file operations
    const editorContent = 'Update plan to include database migrations';
    let tempFilePath: string = '';
    const originalWrite = Bun.write;
    const originalFile = Bun.file;

    // @ts-ignore - Override Bun methods for testing
    Bun.write = mock(async (path: string, content: string) => {
      if (path.includes('rmplan-update-desc-')) {
        tempFilePath = path;
        return { size: 0 };
      }
      return originalWrite(path, content);
    });

    // @ts-ignore - Override Bun methods for testing
    Bun.file = mock((path: string) => {
      if (path === tempFilePath) {
        return {
          text: async () => editorContent,
          unlink: async () => {},
        };
      }
      return originalFile(path);
    });

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    try {
      // Call the update command
      await handleUpdateCommand('1', options, command);

      // Verify editor was opened
      expect(mockLogSpawn).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.any(String),
          expect.stringContaining('rmplan-update-desc-'),
        ]),
        expect.objectContaining({ stdio: ['inherit', 'inherit', 'inherit'] })
      );

      // Verify that log was called with update description
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Update description: Update plan to include database migrations')
      );
    } finally {
      // Restore original Bun methods
      // @ts-ignore
      Bun.write = originalWrite;
      // @ts-ignore
      Bun.file = originalFile;
    }
  });

  test('should handle empty editor content', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock Bun.write and Bun.file for temp file operations
    let tempFilePath: string = '';
    const originalWrite = Bun.write;
    const originalFile = Bun.file;

    // @ts-ignore - Override Bun methods for testing
    Bun.write = mock(async (path: string, content: string) => {
      if (path.includes('rmplan-update-desc-')) {
        tempFilePath = path;
        return { size: 0 };
      }
      return originalWrite(path, content);
    });

    // @ts-ignore - Override Bun methods for testing
    Bun.file = mock((path: string) => {
      if (path === tempFilePath) {
        return {
          text: async () => '', // Empty content
          unlink: async () => {},
        };
      }
      return originalFile(path);
    });

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    try {
      // Call the update command - should throw error
      await expect(handleUpdateCommand('1', options, command)).rejects.toThrow(
        'No update description was provided from the editor.'
      );
    } finally {
      // Restore original Bun methods
      // @ts-ignore
      Bun.write = originalWrite;
      // @ts-ignore
      Bun.file = originalFile;
    }
  });

  test('should generate update prompt with plan data and rmfilter options', async () => {
    // Create a test plan with rmfilter and docs
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          files: [],
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
      rmfilter: ['src/**/*.ts'],
      docs: ['README.md'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const testDescription = 'Add authentication feature';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call the update command
    await handleUpdateCommand('1', options, command);

    // Verify that rmfilter was called with correct arguments
    expect(mockLogSpawn).toHaveBeenCalledWith(
      expect.arrayContaining([
        'rmfilter',
        'src/**/*.ts',
        '--docs',
        'README.md',
        '--bare',
        '--copy',
        '--instructions',
        expect.stringContaining('@'),
      ]),
      expect.objectContaining({
        cwd: tempDir,
        stdio: ['inherit', 'inherit', 'inherit'],
      })
    );

    // Verify that log was called with success message
    expect(logSpy).toHaveBeenCalledWith('Update prompt with context has been copied to clipboard.');
  });

  test('should handle errors when plan file does not exist', async () => {
    const options = {
      description: 'Update something',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call with non-existent plan
    await expect(handleUpdateCommand('non-existent-plan', options, command)).rejects.toThrow();
  });

  test('should handle rmfilter exit with non-zero code', async () => {
    // Override the mock for this test
    mockLogSpawn.mockImplementationOnce(() => ({
      exited: Promise.resolve(1), // Non-zero exit code
    }));

    // Create a test plan
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'pending',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      description: 'Update',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should throw error when rmfilter fails
    await expect(handleUpdateCommand('1', options, command)).rejects.toThrow(
      'rmfilter exited with code 1'
    );
  });
});
