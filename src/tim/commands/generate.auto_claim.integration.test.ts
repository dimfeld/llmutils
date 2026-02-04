import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleGenerateCommand auto-claim integration', () => {
  let tempRoot: string;
  let tasksDir: string;
  let planPath: string;

  const autoClaimPlanSpy = mock(async () => ({ result: { persisted: true } }));
  const resolvePlanWithUuidSpy = mock(async () => ({
    plan: {
      id: 42,
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      title: 'Auto-claim plan',
      goal: 'Demonstrate auto-claim',
      details: '',
      status: 'pending',
      tasks: [],
      filename: planPath,
    },
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  }));

  let handleGenerateCommand: typeof import('./generate.js').handleGenerateCommand;
  let enableAutoClaim: () => void;
  let disableAutoClaim: () => void;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-generate-auto-claim-'));
    tasksDir = path.join(tempRoot, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planPath = path.join(tasksDir, '42-auto.plan.md');
    await fs.writeFile(
      planPath,
      `id: 42\nstatus: pending\ntitle: Auto-claim plan\ngoal: Demo\ntasks: []\n`
    );

    autoClaimPlanSpy.mockClear();
    resolvePlanWithUuidSpy.mockClear();

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
      }),
    }));

    await moduleMocker.mock('../assignments/auto_claim.js', () => {
      let enabled = false;
      return {
        autoClaimPlan: mock(async (...args: unknown[]) => {
          if (!enabled) {
            throw new Error('autoClaimPlan invoked while disabled');
          }
          return autoClaimPlanSpy(...args);
        }),
        enableAutoClaim: () => {
          enabled = true;
        },
        disableAutoClaim: () => {
          enabled = false;
        },
        isAutoClaimEnabled: () => enabled,
        isAutoClaimDisabled: () => !enabled,
      };
    });

    await moduleMocker.mock('../assignments/uuid_lookup.ts', () => ({
      resolvePlanWithUuid: resolvePlanWithUuidSpy,
    }));

    await moduleMocker.mock('../process_markdown.ts', () => ({
      extractMarkdownToYaml: mock(async () => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: mock(() => ({ exited: Promise.resolve(0) })),
    }));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: mock(async () => 'id: 42\ntasks: []'),
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: mock(async () => {}),
      read: mock(async () => ''),
    }));

    await moduleMocker.mock('../../common/run_and_apply.js', () => ({
      runStreamingPrompt: mock(async () => ({ text: 'generated-plan' })),
    }));

    ({ handleGenerateCommand } = await import('./generate.js'));
    ({ enableAutoClaim, disableAutoClaim } = await import('../assignments/auto_claim.js'));
    disableAutoClaim();
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('invokes autoClaimPlan when enabled', async () => {
    enableAutoClaim();

    const options = {
      plan: planPath,
      extract: true,
      claude: false,
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: [],
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(autoClaimPlanSpy).toHaveBeenCalledTimes(1);
    const callArgs = autoClaimPlanSpy.mock.calls[0]?.[0];
    expect(callArgs?.uuid).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(resolvePlanWithUuidSpy).toHaveBeenCalled();
  });
});
