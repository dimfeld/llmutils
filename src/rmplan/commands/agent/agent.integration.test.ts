import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ModuleMocker } from '../../../testing.js';

async function createTempRepoWithPlan(): Promise<{
  repoDir: string;
  planPath: string;
  relPlanPath: string;
}> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-int-'));
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

  afterEach(() => {
    moduleMocker.clear();
  });

  test('serial mode: collects step output and changed files, writes summary', async () => {
    const { repoDir, planPath, relPlanPath } = await createTempRepoWithPlan();

    // Capture the produced summary for assertions
    const captured: { summary?: any; file?: string } = {};

    // Mock config loader
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ executors: { default: 'codex-cli' } })),
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

    // Mock git helpers used by summary collector and mark_done
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => repoDir),
      getCurrentCommitHash: mock(async () => 'BASE'),
      getChangedFilesBetween: mock(async () => [relPlanPath]),
      getChangedFilesOnBranch: mock(async () => [relPlanPath]),
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
    expect(Array.isArray(captured.summary.changedFiles)).toBeTrue();
    // Batch branch does not call trackFileChanges; changed files may be empty here
  });

  test('batch mode: aggregates multiple step results and failures', async () => {
    const { repoDir, planPath, relPlanPath } = await createTempRepoWithPlan();

    const captured: { summary?: any } = {};

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ executors: { default: 'codex-cli' } })),
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
      getChangedFilesBetween: mock(async () => [relPlanPath]),
      getChangedFilesOnBranch: mock(async () => [relPlanPath]),
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
});
