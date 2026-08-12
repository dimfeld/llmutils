import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearConfigCache } from '../configLoader.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanFile } from '../plans.js';
import {
  makeSubagentPlanFixture,
  mockBunStdinText,
  mockIsTTY,
} from '../commands/subagent.test-helpers.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { SubagentInputPolicy } from './types.js';
import { launchPreparedSubagent, prepareSubagentExecution } from './service.js';

const providerMocks = vi.hoisted(() => ({
  executeCodexStep: vi.fn(),
  runClaudeSubprocess: vi.fn(),
}));

vi.mock('../executors/codex_cli/codex_runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/codex_cli/codex_runner.js')>()),
  executeCodexStep: providerMocks.executeCodexStep,
}));

vi.mock('../executors/claude_code/run_claude_subprocess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/claude_code/run_claude_subprocess.js')>()),
  runClaudeSubprocess: providerMocks.runClaudeSubprocess,
}));

describe('reusable subagent service', () => {
  const resolvedInput = (initialMessage?: string): SubagentInputPolicy => ({
    type: 'resolved',
    initialMessage,
  });

  let repositoryRoot: string;
  let tasksDirectory: string;
  let configPath: string;
  let planPath: string;
  let plan: PlanSchema;
  let originalXdgConfigHome: string | undefined;

  async function writeConfig(config: Record<string, unknown> = {}): Promise<void> {
    const lines = [
      'paths:',
      `  tasks: ${JSON.stringify(tasksDirectory)}`,
      `defaultExecutor: ${String(config.defaultExecutor ?? 'codex-cli')}`,
    ];
    if (config.subagents !== undefined) {
      lines.push('subagents:');
      lines.push('  implementer:');
      lines.push('    model:');
      lines.push('      claude: configured-claude-model');
      lines.push('      codex: configured-codex-model');
    }
    if (config.executors !== undefined) {
      lines.push('executors:');
      lines.push('  claude-code:');
      lines.push('    agents:');
      lines.push('      implementer:');
      lines.push('        model: legacy-claude-model');
    }
    await fs.writeFile(configPath, `${lines.join('\n')}\n`, 'utf8');
    clearConfigCache();
  }

  async function prepare(
    overrides: Partial<Parameters<typeof prepareSubagentExecution>[0]> = {}
  ): Promise<Awaited<ReturnType<typeof prepareSubagentExecution>>> {
    return prepareSubagentExecution({
      agentType: 'implementer',
      planId: 42,
      executor: 'codex-cli',
      repositoryRoot,
      configPath,
      inputPolicy: resolvedInput('Use the initial message.'),
      ...overrides,
    });
  }

  beforeEach(async () => {
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-service-'));
    tasksDirectory = path.join(repositoryRoot, 'tasks');
    configPath = path.join(repositoryRoot, '.tim.yml');
    planPath = path.join(tasksDirectory, '42-test-plan.plan.md');
    process.env.XDG_CONFIG_HOME = path.join(repositoryRoot, 'config-home');
    await fs.mkdir(tasksDirectory, { recursive: true });
    await Bun.$`git init`.cwd(repositoryRoot).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repositoryRoot).quiet();
    await Bun.$`git config user.name "Test User"`.cwd(repositoryRoot).quiet();
    await writeConfig();
    plan = {
      ...makeSubagentPlanFixture(),
      uuid: '42424242-4242-4242-8242-424242424242',
    };
    const config: TimConfig = { paths: { tasks: tasksDirectory } };
    await writePlanFile(planPath, plan, { cwdForIdentity: repositoryRoot, config });
    providerMocks.executeCodexStep.mockResolvedValue('Codex finished');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    providerMocks.executeCodexStep.mockReset();
    providerMocks.runClaudeSubprocess.mockReset();
    closeDatabaseForTesting();
    clearConfigCache();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(repositoryRoot, { recursive: true, force: true });
  });

  test('prepares a real prompt without launching a provider or reading stdin', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const restoreIsTTY = mockIsTTY(false);
    const restoreStdin = mockBunStdinText('stdin sentinel');

    try {
      const prepared = await prepare();

      expect(prepared.executor).toBe('codex-cli');
      expect(prepared.gitRoot).toBe(repositoryRoot);
      expect(prepared.useJj).toBe(false);
      expect(prepared.prompt).toContain('Task 1: Implement the widget');
      expect(prepared.prompt).toContain('Use the initial message.');
      expect(prepared.prompt).toContain(
        'Report progress, decisions, and blockers to the orchestrator'
      );
      expect(prepared.prompt).not.toContain('stdin sentinel');
      expect(prepared.timEnvironment).toEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            planId: '42',
            planFilePath: path.join(repositoryRoot, '.tim', 'plans', '42.plan.md'),
          }),
        })
      );
      expect(providerMocks.executeCodexStep).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      restoreStdin();
      restoreIsTTY();
    }
  });

  test('builds real report-mode prompts for every supported role', async () => {
    const cases = [
      { agentType: 'implementer' as const, expected: 'You are a tim implementer agent' },
      { agentType: 'tester' as const, expected: 'You are a tim testing agent' },
      { agentType: 'tdd-tests' as const, expected: 'You are a tim TDD test-writing agent' },
      { agentType: 'reviewer' as const, expected: 'You are a tim advisory code reviewer' },
    ];

    for (const { agentType, expected } of cases) {
      const prepared = await prepare({
        agentType,
        inputPolicy: resolvedInput(`Initial ${agentType} message`),
        promptContext: { mode: 'persistent-agent', agentName: 'test-agent' },
      });

      expect(prepared.prompt).toContain(expected);
      expect(prepared.prompt).toContain(`Initial ${agentType} message`);
      expect(prepared.prompt).toContain('Report progress');
    }
  });

  test('uses configured executor and model precedence', async () => {
    await writeConfig({
      defaultExecutor: 'claude-code',
      subagents: true,
      executors: true,
    });

    const configured = await prepare({ executor: undefined });
    expect(configured.executor).toBe('claude-code');
    expect(configured.model).toBe('configured-claude-model');

    const configuredCodex = await prepare({ executor: 'codex-cli' });
    expect(configuredCodex.model).toBe('configured-codex-model');

    const explicit = await prepare({ executor: 'claude-code', model: 'explicit-model' });
    expect(explicit.model).toBe('explicit-model');
  });

  test('preserves input-file order before inline input', async () => {
    const firstInputPath = path.join(repositoryRoot, 'first.txt');
    const secondInputPath = path.join(repositoryRoot, 'second.txt');
    await fs.writeFile(firstInputPath, 'first file input', 'utf8');
    await fs.writeFile(secondInputPath, 'second file input', 'utf8');

    const prepared = await prepare({
      inputPolicy: {
        type: 'orchestrator',
        inputFile: [firstInputPath, secondInputPath],
        input: 'inline input',
        fallbackToStdin: false,
      },
    });

    const firstIndex = prepared.prompt.indexOf('first file input');
    const secondIndex = prepared.prompt.indexOf('second file input');
    const inlineIndex = prepared.prompt.indexOf('inline input');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(inlineIndex).toBeGreaterThan(secondIndex);
  });

  test('uses stdin fallback only when the orchestrator policy enables it', async () => {
    const restoreIsTTY = mockIsTTY(false);
    const restoreStdin = mockBunStdinText('stdin fallback input');

    try {
      const prepared = await prepare({
        agentType: 'tester',
        inputPolicy: { type: 'orchestrator', fallbackToStdin: true },
      });
      expect(prepared.prompt).toContain('stdin fallback input');
    } finally {
      restoreStdin();
      restoreIsTTY();
    }
  });

  test('rejects invalid task scope through the real plan resolver', async () => {
    plan.tasks[0] = { ...plan.tasks[0], done: true };
    await writePlanFile(planPath, plan, {
      cwdForIdentity: repositoryRoot,
      config: { paths: { tasks: tasksDirectory } },
    });

    await expect(prepare({ taskIndex: '1' })).rejects.toThrow('Already completed task indexes: 1');
    expect(providerMocks.executeCodexStep).not.toHaveBeenCalled();
    expect(providerMocks.runClaudeSubprocess).not.toHaveBeenCalled();
  });

  test('returns a provider-neutral Codex completion handle', async () => {
    const prepared = await prepare({ model: 'gpt-5.6-sol:high' });
    const handle = launchPreparedSubagent(prepared);

    expect(handle.executor).toBe('codex-cli');
    expect(Object.keys(handle).sort()).toEqual(['completion', 'executor']);
    await expect(handle.completion).resolves.toEqual({
      finalMessage: 'Codex finished',
      executor: 'codex-cli',
    });
    expect(providerMocks.executeCodexStep).toHaveBeenCalledWith(
      prepared.prompt,
      repositoryRoot,
      prepared.config,
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        reasoningLevel: 'high',
        appServerMode: 'single-turn-with-steering',
        timEnvironment: prepared.timEnvironment,
      })
    );
  });

  test('uses Claude result text and rejects output with no final message', async () => {
    providerMocks.runClaudeSubprocess.mockImplementationOnce(
      async (options: { processFormattedMessages?: (messages: unknown[]) => void }) => {
        options.processFormattedMessages?.([
          { type: 'assistant', rawMessage: 'Assistant fallback' },
          { type: 'result', resultText: 'Accepted result text' },
        ]);
        return {
          acceptedFinalResult: false,
          exitCode: 0,
          killedByInactivity: false,
          killedByTimeout: false,
        };
      }
    );
    const prepared = await prepare({ executor: 'claude-code' });

    await expect(launchPreparedSubagent(prepared).completion).resolves.toEqual({
      finalMessage: 'Accepted result text',
      executor: 'claude-code',
    });

    providerMocks.runClaudeSubprocess.mockResolvedValueOnce({
      acceptedFinalResult: false,
      exitCode: 0,
      killedByInactivity: false,
      killedByTimeout: false,
    });
    await expect(launchPreparedSubagent(prepared).completion).rejects.toThrow(
      'No final agent message found in Claude subagent output.'
    );
  });
});
