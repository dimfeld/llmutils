import { vi, describe, test, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { clearAllTimCaches } from '../../testing.js';
import { readPlanFile, resolvePlanByNumericId, writePlanFile, writePlanToDb } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { resolvePlan } from '../plan_display.js';
import { handleAddTaskCommand } from './add-task.js';
import { handleRemoveTaskCommand } from './remove-task.js';
import { handleShowCommand } from './show.js';
import { persistReviewIssueDisposition } from './review.js';
import { getDefaultConfig } from '../configSchema.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { managePlanTaskTool } from '../tools/index.js';
import {
  addPlanTaskParameters,
  mcpAddPlanTask,
  mcpRemovePlanTask,
  removePlanTaskParameters,
  type GenerateModeRegistrationContext,
} from '../mcp/generate_mode.js';
import * as loggingModule from '../../logging.js';
import * as configLoaderModule from '../configLoader.js';
import * as gitModule from '../../common/git.js';
import * as clipboardModule from '../../common/clipboard.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../configLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../configLoader.js')>();
  return {
    ...actual,
    loadEffectiveConfig: vi.fn(),
  };
});

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

vi.mock('../../common/clipboard.js', () => ({
  copy: vi.fn(),
  isEnabled: vi.fn(),
}));

describe('task management integration workflows', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFile: string;
  let command: any;
  let logSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let mcpContext: GenerateModeRegistrationContext;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

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

    logSpy = vi.mocked(loggingModule.log);
    warnSpy = vi.mocked(loggingModule.warn);
    logSpy.mockImplementation(() => {});
    warnSpy.mockImplementation(() => {});
    vi.mocked(loggingModule.error).mockImplementation(() => {});

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
    } as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(tempDir);

    vi.mocked(clipboardModule.copy).mockResolvedValue(undefined as any);
    vi.mocked(clipboardModule.isEnabled).mockReturnValue(false);

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
    vi.clearAllMocks();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
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
      101,
      {
        title: 'Add logging',
        description: 'Add structured logging to API handlers',
        files: ['src/api.ts'],
      },
      command
    );

    const { plan: updated } = await resolvePlanByNumericId(101, tempDir);
    expect(updated.tasks).toHaveLength(1);

    logSpy.mockClear();
    await handleShowCommand(101, {}, command);
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
      202,
      {
        index: 1,
      },
      command
    );

    const removalWarning = warnSpy.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n');
    expect(removalWarning).toContain('shifted');

    const { plan: updated } = await resolvePlanByNumericId(202, tempDir);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks.map((task) => task?.title)).toEqual(['Task One', 'Task Three']);

    logSpy.mockClear();
    await handleShowCommand(202, {}, command);
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
      303,
      {
        title: 'Temporary Task',
        description: 'Will be removed shortly',
      },
      command
    );

    await handleRemoveTaskCommand(
      303,
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
      plan: 404,
      title: 'Investigate outage',
      description: 'Collect logs and metrics from affected services.',
      docs: ['docs/runbook.md'],
    });
    const addResult = await mcpAddPlanTask(addArgs, mcpContext, { log: logger });
    expect(addResult).toContain('Added task "Investigate outage"');

    const { plan: afterAdd } = await resolvePlan(404, { gitRoot: tempDir });
    expect(afterAdd.tasks).toHaveLength(1);
    const addedTask = afterAdd.tasks[0];
    expect(addedTask?.title).toBe('Investigate outage');
    expect(afterAdd.updatedAt).toBeTypeOf('string');

    const addTimestamp = afterAdd.updatedAt;

    const removeArgs = removePlanTaskParameters.parse({
      plan: 404,
      taskTitle: 'outage',
    });
    const removeResult = await mcpRemovePlanTask(removeArgs, mcpContext, { log: logger });
    expect(removeResult).toContain('Removed task "Investigate outage"');

    const { plan: afterRemove } = await resolvePlan(404, { gitRoot: tempDir });
    expect(afterRemove.tasks).toHaveLength(0);
    expect(afterRemove.updatedAt).toBeTypeOf('string');
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
      505,
      {
        title: 'Mixed Task',
        description: 'Added via CLI command',
      },
      command
    );

    const removeArgs = removePlanTaskParameters.parse({
      plan: 505,
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

    const { plan: finalPlan } = await resolvePlan(505, { gitRoot: tempDir });
    expect(finalPlan.tasks).toHaveLength(0);
  });
});

describe('structuralReviewAt reset on task add', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFile: string;
  let command: any;
  let mcpContext: GenerateModeRegistrationContext;

  const STRUCTURAL_REVIEW_AT = '2026-02-01T00:00:00.000Z';

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-structural-reset-'));
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/structural-reset-tests.git`
      .cwd(tempDir)
      .quiet();
    planFile = path.join(tasksDir, 'structural-reset.plan.md');

    vi.mocked(loggingModule.log).mockImplementation(() => {});
    vi.mocked(loggingModule.warn).mockImplementation(() => {});
    vi.mocked(loggingModule.error).mockImplementation(() => {});

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
    } as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(tempDir);

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
    vi.clearAllMocks();
    delete process.env.XDG_CONFIG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function countStructuralReviewAtSetScalarOps(planUuid: string): number {
    const db = getDatabase();
    const rows = db
      .prepare(`SELECT payload FROM sync_operation WHERE operation_type = 'plan.set_scalar'`)
      .all() as { payload: string }[];
    return rows.filter((row) => {
      const parsed = JSON.parse(row.payload);
      return parsed.field === 'structural_review_at' && parsed.planUuid === planUuid;
    }).length;
  }

  async function seedPlanWithStructuralReviewAt(
    planId: number,
    overrides: Partial<PlanSchema> = {}
  ): Promise<string> {
    const plan: PlanSchema = {
      id: planId,
      title: `Structural Reset Plan ${planId}`,
      goal: 'Verify structural review reset behavior',
      status: 'pending',
      structuralReviewAt: STRUCTURAL_REVIEW_AT,
      tasks: [{ title: 'Existing task', description: 'Existing work', done: false }],
      ...overrides,
    };
    await writePlanFile(planFile, plan, { cwdForIdentity: tempDir });
    const { plan: written } = await resolvePlanByNumericId(planId, tempDir);
    return written.uuid!;
  }

  test('CLI add-task with an ordinary title clears structuralReviewAt in the DB', async () => {
    await seedPlanWithStructuralReviewAt(601);

    await handleAddTaskCommand(
      601,
      { title: 'Add new feature Y', description: 'Substantive new work' },
      command
    );

    const { plan: updated } = await resolvePlanByNumericId(601, tempDir);
    expect(updated.structuralReviewAt).toBeUndefined();
  });

  test('CLI add-task with --review-follow-up preserves structuralReviewAt', async () => {
    await seedPlanWithStructuralReviewAt(602);

    await handleAddTaskCommand(
      602,
      {
        title: 'Add new feature Y',
        description: 'Substantive new work',
        reviewFollowUp: true,
      },
      command
    );

    const { plan: updated } = await resolvePlanByNumericId(602, tempDir);
    expect(updated.structuralReviewAt).toBe(STRUCTURAL_REVIEW_AT);
  });

  test('CLI add-task with an "Address Review Feedback:" title preserves structuralReviewAt without the flag', async () => {
    await seedPlanWithStructuralReviewAt(603);

    await handleAddTaskCommand(
      603,
      {
        title: 'Address Review Feedback: fix the null check',
        description: 'Follow-up fix',
      },
      command
    );

    const { plan: updated } = await resolvePlanByNumericId(603, tempDir);
    expect(updated.structuralReviewAt).toBe(STRUCTURAL_REVIEW_AT);
  });

  test('CLI add-task with an "Address review:" title preserves structuralReviewAt without the flag', async () => {
    await seedPlanWithStructuralReviewAt(604);

    await handleAddTaskCommand(
      604,
      {
        title: 'Address review: src/foo.ts:12',
        description: 'Follow-up from PR thread',
      },
      command
    );

    const { plan: updated } = await resolvePlanByNumericId(604, tempDir);
    expect(updated.structuralReviewAt).toBe(STRUCTURAL_REVIEW_AT);
  });

  test('CLI add-task does not queue a redundant plan.set_scalar write when structuralReviewAt is already null', async () => {
    const plan: PlanSchema = {
      id: 605,
      title: 'Already Null Plan',
      goal: 'Verify no redundant write is queued',
      status: 'pending',
      tasks: [{ title: 'Existing task', description: 'Existing work', done: false }],
    };
    await writePlanFile(planFile, plan, { cwdForIdentity: tempDir });
    const { plan: seeded } = await resolvePlanByNumericId(605, tempDir);
    expect(seeded.structuralReviewAt).toBeUndefined();
    const planUuid = seeded.uuid!;
    expect(countStructuralReviewAtSetScalarOps(planUuid)).toBe(0);

    await handleAddTaskCommand(
      605,
      { title: 'Add new feature Y', description: 'Substantive new work' },
      command
    );

    const { plan: updated } = await resolvePlanByNumericId(605, tempDir);
    expect(updated.structuralReviewAt).toBeUndefined();
    expect(countStructuralReviewAtSetScalarOps(planUuid)).toBe(0);
  });

  test('MCP addPlanTaskTool with an ordinary title clears structuralReviewAt in the DB', async () => {
    await seedPlanWithStructuralReviewAt(606);

    const addArgs = addPlanTaskParameters.parse({
      plan: 606,
      title: 'Add new feature Y',
      description: 'Substantive new work',
    });
    const logger = { debug() {}, error() {}, info() {}, warn() {} };
    await mcpAddPlanTask(addArgs, mcpContext, { log: logger });

    const { plan: updated } = await resolvePlanByNumericId(606, tempDir);
    expect(updated.structuralReviewAt).toBeUndefined();
  });

  test('MCP addPlanTaskTool with reviewFollowUp: true preserves structuralReviewAt', async () => {
    await seedPlanWithStructuralReviewAt(607);

    const addArgs = addPlanTaskParameters.parse({
      plan: 607,
      title: 'Add new feature Y',
      description: 'Substantive new work',
      reviewFollowUp: true,
    });
    const logger = { debug() {}, error() {}, info() {}, warn() {} };
    await mcpAddPlanTask(addArgs, mcpContext, { log: logger });

    const { plan: updated } = await resolvePlanByNumericId(607, tempDir);
    expect(updated.structuralReviewAt).toBe(STRUCTURAL_REVIEW_AT);
  });

  test('managePlanTaskTool({action: "add", reviewFollowUp: true}) forwards the flag and preserves structuralReviewAt', async () => {
    await seedPlanWithStructuralReviewAt(608);

    await managePlanTaskTool(
      {
        action: 'add',
        plan: 608,
        title: 'Add new feature Y',
        description: 'Substantive new work',
        reviewFollowUp: true,
      },
      mcpContext
    );

    const { plan: updated } = await resolvePlanByNumericId(608, tempDir);
    expect(updated.structuralReviewAt).toBe(STRUCTURAL_REVIEW_AT);
  });

  test('managePlanTaskTool({action: "add"}) without reviewFollowUp clears structuralReviewAt for a substantive title', async () => {
    await seedPlanWithStructuralReviewAt(609);

    await managePlanTaskTool(
      {
        action: 'add',
        plan: 609,
        title: 'Add new feature Y',
        description: 'Substantive new work',
      },
      mcpContext
    );

    const { plan: updated } = await resolvePlanByNumericId(609, tempDir);
    expect(updated.structuralReviewAt).toBeUndefined();
  });

  test('an append disposition preserves structuralReviewAt for review follow-up tasks', async () => {
    await writePlanToDb(
      {
        id: 610,
        title: 'Append Issues Plan',
        goal: 'Verify an append disposition preserves the structural marker',
        status: 'pending',
        structuralReviewAt: STRUCTURAL_REVIEW_AT,
        tasks: [{ title: 'Existing task', description: 'Existing work', done: false }],
      },
      { cwdForIdentity: tempDir }
    );

    const { appendedTaskCount: appendedCount } = await persistReviewIssueDisposition(
      610,
      {
        kind: 'append',
        tasksToAppend: [
          {
            severity: 'major',
            category: 'bug',
            content: 'The request handler is missing a null check.',
          },
        ],
        issuesToSave: [],
        issuesToResolve: [],
      },
      tempDir
    );

    expect(appendedCount).toBe(1);
    const { plan: updated } = await resolvePlanByNumericId(610, tempDir);
    expect(updated.structuralReviewAt).toBe(STRUCTURAL_REVIEW_AT);
    expect(updated.tasks.some((task) => task.title.startsWith('Address Review Feedback:'))).toBe(
      true
    );
  });
});
