import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';

// We'll import timAgent lazily after setting up module mocks
let timAgent: typeof import('./agent.js').timAgent;

describe('tim agent integration (timeout simulation)', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let originalCwd: string;
  let moduleMocker: ModuleMocker;
  const logSink = mock(() => {});

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-timeout-'));
    process.chdir(tempDir);
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Initialize a real git repo for file-change tracking
    await Bun.spawn(['git', 'init', '-b', 'main'], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'config', 'user.name', 'Test User'], { cwd: tempDir }).exited;

    // Seed a tracked file for file-change tracking
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'foo.txt'), 'initial\n');
    await Bun.spawn(['git', 'add', '.'], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir }).exited;

    // Create config file
    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: { tasks: 'tasks' },
      }),
      'utf8'
    );

    // Mock logging to keep output quiet and deterministic
    moduleMocker = new ModuleMocker(import.meta);
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSink,
      error: logSink,
      warn: logSink,
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: () => {},
      closeLogFile: async () => {},
    }));

    // Ensure git root resolves to our temp directory
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getUsingJj: mock(async () => false),
    }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
    logSink.mockReset();
  });

  test('captures failed step and error message when executor times out', async () => {
    const plan = {
      id: 707,
      title: 'Timeout Plan',
      goal: 'Simulate executor timeout',
      details: 'Verify summary captures timeout error',
      status: 'in_progress',
      tasks: [
        {
          title: 'Timeout Task',
          description: 'Will time out',
          done: false,
          steps: [{ prompt: 'Simulate timeout', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '707.yml');
    const { details, ...planWithoutDetails } = plan;
    let planContent = `---\n${yaml.stringify(planWithoutDetails)}---\n`;
    if (details) {
      planContent += `\n${details}\n`;
    }
    await fs.writeFile(planPath, planContent, 'utf8');

    // Register a stub executor that throws a timeout-like error
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubTimeoutExecutor {
        static name = 'stub-timeout';
        static description = 'Stub executor that simulates a timeout';
        static optionsSchema = z.object({});
        async execute(): Promise<string> {
          throw new Error('permission prompt timeout');
        }
      }
      executors.set(StubTimeoutExecutor.name, StubTimeoutExecutor as any);
    }

    ({ timAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'timeout-summary.txt');
    await expect(
      timAgent(
        planPath,
        { executor: 'stub-timeout', serialTasks: true, summaryFile: summaryOut, model: 'auto' },
        { config: configPath }
      )
    ).rejects.toBeInstanceOf(Error);

    const content = await fs.readFile(summaryOut, 'utf8');
    expect(content).toContain('Execution Summary: Timeout Plan');
    // Failed step recorded
    expect(content).toMatch(/Failed Steps[\s\S]*1/);
    // Error message included in steps/errors
    expect(content).toContain('permission prompt timeout');
  });
});
