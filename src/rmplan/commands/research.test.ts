import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleResearchCommand } from './research.js';
import { clearPlanCache, writePlanFile, readPlanFile } from '../plans.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const clipboardWriteSpy = mock(() => {});
const waitForEnterSpy = mock(() => Promise.resolve(''));
const logSpawnSpy = mock(() => ({ exited: Promise.resolve() }));
const sshAwarePasteActionSpy = mock(() => 'paste');
const runRmfilterProgrammaticallySpy = mock(() => Promise.resolve('rmfilter output'));

describe('handleResearchCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    clipboardWriteSpy.mockClear();
    waitForEnterSpy.mockClear();
    logSpawnSpy.mockClear();
    sshAwarePasteActionSpy.mockClear();
    runRmfilterProgrammaticallySpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-research-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
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

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: clipboardWriteSpy,
    }));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: waitForEnterSpy,
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: logSpawnSpy,
    }));

    await moduleMocker.mock('../../common/ssh_detection.js', () => ({
      sshAwarePasteAction: sshAwarePasteActionSpy,
    }));

    await moduleMocker.mock('../../rmfilter/rmfilter.js', () => ({
      runRmfilterProgrammatically: runRmfilterProgrammaticallySpy,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('generates basic research prompt and copies to clipboard', async () => {
    // Create a test plan
    const plan = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test implementation',
      details: 'Implement test feature',
      status: 'pending',
      priority: 'medium',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              prompt: 'Do step 1',
              done: false,
            },
          ],
        },
      ],
    };

    await writePlanFile(path.join(tasksDir, '1.yml'), plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('1', undefined, options, command);

    // Should have generated and copied research prompt
    expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
    const promptContent = clipboardWriteSpy.mock.calls[0][0];
    expect(promptContent).toContain('# Research Assistant');
    expect(promptContent).toContain('Test implementation');
    expect(promptContent).toContain('Implement test feature');

    // Should have prompted for paste
    expect(waitForEnterSpy).toHaveBeenCalledWith(true);
    expect(logSpy).toHaveBeenCalledWith('Research prompt copied to clipboard');
  });

  test('updates plan with pasted research content', async () => {
    // Mock waitForEnter to return sample research
    waitForEnterSpy.mockResolvedValue('This is my research findings from investigation.');

    // Create a test plan
    const plan = {
      id: '2',
      title: 'Research Plan',
      goal: 'Research implementation',
      details: 'Initial details',
      status: 'pending',
      priority: 'medium',
      tasks: [
        {
          title: 'Task 1',
          description: 'Research task',
          steps: [
            {
              prompt: 'Research step',
              done: false,
            },
          ],
        },
      ],
    };

    const planFile = path.join(tasksDir, '2.yml');
    // Use writePlanFile to ensure proper format
    await writePlanFile(planFile, plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('2', undefined, options, command);

    // Read the updated plan file
    const updatedPlan = await readPlanFile(planFile);

    // Should have appended research to details
    expect(updatedPlan.details).toContain('Initial details');
    expect(updatedPlan.details).toMatch(/# Research \w+ \w+ \d+ \d+/); // Matches date format
    expect(updatedPlan.details).toContain('This is my research findings from investigation.');

    // Should have updated timestamp
    expect(updatedPlan.updatedAt).toBeDefined();

    expect(logSpy).toHaveBeenCalledWith('Plan updated with research results');
  });

  test('handles --rmfilter option with combined arguments', async () => {
    // Create a test plan with rmfilter arguments
    const plan = {
      id: '3',
      title: 'Plan with RMFilter',
      goal: 'Test rmfilter integration',
      details: 'Plan that uses rmfilter',
      status: 'pending',
      priority: 'medium',
      rmfilter: ['src/**/*.ts', '--with-imports'],
      tasks: [
        {
          title: 'Task 1',
          description: 'Task with context',
          steps: [
            {
              prompt: 'Do step with context',
              done: false,
            },
          ],
        },
      ],
    };

    await writePlanFile(path.join(tasksDir, '3.yml'), plan);

    // Mock process.argv to include additional rmfilter args
    const originalArgv = process.argv;
    process.argv = ['node', 'rmplan', 'research', '3', '--rmfilter', '--', 'additional-file.ts'];

    const options = { rmfilter: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    try {
      await handleResearchCommand('3', undefined, options, command);

      // Should have called runRmfilterProgrammatically
      expect(runRmfilterProgrammaticallySpy).toHaveBeenCalledTimes(1);
      const rmfilterCall = runRmfilterProgrammaticallySpy.mock.calls[0];
      const rmfilterArgs = rmfilterCall[0];
      const rmfilterCwd = rmfilterCall[1];

      expect(rmfilterArgs).toContain('--instructions');
      expect(rmfilterArgs).toContain('--bare');
      expect(rmfilterArgs).toContain('src/**/*.ts');
      expect(rmfilterArgs).toContain('--with-imports');
      expect(rmfilterArgs).toContain('additional-file.ts');
      expect(rmfilterCwd).toBe(tempDir);

      // Should have written rmfilter output to clipboard
      expect(clipboardWriteSpy).toHaveBeenCalledWith('rmfilter output');

      expect(logSpy).toHaveBeenCalledWith('Research prompt with context copied to clipboard');
    } finally {
      process.argv = originalArgv;
    }
  });

  test('falls back to clipboard when rmfilter has no arguments', async () => {
    // Create a test plan without rmfilter arguments
    const plan = {
      id: '4',
      title: 'Plan without RMFilter args',
      goal: 'Test fallback behavior',
      details: 'Plan without rmfilter args',
      status: 'pending',
      priority: 'medium',
      tasks: [
        {
          title: 'Task 1',
          description: 'Simple task',
          steps: [
            {
              prompt: 'Do step',
              done: false,
            },
          ],
        },
      ],
    };

    await writePlanFile(path.join(tasksDir, '4.yml'), plan);

    const options = { rmfilter: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('4', undefined, options, command);

    // Should fall back to clipboard write since no rmfilter args
    expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
    expect(logSpawnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Research prompt copied to clipboard');
  });

  test('throws error when plan file does not exist', async () => {
    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(
      handleResearchCommand('nonexistent', undefined, options, command)
    ).rejects.toThrow();
  });

  test('does not update plan when no content is pasted', async () => {
    // Mock waitForEnter to return empty content
    waitForEnterSpy.mockResolvedValue('');

    // Create a test plan
    const plan = {
      id: '5',
      title: 'No Update Plan',
      goal: 'Test no update',
      details: 'Original details',
      status: 'pending',
      priority: 'medium',
      tasks: [
        {
          title: 'Task 1',
          description: 'Task',
          steps: [
            {
              prompt: 'Step',
              done: false,
            },
          ],
        },
      ],
    };

    const planFile = path.join(tasksDir, '5.yml');
    await writePlanFile(planFile, plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('5', undefined, options, command);

    // Read the plan file
    const updatedPlan = await readPlanFile(planFile);

    // Should not have changed
    expect(updatedPlan.details).toBe('Original details');
    expect(logSpy).toHaveBeenCalledWith('No research content was pasted');
  });

  test('generates research prompt with specific research goal', async () => {
    // Create a test plan
    const plan = {
      id: '6',
      title: 'Main Plan',
      goal: 'Build a complete system',
      details: 'System details',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '6.yml');
    await writePlanFile(planFile, plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('6', 'authentication flow', options, command);

    // Should have generated prompt with research goal
    expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
    const promptContent = clipboardWriteSpy.mock.calls[0][0];
    expect(promptContent).toContain('# Research Assistant');
    expect(promptContent).toContain('**Goal**: authentication flow');
    expect(promptContent).toContain('**Overall Project Goal**: Build a complete system');
    expect(promptContent).toContain('**Specific Research Focus**: authentication flow');
  });

  test('generates tutorial prompt with --tutorial flag', async () => {
    // Create a test plan
    const plan = {
      id: '7',
      title: 'Tutorial Plan',
      goal: 'Implement OAuth integration',
      details: 'OAuth details',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '7.yml');
    await writePlanFile(planFile, plan);

    const options = { tutorial: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('7', undefined, options, command);

    // Should have generated tutorial prompt
    expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
    const promptContent = clipboardWriteSpy.mock.calls[0][0];
    expect(promptContent).toContain('# Tutorial Creation Assistant');
    expect(promptContent).toContain('You are acting as a senior engineer creating a tutorial');
    expect(promptContent).toContain('**Goal**: Implement OAuth integration');
    expect(promptContent).toContain('Step-by-Step Implementation');
  });

  test('includes research goal in appended details', async () => {
    // Mock waitForEnter to return sample research
    waitForEnterSpy.mockResolvedValue('Tutorial content here.');

    // Create a test plan
    const plan = {
      id: '8',
      title: 'Goal Details Plan',
      goal: 'Main goal',
      details: 'Original details',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '8.yml');
    await writePlanFile(planFile, plan);

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Mock the date for consistent testing
    const originalDate = Date;
    const mockDate = new Date('2024-01-15');

    try {
      global.Date = class extends Date {
        constructor(...args: any[]) {
          if (args.length === 0) {
            super(mockDate.getTime());
          } else {
            super(...args);
          }
        }
        static now() {
          return mockDate.getTime();
        }
      } as any;

      await handleResearchCommand('8', 'specific research task', options, command);

      // Read the updated plan
      const updatedPlan = await readPlanFile(planFile);

      // Should have appended research with goal in header
      expect(updatedPlan.details).toContain('# Research Mon Jan 15 2024: specific research task');
      expect(updatedPlan.details).toContain('Tutorial content here.');
    } finally {
      // Restore original Date
      global.Date = originalDate;
    }
  });

  test('generates Q&A prompt with --ask flag', async () => {
    // Create a test plan
    const plan = {
      id: '9',
      title: 'Q&A Plan',
      goal: 'Build a chat application',
      details: 'Basic chat app details',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    const planFile = path.join(tasksDir, '9.yml');
    await writePlanFile(planFile, plan);

    const options = { ask: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('9', undefined, options, command);

    // Should have generated Q&A prompt
    expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
    const promptContent = clipboardWriteSpy.mock.calls[0][0];
    expect(promptContent).toContain('# Requirements Gathering Assistant');
    expect(promptContent).toContain('You are acting as a business analyst');
    expect(promptContent).toContain('**Goal**: Build a chat application');
    expect(promptContent).toContain('Ask me one question at a time');
    expect(promptContent).toContain('only one question at a time');
    expect(promptContent).toContain('Begin by asking your first question about this project');
  });
});
