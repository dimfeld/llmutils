import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';

// We'll import rmplanAgent lazily after setting up module mocks
let rmplanAgent: typeof import('./agent.js').rmplanAgent;

describe('rmplan agent integration (execution summary)', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let originalCwd: string;
  let moduleMocker: ModuleMocker;
  const logSink = mock(() => {});

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-integration-'));
    process.chdir(tempDir);
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Initialize a real git repo for file-change tracking and commits
    await Bun.spawn(['git', 'init', '-b', 'main'], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'config', 'user.name', 'Test User'], { cwd: tempDir }).exited;

    // Seed a tracked file that we will modify during execution
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'foo.txt'), 'initial\n');
    await Bun.spawn(['git', 'add', '.'], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir }).exited;

    // Create config file
    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: { tasks: 'tasks' },
      }),
      'utf8'
    );

    // Mock logging to keep output quiet and make assertions easier
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
      // Leave other functions to their originals by not overriding them here
    }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
    logSink.mockReset();
  });

  test('serial mode captures Codex CLI sections and tracks file changes', async () => {
    // Create a simple plan with one task/step
    const plan = {
      id: 101,
      title: 'Serial Summary Plan',
      goal: 'Test serial execution summary',
      details: 'Ensure summary captures outputs',
      status: 'in_progress',
      tasks: [
        {
          title: 'Implement feature',
          description: 'Do the thing',
          done: false,
          steps: [{ prompt: 'Make the change', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '101.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');
    // Track the plan file so later commits include it
    await Bun.spawn(['git', 'add', planPath], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'commit', '-m', 'Add plan file'], { cwd: tempDir }).exited;

    // Register a stub executor dynamically
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubCodexExecutor {
        static name = 'codex-cli';
        static description = 'Stub Codex-like executor for tests';
        static optionsSchema = z.object({});
        constructor(
          _opts: any,
          private shared: any
        ) {}
        async execute(): Promise<string> {
          const target = path.join(this.shared.baseDir, 'src', 'foo.txt');
          await fs.writeFile(target, 'modified by codex\n', 'utf8');
          return [
            '=== Codex Implementer ===',
            'Created new module',
            '=== Codex Tester ===',
            'All tests passed',
            '=== Codex Reviewer ===',
            'Looks good to ship',
          ].join('\n');
        }
      }
      executors.set('codex-cli', StubCodexExecutor as any);
    }

    // Import after mocks are set up
    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'serial-summary.txt');
    await rmplanAgent(
      planPath,
      { executor: 'codex-cli', serialTasks: true, summaryFile: summaryOut, model: 'auto' },
      { config: configPath }
    );

    const summary = await fs.readFile(summaryOut, 'utf8');
    // Header and metadata
    expect(summary).toContain('Execution Summary: Serial Summary Plan');
    expect(summary).toContain('Mode');
    expect(summary).toContain('Steps Executed');
    // Step result label and parsed sections
    expect(summary).toContain('Step 1');
    expect(summary).toContain('Implementer:');
    expect(summary).toContain('Tester:');
    expect(summary).toContain('Reviewer:');
    // Changed files include our modified file and the plan file
    expect(summary).toMatch(/src\/foo\.txt/);
    expect(summary).toMatch(/tasks\/101\.yml/);
  });

  test('batch mode captures Claude final message and aggregates steps', async () => {
    // Create a plan with multiple tasks to trigger batch mode prompt
    const plan = {
      id: 202,
      title: 'Batch Summary Plan',
      goal: 'Test batch execution summary',
      details: 'Ensure summary aggregates batch iterations',
      status: 'pending',
      tasks: [
        {
          title: 'Task A',
          description: 'A',
          done: false,
          steps: [{ prompt: 'Do A1', done: false }],
        },
        {
          title: 'Task B',
          description: 'B',
          done: false,
          steps: [{ prompt: 'Do B1', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '202.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');
    // Track the plan file so later commits include it
    await Bun.spawn(['git', 'add', planPath], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'commit', '-m', 'Add plan file'], { cwd: tempDir }).exited;

    // Register a stub Claude-like executor that marks tasks done and writes a file
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubClaudeExecutor {
        static name = 'claude-code';
        static description = 'Stub Claude-like executor for tests';
        static optionsSchema = z.object({});
        constructor(
          _opts: any,
          private shared: any
        ) {}
        async execute(_context: string, planInfo: any): Promise<string> {
          // Use project helpers to safely parse/write plan files with front-matter
          const { readPlanFile, writePlanFile } = await import('../../plans.js');
          const node: any = await readPlanFile(planInfo.planFilePath);
          for (const t of node.tasks || []) {
            t.done = true;
            for (const s of t.steps || []) s.done = true;
          }
          await writePlanFile(planInfo.planFilePath, node);
          await fs.writeFile(
            path.join(this.shared.baseDir, 'src', 'foo.txt'),
            'modified by claude\n',
            'utf8'
          );
          return 'Final orchestrator message: done.';
        }
      }
      executors.set('claude-code', StubClaudeExecutor as any);
    }

    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'batch-summary.txt');
    try {
      await rmplanAgent(
        planPath,
        { executor: 'claude-code', /* batch is default */ summaryFile: summaryOut, model: 'auto' },
        { config: configPath }
      );
    } catch (e) {
      // Some flows may stop batch mode with an error after execution; summary still gets written
    }

    const summary = await fs.readFile(summaryOut, 'utf8');
    expect(summary).toContain('Execution Summary: Batch Summary Plan');
    expect(summary).toContain('Mode');
    // Should show one or more batch iterations
    expect(summary).toMatch(/Batch Iteration\s+1/);
    expect(summary).toContain('Final orchestrator message: done.');
    // Changed files include our modified file and the plan file
    expect(summary).toMatch(/src\/foo\.txt/);
    expect(summary).toMatch(/tasks\/202\.yml/);
  });

  test('records failed step and error on executor throw', async () => {
    const plan = {
      id: 303,
      title: 'Error Summary Plan',
      goal: 'Test error handling',
      details: 'Ensure errors appear in summary',
      status: 'in_progress',
      tasks: [
        {
          title: 'Throwing Task',
          description: 'Will fail',
          done: false,
          steps: [{ prompt: 'Try and fail', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '303.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');

    // Register a throwing stub executor
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubThrowExecutor {
        static name = 'stub-throw';
        static description = 'Stub executor that throws';
        static optionsSchema = z.object({});
        constructor(_opts: any) {}
        async execute(): Promise<string> {
          throw new Error('executor boom');
        }
      }
      executors.set(StubThrowExecutor.name, StubThrowExecutor as any);
    }

    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'error-summary.txt');
    await expect(
      rmplanAgent(
        planPath,
        { executor: 'stub-throw', serialTasks: true, summaryFile: summaryOut, model: 'auto' },
        { config: configPath }
      )
    ).rejects.toBeInstanceOf(Error);

    const summary = await fs.readFile(summaryOut, 'utf8');
    expect(summary).toContain('Execution Summary: Error Summary Plan');
    expect(summary).toContain('Failed Steps');
    expect(summary).toMatch(/✖/); // failure marker in steps
    expect(summary).toContain('executor boom');
  });

  test('honors --no-summary by not writing or printing a summary', async () => {
    const plan = {
      id: 404,
      title: 'No Summary Plan',
      goal: 'Verify summary can be disabled',
      details: 'Ensure --no-summary suppresses output',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task',
          description: 'Do it',
          done: false,
          steps: [{ prompt: 'Do it', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '404.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');

    // Minimal stub executor that returns output which would normally be summarized
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubEchoExecutor {
        static name = 'stub-echo';
        static description = 'Echoes a short message';
        static optionsSchema = z.object({});
        async execute(): Promise<string> {
          return 'Executor finished successfully';
        }
      }
      executors.set(StubEchoExecutor.name, StubEchoExecutor as any);
    }

    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'no-summary.txt');

    await rmplanAgent(
      planPath,
      {
        executor: 'stub-echo',
        serialTasks: true,
        summary: false,
        summaryFile: summaryOut,
        model: 'auto',
      },
      { config: configPath }
    );

    // Should not write a file
    await expect(fs.access(summaryOut)).rejects.toBeTruthy();
    // And should not print the summary header via logging either
    const printed = logSink.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed.includes('Execution Summary:')).toBeFalse();
  });

  test('RMPLAN_SUMMARY_ENABLED=0 disables summary collection even with summaryFile', async () => {
    const plan = {
      id: 505,
      title: 'Env Disabled Summary Plan',
      goal: 'Respect env var to disable summaries',
      details: 'Ensure env var disables summaries',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple Task',
          description: 'Do it',
          done: false,
          steps: [{ prompt: 'Do it', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '505.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');

    // Long-output stub to prove collector would have truncated content if enabled
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubBigOutputExecutor {
        static name = 'stub-big';
        static description = 'Produces very large output';
        static optionsSchema = z.object({});
        async execute(): Promise<string> {
          return 'X'.repeat(300_000); // Would trigger collector truncation if enabled
        }
      }
      executors.set(StubBigOutputExecutor.name, StubBigOutputExecutor as any);
    }

    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'env-disabled.txt');
    const prev = process.env.RMPLAN_SUMMARY_ENABLED;
    try {
      process.env.RMPLAN_SUMMARY_ENABLED = '0';
      await rmplanAgent(
        planPath,
        { executor: 'stub-big', serialTasks: true, summaryFile: summaryOut, model: 'auto' },
        { config: configPath }
      );
    } finally {
      if (prev == null) delete process.env.RMPLAN_SUMMARY_ENABLED;
      else process.env.RMPLAN_SUMMARY_ENABLED = prev;
    }

    // No file written and no printed summary header
    await expect(fs.access(summaryOut)).rejects.toBeTruthy();
    const printed = logSink.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed.includes('Execution Summary:')).toBeFalse();
  });

  test('very large executor output is truncated with collector notice in file output', async () => {
    const plan = {
      id: 606,
      title: 'Truncate Integration Plan',
      goal: 'Ensure truncation notice appears in integration path',
      details: 'Large output should be truncated by collector',
      status: 'in_progress',
      tasks: [
        {
          title: 'Big Output Task',
          description: 'Generate huge output',
          done: false,
          steps: [{ prompt: 'Do big', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '606.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');

    // Stub that returns very large text
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubHugeExecutor {
        static name = 'stub-huge';
        static description = 'Huge output';
        static optionsSchema = z.object({});
        async execute(): Promise<string> {
          return 'A'.repeat(300_000);
        }
      }
      executors.set(StubHugeExecutor.name, StubHugeExecutor as any);
    }

    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'truncate-summary.txt');
    await rmplanAgent(
      planPath,
      { executor: 'stub-huge', serialTasks: true, summaryFile: summaryOut, model: 'auto' },
      { config: configPath }
    );

    const summary = await fs.readFile(summaryOut, 'utf8');
    // Collector-level truncation notice should be present with explicit lengths
    expect(summary).toMatch(/… truncated \(showing first 100000 of 300000 chars\)/);
  });

  test('prints execution summary to stdout when no summaryFile is provided', async () => {
    const plan = {
      id: 707,
      title: 'Stdout Summary Plan',
      goal: 'Print summary to stdout',
      details: 'No summary file specified',
      status: 'in_progress',
      tasks: [
        {
          title: 'Simple',
          description: 'Just run',
          done: false,
          steps: [{ prompt: 'run', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '707.yml');
    await fs.writeFile(planPath, yaml.stringify(plan), 'utf8');

    // Minimal stub executor
    {
      const { executors } = await import('../../executors/build.ts');
      const { z } = await import('zod/v4');
      class StubStdoutExecutor {
        static name = 'stub-stdout';
        static description = 'Emits small output';
        static optionsSchema = z.object({});
        async execute(): Promise<string> {
          return 'ok';
        }
      }
      executors.set(StubStdoutExecutor.name, StubStdoutExecutor as any);
    }

    ({ rmplanAgent } = await import('./agent.js'));

    await rmplanAgent(
      planPath,
      { executor: 'stub-stdout', serialTasks: true, model: 'auto' },
      { config: configPath }
    );

    const printed = logSink.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('Execution Summary: Stdout Summary Plan');
    // Ensure we did not log a file write notice
    expect(printed).not.toContain('Execution summary written to:');
  });
  test('does not write a summary file if plan parsing fails early', async () => {
    const badPlanPath = path.join(tasksDir, 'bad.yml');
    await fs.writeFile(badPlanPath, 'this: is: not: valid: yaml: [', 'utf8');

    // Ensure file is tracked so any accidental writes would be visible
    await Bun.spawn(['git', 'add', badPlanPath], { cwd: tempDir }).exited;
    await Bun.spawn(['git', 'commit', '-m', 'Add bad plan'], { cwd: tempDir }).exited;

    ({ rmplanAgent } = await import('./agent.js'));

    const summaryOut = path.join(tempDir, 'out', 'should-not-exist.txt');
    await expect(
      rmplanAgent(
        badPlanPath,
        { executor: 'codex-cli', serialTasks: true, summaryFile: summaryOut, model: 'auto' },
        { config: configPath }
      )
    ).rejects.toBeInstanceOf(Error);

    // Since the plan failed to parse before summary collection initialized,
    // no summary file should be present
    await expect(fs.access(summaryOut)).rejects.toBeTruthy();
  });
});
