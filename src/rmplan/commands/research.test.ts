import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleResearchCommand } from './research.js';
import { clearPlanCache } from '../plans.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const clipboardWriteSpy = mock(() => {});
const waitForEnterSpy = mock(() => Promise.resolve(''));
const logSpawnSpy = mock(() => ({ exited: Promise.resolve() }));
const sshAwarePasteActionSpy = mock(() => 'paste');

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

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('1', options, command);

    // Should have generated and copied research prompt
    expect(clipboardWriteSpy).toHaveBeenCalledTimes(1);
    const promptContent = clipboardWriteSpy.mock.calls[0][0];
    expect(promptContent).toContain('# Research Prompt for Plan');
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
    await fs.writeFile(planFile, yaml.stringify(plan));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('2', options, command);

    // Read the updated plan file
    const updatedContent = await fs.readFile(planFile, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent);

    // Should have appended research to details
    expect(updatedPlan.details).toContain('Initial details');
    expect(updatedPlan.details).toContain('--- Research ---');
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

    await fs.writeFile(path.join(tasksDir, '3.yml'), yaml.stringify(plan));

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
      await handleResearchCommand('3', options, command);

      // Should have called logSpawn with rmfilter command
      expect(logSpawnSpy).toHaveBeenCalledTimes(1);
      const spawnCall = logSpawnSpy.mock.calls[0];
      const spawnArgs = spawnCall[0];
      const spawnOptions = spawnCall[1];

      expect(spawnArgs[0]).toBe('rmfilter');
      expect(spawnArgs).toContain('--copy');
      expect(spawnArgs).toContain('--instructions');
      expect(spawnArgs).toContain('src/**/*.ts');
      expect(spawnArgs).toContain('--with-imports');
      expect(spawnArgs).toContain('additional-file.ts');
      expect(spawnOptions.cwd).toBe(tempDir);

      expect(logSpy).toHaveBeenCalledWith(
        'Research prompt with context copied to clipboard via rmfilter'
      );
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

    await fs.writeFile(path.join(tasksDir, '4.yml'), yaml.stringify(plan));

    const options = { rmfilter: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('4', options, command);

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

    await expect(handleResearchCommand('nonexistent', options, command)).rejects.toThrow();
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
    await fs.writeFile(planFile, yaml.stringify(plan));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleResearchCommand('5', options, command);

    // Read the plan file
    const updatedContent = await fs.readFile(planFile, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent);

    // Should not have changed
    expect(updatedPlan.details).toBe('Original details');
    expect(logSpy).toHaveBeenCalledWith('No research content was pasted');
  });
});
