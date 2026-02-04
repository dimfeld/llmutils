import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModuleMocker, clearAllTimCaches } from '../../testing.js';
import { getDefaultConfig } from '../configSchema.js';
import { writePlanFile } from '../plans.js';
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

  beforeEach(async () => {
    clearAllTimCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tools-cli-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

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

  test('create-plan returns JSON output and writes plan file', async () => {
    const { handleToolCommand } = await import('./tools.js');
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify({ title: 'CLI Plan' }));

    await handleToolCommand('create-plan', { json: true }, command);

    const output = readStdout();
    const payload = JSON.parse(output);
    const resultPath = payload.result.path;

    expect(payload.success).toBe(true);
    expect(payload.result).toMatchObject({
      id: expect.any(Number),
      path: expect.any(String),
    });

    const planPath = path.join(tempDir, String(resultPath));
    const stats = await fs.stat(planPath);
    expect(stats.isFile()).toBe(true);
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
    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    const context = {
      config,
      configPath: undefined,
      gitRoot: tempDir,
    };

    const toolOutput = await getPlanTool({ plan: planFile }, context);
    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify({ plan: planFile }));

    await handleToolCommand('get-plan', {}, command);

    expect(readStdout()).toBe(expected);

    const mcpOutput = await mcpGetPlan({ plan: planFile }, context);
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
    const args = { plan: planFile, details: 'New details' };
    await writePlanFile(planFile, plan, { skipUpdatedAt: true });
    const toolOutput = await updatePlanDetailsTool(args, context);

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify(args));

    await handleToolCommand('update-plan-details', {}, command);

    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;
    expect(readStdout()).toBe(expected);

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

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
      plan: planFile,
      tasks: [
        {
          title: 'Task 1',
          description: 'Do the thing',
        },
      ],
    };
    await writePlanFile(planFile, plan, { skipUpdatedAt: true });
    const toolOutput = await updatePlanTasksTool(args, context);

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText(JSON.stringify(args));

    await handleToolCommand('update-plan-tasks', {}, command);

    const expected = toolOutput.text.endsWith('\n') ? toolOutput.text : `${toolOutput.text}\n`;
    expect(readStdout()).toBe(expected);

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

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
      plan: planFile,
      tasks: [
        {
          title: 'Task with detail',
          detail: 'This uses detail instead of description',
        },
      ],
    };
    await writePlanFile(planFile, plan, { skipUpdatedAt: true });
    const toolOutput = await updatePlanTasksTool(
      args as Parameters<typeof updatePlanTasksTool>[0],
      context
    );

    expect(toolOutput.text).toContain('Successfully updated plan');
    expect(toolOutput.text).toContain('1 task');

    // Verify the task was written with description field
    const updatedPlan = await fs.readFile(planFile, 'utf-8');
    expect(updatedPlan).toContain('Task with detail');
    expect(updatedPlan).toContain('This uses detail instead of description');
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

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    const tasksJson = JSON.stringify([
      {
        title: 'Task from --tasks',
        description: 'This task was passed via CLI option',
      },
    ]);

    // Use inputData instead of stdin
    const options = {
      inputData: {
        plan: planFile,
        tasks: JSON.parse(tasksJson),
      },
    };

    await handleToolCommand('update-plan-tasks', options, command);

    const output = readStdout();
    expect(output).toContain('Successfully updated plan');
    expect(output).toContain('1 task');

    // Verify the task was actually written to the file
    const updatedPlan = await fs.readFile(planFile, 'utf-8');
    expect(updatedPlan).toContain('Task from --tasks');
    expect(updatedPlan).toContain('This task was passed via CLI option');
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
    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    const context = createToolContext();
    const args = {
      plan: planFile,
      action: 'add',
      title: 'New Task',
      description: 'Add a task',
    } as const;
    const toolOutput = await managePlanTaskTool(args, context);

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

    const mcpOutput = await mcpManagePlanTask(args, context);
    expect(mcpOutput).toBe(toolOutput.text);

    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

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
    await writePlanFile(planFile, plan, { skipUpdatedAt: true });

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
