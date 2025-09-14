import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ModuleMocker } from '../../../testing.js';

const tempDirs: string[] = [];

async function createTempRepoWithPlan(): Promise<{
  repoDir: string;
  planPath: string;
  relPlanPath: string;
}> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-int-'));
  tempDirs.push(repoDir);
  const planPath = path.join(repoDir, 'test.plan.yml');
  const planContent = `
id: 1
title: Integration Plan
status: pending
tasks:
  - title: Do something
    description: desc
    steps:
      - prompt: Write code
        done: false
`;
  await fs.writeFile(planPath, planContent, 'utf8');
  return { repoDir, planPath, relPlanPath: path.relative(repoDir, planPath) };
}

describe('rmplanAgent integration summary', () => {
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(() => {
    moduleMocker.clear();
  });

  afterEach(async () => {
    moduleMocker.clear();
    // Clean up temp dirs
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });

  test('serial mode: collects step output and changed files, writes summary', async () => {
    const { repoDir, planPath, relPlanPath } = await createTempRepoWithPlan();

    // Capture the produced summary for assertions
    const captured: { summary?: any; file?: string } = {};

    // Mock config loader with correct shape
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ defaultExecutor: 'codex-cli' })),
    }));

    // Use real plan file IO for this integration test
    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      findNextPlan: mock(async () => null),
    }));

    // Use real marking but avoid actual VCS commit
    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: mock(async () => 0),
    }));

    // Provide a simple executor that returns a combined codex-style output
    const executorExecuteSpy = mock(async () => {
      return [
        '=== Codex Implementer ===',
        'Implemented changes successfully',
        '=== Codex Tester ===',
        'All tests passed',
        '=== Codex Reviewer ===',
        'ACCEPTABLE',
      ].join('\n');
    });
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecuteSpy, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => undefined),
    }));

    // Capture initial contents to validate real change tracking
    const initialContent = await fs.readFile(planPath, 'utf8');
    // Mock git helpers used by summary collector and mark_done
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => repoDir),
      getCurrentCommitHash: mock(async () => 'BASE'),
      getChangedFilesBetween: mock(async () => {
        const after = await fs.readFile(planPath, 'utf8');
        return after !== initialContent ? [relPlanPath] : [];
      }),
      getChangedFilesOnBranch: mock(async () => {
        const after = await fs.readFile(planPath, 'utf8');
        return after !== initialContent ? [relPlanPath] : [];
      }),
      getTrunkBranch: mock(async () => 'main'),
      getUsingJj: mock(async () => false),
      hasUncommittedChanges: mock(async () => true),
    }));

    // Capture summary argument
    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async (summary: any, filePath?: string) => {
        captured.summary = summary;
        captured.file = filePath;
      }),
    }));

    // Quiet logs to keep test output clean
    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
      log: (..._args: any[]) => {},
      error: (..._args: any[]) => {},
      warn: (..._args: any[]) => {},
    }));

    const { rmplanAgent } = await import('./agent.js');

    await rmplanAgent(planPath, { summary: true, log: false, serialTasks: true }, {});

    // Executor ran once
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);

    // Summary was produced and contains our content and changed file
    expect(captured.summary).toBeDefined();
    expect(captured.summary.mode).toBe('serial');
    expect(captured.summary.steps.length).toBe(1);
    expect(captured.summary.steps[0].success).toBeTrue();
    const out = captured.summary.steps[0].output?.content ?? '';
    expect(String(out)).toContain('Implementer');
    expect(String(out)).toContain('Tester');
    expect(String(out)).toContain('Reviewer');
    // Verify plan metadata and timings present
    expect(captured.summary.planId).toBe('1');
    expect(captured.summary.planTitle).toBe('Integration Plan');
    expect(typeof captured.summary.startedAt).toBe('string');
    expect(typeof captured.summary.endedAt).toBe('string');
    expect(typeof captured.summary.durationMs).toBe('number');
    expect(captured.summary.metadata.totalSteps).toBe(1);
    expect(captured.summary.metadata.failedSteps).toBe(0);
    // Verify changed files include the plan (validated via real file change)
    expect(captured.summary.changedFiles).toContain(relPlanPath);
  });

  test('batch mode: aggregates multiple step results and failures', async () => {
    const { repoDir, planPath, relPlanPath } = await createTempRepoWithPlan();

    const captured: { summary?: any } = {};

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ defaultExecutor: 'codex-cli' })),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      findNextPlan: mock(async () => null),
    }));

    // Mock executeBatchMode to simulate two iterations with one failure
    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: mock(async (_opts: any, summaryCollector?: any) => {
        summaryCollector?.setBatchIterations(2);
        summaryCollector?.addStepResult({
          title: 'Batch Iteration 1',
          executor: 'codex-cli',
          success: true,
          output: { content: 'OK 1' },
          durationMs: 100,
        });
        summaryCollector?.addStepResult({
          title: 'Batch Iteration 2',
          executor: 'codex-cli',
          success: false,
          errorMessage: 'Timeout',
          output: { content: 'Failed' },
          durationMs: 200,
        });
        return { success: false };
      }),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => repoDir),
      getCurrentCommitHash: mock(async () => 'BASE'),
      getChangedFilesBetween: mock(async () => []),
      getChangedFilesOnBranch: mock(async () => []),
      getTrunkBranch: mock(async () => 'main'),
      getUsingJj: mock(async () => false),
      hasUncommittedChanges: mock(async () => true),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({
        execute: mock(async () => 'IGNORED'),
        filePathPrefix: '',
      })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => undefined),
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async (summary: any) => {
        captured.summary = summary;
      }),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
      log: (..._args: any[]) => {},
      error: (..._args: any[]) => {},
      warn: (..._args: any[]) => {},
    }));

    const { rmplanAgent } = await import('./agent.js');

    await rmplanAgent(planPath, { summary: true, log: false, serialTasks: false }, {});

    expect(captured.summary).toBeDefined();
    expect(captured.summary.mode).toBe('batch');
    expect(captured.summary.steps.length).toBe(2);
    expect(captured.summary.metadata.totalSteps).toBe(2);
    expect(captured.summary.metadata.failedSteps).toBe(1);
    // Batch branch does not track file changes in rmplanAgent's finally block
    expect(captured.summary.steps[1].errorMessage || '').toContain('Timeout');
  });

  test('serial mode: writes summary to file and clamps large output', async () => {
    const { repoDir, planPath } = await createTempRepoWithPlan();

    // Large output to trigger truncation in collector
    const big = 'X'.repeat(150_000);
    const executorExecuteSpy = mock(async () => `Implementer\n${big}`);

    // Mock config and minimal plan plumbing
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ defaultExecutor: 'codex-cli' })),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      findNextPlan: mock(async () => null),
    }));

    // Marking done will modify the plan file
    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: mock(async () => ({ message: 'ok', planComplete: false })),
      markTaskDone: mock(async () => ({ planComplete: false })),
    }));

    // Prepare a single-step selection
    let once = false;
    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => {
        if (once) return null;
        once = true;
        return {
          type: 'step',
          taskIndex: 0,
          stepIndex: 0,
          task: { title: 'T', description: 'D', steps: [{ prompt: 'p', done: false }] },
        };
      }),
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CTX',
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecuteSpy, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => repoDir),
      getCurrentCommitHash: mock(async () => 'BASE'),
      getChangedFilesBetween: mock(async () => []),
      getChangedFilesOnBranch: mock(async () => []),
      getTrunkBranch: mock(async () => 'main'),
      getUsingJj: mock(async () => false),
      hasUncommittedChanges: mock(async () => true),
    }));

    // Quiet logs
    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
      log: (..._args: any[]) => {},
      error: (..._args: any[]) => {},
      warn: (..._args: any[]) => {},
    }));

    const outFile = path.join(repoDir, 'summary.txt');
    const { rmplanAgent } = await import('./agent.js');
    await rmplanAgent(
      planPath,
      { summary: true, summaryFile: outFile, log: false, serialTasks: true },
      {}
    );

    // Verify file is written and includes header and truncation marker (collector truncates at 100k)
    const content = await fs.readFile(outFile, 'utf8');
    expect(content).toContain('Execution Summary: Integration Plan');
    expect(content).toContain('Step Results');
    expect(content).toContain('… truncated (showing first');
  });

  test('serial mode: executor throws, summary records failed step and error', async () => {
    const { repoDir, planPath, relPlanPath } = await createTempRepoWithPlan();

    const failingExecuteSpy = mock(async () => {
      throw new Error('boom');
    });

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ defaultExecutor: 'codex-cli' })),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      findNextPlan: mock(async () => null),
    }));

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => ({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Ti', description: 'Di', steps: [{ prompt: 'p', done: false }] },
      })),
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CTX',
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: failingExecuteSpy, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => undefined),
    }));

    // Track file changes from the plan update attempt (there may be none since it fails before mark)
    const initial = await fs.readFile(planPath, 'utf8');
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => repoDir),
      getCurrentCommitHash: mock(async () => 'BASE'),
      getChangedFilesBetween: mock(async () => {
        const after = await fs.readFile(planPath, 'utf8');
        return after !== initial ? [relPlanPath] : [];
      }),
      getChangedFilesOnBranch: mock(async () => []),
      getTrunkBranch: mock(async () => 'main'),
      getUsingJj: mock(async () => false),
      hasUncommittedChanges: mock(async () => true),
    }));

    // Capture summary
    const captured: { summary?: any } = {};
    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async (summary: any) => {
        captured.summary = summary;
      }),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
      log: (..._args: any[]) => {},
      error: (..._args: any[]) => {},
      warn: (..._args: any[]) => {},
    }));

    const { rmplanAgent } = await import('./agent.js');
    await expect(
      rmplanAgent(planPath, { summary: true, log: false, serialTasks: true }, {})
    ).rejects.toThrow();

    expect(failingExecuteSpy).toHaveBeenCalledTimes(1);
    expect(captured.summary).toBeDefined();
    const step = captured.summary.steps[0];
    expect(step.success).toBeFalse();
    expect(String(step.errorMessage || '')).toContain('boom');
  });
});
