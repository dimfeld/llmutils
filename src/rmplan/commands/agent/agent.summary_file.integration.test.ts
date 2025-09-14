import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';

// This test specifically verifies that rmplanAgent writes a summary file in batch mode
// using the real summary display module (no mock), ensuring on-disk content is formatted.

const moduleMocker = new ModuleMocker(import.meta);

let tempDir: string;
let planFile: string;
let summaryOut: string;

async function createPlanFile(filePath: string, planData: any) {
  const schemaComment =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
  await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
}

describe('rmplanAgent - summary file write (batch mode)', () => {
  beforeEach(async () => {
    // Temp dir + plan
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-summary-file-int-'));
    planFile = path.join(tempDir, 'plan.yml');
    summaryOut = path.join(tempDir, 'out', 'summary.txt');

    // Quiet logs to avoid noisy output; keep interfaces intact
    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
      boldMarkdownHeaders: (s: string) => s,
    }));

    // Minimal config and git environment
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ models: { execution: 'test-model' } })),
    }));
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getChangedFilesOnBranch: mock(async () => ['src/a.ts']),
      getCurrentCommitHash: mock(async () => 'rev-0'),
      getChangedFilesBetween: mock(async () => ['src/a.ts']),
      getUsingJj: mock(async () => true),
      hasUncommittedChanges: mock(async () => true),
    }));

    // Real summary display is used: DO NOT mock '../../summary/display.js'

    // Plan IO uses real FS in temp dir
    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      readPlanFile: mock(async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf8');
        return yaml.parse(content.replace(/^#.*\n/, ''));
      }),
      writePlanFile: mock(async (filePath: string, data: any) => {
        await createPlanFile(filePath, data);
      }),
      clearPlanCache: mock(() => {}),
    }));

    // Prompt builder used by batch mode to construct prompt; keep simple
    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'BATCH PROMPT'),
    }));

    // Prepare initial plan with two incomplete tasks to force batch iterations
    await createPlanFile(planFile, {
      id: 551,
      title: 'Batch Plan',
      goal: 'Run multiple tasks',
      details: 'Batch summary file test',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [
        { title: 'Task A', description: 'A', steps: [{ prompt: 'Do A', done: false }] },
        { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
      ],
    });
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes a formatted summary file including mode and step counts', async () => {
    // Executor that marks tasks done across two iterations
    let call = 0;
    const executorExecute = mock(async () => {
      call++;
      if (call === 1) {
        // After first batch run, mark Task A done
        await createPlanFile(planFile, {
          id: 551,
          title: 'Batch Plan',
          goal: 'Run multiple tasks',
          details: 'Batch summary file test',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            { title: 'Task A', description: 'A', steps: [{ prompt: 'Do A', done: true }], done: true },
            { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
          ],
        });
        return 'Batch iteration 1 complete';
      } else {
        // After second run, all tasks done
        await createPlanFile(planFile, {
          id: 551,
          title: 'Batch Plan',
          goal: 'Run multiple tasks',
          details: 'Batch summary file test',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            { title: 'Task A', description: 'A', steps: [{ prompt: 'Do A', done: true }], done: true },
            { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: true }], done: true },
          ],
        });
        return 'Batch iteration 2 complete';
      }
    });

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecute, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    const { rmplanAgent } = await import('./agent.js');
    const options: any = { log: false, executor: 'codex-cli', summaryFile: summaryOut };
    await rmplanAgent(planFile, options, {});

    // Verify file written and contains key elements
    const content = await fs.readFile(summaryOut, 'utf8');
    expect(content).toContain('Execution Summary: Batch Plan');
    // Table section should include Mode and batch
    expect(content).toContain('Mode');
    expect(content).toContain('batch');
    // Should reflect two steps executed (two iterations)
    expect(content).toMatch(/Steps Executed[\s\S]*2/);
    // Batch iteration titles appear in Step Results
    expect(content).toContain('Batch Iteration 1');
    expect(content).toContain('Batch Iteration 2');
  });
});

