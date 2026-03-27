import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModuleMocker, clearAllTimCaches } from '../../testing.js';
import { getDefaultConfig } from '../configSchema.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { upsertPlan } from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import { resolvePlanFromDb, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  getPlanTool,
  listReadyPlansTool,
  managePlanTaskTool,
  updatePlanDetailsTool,
  updatePlanTasksTool,
} from '../tools/index.js';
import {
  mcpManagePlanTask,
  mcpUpdatePlanDetails,
  mcpUpdatePlanTasks,
} from '../mcp/generate_mode.js';
import { mcpListReadyPlans } from './ready.js';
import { mcpGetPlan } from './show.js';

type RestoreFn = () => void;

const moduleMocker = new ModuleMocker(import.meta);

describe('tim tools CLI handlers', () => {
  let tempDir: string;
  let tasksDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let restoreBunStdin: RestoreFn | null;
  let restoreIsTTY: RestoreFn | null;
  let command: any;
  let config: ReturnType<typeof getDefaultConfig>;
  let originalEnv: Partial<Record<string, string>>;

  beforeEach(async () => {
    clearAllTimCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tools-cli-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/tools-tests.git`
      .cwd(tempDir)
      .quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    config = getDefaultConfig();
    config.paths = { tasks: tasksDir };

    stdoutWrites = [];
    stderrWrites = [];
    restoreBunStdin = null;
    restoreIsTTY = null;

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => config),
    }));

    await moduleMocker.mock('../path_resolver.js', () => ({
      resolvePlanPathContext: mock(async () => ({
        gitRoot: tempDir,
        tasksDir,
        configBaseDir: tempDir,
      })),
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      writeStdout: mock((value: string) => {
        stdoutWrites.push(value);
      }),
      writeStderr: mock((value: string) => {
        stderrWrites.push(value);
      }),
    }));

    command = {
      parent: {
        parent: {
          opts: () => ({ config: path.join(tempDir, 'tim.yml') }),
        },
      },
    };
  });

  afterEach(async () => {
    restoreBunStdin?.();
    restoreIsTTY?.();
    moduleMocker.clear();
    clearAllTimCaches();
    closeDatabaseForTesting();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function mockBunStdinText(value: string): RestoreFn {
    const bunAny = Bun as any;
    const descriptor = Object.getOwnPropertyDescriptor(bunAny, 'stdin');
    const original = bunAny.stdin;
    const replacement = { text: async () => value };

    if (descriptor?.configurable) {
      Object.defineProperty(bunAny, 'stdin', {
        value: replacement,
        configurable: true,
      });
      return () => {
        Object.defineProperty(bunAny, 'stdin', descriptor);
      };
    }

    if (descriptor?.writable) {
      bunAny.stdin = replacement;
      return () => {
        bunAny.stdin = original;
      };
    }

    throw new Error('Unable to override Bun.stdin in test environment.');
  }

  function mockIsTTY(value: boolean): RestoreFn {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
    return () => {
      if (descriptor) {
        Object.defineProperty(process.stdin, 'isTTY', descriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    };
  }

  function readStdout(): string {
    return stdoutWrites.join('');
  }

  function readStderr(): string {
    return stderrWrites.join('');
  }

  function createToolContext() {
    return {
      config,
      configPath: undefined,
      gitRoot: tempDir,
    };
  }

  function createNoopLogger() {
    return {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
    };
  }

  function createDbTestUuid(id: number): string {
    return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
  }

  async function writeDbBackedPlan(planPath: string, plan: PlanSchema) {
    const planWithUuid: PlanSchema = {
      ...plan,
      uuid: plan.uuid ?? createDbTestUuid(plan.id),
    };

    await writePlanFile(planPath, planWithUuid, {
      skipUpdatedAt: true,
      cwdForIdentity: tempDir,
    });
  }

  async function upsertDbPlan(plan: PlanSchema) {
    if (typeof plan.id !== 'number' || !plan.uuid) {
      throw new Error('DB test plans must include numeric id and uuid');
    }

    const repository = await getRepositoryIdentity({ cwd: tempDir });
    const db = getDatabase();
    const project = getOrCreateProject(db, repository.repositoryId, {
      remoteUrl: repository.remoteUrl,
      lastGitRoot: repository.gitRoot,
    });

    upsertPlan(db, project.id, {
      uuid: plan.uuid,
      planId: plan.id,
      title: plan.title ?? null,
      goal: plan.goal ?? null,
      details: plan.details ?? null,
      sourceCreatedAt: plan.createdAt ?? null,
      sourceUpdatedAt: plan.updatedAt ?? null,
      status: plan.status,
      priority: plan.priority ?? null,
      branch: plan.branch ?? null,
      simple: typeof plan.simple === 'boolean' ? plan.simple : null,
      tdd: typeof plan.tdd === 'boolean' ? plan.tdd : null,
      discoveredFrom: plan.discoveredFrom ?? null,
      issue: plan.issue ?? null,
      pullRequest: plan.pullRequest ?? null,
      assignedTo: plan.assignedTo ?? null,
      baseBranch: plan.baseBranch ?? null,
      parentUuid: typeof plan.parent === 'number' ? createDbTestUuid(plan.parent) : null,
      epic: plan.epic === true,
      filename: `${plan.id}-db.plan.md`,
      tasks: plan.tasks ?? [],
      dependencyUuids: (plan.dependencies ?? []).map((dependencyId) => `plan-${dependencyId}`),
      tags: plan.tags ?? [],
    });
  }

  test('create-plan returns JSON output and writes plan to the database', async () => {
    const { handleToolCommand } = await import('./tools.js');
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify({ title: 'CLI Plan' }));

    await handleToolCommand('create-plan', { json: true }, command);

    const output = readStdout();
    const payload = JSON.parse(output);
    const resultId = payload.result.id;
    const resultPath = payload.result.path;

    expect(payload.success).toBe(true);
    expect(payload.result).toMatchObject({
      id: expect.any(Number),
      path: expect.any(String),
    });
    expect(resultPath).toBe(`plan ${resultId}`);
    expect(await getPlanTool({ plan: String(resultId) }, createToolContext())).toMatchObject({
      data: expect.objectContaining({ id: resultId, title: 'CLI Plan' }),
    });
  });

  test('get-plan CLI output matches shared tool output', async () => {
    const { handleToolCommand } = await import('./tools.js');

    const planFile = path.join(tasksDir, '42-cli-plan.plan.md');
    const plan: PlanSchema = {
      id: 42,
      title: 'CLI Plan',
      goal: 'Verify tool parity',
      details: 'Plan details',
      status: 'pending',
      tasks: [],
    };
    await writeDbBackedPlan(planFile, plan);

    const context = {
      config,
      configPath: undefined,
      gitRoot: tempDir,
    };

    const toolOutput = await getPlanTool({ plan: '42' }, context);
    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify({ plan: '42' }));

    await handleToolCommand('get-plan', {}, command);

    expect(readStdout()).toBe(expected);

    const mcpOutput = await mcpGetPlan({ plan: '42' }, context);
    expect(mcpOutput).toBe(toolOutput.text);
  });

  test('update-plan-details CLI output matches shared tool output', async () => {
    const { handleToolCommand } = await import('./tools.js');

    const planFile = path.join(tasksDir, '10-details.plan.md');
    const plan: PlanSchema = {
      id: 10,
      title: 'Details Plan',
      goal: 'Update details',
      details: 'Old details',
      status: 'pending',
      tasks: [],
    };

    const context = createToolContext();
    const args = { plan: '10', details: 'New details' };
    await writeDbBackedPlan(planFile, plan);
    const toolOutput = await updatePlanDetailsTool(args, context);

    await writeDbBackedPlan(planFile, plan);

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify(args));

    await handleToolCommand('update-plan-details', {}, command);

    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;
    expect(readStdout()).toBe(expected);

    await writeDbBackedPlan(planFile, plan);

    const mcpOutput = await mcpUpdatePlanDetails(args, context);
    expect(mcpOutput).toBe(toolOutput.text);
  });

  test('update-plan-tasks CLI output matches shared tool output', async () => {
    const { handleToolCommand } = await import('./tools.js');

    const planFile = path.join(tasksDir, '11-tasks.plan.md');
    const plan: PlanSchema = {
      id: 11,
      title: 'Tasks Plan',
      goal: 'Update tasks',
      details: 'Initial details',
      status: 'pending',
      tasks: [],
    };

    const context = createToolContext();
    const args = {
      plan: '11',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do the thing',
        },
      ],
    };
    await writeDbBackedPlan(planFile, plan);
    const toolOutput = await updatePlanTasksTool(args, context);

    await writeDbBackedPlan(planFile, plan);

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify(args));

    await handleToolCommand('update-plan-tasks', {}, command);

    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;
    expect(readStdout()).toBe(expected);

    await writeDbBackedPlan(planFile, plan);

    const mcpOutput = await mcpUpdatePlanTasks(args, context, { log: createNoopLogger() });
    expect(mcpOutput).toBe(toolOutput.text);
  });

  test('update-plan-tasks accepts detail as alias for description', async () => {
    const planFile = path.join(tasksDir, '15-detail-alias.plan.md');
    const plan: PlanSchema = {
      id: 15,
      title: 'Detail Alias Plan',
      goal: 'Test detail alias',
      details: 'Initial details',
      status: 'pending',
      tasks: [],
    };

    const context = createToolContext();
    const args = {
      plan: '15',
      tasks: [
        {
          title: 'Task with detail',
          detail: 'This uses detail instead of description',
        },
      ],
    };
    await writeDbBackedPlan(planFile, plan);
    const toolOutput = await updatePlanTasksTool(
      args as Parameters<typeof updatePlanTasksTool>[0],
      context
    );

    expect(toolOutput.text).toContain('Successfully updated plan');
    expect(toolOutput.text).toContain('1 task');

    const { plan: storedPlan } = await resolvePlanFromDb('15', tempDir);
    expect(storedPlan.tasks).toHaveLength(1);
    expect(storedPlan.tasks[0]?.title).toBe('Task with detail');
    expect(storedPlan.tasks[0]?.description).toBe('This uses detail instead of description');
  });

  test('update-plan-tasks accepts details as alias for description', async () => {
    const planFile = path.join(tasksDir, '16-details-alias.plan.md');
    const plan: PlanSchema = {
      id: 16,
      title: 'Details Alias Plan',
      goal: 'Test details alias',
      details: 'Initial details',
      status: 'pending',
      tasks: [],
    };

    const context = createToolContext();
    const args = {
      plan: '16',
      tasks: [
        {
          title: 'Task with details',
          details: 'This uses details instead of description',
        },
      ],
    };
    await writeDbBackedPlan(planFile, plan);
    const toolOutput = await updatePlanTasksTool(
      args as Parameters<typeof updatePlanTasksTool>[0],
      context
    );

    expect(toolOutput.text).toContain('Successfully updated plan');
    expect(toolOutput.text).toContain('1 task');

    const { plan: storedPlan } = await resolvePlanFromDb('16', tempDir);
    expect(storedPlan.tasks).toHaveLength(1);
    expect(storedPlan.tasks[0]?.title).toBe('Task with details');
    expect(storedPlan.tasks[0]?.description).toBe('This uses details instead of description');
  });

  test('update-plan-tasks with --tasks option bypasses stdin', async () => {
    const { handleToolCommand } = await import('./tools.js');

    const planFile = path.join(tasksDir, '14-tasks-option.plan.md');
    const plan: PlanSchema = {
      id: 14,
      title: 'Tasks Option Plan',
      goal: 'Update tasks via --tasks',
      details: 'Initial details',
      status: 'pending',
      tasks: [],
    };

    await writeDbBackedPlan(planFile, plan);

    const tasksJson = JSON.stringify([
      {
        title: 'Task from --tasks',
        description: 'This task was passed via CLI option',
      },
    ]);

    // Use inputData instead of stdin
    const options = {
      inputData: {
        plan: '14',
        tasks: JSON.parse(tasksJson),
      },
    };

    await handleToolCommand('update-plan-tasks', options, command);

    const output = readStdout();
    expect(output).toContain('Successfully updated plan');
    expect(output).toContain('1 task');

    const { plan: storedPlan } = await resolvePlanFromDb('14', tempDir);
    expect(storedPlan.tasks).toHaveLength(1);
    expect(storedPlan.tasks[0]?.title).toBe('Task from --tasks');
    expect(storedPlan.tasks[0]?.description).toBe('This task was passed via CLI option');
  });

  test('manage-plan-task CLI output matches shared tool output and JSON preserves action data', async () => {
    const { handleToolCommand } = await import('./tools.js');

    const planFile = path.join(tasksDir, '12-manage.plan.md');
    const plan: PlanSchema = {
      id: 12,
      title: 'Manage Plan',
      goal: 'Manage tasks',
      details: 'Initial details',
      status: 'pending',
      tasks: [],
    };
    await writeDbBackedPlan(planFile, plan);

    const context = createToolContext();
    const args = {
      plan: '12',
      action: 'add',
      title: 'New Task',
      description: 'Add a task',
    } as const;
    const toolOutput = await managePlanTaskTool(args, context);

    await writeDbBackedPlan(planFile, plan);

    const mcpOutput = await mcpManagePlanTask(args, context);
    expect(mcpOutput).toBe(toolOutput.text);

    await writeDbBackedPlan(planFile, plan);

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify(args));

    await handleToolCommand('manage-plan-task', { json: true }, command);

    const payload = JSON.parse(readStdout());
    expect(payload.success).toBe(true);
    if (!toolOutput.data) {
      throw new Error('Expected manage-plan-task tool to return JSON data.');
    }
    expect(payload.result).toEqual(toolOutput.data);
  });

  test('list-ready-plans CLI output matches shared tool output', async () => {
    const { handleToolCommand } = await import('./tools.js');

    const planFile = path.join(tasksDir, '13-ready.plan.md');
    const plan: PlanSchema = {
      id: 13,
      title: 'Ready Plan',
      goal: 'Be ready',
      status: 'pending',
      tasks: [],
    };
    await writeDbBackedPlan(planFile, plan);

    const context = createToolContext();
    const args = {};
    const toolOutput = await listReadyPlansTool(args, context);

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify(args));

    await handleToolCommand('list-ready-plans', {}, command);

    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;
    expect(readStdout()).toBe(expected);

    const mcpOutput = await mcpListReadyPlans(args, context);
    expect(mcpOutput).toBe(toolOutput.text);
  });

  test('listReadyPlansTool reads only SQLite plans', async () => {
    const context = createToolContext();
    const toolOutput = await listReadyPlansTool({}, context);

    expect(toolOutput.data?.count).toBe(0);
    expect(toolOutput.text).toContain('"count": 0');
  });

  test('listReadyPlansTool uses SQLite plans by default for epic filtering when local files diverge', async () => {
    await writePlanFile(
      path.join(tasksDir, '50-epic.plan.md'),
      {
        id: 50,
        uuid: createDbTestUuid(50),
        title: 'Local Done Epic',
        goal: 'Local version should be ignored',
        status: 'done',
        epic: true,
        tasks: [],
      },
      { skipUpdatedAt: true, cwdForIdentity: tempDir }
    );
    await writePlanFile(
      path.join(tasksDir, '51-child.plan.md'),
      {
        id: 51,
        uuid: createDbTestUuid(51),
        title: 'Local Done Child',
        goal: 'Local version should be ignored',
        status: 'done',
        parent: 50,
        tasks: [],
      },
      { skipUpdatedAt: true, cwdForIdentity: tempDir }
    );

    await upsertDbPlan({
      id: 50,
      uuid: createDbTestUuid(50),
      title: 'DB Epic',
      goal: 'Epic from SQLite',
      status: 'pending',
      epic: true,
      tasks: [],
    });
    await upsertDbPlan({
      id: 51,
      uuid: createDbTestUuid(51),
      title: 'DB Child',
      goal: 'Child from SQLite',
      status: 'pending',
      parent: 50,
      tasks: [],
    });
    await upsertDbPlan({
      id: 52,
      uuid: createDbTestUuid(52),
      title: 'DB Unrelated',
      goal: 'Should be filtered out',
      status: 'pending',
      tasks: [],
    });

    const context = createToolContext();
    const toolOutput = await listReadyPlansTool({ epic: 50 }, context);

    expect(toolOutput.data?.count).toBe(2);
    expect(toolOutput.data?.plans.map((plan) => plan.title)).toEqual(['DB Epic', 'DB Child']);
    expect(toolOutput.text).toContain('DB Epic');
    expect(toolOutput.text).toContain('DB Child');
    expect(toolOutput.text).not.toContain('Local Done Epic');
    expect(toolOutput.text).not.toContain('DB Unrelated');
  });

  test('invalid JSON input returns JSON error payload', async () => {
    const { handleToolCommand } = await import('./tools.js');
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText('{ invalid-json');

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await expect(handleToolCommand('get-plan', { json: true }, command)).rejects.toThrow(
        'process.exit(1)'
      );
    } finally {
      process.exit = originalExit;
    }

    const payload = JSON.parse(readStderr());
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Invalid JSON input');
    expect(payload.code).toBe('ERROR');
  });

  test('tty input returns error when stdin is required', async () => {
    const { handleToolCommand } = await import('./tools.js');
    restoreIsTTY = mockIsTTY(true);
    restoreBunStdin = mockBunStdinText('');

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await expect(handleToolCommand('get-plan', { json: true }, command)).rejects.toThrow(
        'process.exit(1)'
      );
    } finally {
      process.exit = originalExit;
    }

    const payload = JSON.parse(readStderr());
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('requires JSON input on stdin');
    expect(payload.code).toBe('ERROR');
  });

  test('schema validation errors return VALIDATION_ERROR code', async () => {
    const { handleToolCommand } = await import('./tools.js');
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify({}));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await expect(handleToolCommand('get-plan', { json: true }, command)).rejects.toThrow(
        'process.exit(1)'
      );
    } finally {
      process.exit = originalExit;
    }

    const payload = JSON.parse(readStderr());
    expect(payload.success).toBe(false);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.error).toContain('plan');
  });
});
