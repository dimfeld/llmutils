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
    mockGenerateUpdatePrompt.mockClear();
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

    await moduleMocker.mock('../prompt.js', () => ({
      generateUpdatePrompt: mockGenerateUpdatePrompt,
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
    expect(mockGenerateUpdatePrompt).toHaveBeenCalledWith(
      '# Test Plan\n## Goal\nTest goal',
      testDescription
    );
  });

  test('should open editor when description not provided', async () => {
    // Mock waitForEnter to avoid stdin issues in tests
    const mockWaitForEnter = mock(() => Promise.resolve(''));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mockWaitForEnter,
    }));

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

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
      await newHandleUpdateCommand('1', options, command);
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

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

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
      await newHandleUpdateCommand('1', options, command);
    } catch (e) {
      // Expected to fail at rmfilter
    }

    // Verify that rmfilter was called with correct arguments
    expect(mockRunRmfilterProgrammatically).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--bare',
        '--instructions',
        'Update prompt content',
        '--edit-format',
        'diff',
        '--docs',
        'README.md',
        'src/**/*.ts',
      ]),
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

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

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
    await newHandleUpdateCommand('1', options, command);

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

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

    const options = {
      description: 'Update',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should throw error when LLM response is empty
    await expect(newHandleUpdateCommand('1', options, command)).rejects.toThrow(
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

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

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
    await newHandleUpdateCommand('1', options, command);

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

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

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
    await newHandleUpdateCommand('2', options, command);

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

    // Re-import after mocking
    const updateModule = await import('./update.js');
    const { handleUpdateCommand: newHandleUpdateCommand } = updateModule;

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
    await newHandleUpdateCommand('3', options, command);

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
        'The update description should be provided as a positional argument'
      );
      expect(error.message).toContain('rmplan update <plan> "description" -- <rmfilter args>');
    } finally {
      // Restore original argv
      process.argv = originalArgv;
    }
  });
});
