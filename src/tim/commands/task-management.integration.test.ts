import { describe, test, beforeEach, afterEach, expect, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker, clearAllTimCaches } from '../../testing.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { resolvePlan } from '../plan_display.js';
import { handleAddTaskCommand } from './add-task.js';
import { handleRemoveTaskCommand } from './remove-task.js';
import { handleShowCommand } from './show.js';
import { getDefaultConfig } from '../configSchema.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { closeDatabaseForTesting } from '../db/database.js';
import {
  addPlanTaskParameters,
  mcpAddPlanTask,
  mcpRemovePlanTask,
  removePlanTaskParameters,
  type GenerateModeRegistrationContext,
} from '../mcp/generate_mode.js';

describe('task management integration workflows', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFile: string;
  let command: any;
  let moduleMocker: ModuleMocker;
  let logSpy: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof mock>;
  let mcpContext: GenerateModeRegistrationContext;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    clearPlanCache();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-task-mgmt-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/task-mgmt-tests.git`
      .cwd(tempDir)
      .quiet();
    planFile = path.join(tasksDir, 'task-mgmt.plan.md');

    moduleMocker = new ModuleMocker(import.meta);
    logSpy = mock(() => {});
    warnSpy = mock(() => {});

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
      error: mock(() => {}),
    }));
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
      }),
    }));
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
    await moduleMocker.mock('../../common/clipboard.js', () => ({
      copy: async () => {},
      isEnabled: () => false,
    }));

    command = { parent: { opts: () => ({ config: path.join(tempDir, 'tim.yml') }) } };

    const config = getDefaultConfig();
    config.paths = { tasks: tasksDir };
    mcpContext = {
      config,
      configPath: undefined,
      gitRoot: tempDir,
    };
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    moduleMocker.clear();
    clearPlanCache();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockReset();
    warnSpy.mockReset();
  });

  test('add-task followed by show displays the new task', async () => {
    const plan: PlanSchema = {
      id: 101,
      title: 'Integration Plan',
      goal: 'Verify add and show',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(planFile, plan);

    await handleAddTaskCommand(
      planFile,
      {
        title: 'Add logging',
        description: 'Add structured logging to API handlers',
        files: ['src/api.ts'],
      },
      command
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(1);

    logSpy.mockClear();
    await handleShowCommand(planFile, {}, command);
    const showOutput = logSpy.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(showOutput).toContain('Add logging');
    expect(showOutput).toContain('Add structured logging to API handlers');
  });

  test('remove-task followed by show removes the middle task and warns about index shifts', async () => {
    const plan: PlanSchema = {
      id: 202,
      title: 'Removal Plan',
      goal: 'Verify remove workflow',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task One',
          description: 'First item',
          done: false,
          files: [],
          docs: [],
          steps: [],
        },
        {
          title: 'Task Two',
          description: 'Middle item',
          done: false,
          files: [],
          docs: [],
          steps: [],
        },
        {
          title: 'Task Three',
          description: 'Last item',
          done: true,
          files: [],
          docs: [],
          steps: [],
        },
      ],
    };
    await writePlanFile(planFile, plan);

    logSpy.mockClear();
    warnSpy.mockClear();
    await handleRemoveTaskCommand(
      planFile,
      {
        index: 1,
      },
      command
    );

    const removalWarning = warnSpy.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(removalWarning).toContain('shifted');

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks.map((task) => task?.title)).toEqual(['Task One', 'Task Three']);

    logSpy.mockClear();
    await handleShowCommand(planFile, {}, command);
    const showOutput = logSpy.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(showOutput).toContain('Task One');
    expect(showOutput).toContain('Task Three');
    expect(showOutput).not.toContain('Task Two');
  });

  test('add and remove round-trip restores the original tasks', async () => {
    const plan: PlanSchema = {
      id: 303,
      title: 'Round Trip Plan',
      goal: 'Ensure add/remove symmetry',
      status: 'pending',
      tasks: [
        {
          title: 'Baseline',
          description: 'Existing task',
          done: false,
          files: [],
          docs: [],
          steps: [],
        },
      ],
    };
    await writePlanFile(planFile, plan);

    const originalTasks = JSON.parse(JSON.stringify(plan.tasks));

    await handleAddTaskCommand(
      planFile,
      {
        title: 'Temporary Task',
        description: 'Will be removed shortly',
      },
      command
    );

    await handleRemoveTaskCommand(
      planFile,
      {
        title: 'Temporary',
        yes: true,
      },
      command
    );

    const updated = await readPlanFile(planFile);
    expect(
      updated.tasks.map((task) => ({
        title: task.title,
        description: task.description,
        done: task.done,
      }))
    ).toEqual(
      originalTasks.map((task: any) => ({
        title: task.title,
        description: task.description,
        done: task.done,
      }))
    );
  });

  test('MCP add and remove tools update the plan end-to-end', async () => {
    const plan: PlanSchema = {
      id: 404,
      title: 'MCP Plan',
      goal: 'Exercise MCP tools',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(planFile, plan);

    const logger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };

    const addArgs = addPlanTaskParameters.parse({
      plan: '404',
      title: 'Investigate outage',
      description: 'Collect logs and metrics from affected services.',
      docs: ['docs/runbook.md'],
    });
    const addResult = await mcpAddPlanTask(addArgs, mcpContext, { log: logger });
    expect(addResult).toContain('Added task "Investigate outage"');

    const { plan: afterAdd } = await resolvePlan('404', { gitRoot: tempDir });
    expect(afterAdd.tasks).toHaveLength(1);
    const addedTask = afterAdd.tasks[0];
    expect(addedTask?.title).toBe('Investigate outage');
    expect(afterAdd.updatedAt).toBeString();

    const addTimestamp = afterAdd.updatedAt;

    const removeArgs = removePlanTaskParameters.parse({
      plan: '404',
      taskTitle: 'outage',
    });
    const removeResult = await mcpRemovePlanTask(removeArgs, mcpContext, { log: logger });
    expect(removeResult).toContain('Removed task "Investigate outage"');

    const { plan: afterRemove } = await resolvePlan('404', { gitRoot: tempDir });
    expect(afterRemove.tasks).toHaveLength(0);
    expect(afterRemove.updatedAt).toBeString();
    if (addTimestamp) {
      const addTime = Date.parse(addTimestamp);
      const removeTime = Date.parse(afterRemove.updatedAt);
      expect(removeTime).toBeGreaterThanOrEqual(addTime);
    }
  });

  test('CLI add with MCP removal works across interfaces', async () => {
    const plan: PlanSchema = {
      id: 505,
      title: 'Mixed Interfaces Plan',
      goal: 'Combine CLI and MCP operations',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(planFile, plan);

    await handleAddTaskCommand(
      planFile,
      {
        title: 'Mixed Task',
        description: 'Added via CLI command',
      },
      command
    );

    const removeArgs = removePlanTaskParameters.parse({
      plan: '505',
      taskTitle: 'Mixed Task',
    });
    const logger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };
    const removeResult = await mcpRemovePlanTask(removeArgs, mcpContext, { log: logger });
    expect(removeResult).toContain('Removed task "Mixed Task"');

    const { plan: finalPlan } = await resolvePlan('505', { gitRoot: tempDir });
    expect(finalPlan.tasks).toHaveLength(0);
  });
});
