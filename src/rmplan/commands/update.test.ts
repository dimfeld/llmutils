import { describe, test, expect, beforeEach, afterEach, mock, spyOn, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';
import * as updateMod from './update.js';
import { generateUpdatePrompt } from './update.js';

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

// Mock rmfilter and clipboard
const mockRunRmfilterProgrammatically = mock(() => Promise.resolve('rmfilter output'));
const mockClipboardWrite = mock(() => Promise.resolve());

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
    mockRunRmfilterProgrammatically.mockClear();
    mockClipboardWrite.mockClear();

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

    await moduleMocker.mock('../../rmfilter/rmfilter.js', () => ({
      runRmfilterProgrammatically: mockRunRmfilterProgrammatically,
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: mockClipboardWrite,
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
    // Mock waitForEnter to avoid stdin issues in tests
    const mockWaitForEnter = mock(() => Promise.resolve(''));
    const promptSpy = spyOn(updateMod, 'generateUpdatePrompt');

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Re-import after mocking
    const updateModule = await import('./update.js');
    handleUpdateCommand = updateModule.handleUpdateCommand;

    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
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

    // Override mockLogSpawn to fail early to avoid waitForEnter
    mockLogSpawn.mockImplementationOnce(() => ({
      exited: Promise.resolve(1), // Non-zero exit code to exit early
    }));

    // Call the update command - will fail at rmfilter, but that's ok for this test
    try {
      await handleUpdateCommand('1', options, command);
    } catch (e) {
      // Expected to fail at rmfilter
    }

    // Verify that log was called with update description
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Update description: Add authentication feature to the plan')
    );

    // Verify the conversion and prompt generation were called
    expect(mockConvertYamlToMarkdown).toHaveBeenCalled();
    expect(promptSpy).toHaveBeenCalledWith('# Test Plan\n## Goal\nTest goal', testDescription);
  });

  test('should open editor when description not provided', async () => {
    // Mock waitForEnter to avoid stdin issues in tests
    const mockWaitForEnter = mock(() => Promise.resolve(''));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
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

    // Override mockLogSpawn to fail early to avoid waitForEnter
    mockLogSpawn.mockImplementationOnce(() => ({
      exited: Promise.resolve(1), // Non-zero exit code to exit early
    }));

    try {
      // Call the update command - will fail at rmfilter, but that's ok for this test
      await handleUpdateCommand('1', options, command);
    } catch (e) {
      // Expected to fail at rmfilter
    }

    // Verify editor was opened
    expect(mockLogSpawn).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(String), expect.stringContaining('rmplan-update-desc-')]),
      expect.objectContaining({ stdio: ['inherit', 'inherit', 'inherit'] })
    );

    // Verify that log was called with update description
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Update description: Update plan to include database migrations')
    );

    // Restore original Bun methods
    // @ts-ignore
    Bun.write = originalWrite;
    // @ts-ignore
    Bun.file = originalFile;
  });

  test('should handle empty editor content', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
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
      id: 1,
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

    // Mock waitForEnter to avoid stdin issues in tests
    const mockWaitForEnter = mock(() => Promise.resolve(''));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    const testDescription = 'Add authentication feature';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Override mockLogSpawn to fail early to avoid waitForEnter
    mockLogSpawn.mockImplementationOnce(() => ({
      exited: Promise.resolve(1), // Non-zero exit code to exit early
    }));

    // Call the update command - will fail at rmfilter, but that's ok for this test
    try {
      await handleUpdateCommand('1', options, command);
    } catch (e) {
      // Expected to fail at rmfilter
    }

    // Verify that rmfilter was called with correct arguments
    expect(mockRunRmfilterProgrammatically).toHaveBeenCalledWith(
      [
        '--bare',
        '--instructions',
        expect.stringMatching('Add authentication feature'),
        '--docs',
        'README.md',
        'src/**/*.ts',
      ],
      tempDir
    );

    // Verify clipboard was written
    expect(mockClipboardWrite).toHaveBeenCalledWith('rmfilter output');
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
    // Override the mock for this test to throw error
    mockRunRmfilterProgrammatically.mockImplementationOnce(() => {
      throw new Error('rmfilter failed');
    });

    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
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
    await expect(handleUpdateCommand('1', options, command)).rejects.toThrow('rmfilter failed');
  });

  test('should complete end-to-end update process with LLM response', async () => {
    // Create an original plan
    const originalPlanId = 1;
    const originalCreatedAt = '2024-01-01T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: originalPlanId,
      title: 'Original Plan',
      goal: 'Original goal',
      details: 'Original details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Original Task',
          description: 'Original task description',
          files: [],
          steps: [{ prompt: 'Original step prompt', done: false }],
        },
      ],
      rmfilter: ['src/**/*.ts'],
      docs: ['README.md'],
      issue: ['https://github.com/example/repo/issues/1'],
      createdAt: originalCreatedAt,
      updatedAt: originalCreatedAt,
      planGeneratedAt: originalCreatedAt,
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Mock waitForEnter to return a simulated LLM response
    const mockWaitForEnter = mock(() =>
      Promise.resolve(`# Updated Plan

## Goal
Updated goal with new features

### Details
Updated details with more information

---

## Task: Updated Task
**Description:** Updated task description with new requirements
**Files:**
- src/new-file.ts
- src/another-file.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Updated step prompt with new instructions
    \`\`\`

---

## Task: New Task
**Description:** A completely new task added by the update
**Steps:**
1.  **Prompt:**
    \`\`\`
    New task prompt
    \`\`\`
`)
    );

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Mock extractMarkdownToYaml to verify it's called correctly
    const mockExtractMarkdownToYaml = mock(async (inputText, config, quiet, options) => {
      // Verify the updatePlan option is passed correctly
      expect(options.updatePlan).toBeDefined();
      expect(options.updatePlan.data.id).toBe(originalPlanId);
      expect(options.updatePlan.data.createdAt).toBe(originalCreatedAt);
      expect(options.updatePlan.path).toBe(planPath);
      expect(options.output).toBe(planPath);

      // Simulate updating the plan file
      const updatedPlan: PlanSchema = {
        ...originalPlan,
        title: 'Updated Plan',
        goal: 'Updated goal with new features',
        details: 'Updated details with more information',
        tasks: [
          {
            title: 'Updated Task',
            description: 'Updated task description with new requirements',
            files: ['src/new-file.ts', 'src/another-file.ts'],
            steps: [{ prompt: 'Updated step prompt with new instructions', done: false }],
          },
          {
            title: 'New Task',
            description: 'A completely new task added by the update',
            files: [],
            steps: [{ prompt: 'New task prompt', done: false }],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(planPath, yaml.stringify(updatedPlan));
      return `Successfully updated plan at ${planPath}`;
    });

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
    }));

    const testDescription = 'Add new features and update existing tasks';
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

    // Verify waitForEnter was called
    expect(mockWaitForEnter).toHaveBeenCalledWith(true);

    // Verify extractMarkdownToYaml was called
    expect(mockExtractMarkdownToYaml).toHaveBeenCalled();

    // Verify the plan file was updated
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify core metadata is preserved
    expect(updatedPlan.id).toBe(originalPlanId);
    expect(updatedPlan.createdAt).toBe(originalCreatedAt);

    // Verify content is updated
    expect(updatedPlan.title).toBe('Updated Plan');
    expect(updatedPlan.goal).toBe('Updated goal with new features');
    expect(updatedPlan.tasks).toHaveLength(2);
    expect(updatedPlan.tasks[0].title).toBe('Updated Task');
    expect(updatedPlan.tasks[1].title).toBe('New Task');

    // Verify updatedAt is changed
    expect(updatedPlan.updatedAt).not.toBe(originalCreatedAt);
    expect(new Date(updatedPlan.updatedAt).getTime()).toBeGreaterThan(
      new Date(originalCreatedAt).getTime()
    );

    // Verify success message
    expect(logSpy).toHaveBeenCalledWith(`Successfully updated plan: ${planPath}`);
  });

  test('should handle empty LLM response', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'pending',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock waitForEnter to return empty response
    const mockWaitForEnter = mock(() => Promise.resolve(''));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    const options = {
      description: 'Update',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should throw error when LLM response is empty
    await expect(handleUpdateCommand('1', options, command)).rejects.toThrow(
      'No response from LLM was provided'
    );
  });

  test('should add a new task to an existing plan', async () => {
    // Create an original plan with one task
    const originalPlanId = 1;
    const originalCreatedAt = '2024-01-01T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: originalPlanId,
      title: 'Original Plan',
      goal: 'Original goal',
      details: 'Original details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Existing Task',
          description: 'Existing task description',
          files: ['src/existing.ts'],
          steps: [{ prompt: 'Existing step prompt', done: false }],
        },
      ],
      rmfilter: ['src/**/*.ts'],
      createdAt: originalCreatedAt,
      updatedAt: originalCreatedAt,
      planGeneratedAt: originalCreatedAt,
    };

    const planPath = path.join(tasksDir, '1.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Mock waitForEnter to return a simulated LLM response that adds a new task
    const mockWaitForEnter = mock(() =>
      Promise.resolve(`# Original Plan

## Goal
Original goal

### Details
Original details

---

## Task: Existing Task
**Description:** Existing task description
**Files:**
- src/existing.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Existing step prompt
    \`\`\`

---

## Task: New Authentication Task
**Description:** Implement user authentication system
**Files:**
- src/auth/login.ts
- src/auth/logout.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Implement login functionality with JWT tokens
    \`\`\`
2.  **Prompt:**
    \`\`\`
    Implement logout functionality and session cleanup
    \`\`\`
`)
    );

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Mock extractMarkdownToYaml to simulate updating the plan file
    const mockExtractMarkdownToYaml = mock(async (inputText, config, quiet, options) => {
      // Verify the updatePlan option is passed correctly
      expect(options.updatePlan).toBeDefined();
      expect(options.updatePlan.data.id).toBe(originalPlanId);
      expect(options.updatePlan.data.createdAt).toBe(originalCreatedAt);
      expect(options.updatePlan.path).toBe(planPath);
      expect(options.output).toBe(planPath);

      // Simulate updating the plan file with the new task
      const updatedPlan: PlanSchema = {
        ...originalPlan,
        tasks: [
          originalPlan.tasks[0],
          {
            title: 'New Authentication Task',
            description: 'Implement user authentication system',
            files: ['src/auth/login.ts', 'src/auth/logout.ts'],
            steps: [
              { prompt: 'Implement login functionality with JWT tokens', done: false },
              { prompt: 'Implement logout functionality and session cleanup', done: false },
            ],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(planPath, yaml.stringify(updatedPlan));
      return `Successfully updated plan at ${planPath}`;
    });

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
    }));

    const testDescription = 'Add authentication feature with login and logout functionality';
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

    // Verify the plan file was updated
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify core metadata is preserved
    expect(updatedPlan.id).toBe(originalPlanId);
    expect(updatedPlan.createdAt).toBe(originalCreatedAt);

    // Verify the new task was added
    expect(updatedPlan.tasks).toHaveLength(2);
    expect(updatedPlan.tasks[0].title).toBe('Existing Task');
    expect(updatedPlan.tasks[1].title).toBe('New Authentication Task');
    expect(updatedPlan.tasks[1].description).toBe('Implement user authentication system');
    expect(updatedPlan.tasks[1].files).toEqual(['src/auth/login.ts', 'src/auth/logout.ts']);
    expect(updatedPlan.tasks[1].steps).toHaveLength(2);

    // Verify success message
    expect(logSpy).toHaveBeenCalledWith(`Successfully updated plan: ${planPath}`);
  });

  test('should remove a task from an existing plan', async () => {
    // Create an original plan with multiple tasks
    const originalPlanId = 2;
    const originalCreatedAt = '2024-01-02T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: originalPlanId,
      title: 'Multi-Task Plan',
      goal: 'Build a complete application',
      details: 'Application with multiple features',
      status: 'in_progress',
      tasks: [
        {
          title: 'Setup Database',
          description: 'Configure database connections',
          files: ['src/db/config.ts'],
          steps: [{ prompt: 'Setup PostgreSQL connection', done: true }],
        },
        {
          title: 'User Management',
          description: 'Implement user CRUD operations',
          files: ['src/users/controller.ts'],
          steps: [{ prompt: 'Create user endpoints', done: false }],
        },
        {
          title: 'Email Service',
          description: 'Setup email notifications',
          files: ['src/email/service.ts'],
          steps: [{ prompt: 'Configure email provider', done: false }],
        },
      ],
      createdAt: originalCreatedAt,
      updatedAt: originalCreatedAt,
      planGeneratedAt: originalCreatedAt,
    };

    const planPath = path.join(tasksDir, '2.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Mock waitForEnter to return a simulated LLM response that removes the Email Service task
    const mockWaitForEnter = mock(() =>
      Promise.resolve(`# Multi-Task Plan

## Goal
Build a complete application

### Details
Application with multiple features

---

## Task: Setup Database
**Description:** Configure database connections
**Files:**
- src/db/config.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Setup PostgreSQL connection
    \`\`\`

---

## Task: User Management
**Description:** Implement user CRUD operations
**Files:**
- src/users/controller.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Create user endpoints
    \`\`\`
`)
    );

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Mock extractMarkdownToYaml to simulate updating the plan file
    const mockExtractMarkdownToYaml = mock(async (inputText, config, quiet, options) => {
      // Verify the updatePlan option is passed correctly
      expect(options.updatePlan).toBeDefined();
      expect(options.updatePlan.data.id).toBe(originalPlanId);

      // Simulate updating the plan file with the Email Service task removed
      const updatedPlan: PlanSchema = {
        ...originalPlan,
        tasks: [originalPlan.tasks[0], originalPlan.tasks[1]], // Remove the third task
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(planPath, yaml.stringify(updatedPlan));
      return `Successfully updated plan at ${planPath}`;
    });

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
    }));

    const testDescription =
      'Remove the email service task as it will be handled by a third-party service';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call the update command
    await handleUpdateCommand('2', options, command);

    // Verify the plan file was updated
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify core metadata is preserved
    expect(updatedPlan.id).toBe(originalPlanId);
    expect(updatedPlan.createdAt).toBe(originalCreatedAt);

    // Verify the Email Service task was removed
    expect(updatedPlan.tasks).toHaveLength(2);
    expect(updatedPlan.tasks[0].title).toBe('Setup Database');
    expect(updatedPlan.tasks[1].title).toBe('User Management');
    expect(updatedPlan.tasks.find((t: any) => t.title === 'Email Service')).toBeUndefined();

    // Verify success message
    expect(logSpy).toHaveBeenCalledWith(`Successfully updated plan: ${planPath}`);
  });

  test('should modify an existing task in a plan', async () => {
    // Create an original plan with a task that needs modification
    const originalPlanId = 3;
    const originalCreatedAt = '2024-01-03T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: originalPlanId,
      title: 'API Development Plan',
      goal: 'Build RESTful API',
      details: 'Create API endpoints for the application',
      status: 'in_progress',
      tasks: [
        {
          title: 'User API',
          description: 'Basic user endpoints',
          files: ['src/api/users.ts'],
          steps: [
            { prompt: 'Create GET /users endpoint', done: true },
            { prompt: 'Create POST /users endpoint', done: false },
          ],
        },
        {
          title: 'Product API',
          description: 'Product management endpoints',
          files: ['src/api/products.ts'],
          steps: [{ prompt: 'Create product CRUD endpoints', done: false }],
        },
      ],
      createdAt: originalCreatedAt,
      updatedAt: originalCreatedAt,
      planGeneratedAt: originalCreatedAt,
    };

    const planPath = path.join(tasksDir, '3.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Mock waitForEnter to return a simulated LLM response that modifies the User API task
    const mockWaitForEnter = mock(() =>
      Promise.resolve(`# API Development Plan

## Goal
Build RESTful API

### Details
Create API endpoints for the application

---

## Task: User API
**Description:** Comprehensive user management endpoints with authentication
**Files:**
- src/api/users.ts
- src/api/auth.ts
- src/middleware/authentication.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Create GET /users endpoint with pagination and filtering
    \`\`\`
2.  **Prompt:**
    \`\`\`
    Create POST /users endpoint with validation
    \`\`\`
3.  **Prompt:**
    \`\`\`
    Implement JWT authentication middleware
    \`\`\`
4.  **Prompt:**
    \`\`\`
    Add role-based access control
    \`\`\`

---

## Task: Product API
**Description:** Product management endpoints
**Files:**
- src/api/products.ts
**Steps:**
1.  **Prompt:**
    \`\`\`
    Create product CRUD endpoints
    \`\`\`
`)
    );

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Mock extractMarkdownToYaml to simulate updating the plan file
    const mockExtractMarkdownToYaml = mock(async (inputText, config, quiet, options) => {
      // Verify the updatePlan option is passed correctly
      expect(options.updatePlan).toBeDefined();
      expect(options.updatePlan.data.id).toBe(originalPlanId);

      // Simulate updating the plan file with modified User API task
      const updatedPlan: PlanSchema = {
        ...originalPlan,
        tasks: [
          {
            title: 'User API',
            description: 'Comprehensive user management endpoints with authentication',
            files: ['src/api/users.ts', 'src/api/auth.ts', 'src/middleware/authentication.ts'],
            steps: [
              { prompt: 'Create GET /users endpoint with pagination and filtering', done: false },
              { prompt: 'Create POST /users endpoint with validation', done: false },
              { prompt: 'Implement JWT authentication middleware', done: false },
              { prompt: 'Add role-based access control', done: false },
            ],
          },
          originalPlan.tasks[1], // Keep Product API task unchanged
        ],
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(planPath, yaml.stringify(updatedPlan));
      return `Successfully updated plan at ${planPath}`;
    });

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
    }));

    const testDescription =
      'Expand the User API task to include authentication and authorization features';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call the update command
    await handleUpdateCommand('3', options, command);

    // Verify the plan file was updated
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify core metadata is preserved
    expect(updatedPlan.id).toBe(originalPlanId);
    expect(updatedPlan.createdAt).toBe(originalCreatedAt);

    // Verify the User API task was modified
    expect(updatedPlan.tasks).toHaveLength(2);
    expect(updatedPlan.tasks[0].title).toBe('User API');
    expect(updatedPlan.tasks[0].description).toBe(
      'Comprehensive user management endpoints with authentication'
    );
    expect(updatedPlan.tasks[0].files).toHaveLength(3);
    expect(updatedPlan.tasks[0].files).toContain('src/middleware/authentication.ts');
    expect(updatedPlan.tasks[0].steps).toHaveLength(4);
    expect(updatedPlan.tasks[0].steps[2].prompt).toContain('JWT authentication');

    // Verify Product API task remains unchanged
    expect(updatedPlan.tasks[1].title).toBe('Product API');
    expect(updatedPlan.tasks[1].description).toBe('Product management endpoints');

    // Verify success message
    expect(logSpy).toHaveBeenCalledWith(`Successfully updated plan: ${planPath}`);
  });

  test('should preserve fields like parent during update', async () => {
    // Create an original plan with parent and other fields
    const originalPlanId = 4;
    const originalCreatedAt = '2024-01-04T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: originalPlanId,
      title: 'Child Plan',
      goal: 'Implement sub-feature',
      details: 'Details for sub-feature',
      status: 'in_progress',
      priority: 'high',
      parent: 100,
      container: false,
      baseBranch: 'feature/parent-feature',
      changedFiles: ['src/feature.ts', 'tests/feature.test.ts'],
      pullRequest: ['https://github.com/org/repo/pull/456'],
      assignedTo: 'jane.doe',
      docs: ['docs/feature.md'],
      issue: ['https://github.com/org/repo/issues/123'],
      rmfilter: ['--with-imports', 'src/**/*.ts'],
      dependencies: [50, 51],
      tasks: [
        {
          title: 'Original Task',
          description: 'Original task description',
          files: [],
          steps: [{ prompt: 'Original step prompt', done: false }],
        },
      ],
      createdAt: originalCreatedAt,
      updatedAt: originalCreatedAt,
      planGeneratedAt: originalCreatedAt,
      promptsGeneratedAt: originalCreatedAt,
    };

    const planPath = path.join(tasksDir, '4.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Mock waitForEnter to return a simulated LLM response
    const mockWaitForEnter = mock(() =>
      Promise.resolve(`# Updated Child Plan

## Goal
Updated goal for sub-feature

### Details
Updated details with more information

---

## Task: Updated Task
**Description:** Updated task description
**Steps:**
1.  **Prompt:**
    \`\`\`
    Updated step prompt
    \`\`\`
`)
    );

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Mock extractMarkdownToYaml to verify field preservation
    const mockExtractMarkdownToYaml = mock(async (inputText, config, quiet, options) => {
      // Verify the updatePlan option is passed correctly
      expect(options.updatePlan).toBeDefined();
      expect(options.updatePlan.data.id).toBe(originalPlanId);
      expect(options.updatePlan.data.parent).toBe(100);

      // Simulate the real behavior of extractMarkdownToYaml with field preservation
      const updatedPlan: PlanSchema = {
        // All original fields should be preserved
        ...originalPlan,
        // Only these fields should be updated from the LLM response
        title: 'Updated Child Plan',
        goal: 'Updated goal for sub-feature',
        details: 'Updated details with more information',
        tasks: [
          {
            title: 'Updated Task',
            description: 'Updated task description',
            files: [],
            steps: [{ prompt: 'Updated step prompt', done: false }],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(planPath, yaml.stringify(updatedPlan));
      return `Successfully updated plan at ${planPath}`;
    });

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
    }));

    const testDescription = 'Update the sub-feature implementation details';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call the update command
    await handleUpdateCommand('4', options, command);

    // Verify the plan file was updated
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify all original fields are preserved
    expect(updatedPlan.id).toBe(originalPlanId);
    expect(updatedPlan.parent).toBe(100);
    expect(updatedPlan.container).toBe(false);
    expect(updatedPlan.baseBranch).toBe('feature/parent-feature');
    expect(updatedPlan.changedFiles).toEqual(['src/feature.ts', 'tests/feature.test.ts']);
    expect(updatedPlan.pullRequest).toEqual(['https://github.com/org/repo/pull/456']);
    expect(updatedPlan.assignedTo).toBe('jane.doe');
    expect(updatedPlan.docs).toEqual(['docs/feature.md']);
    expect(updatedPlan.issue).toEqual(['https://github.com/org/repo/issues/123']);
    expect(updatedPlan.rmfilter).toEqual(['--with-imports', 'src/**/*.ts']);
    expect(updatedPlan.dependencies).toEqual([50, 51]);
    expect(updatedPlan.priority).toBe('high');
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.createdAt).toBe(originalCreatedAt);
    expect(updatedPlan.planGeneratedAt).toBe(originalCreatedAt);
    expect(updatedPlan.promptsGeneratedAt).toBe(originalCreatedAt);

    // Verify content was updated
    expect(updatedPlan.title).toBe('Updated Child Plan');
    expect(updatedPlan.goal).toBe('Updated goal for sub-feature');
    expect(updatedPlan.details).toBe('Updated details with more information');
    expect(updatedPlan.tasks[0].title).toBe('Updated Task');

    // Verify updatedAt was changed
    expect(updatedPlan.updatedAt).not.toBe(originalCreatedAt);
    expect(new Date(updatedPlan.updatedAt).getTime()).toBeGreaterThan(
      new Date(originalCreatedAt).getTime()
    );

    // Verify success message
    expect(logSpy).toHaveBeenCalledWith(`Successfully updated plan: ${planPath}`);
  });

  test('should change status from done to in_progress when updating a completed plan', async () => {
    // Create an original plan with status done
    const originalPlanId = 5;
    const originalCreatedAt = '2024-01-05T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: originalPlanId,
      title: 'Completed Plan',
      goal: 'A plan that was completed',
      details: 'This plan has been completed',
      status: 'done',
      tasks: [
        {
          title: 'Completed Task',
          description: 'A task that was completed',
          files: [],
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: true },
          ],
        },
      ],
      createdAt: originalCreatedAt,
      updatedAt: originalCreatedAt,
      planGeneratedAt: originalCreatedAt,
    };

    const planPath = path.join(tasksDir, '5.yml');
    await fs.writeFile(planPath, yaml.stringify(originalPlan));

    // Mock waitForEnter to return a simulated LLM response
    const mockWaitForEnter = mock(() =>
      Promise.resolve(`# Completed Plan - Updated

## Goal
A plan that was completed - now being updated

### Details
This plan is being updated with new requirements

---

## Task: Updated Task
**Description:** Adding new functionality to the completed task
**Steps:**
1.  **Prompt:**
    \`\`\`
    Implement the new feature
    \`\`\`
`)
    );

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Mock extractMarkdownToYaml to verify status change
    const mockExtractMarkdownToYaml = mock(async (inputText, config, quiet, options) => {
      // Verify the updatePlan option is passed correctly
      expect(options.updatePlan).toBeDefined();
      expect(options.updatePlan.data.id).toBe(originalPlanId);
      expect(options.updatePlan.data.status).toBe('done');

      // Simulate the real behavior - status should change from done to in_progress
      const updatedPlan: PlanSchema = {
        ...originalPlan,
        title: 'Completed Plan - Updated',
        goal: 'A plan that was completed - now being updated',
        details: 'This plan is being updated with new requirements',
        status: 'in_progress', // This should be changed from 'done'
        tasks: [
          {
            title: 'Updated Task',
            description: 'Adding new functionality to the completed task',
            files: [],
            steps: [{ prompt: 'Implement the new feature', done: false }],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(planPath, yaml.stringify(updatedPlan));
      return `Successfully updated plan at ${planPath}`;
    });

    await moduleMocker.mock('../process_markdown.js', () => ({
      convertYamlToMarkdown: mockConvertYamlToMarkdown,
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
    }));

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

    const testDescription = 'Add new requirements to the completed plan';
    const options = {
      description: testDescription,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call the update command
    await newHandleUpdateCommand('5', options, command);

    // Verify the plan file was updated
    const updatedPlanContent = await fs.readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent);

    // Verify status changed from done to in_progress
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.status).not.toBe('done');

    // Verify other fields were updated
    expect(updatedPlan.id).toBe(originalPlanId);
    expect(updatedPlan.createdAt).toBe(originalCreatedAt);
    expect(updatedPlan.title).toBe('Completed Plan - Updated');

    // Verify success message
    expect(logSpy).toHaveBeenCalledWith(`Successfully updated plan: ${planPath}`);
  });

  test('should throw error when description is mistakenly placed after double dash', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      description: 'Add new feature',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Simulate user putting description after -- by modifying process.argv
    const originalArgv = process.argv;
    process.argv = ['node', 'rmplan', 'update', '1', '--', 'Add new feature', 'src/**/*.ts'];

    try {
      await handleUpdateCommand('1', options, command);
    } catch (error) {
      expect(error.message).toContain(
        'Usage: rmplan update <plan> "description" -- <rmfilter args>'
      );
    } finally {
      // Restore original argv
      process.argv = originalArgv;
    }
  });
});

describe('generateUpdatePrompt', () => {
  it('should correctly embed planAsMarkdown and updateDescription in the prompt', () => {
    const planAsMarkdown = `# My Test Plan

## Goal
To test the update prompt generation

## Priority
medium

### Details
This is a test plan with some details

---

## Task: First Task
**Description:** This is the first task
**Files:**
- src/test1.ts
- src/test2.ts

**Steps:**
1.  **Prompt:**
    \`\`\`
    Do something first
    \`\`\`
2.  **Prompt:**
    \`\`\`
    Do something second
    \`\`\``;

    const updateDescription = 'Add a new task for error handling and update the priority to high';

    const prompt = generateUpdatePrompt(planAsMarkdown, updateDescription);

    // Check that the prompt contains the key sections
    expect(prompt).toContain('# Plan Update Task');
    expect(prompt).toContain(
      'You are acting as a project manager tasked with updating an existing project plan'
    );

    // Check that the existing plan is embedded
    expect(prompt).toContain('## Current Plan');
    expect(prompt).toContain(planAsMarkdown);

    // Check that the update description is embedded
    expect(prompt).toContain('## Requested Update');
    expect(prompt).toContain(updateDescription);

    // Check instructions section
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('Return the ENTIRE updated plan');
    expect(prompt).toContain('For **Pending Tasks** only, you may:');
    expect(prompt).toContain('Add new tasks');
    expect(prompt).toContain('Remove existing pending tasks');
    expect(prompt).toContain('Modify pending tasks');
    expect(prompt).toContain('Preserve any unmodified parts');

    // Check that it references the required output format
    expect(prompt).toContain('## Required Output Format');
    expect(prompt).toContain('Your response must follow the exact structure of the input plan');

    // Check important notes
    expect(prompt).toContain('## Important Notes');
    expect(prompt).toContain('Output ONLY the updated plan in Markdown format');
  });

  it('should include instructions for preserving completed tasks', () => {
    const planAsMarkdown = `# Test Plan

## Goal
Test goal

---

# Completed Tasks
*These tasks have been completed and should not be modified.*

## Task: Completed Task [TASK-1] ✓
**Description:** This task is done
**Steps:** *(All completed)*
1.  **Prompt:** ✓
    \`\`\`
    Completed step
    \`\`\`

---

# Pending Tasks
*These tasks can be updated, modified, or removed as needed.*

## Task: Pending Task [TASK-2]
**Description:** This task is not done
**Steps:**
1.  **Prompt:**
    \`\`\`
    Pending step
    \`\`\``;

    const updateDescription = 'Add a new feature';

    const prompt = generateUpdatePrompt(planAsMarkdown, updateDescription);

    // Check for completed task preservation instructions
    expect(prompt).toContain('CRITICAL: Preserve ALL completed tasks exactly as they appear');
    expect(prompt).toContain('Completed tasks are marked with ✓');
    expect(prompt).toContain('Do NOT modify, remove, or change any completed tasks');
    expect(prompt).toContain('Keep all task IDs (e.g., [TASK-1], [TASK-2]) exactly as shown');

    // Check for pending task instructions
    expect(prompt).toContain('For **Pending Tasks** only, you may:');
    expect(prompt).toContain('Add new tasks');
    expect(prompt).toContain('Remove existing pending tasks');
    expect(prompt).toContain('Modify pending tasks');

    // Check for task numbering instructions
    expect(prompt).toContain('Continue the task numbering sequence');
    expect(prompt).toContain(
      'if the last task is [TASK-5], new tasks should be [TASK-6], [TASK-7]'
    );

    // Check structure preservation
    expect(prompt).toContain('Keep the "Completed Tasks" section if it exists');
    expect(prompt).toContain('Keep the "Pending Tasks" section');
    expect(prompt).toContain('Maintain the separation between completed and pending tasks');

    // Check formatting requirements
    expect(prompt).toContain('Task ID format [TASK-N]');
    expect(prompt).toContain('Completed task markers (✓)');

    // Check final warning
    expect(prompt).toContain(
      'NEVER modify completed tasks - they represent work that has already been done'
    );
  });
});

describe('handleUpdateCommand direct mode', () => {
  let tempDir: string;
  let tasksDir: string;
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-update-direct-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  test('should run LLM directly when --direct flag is set', async () => {
    const planPath = path.join(tasksDir, 'test-plan.yml');
    const planContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
id: 123
title: Test Plan
goal: Test goal
status: pending
priority: medium
tasks:
  - title: Task 1
    description: First task
    steps:
      - prompt: Do something
        done: false`;

    await Bun.write(planPath, planContent);

    // Mock dependencies
    const mockRunStreamingPrompt = mock(async ({ model, messages }: any) => {
      expect(messages[0].content).toContain('# Plan Update Task');
      expect(messages[0].content).toContain('Add a new task for testing');
      return { text: '# Updated plan content\n\nyaml:\nid: 123\ntitle: Updated Plan' };
    });

    const mockCreateModel = mock(async (modelId: string) => {
      expect(modelId).toBe('test-model');
      return 'test-model-instance';
    });

    const mockExtractMarkdownToYaml = mock(async (inputText: string) => {
      expect(inputText).toContain('# Updated plan content');
    });

    const mockClipboardWrite = mock(async () => {});

    await moduleMocker.mock('../llm_utils/run_and_apply.js', () => ({
      runStreamingPrompt: mockRunStreamingPrompt,
      DEFAULT_RUN_MODEL: 'default-model',
    }));

    await moduleMocker.mock('../../common/model_factory.js', () => ({
      createModel: mockCreateModel,
    }));

    await moduleMocker.mock('../process_markdown.js', () => ({
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
      convertYamlToMarkdown: () => '# Test Plan\n\n## Goal\nTest goal',
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: mockClipboardWrite,
    }));

    await moduleMocker.mock('../../rmfilter/rmfilter.js', () => ({
      runRmfilterProgrammatically: async () => '# Plan Update Task\n\nAdd a new task for testing',
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
        models: { execution: 'test-model' },
      }),
    }));

    const { handleUpdateCommand } = await import('./update.js');

    const options = {
      description: 'Add a new task for testing',
      direct: true,
      model: 'test-model',
    };

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, 'rmplan.yml') }),
      },
    };

    await handleUpdateCommand('test-plan.yml', options, command);

    expect(mockRunStreamingPrompt).toHaveBeenCalledTimes(1);
    expect(mockCreateModel).toHaveBeenCalledWith('test-model');
    expect(mockExtractMarkdownToYaml).toHaveBeenCalledTimes(1);
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
  });

  test('should use manual mode when --direct is not set', async () => {
    const planPath = path.join(tasksDir, 'test-plan.yml');
    const planContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
id: 123
title: Test Plan
goal: Test goal
status: pending
priority: medium
tasks:
  - title: Task 1
    description: First task
    steps:
      - prompt: Do something
        done: false`;

    await Bun.write(planPath, planContent);

    // Mock dependencies
    const mockWaitForEnter = mock(async () => '# Updated plan from user');
    const mockClipboardWrite = mock(async () => {});
    const mockExtractMarkdownToYaml = mock(async () => {});

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    await moduleMocker.mock('../process_markdown.js', () => ({
      extractMarkdownToYaml: mockExtractMarkdownToYaml,
      convertYamlToMarkdown: () => '# Test Plan\n\n## Goal\nTest goal',
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: mockClipboardWrite,
    }));

    await moduleMocker.mock('../../rmfilter/rmfilter.js', () => ({
      runRmfilterProgrammatically: async () => '# Plan Update Task\n\nAdd a new task for testing',
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
      }),
    }));

    const { handleUpdateCommand } = await import('./update.js');

    const options = {
      description: 'Add a new task for testing',
      // direct not set, should default to false
    };

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, 'rmplan.yml') }),
      },
    };

    await handleUpdateCommand('test-plan.yml', options, command);

    expect(mockWaitForEnter).toHaveBeenCalledTimes(1);
    expect(mockClipboardWrite).toHaveBeenCalledWith(
      '# Plan Update Task\n\nAdd a new task for testing'
    );
    expect(mockExtractMarkdownToYaml).toHaveBeenCalledTimes(1);
  });
});
