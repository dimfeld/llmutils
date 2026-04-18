import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleSubagentCommand } from './subagent.js';
import {
  makeSubagentPlanFixture,
  mockBunStdinText,
  mockIsTTY,
  writePlanFixture,
} from './subagent.test-helpers.js';

const mocks = vi.hoisted(() => ({
  loadEffectiveConfig: vi.fn(),
  getGitRoot: vi.fn(),
  resolvePlanByNumericId: vi.fn(),
  buildExecutionPromptWithoutSteps: vi.fn(),
  executeCodexStep: vi.fn(),
  loadAgentInstructionsFor: vi.fn(),
  isTunnelActive: vi.fn(),
  createTunnelServer: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debugLog: vi.fn(),
  sendStructured: vi.fn(),
  runClaudeSubprocess: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({ loadEffectiveConfig: mocks.loadEffectiveConfig }));
vi.mock('../../common/git.js', () => ({ getGitRoot: mocks.getGitRoot }));
vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: mocks.resolvePlanByNumericId,
  };
});
vi.mock('../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: mocks.buildExecutionPromptWithoutSteps,
}));
vi.mock('../executors/codex_cli/codex_runner.js', () => ({
  executeCodexStep: mocks.executeCodexStep,
}));
vi.mock('../executors/codex_cli/agent_helpers.js', () => ({
  loadAgentInstructionsFor: mocks.loadAgentInstructionsFor,
}));
vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: mocks.isTunnelActive,
}));
vi.mock('../../logging/tunnel_server.js', () => ({
  createTunnelServer: mocks.createTunnelServer,
}));
vi.mock('../../logging.js', () => ({
  log: mocks.log,
  error: mocks.error,
  warn: mocks.warn,
  debugLog: mocks.debugLog,
  sendStructured: mocks.sendStructured,
}));
vi.mock('../executors/claude_code/run_claude_subprocess.js', () => ({
  runClaudeSubprocess: mocks.runClaudeSubprocess,
}));

describe('subagent command - prompt construction and executor delegation', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;
  let restoreBunStdin: (() => void) | null = null;
  let restoreIsTTY: (() => void) | null = null;

  let capturedCodexPrompt: string | undefined;
  let capturedCodexOptions: Record<string, unknown> | undefined;
  let stdoutWriteCalls: string[] = [];
  let originalConsoleLog: typeof console.log;
  let currentPlanData = makeSubagentPlanFixture();
  let agentInstructionRequests: string[] = [];
  let customInstructionsMap: Record<string, string | undefined> = {};
  let effectiveConfigOverride: any = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCodexPrompt = undefined;
    capturedCodexOptions = undefined;
    stdoutWriteCalls = [];
    agentInstructionRequests = [];
    customInstructionsMap = {};
    currentPlanData = makeSubagentPlanFixture();
    restoreBunStdin = null;
    restoreIsTTY = null;
    effectiveConfigOverride = null;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-codex-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
    await writePlanFixture(planFilePath, currentPlanData);

    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutWriteCalls.push(args.map((arg) => String(arg)).join(' '));
    };

    restoreIsTTY = mockIsTTY(true);

    mocks.loadEffectiveConfig.mockImplementation(async () => ({
      ...(effectiveConfigOverride ?? {
        paths: { tasks: tasksDir },
        models: {},
        executors: {},
        agents: {},
      }),
    }));
    mocks.getGitRoot.mockImplementation(async () => tempDir);
    mocks.resolvePlanByNumericId.mockImplementation(async () => ({
      plan: currentPlanData,
      planPath: planFilePath,
    }));
    mocks.buildExecutionPromptWithoutSteps.mockImplementation(async (opts: any) => {
      return `Mock context for plan: ${opts.planData.title}\nGoal: ${opts.planData.goal}\n${
        opts.task?.description || ''
      }`;
    });
    mocks.isTunnelActive.mockReturnValue(false);
    mocks.createTunnelServer.mockResolvedValue({
      close: vi.fn(),
    });
    mocks.executeCodexStep.mockImplementation(
      async (prompt: string, _cwd: string, _config: any, options?: any) => {
        capturedCodexPrompt = prompt;
        capturedCodexOptions = options;
        return 'Codex execution complete.';
      }
    );
    mocks.loadAgentInstructionsFor.mockImplementation(async (agent: string) => {
      agentInstructionRequests.push(agent);
      return customInstructionsMap[agent];
    });
  });

  afterEach(async () => {
    restoreBunStdin?.();
    restoreIsTTY?.();
    console.log = originalConsoleLog;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('builds implementer prompt with correct context and mode: report', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('implementer agent');
    expect(capturedCodexPrompt!).toContain('Build a widget');
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
    expect(capturedCodexPrompt!).toContain('Do NOT update the plan file directly');
  });

  test('builds tester prompt with correct context and mode: report', async () => {
    await handleSubagentCommand('tester', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('testing agent');
    expect(capturedCodexPrompt!).toContain('Build a widget');
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
  });

  test('builds verifier prompt with correct context and mode: report', async () => {
    await handleSubagentCommand('verifier', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('verification agent');
    expect(capturedCodexPrompt!).toContain('Build a widget');
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
  });

  test('builds tdd-tests prompt with correct context and mode: report', async () => {
    await handleSubagentCommand('tdd-tests', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('TDD test-writing agent');
    expect(capturedCodexPrompt!).toContain('tests should initially FAIL');
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
  });

  test('includes orchestrator --input in the prompt as custom instructions', async () => {
    const inputText = 'Focus on task 1: Implement the widget. Use React for the frontend.';

    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli', input: inputText }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(inputText);
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('includes orchestrator --input-file content in the prompt as custom instructions', async () => {
    const inputText = 'Use this long context from a file instead of inline CLI arguments.';
    const inputFilePath = path.join(tempDir, 'orchestrator-input.txt');
    await fs.writeFile(inputFilePath, inputText, 'utf8');

    await handleSubagentCommand(
      'implementer',
      42,
      { executor: 'codex-cli', inputFile: inputFilePath },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(inputText);
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('falls back to stdin input when no --input options are provided', async () => {
    restoreIsTTY?.();
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText('Piped instructions from orchestrator stdin.');

    await handleSubagentCommand('tester', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('Piped instructions from orchestrator stdin.');
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('reads stdin when --input-file is "-"', async () => {
    restoreIsTTY?.();
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText('Instructions via --input-file -');

    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli', inputFile: '-' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('Instructions via --input-file -');
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('supports --input and --input-file together (file first, then inline input)', async () => {
    const fileText = 'Context from file input.';
    const inputText = 'Inline context appended.';
    const inputFilePath = path.join(tempDir, 'orchestrator-input.txt');
    await fs.writeFile(inputFilePath, fileText, 'utf8');

    await expect(
      handleSubagentCommand(
        'implementer',
        42,
        { executor: 'codex-cli', input: inputText, inputFile: inputFilePath },
        {}
      )
    ).resolves.toBeUndefined();

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt).toContain(fileText);
    expect(capturedCodexPrompt).toContain(inputText);
    expect(capturedCodexPrompt!.indexOf(fileText)).toBeLessThan(
      capturedCodexPrompt!.indexOf(inputText)
    );
  });

  test('supports array --input-file values', async () => {
    const firstFileText = 'First file context.';
    const secondFileText = 'Second file context.';
    const firstInputFilePath = path.join(tempDir, 'orchestrator-input-1.txt');
    const secondInputFilePath = path.join(tempDir, 'orchestrator-input-2.txt');
    await fs.writeFile(firstInputFilePath, firstFileText, 'utf8');
    await fs.writeFile(secondInputFilePath, secondFileText, 'utf8');

    await handleSubagentCommand(
      'implementer',
      42,
      {
        executor: 'codex-cli',
        inputFile: [firstInputFilePath, secondInputFilePath],
      },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt).toContain(firstFileText);
    expect(capturedCodexPrompt).toContain(secondFileText);
    expect(capturedCodexPrompt!.indexOf(firstFileText)).toBeLessThan(
      capturedCodexPrompt!.indexOf(secondFileText)
    );
  });

  test('includes custom agent instructions when configured', async () => {
    const customInstructionsText = 'Always use TypeScript strict mode and run bun run check.';
    customInstructionsMap.implementer = customInstructionsText;

    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(customInstructionsText);
  });

  test('combines custom instructions and orchestrator input', async () => {
    const customInstructions = 'Custom: Always test edge cases.';
    const orchestratorInput = 'Orchestrator: Focus on task 2 only.';
    customInstructionsMap.tester = customInstructions;

    await handleSubagentCommand(
      'tester',
      42,
      { executor: 'codex-cli', input: orchestratorInput },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(customInstructions);
    expect(capturedCodexPrompt!).toContain(orchestratorInput);
  });

  test('verifier loads both tester and reviewer instructions', async () => {
    const testerInstructions = 'Tester: Always run integration tests.';
    const reviewerInstructions = 'Reviewer: Check for security vulnerabilities.';
    customInstructionsMap.tester = testerInstructions;
    customInstructionsMap.reviewer = reviewerInstructions;

    await handleSubagentCommand('verifier', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(testerInstructions);
    expect(capturedCodexPrompt!).toContain(reviewerInstructions);
    expect(agentInstructionRequests).toContain('tester');
    expect(agentInstructionRequests).toContain('reviewer');
  });

  test('implementer only loads implementer instructions', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(agentInstructionRequests).toEqual(['implementer']);
  });

  test('tester only loads tester instructions', async () => {
    await handleSubagentCommand('tester', 42, { executor: 'codex-cli' }, {});

    expect(agentInstructionRequests).toEqual(['tester']);
  });

  test('tdd-tests loads tddTests instructions key', async () => {
    const tddInstructions = 'TDD: Prefer behavior-driven tests.';
    customInstructionsMap.tddTests = tddInstructions;

    await handleSubagentCommand('tdd-tests', 42, { executor: 'codex-cli' }, {});

    expect(agentInstructionRequests).toEqual(['tddTests']);
    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(tddInstructions);
  });

  test('prints final message to stdout for codex executor', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Codex execution complete.');
  });

  test('writes final message to --output-file when provided', async () => {
    const outputFilePath = path.join(tempDir, 'subagent-output', 'implementer.txt');

    await handleSubagentCommand(
      'implementer',
      42,
      { executor: 'codex-cli', outputFile: outputFilePath },
      {}
    );

    const fileOutput = await fs.readFile(outputFilePath, 'utf8');
    expect(fileOutput).toBe('Codex execution complete.');
    expect(stdoutWriteCalls.join('')).toContain('Codex execution complete.');
  });

  test('includes all incomplete tasks in the context description', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('Implement the widget');
    expect(capturedCodexPrompt!).toContain('Test the widget');
  });

  test('handles plan with only completed tasks gracefully', async () => {
    currentPlanData = {
      ...currentPlanData,
      tasks: [
        {
          title: 'Done task',
          description: 'Already complete',
          done: true,
        },
      ],
    };

    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('implementer agent');
  });

  test('delegates to codex when executor is codex-cli', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
  });

  test('enables single-turn steering for codex subagent execution', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexOptions).toEqual(
      expect.objectContaining({
        appServerMode: 'single-turn-with-steering',
      })
    );
  });

  test('uses subagents config model for codex subagent when CLI model is not set', async () => {
    effectiveConfigOverride = {
      paths: { tasks: tasksDir },
      models: {},
      executors: {},
      subagents: { implementer: { model: { codex: 'gpt-5-codex' } } },
      agents: {},
    };

    await handleSubagentCommand('implementer', 42, { executor: 'codex-cli' }, {});

    expect(capturedCodexOptions).toEqual(
      expect.objectContaining({
        model: 'gpt-5-codex',
      })
    );
  });

  test('CLI model overrides subagents config model', async () => {
    effectiveConfigOverride = {
      paths: { tasks: tasksDir },
      models: {},
      executors: {},
      subagents: { implementer: { model: { codex: 'gpt-5-codex' } } },
      agents: {},
    };

    await handleSubagentCommand(
      'implementer',
      42,
      { executor: 'codex-cli', model: 'gpt-5-override' },
      {}
    );

    expect(capturedCodexOptions).toEqual(
      expect.objectContaining({
        model: 'gpt-5-override',
      })
    );
  });
});
