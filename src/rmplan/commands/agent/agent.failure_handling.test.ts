import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

describe('rmplanAgent - serial mode failure handling', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-failure-serial-'));
    await fs.mkdir(path.join(tempDir, 'tasks'), { recursive: true });
    planFile = path.join(tempDir, 'tasks', 'p.yml');
    const content = `---\nid: 1\ntitle: P\ngoal: G\ndetails: D\ntasks:\n  - title: T1\n    description: Desc\n    steps:\n      - prompt: do it\n---\n`;
    await fs.writeFile(planFile, content);
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('executor failure stops loop, prints details, and does not mark step done', async () => {
    // Mock config + summary handling
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ models: {}, postApplyCommands: [] })),
    }));

    await moduleMocker.mock('../../summary/collector.js', () => ({
      SummaryCollector: class {
        recordExecutionStart = mock(() => {});
        recordExecutionEnd = mock(() => {});
        addStepResult = mock(() => {});
        addError = mock(() => {});
        trackFileChanges = mock(async () => {});
        getExecutionSummary = mock(() => ({ steps: [], changedFiles: [], errors: [] }));
        constructor(_init: any) {}
      },
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {}),
    }));

    // Mock git
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    // Mock find_next to yield one actionable step
    let yielded = false;
    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => {
        if (yielded) return null;
        yielded = true;
        return {
          type: 'step',
          taskIndex: 0,
          stepIndex: 0,
          task: { title: 'T1', description: '', steps: [{ prompt: 'do it', done: false }] },
        };
      }),
    }));

    // PrepareNextStep returns a direct prompt
    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CTX',
        promptFilePath: undefined,
        rmfilterArgs: undefined,
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    // Spy that should NOT be called due to failure
    const markStepDoneSpy = mock(async () => ({ planComplete: false, message: 'ok' }));
    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
      markTaskDone: mock(async () => ({ planComplete: false })),
    }));

    // Mock executors index to return a failing executor output
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({
        filePathPrefix: '',
        prepareStepOptions: () => ({}),
        execute: async () => ({
          content: 'FAILED: Something is impossible\nProblems:\n- details',
          success: false,
          failureDetails: {
            requirements: '',
            problems: 'details',
            sourceAgent: 'implementer',
          },
        }),
      })),
      DEFAULT_EXECUTOR: 'codex_cli',
      defaultModelForExecutor: mock(() => undefined),
    }));

    // Silence logs
    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    const { rmplanAgent } = await import('./agent.ts');
    await expect(
      rmplanAgent(planFile, { summary: true, log: false, serialTasks: true }, {})
    ).rejects.toThrow('Agent stopped due to error.');

    // Ensure we did not mark the step as done
    expect(markStepDoneSpy).not.toHaveBeenCalled();
  });
});
