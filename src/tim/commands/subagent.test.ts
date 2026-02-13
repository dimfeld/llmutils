import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker } from '../../testing.js';
import { clearPlanCache, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
  getVerifierAgentPrompt,
} from '../executors/claude_code/agent_prompts.js';

const moduleMocker = new ModuleMocker(import.meta);

function createStreamingProcessMock(overrides?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  killedByInactivity?: boolean;
  stdin?: { write: (...args: any[]) => any; end: (...args: any[]) => any };
}) {
  return {
    stdin:
      overrides?.stdin ??
      ({
        write: mock((_value: string) => {}),
        end: mock(async () => {}),
      } as const),
    result: Promise.resolve({
      exitCode: overrides?.exitCode ?? 0,
      stdout: overrides?.stdout ?? '',
      stderr: overrides?.stderr ?? '',
      signal: overrides?.signal ?? null,
      killedByInactivity: overrides?.killedByInactivity ?? false,
    }),
    kill: mock(() => {}),
  };
}

async function sendSinglePromptAndWaitForTest(streamingProcess: any, content: string) {
  const inputMessage = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  });
  streamingProcess.stdin.write(`${inputMessage}\n`);
  await streamingProcess.stdin.end();
  return streamingProcess.result;
}

/**
 * Tests for the `tim subagent` command (tasks 4 and 5 from plan 162).
 *
 * These tests verify:
 * 1. Prompt construction for each subagent type (implementer/tester/verifier)
 * 2. Correct executor delegation based on -x flag (codex-cli vs claude-code)
 * 3. Custom instructions and orchestrator input are combined correctly
 * 4. Allowed tools include Bash(tim subagent:*)
 * 5. Command registration in tim.ts
 */

describe('subagent command - prompt construction and executor delegation', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;
  let restoreBunStdin: (() => void) | null = null;
  let restoreIsTTY: (() => void) | null = null;

  // Track what gets passed to executors
  let capturedCodexPrompt: string | undefined;
  let capturedClaudeSpawnArgs: string[] | undefined;

  // Spy on process.stdout.write to capture final output
  let stdoutWriteCalls: string[] = [];
  let originalStdoutWrite: typeof process.stdout.write;

  // Track which custom instructions were requested
  let agentInstructionRequests: string[] = [];
  let customInstructionsMap: Record<string, string | undefined> = {};

  const basePlan: PlanSchema = {
    id: 42,
    title: 'Test Plan for Subagent',
    goal: 'Build a widget',
    details: 'Detailed description of the widget to build',
    status: 'pending',
    tasks: [
      {
        title: 'Implement the widget',
        description: 'Write the widget code',
        done: false,
      },
      {
        title: 'Test the widget',
        description: 'Write tests for the widget code',
        done: false,
      },
    ],
  };

  beforeEach(async () => {
    clearPlanCache();
    capturedCodexPrompt = undefined;
    capturedClaudeSpawnArgs = undefined;
    stdoutWriteCalls = [];
    agentInstructionRequests = [];
    customInstructionsMap = {};
    restoreBunStdin = null;
    restoreIsTTY = null;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
    await writePlanFile(planFilePath, basePlan);

    // Capture stdout.write calls
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((data: any) => {
      stdoutWriteCalls.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as typeof process.stdout.write;

    // Mock logging to suppress output
    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    // Mock config loader - return minimal config
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {},
        agents: {},
      })),
    }));

    // Mock git root
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    // Mock prompt_builder to return a controlled context string.
    // This avoids filesystem dependencies from buildPlanContextPrompt.
    await moduleMocker.mock('../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(
        async (opts: any) =>
          `Mock context for plan: ${opts.planData.title}\nGoal: ${opts.planData.goal}\n${opts.task?.description || ''}`
      ),
    }));

    // Mock tunnel client - no active tunnel in tests
    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => false),
    }));

    // Mock tunnel server - don't actually create sockets
    await moduleMocker.mock('../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async () => ({
        close: mock(() => {}),
      })),
    }));

    // Mock codex runner - capture the prompt
    await moduleMocker.mock('../executors/codex_cli/codex_runner.js', () => ({
      executeCodexStep: mock(async (prompt: string) => {
        capturedCodexPrompt = prompt;
        return 'Codex execution complete.';
      }),
    }));

    // Mock agent helpers for loading custom instructions - track requests
    await moduleMocker.mock('../executors/codex_cli/agent_helpers.js', () => ({
      loadAgentInstructionsFor: mock(async (agent: string) => {
        agentInstructionRequests.push(agent);
        return customInstructionsMap[agent];
      }),
    }));

    // Mock shared permissions
    await moduleMocker.mock('../assignments/permissions_io.js', () => ({
      readSharedPermissions: mock(async () => ({ permissions: { allow: [] } })),
    }));
    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'test-repo' })),
    }));

    // Mock permissions MCP setup - default no-op (never triggered unless config enables it)
    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => ({
        mcpConfigFile: '/tmp/mock-mcp-config.json',
        tempDir: '/tmp/mock-mcp-dir',
        socketServer: { close: mock(() => {}) },
        cleanup: mock(async () => {}),
      })),
    }));

    // Mock the process spawning for claude-code path
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        capturedClaudeSpawnArgs = args;
        // Simulate a result message so the code can extract it
        if (opts?.formatStdout) {
          const resultJson = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Claude execution complete.',
          });
          opts.formatStdout(resultJson + '\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    // Mock the format module to properly extract result text
    await moduleMocker.mock('../executors/claude_code/format.js', () => ({
      extractStructuredMessages: mock((results: any[]) => {
        return results
          .filter((r: any) => r.type === 'result' || r.type === 'assistant')
          .map((r: any) => r.resultText || r.rawMessage || '');
      }),
      formatJsonMessage: mock((line: string) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            return { type: 'result', resultText: parsed.result || '' };
          }
          if (parsed.type === 'assistant') {
            return { type: 'assistant', rawMessage: parsed.content || '' };
          }
          return { type: parsed.type };
        } catch {
          return { type: 'unknown' };
        }
      }),
      resetToolUseCache: mock(() => {}),
    }));

    // Keep stdin in TTY mode by default so most tests don't accidentally read stdin.
    restoreIsTTY = mockIsTTY(true);
  });

  afterEach(async () => {
    restoreBunStdin?.();
    restoreIsTTY?.();
    process.stdout.write = originalStdoutWrite;
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function mockBunStdinText(value: string): () => void {
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

  function mockIsTTY(value: boolean): () => void {
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

  // ---- Prompt Construction Tests ----

  test('builds implementer prompt with correct context and mode: report', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();

    // Verify the prompt contains implementer-specific content
    expect(capturedCodexPrompt!).toContain('implementer agent');
    expect(capturedCodexPrompt!).toContain('Build a widget');

    // Verify mode: report is used - progress reporting guidance should appear
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
    expect(capturedCodexPrompt!).toContain('Do NOT update the plan file directly');
  });

  test('builds tester prompt with correct context and mode: report', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('tester', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();

    // Verify the prompt contains tester-specific content
    expect(capturedCodexPrompt!).toContain('testing agent');
    expect(capturedCodexPrompt!).toContain('Build a widget');

    // Verify mode: report
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
  });

  test('builds verifier prompt with correct context and mode: report', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('verifier', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();

    // Verify the prompt contains verifier-specific content
    expect(capturedCodexPrompt!).toContain('verification agent');
    expect(capturedCodexPrompt!).toContain('Build a widget');

    // Verify mode: report
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
  });

  test('builds tdd-tests prompt with correct context and mode: report', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('tdd-tests', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('TDD test-writing agent');
    expect(capturedCodexPrompt!).toContain('tests should initially FAIL');
    expect(capturedCodexPrompt!).toContain(
      'Report progress, decisions, and blockers to the orchestrator'
    );
  });

  test('includes orchestrator --input in the prompt as custom instructions', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    const inputText = 'Focus on task 1: Implement the widget. Use React for the frontend.';
    await handleSubagentCommand(
      'implementer',
      planFilePath,
      { executor: 'codex-cli', input: inputText },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    // The input should appear in the Custom Instructions section
    expect(capturedCodexPrompt!).toContain(inputText);
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('includes orchestrator --input-file content in the prompt as custom instructions', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    const inputText = 'Use this long context from a file instead of inline CLI arguments.';
    const inputFilePath = path.join(tempDir, 'orchestrator-input.txt');
    await fs.writeFile(inputFilePath, inputText, 'utf8');

    await handleSubagentCommand(
      'implementer',
      planFilePath,
      { executor: 'codex-cli', inputFile: inputFilePath },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(inputText);
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('falls back to stdin input when no --input options are provided', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    restoreIsTTY?.();
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText('Piped instructions from orchestrator stdin.');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('Piped instructions from orchestrator stdin.');
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('reads stdin when --input-file is \"-\"', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    restoreIsTTY?.();
    restoreIsTTY = mockIsTTY(false);
    restoreBunStdin = mockBunStdinText('Instructions via --input-file -');

    await handleSubagentCommand(
      'implementer',
      planFilePath,
      { executor: 'codex-cli', inputFile: '-' },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain('Instructions via --input-file -');
    expect(capturedCodexPrompt!).toContain('## Custom Instructions');
  });

  test('rejects using --input and --input-file together', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await expect(
      handleSubagentCommand(
        'implementer',
        planFilePath,
        { executor: 'codex-cli', input: 'inline', inputFile: '/tmp/input.txt' },
        {}
      )
    ).rejects.toThrow('Cannot provide both --input and --input-file');
  });

  test('includes custom agent instructions when configured', async () => {
    const customInstructionsText = 'Always use TypeScript strict mode and run bun run check.';
    customInstructionsMap['implementer'] = customInstructionsText;

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(customInstructionsText);
  });

  test('combines custom instructions and orchestrator input', async () => {
    const customInstructions = 'Custom: Always test edge cases.';
    const orchestratorInput = 'Orchestrator: Focus on task 2 only.';
    customInstructionsMap['tester'] = customInstructions;

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand(
      'tester',
      planFilePath,
      { executor: 'codex-cli', input: orchestratorInput },
      {}
    );

    expect(capturedCodexPrompt).toBeDefined();
    // Both should appear in the prompt
    expect(capturedCodexPrompt!).toContain(customInstructions);
    expect(capturedCodexPrompt!).toContain(orchestratorInput);
  });

  test('verifier loads both tester and reviewer instructions', async () => {
    const testerInstructions = 'Tester: Always run integration tests.';
    const reviewerInstructions = 'Reviewer: Check for security vulnerabilities.';
    customInstructionsMap['tester'] = testerInstructions;
    customInstructionsMap['reviewer'] = reviewerInstructions;

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('verifier', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    // Both tester and reviewer instructions should be in the prompt
    expect(capturedCodexPrompt!).toContain(testerInstructions);
    expect(capturedCodexPrompt!).toContain(reviewerInstructions);

    // Should have requested both tester and reviewer instructions
    expect(agentInstructionRequests).toContain('tester');
    expect(agentInstructionRequests).toContain('reviewer');
  });

  test('implementer only loads implementer instructions', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(agentInstructionRequests).toEqual(['implementer']);
  });

  test('tester only loads tester instructions', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('tester', planFilePath, { executor: 'codex-cli' }, {});

    expect(agentInstructionRequests).toEqual(['tester']);
  });

  test('tdd-tests loads tddTests instructions key', async () => {
    const tddInstructions = 'TDD: Prefer behavior-driven tests.';
    customInstructionsMap['tddTests'] = tddInstructions;

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('tdd-tests', planFilePath, { executor: 'codex-cli' }, {});

    expect(agentInstructionRequests).toEqual(['tddTests']);
    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedCodexPrompt!).toContain(tddInstructions);
  });

  test('prints final message to stdout for codex executor', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Codex execution complete.');
  });

  test('prints final message to stdout for claude executor', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Claude execution complete.');
  });

  test('includes all incomplete tasks in the context description', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    // The mock context includes the task description, which is built from incomplete tasks
    expect(capturedCodexPrompt!).toContain('Implement the widget');
    expect(capturedCodexPrompt!).toContain('Test the widget');
  });

  test('handles plan with only completed tasks gracefully', async () => {
    const donePlan: PlanSchema = {
      ...basePlan,
      tasks: [
        {
          title: 'Done task',
          description: 'Already complete',
          done: true,
        },
      ],
    };
    await writePlanFile(planFilePath, donePlan);
    clearPlanCache();

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    // Should still produce a prompt, even with 0 incomplete tasks
    expect(capturedCodexPrompt!).toContain('implementer agent');
  });

  // ---- Executor Delegation Tests ----

  test('delegates to codex when executor is codex-cli', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    expect(capturedCodexPrompt).toBeDefined();
    expect(capturedClaudeSpawnArgs).toBeUndefined();
  });

  test('delegates to claude when executor is claude-code', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedCodexPrompt).toBeUndefined();
    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs![0]).toBe('claude');
  });

  test('defaults to claude-code when executor option is empty', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: '' }, {});

    expect(capturedCodexPrompt).toBeUndefined();
    expect(capturedClaudeSpawnArgs).toBeDefined();
  });

  test('passes model to claude-code spawned process', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand(
      'implementer',
      planFilePath,
      { executor: 'claude-code', model: 'sonnet' },
      {}
    );

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const modelIdx = capturedClaudeSpawnArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![modelIdx + 1]).toBe('sonnet');
  });

  test('uses default opus model when no model specified for claude', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const modelIdx = capturedClaudeSpawnArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![modelIdx + 1]).toBe('opus');
  });

  test('claude-code path includes stream-json output format', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--output-format');
    const fmtIdx = capturedClaudeSpawnArgs!.indexOf('--output-format');
    expect(capturedClaudeSpawnArgs![fmtIdx + 1]).toBe('stream-json');
  });

  test('claude-code path includes --verbose and --input-format stream-json flags', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--verbose');
    expect(capturedClaudeSpawnArgs!).toContain('--input-format');
    const inputFormatIndex = capturedClaudeSpawnArgs!.indexOf('--input-format');
    expect(capturedClaudeSpawnArgs![inputFormatIndex + 1]).toBe('stream-json');
  });

  test('claude-code path writes prompt to stdin as stream-json line and closes stdin', async () => {
    const stdinWrite = mock((_value: string) => {});
    const stdinEnd = mock(async () => {});

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        capturedClaudeSpawnArgs = args;
        if (opts?.formatStdout) {
          const resultJson = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Claude execution complete.',
          });
          opts.formatStdout(resultJson + '\n');
        }
        return {
          ...createStreamingProcessMock(),
          stdin: { write: stdinWrite, end: stdinEnd },
        };
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(stdinWrite).toHaveBeenCalledTimes(1);
    const sentLine = stdinWrite.mock.calls[0]?.[0];
    expect(typeof sentLine).toBe('string');
    expect(sentLine.endsWith('\n')).toBeTrue();
    expect(JSON.parse(sentLine.trim())).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: expect.any(String),
      },
    });
    expect(stdinEnd).toHaveBeenCalledTimes(1);
  });

  test('claude-code path includes --no-session-persistence', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--no-session-persistence');
  });

  test('claude-code path includes allowed tools', async () => {
    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--allowedTools');
  });

  test('claude-code path respects allowAllTools config', async () => {
    // Re-mock config with allowAllTools
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {
            allowAllTools: true,
          },
        },
        agents: {},
      })),
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--dangerously-skip-permissions');
    expect(capturedClaudeSpawnArgs!).not.toContain('--allowedTools');
  });

  test('claude-code path includes MCP config when configured', async () => {
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {
            mcpConfigFile: '/path/to/mcp-config.json',
          },
        },
        agents: {},
      })),
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs!).toContain('/path/to/mcp-config.json');
  });
});

describe('subagent prompt function correctness', () => {
  // These tests verify the prompt functions from agent_prompts.ts
  // are used correctly (with the right mode and arguments), without
  // needing any mocking or file system interaction.

  test('getImplementerPrompt with mode: report includes progress reporting', () => {
    const result = getImplementerPrompt('test context', '42', 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('implementer');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
    expect(result.prompt).toContain('Do NOT update the plan file directly');
  });

  test('getTesterPrompt with mode: report includes progress reporting', () => {
    const result = getTesterPrompt('test context', '42', 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tester');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getTddTestsPrompt with mode: report includes TDD-first guidance', () => {
    const result = getTddTestsPrompt('test context', '42', 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tdd-tests');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('tests should initially FAIL');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getVerifierAgentPrompt with mode: report includes progress reporting', () => {
    const result = getVerifierAgentPrompt(
      'test context',
      '42',
      'custom instructions',
      undefined,
      false,
      false,
      {
        mode: 'report',
      }
    );

    expect(result.name).toBe('verifier');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getImplementerPrompt custom instructions appear in dedicated section', () => {
    const result = getImplementerPrompt('context', '42', 'My custom instruction', undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('## Custom Instructions');
    expect(result.prompt).toContain('My custom instruction');
  });

  test('getImplementerPrompt without custom instructions omits section', () => {
    const result = getImplementerPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).not.toContain('## Custom Instructions');
  });

  test('getTesterPrompt model is passed through', () => {
    const result = getTesterPrompt('context', '42', undefined, 'sonnet', {
      mode: 'report',
    });

    expect(result.model).toBe('sonnet');
  });

  test('getVerifierAgentPrompt model is passed through', () => {
    const result = getVerifierAgentPrompt('context', '42', undefined, 'haiku', false, false, {
      mode: 'report',
    });

    expect(result.model).toBe('haiku');
  });

  test('getImplementerPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getImplementerPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getTesterPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getTesterPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getVerifierAgentPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getVerifierAgentPrompt('context', '42', undefined, undefined, false, false, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getImplementerPrompt skills include using-tim', () => {
    const result = getImplementerPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.skills).toContain('using-tim');
  });

  test('all prompt functions produce skills with using-tim', () => {
    const impl = getImplementerPrompt('ctx', '1', undefined, undefined, { mode: 'report' });
    const tdd = getTddTestsPrompt('ctx', '1', undefined, undefined, { mode: 'report' });
    const tester = getTesterPrompt('ctx', '1', undefined, undefined, { mode: 'report' });
    const verifier = getVerifierAgentPrompt('ctx', '1', undefined, undefined, false, false, {
      mode: 'report',
    });

    expect(impl.skills).toContain('using-tim');
    expect(tdd.skills).toContain('using-tim');
    expect(tester.skills).toContain('using-tim');
    expect(verifier.skills).toContain('using-tim');
  });
});

describe('allowed tools in getDefaultAllowedTools', () => {
  test('Bash(tim subagent:*) is in the default allowed tools list', async () => {
    const { getDefaultAllowedTools } =
      await import('../executors/claude_code/run_claude_subprocess.ts');
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Bash(tim subagent:*)');
  });

  test('Bash(tim subagent:*) coexists with other tim tools', async () => {
    const { getDefaultAllowedTools } =
      await import('../executors/claude_code/run_claude_subprocess.ts');
    const tools = getDefaultAllowedTools();

    expect(tools).toContain('Bash(tim add:*)');
    expect(tools).toContain('Bash(tim review:*)');
    expect(tools).toContain('Bash(tim set-task-done:*)');
    expect(tools).toContain('Bash(tim subagent:*)');
  });
});

describe('subagent command registration in tim.ts', () => {
  test('registers subagent command with all four subcommands', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    // Verify the subagent command is registered
    expect(source).toContain("command('subagent')");
    expect(source).toContain('Run a subagent for the orchestrator');

    // Verify all subcommand types are registered via the loop
    expect(source).toContain("'implementer'");
    expect(source).toContain("'tester'");
    expect(source).toContain("'tdd-tests'");
    expect(source).toContain("'verifier'");
  });

  test('subcommands accept required options', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    // Each subcommand should accept planFile, executor, model, input, and input-file
    expect(source).toContain('<planFile>');
    expect(source).toContain("'--input <text>'");
    expect(source).toContain("'--input-file <path>'");
    expect(source).toContain("'-x, --executor <name>'");
    expect(source).toContain("'-m, --model <model>'");
  });

  test('subcommands import and call handleSubagentCommand', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    expect(source).toContain("import('./commands/subagent.js')");
    expect(source).toContain('handleSubagentCommand');
  });

  test('subcommand default executor is claude-code', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    // The default executor value for the -x option should be claude-code
    expect(source).toContain("'claude-code'");
  });

  test('subcommand executor option uses .choices() for validation', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    // The subagent command's -x/--executor should use Commander.js .choices()
    // to restrict values to only 'codex-cli' and 'claude-code' (not 'dynamic')
    expect(source).toContain(".choices(['codex-cli', 'claude-code'])");
  });
});

describe('subagent command - permissions MCP integration', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;
  let capturedPermissionsMcpSetupOptions: any;

  let capturedClaudeSpawnArgs: string[] | undefined;
  let stdoutWriteCalls: string[] = [];
  let originalStdoutWrite: typeof process.stdout.write;

  const basePlan: PlanSchema = {
    id: 42,
    title: 'Test Plan for Subagent',
    goal: 'Build a widget',
    details: 'Detailed description of the widget to build',
    status: 'pending',
    tasks: [
      {
        title: 'Implement the widget',
        description: 'Write the widget code',
        done: false,
      },
    ],
  };

  beforeEach(async () => {
    clearPlanCache();
    capturedClaudeSpawnArgs = undefined;
    capturedPermissionsMcpSetupOptions = undefined;
    stdoutWriteCalls = [];

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-mcp-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
    await writePlanFile(planFilePath, basePlan);

    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((data: any) => {
      stdoutWriteCalls.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as typeof process.stdout.write;

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'Mock context'),
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => false),
    }));

    await moduleMocker.mock('../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async () => ({
        close: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('../executors/codex_cli/codex_runner.js', () => ({
      executeCodexStep: mock(async () => 'Codex done.'),
    }));

    await moduleMocker.mock('../executors/codex_cli/agent_helpers.js', () => ({
      loadAgentInstructionsFor: mock(async () => undefined),
    }));

    await moduleMocker.mock('../assignments/permissions_io.js', () => ({
      readSharedPermissions: mock(async () => ({ permissions: { allow: [] } })),
    }));
    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'test-repo' })),
    }));

    await moduleMocker.mock('../executors/claude_code/format.js', () => ({
      extractStructuredMessages: mock((results: any[]) => {
        return results
          .filter((r: any) => r.type === 'result' || r.type === 'assistant')
          .map((r: any) => r.resultText || r.rawMessage || '');
      }),
      formatJsonMessage: mock((line: string) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            return { type: 'result', resultText: parsed.result || '' };
          }
          if (parsed.type === 'assistant') {
            return { type: 'assistant', rawMessage: parsed.content || '' };
          }
          return { type: parsed.type };
        } catch {
          return { type: 'unknown' };
        }
      }),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (args: string[], opts: any) => {
        capturedClaudeSpawnArgs = args;
        if (opts?.formatStdout) {
          const resultJson = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Claude execution complete.',
          });
          opts.formatStdout(resultJson + '\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('includes --permission-prompt-tool and --mcp-config when permissionsMcp is enabled', async () => {
    // Configure permissionsMcp.enabled = true
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {
            permissionsMcp: {
              enabled: true,
            },
          },
        },
        agents: {},
      })),
    }));

    // Mock permissions MCP setup to return a known config file path
    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => ({
        mcpConfigFile: '/tmp/test-mcp-config.json',
        tempDir: '/tmp/test-mcp-dir',
        socketServer: { close: mock(() => {}) },
        cleanup: mock(async () => {}),
      })),
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--permission-prompt-tool');
    expect(capturedClaudeSpawnArgs!).toContain('mcp__permissions__approval_prompt');
    expect(capturedClaudeSpawnArgs!).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs!).toContain('/tmp/test-mcp-config.json');
  });

  test('does not include --permission-prompt-tool when permissionsMcp is not enabled', async () => {
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {},
        },
        agents: {},
      })),
    }));

    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => {
        throw new Error('should not be called');
      }),
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).not.toContain('--permission-prompt-tool');
  });

  test('permissions MCP config takes priority over mcpConfigFile', async () => {
    // When both permissionsMcp.enabled and mcpConfigFile are set,
    // the permissions MCP config should be used, not the user's mcpConfigFile
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {
            mcpConfigFile: '/path/to/user-mcp-config.json',
            permissionsMcp: {
              enabled: true,
            },
          },
        },
        agents: {},
      })),
    }));

    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => ({
        mcpConfigFile: '/tmp/permissions-mcp-config.json',
        tempDir: '/tmp/test-mcp-dir',
        socketServer: { close: mock(() => {}) },
        cleanup: mock(async () => {}),
      })),
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    // Should use the permissions MCP config, not the user's
    expect(capturedClaudeSpawnArgs!).toContain('/tmp/permissions-mcp-config.json');
    expect(capturedClaudeSpawnArgs!).not.toContain('/path/to/user-mcp-config.json');
  });

  test('disables permissions MCP when allowAllTools is true', async () => {
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {
            allowAllTools: true,
            permissionsMcp: {
              enabled: true,
            },
          },
        },
        agents: {},
      })),
    }));

    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => {
        throw new Error('should not be called when allowAllTools is true');
      }),
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).not.toContain('--permission-prompt-tool');
    expect(capturedClaudeSpawnArgs!).toContain('--dangerously-skip-permissions');
  });

  test('passes autoApproveCreatedFileDeletion and tracked files into permissions MCP setup', async () => {
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {
          'claude-code': {
            permissionsMcp: {
              enabled: true,
              autoApproveCreatedFileDeletion: true,
            },
          },
        },
        agents: {},
      })),
    }));

    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async (options: any) => {
        capturedPermissionsMcpSetupOptions = options;
        return {
          mcpConfigFile: '/tmp/permissions-mcp-config.json',
          tempDir: '/tmp/test-mcp-dir',
          socketServer: { close: mock(() => {}) },
          cleanup: mock(async () => {}),
        };
      }),
    }));

    await moduleMocker.mock('../executors/claude_code/format.js', () => ({
      extractStructuredMessages: mock((results: any[]) => {
        return results
          .filter((r: any) => r.type === 'result' || r.type === 'assistant')
          .map((r: any) => r.resultText || r.rawMessage || '');
      }),
      formatJsonMessage: mock((line: string) => {
        if (line === 'FILEPATH_EVENT') {
          return { type: 'assistant', filePaths: ['generated.txt'] };
        }
        if (line === 'RESULT_EVENT') {
          return { type: 'result', resultText: 'done' };
        }
        return { type: 'unknown' };
      }),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        opts.formatStdout?.('FILEPATH_EVENT\nRESULT_EVENT\n');
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(capturedPermissionsMcpSetupOptions).toBeDefined();
    expect(capturedPermissionsMcpSetupOptions.autoApproveCreatedFileDeletion).toBe(true);
    expect(capturedPermissionsMcpSetupOptions.workingDirectory).toBe(tempDir);
    expect(capturedPermissionsMcpSetupOptions.trackedFiles).toBeInstanceOf(Set);
    expect(
      capturedPermissionsMcpSetupOptions.trackedFiles.has(path.join(tempDir, 'generated.txt'))
    ).toBe(true);
  });
});

describe('subagent command - executeWithClaude error scenarios', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;

  let stdoutWriteCalls: string[] = [];
  let originalStdoutWrite: typeof process.stdout.write;

  const basePlan: PlanSchema = {
    id: 42,
    title: 'Test Plan for Subagent',
    goal: 'Build a widget',
    details: 'Detailed description of the widget to build',
    status: 'pending',
    tasks: [
      {
        title: 'Implement the widget',
        description: 'Write the widget code',
        done: false,
      },
    ],
  };

  beforeEach(async () => {
    clearPlanCache();
    stdoutWriteCalls = [];

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-err-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
    await writePlanFile(planFilePath, basePlan);

    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((data: any) => {
      stdoutWriteCalls.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as typeof process.stdout.write;

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {},
        agents: {},
      })),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'Mock context'),
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => false),
    }));

    await moduleMocker.mock('../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async () => ({
        close: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('../executors/codex_cli/codex_runner.js', () => ({
      executeCodexStep: mock(async () => 'Codex done.'),
    }));

    await moduleMocker.mock('../executors/codex_cli/agent_helpers.js', () => ({
      loadAgentInstructionsFor: mock(async () => undefined),
    }));

    await moduleMocker.mock('../assignments/permissions_io.js', () => ({
      readSharedPermissions: mock(async () => ({ permissions: { allow: [] } })),
    }));
    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'test-repo' })),
    }));

    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => ({
        mcpConfigFile: '/tmp/mock-mcp-config.json',
        tempDir: '/tmp/mock-mcp-dir',
        socketServer: { close: mock(() => {}) },
        cleanup: mock(async () => {}),
      })),
    }));

    await moduleMocker.mock('../executors/claude_code/format.js', () => ({
      extractStructuredMessages: mock((results: any[]) => {
        return results
          .filter((r: any) => r.type === 'result' || r.type === 'assistant')
          .map((r: any) => r.resultText || r.rawMessage || '');
      }),
      formatJsonMessage: mock((line: string) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            return { type: 'result', resultText: parsed.result || '' };
          }
          if (parsed.type === 'assistant') {
            return { type: 'assistant', rawMessage: parsed.content || '' };
          }
          return { type: parsed.type };
        } catch {
          return { type: 'unknown' };
        }
      }),
      resetToolUseCache: mock(() => {}),
    }));
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('throws error on non-zero exit code with no result message', async () => {
    // spawnAndLogOutput returns non-zero exit code without producing any result message
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], _opts: any) => {
        // Do NOT call formatStdout - no output at all
        return createStreamingProcessMock({ exitCode: 1 });
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await expect(
      handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {})
    ).rejects.toThrow('non-zero exit code');
  });

  test('non-zero exit code is tolerated when a result message was received', async () => {
    // spawnAndLogOutput returns non-zero exit code but DID produce a result message
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts?.formatStdout) {
          const resultJson = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Completed despite exit code.',
          });
          opts.formatStdout(resultJson + '\n');
        }
        return createStreamingProcessMock({ exitCode: 1 });
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    // Should NOT throw because a result message was seen
    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Completed despite exit code.');
  });

  test('throws error on timeout (killedByInactivity) with no result message', async () => {
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], _opts: any) => {
        // Simulate timeout - no output, killed by inactivity
        return createStreamingProcessMock({ killedByInactivity: true });
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await expect(
      handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {})
    ).rejects.toThrow('timed out');
  });

  test('timeout is tolerated when a result message was received', async () => {
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts?.formatStdout) {
          const resultJson = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Completed before timeout.',
          });
          opts.formatStdout(resultJson + '\n');
        }
        return createStreamingProcessMock({ killedByInactivity: true });
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    // Should NOT throw because a result message was seen before timeout
    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Completed before timeout.');
  });

  test('throws error when no final message found in output', async () => {
    // spawnAndLogOutput succeeds (exit code 0) but output has no result or assistant message
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts?.formatStdout) {
          // Send only a non-result, non-assistant message
          const logJson = JSON.stringify({ type: 'system', message: 'Starting...' });
          opts.formatStdout(logJson + '\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await expect(
      handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {})
    ).rejects.toThrow('No final agent message found');
  });

  test('uses last assistant raw message when no result text is available', async () => {
    // spawnAndLogOutput produces an assistant message but no result message
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        if (opts?.formatStdout) {
          const assistantJson = JSON.stringify({
            type: 'assistant',
            content: 'Fallback assistant message.',
          });
          opts.formatStdout(assistantJson + '\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Fallback assistant message.');
  });

  test('model flag is silently ignored for codex-cli executor', async () => {
    // Need process mock for this test since it runs codex path
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async () => {
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    // This should not throw - model is silently ignored for codex
    await handleSubagentCommand(
      'implementer',
      planFilePath,
      { executor: 'codex-cli', model: 'sonnet' },
      {}
    );

    // Verify that codex was called (not claude) - the output should be from codex
    expect(stdoutWriteCalls.join('')).toContain('Codex done.');
  });
});

describe('subagent command - tunnel behavior', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;

  let capturedSpawnEnv: Record<string, string> | undefined;
  let stdoutWriteCalls: string[] = [];
  let originalStdoutWrite: typeof process.stdout.write;

  // Track tunnel mock calls
  let createTunnelServerCalls: string[] = [];
  let createTunnelServerOptions: any[] = [];
  let tunnelCloseCallCount = 0;

  const basePlan: PlanSchema = {
    id: 42,
    title: 'Test Plan for Subagent',
    goal: 'Build a widget',
    details: 'Detailed description of the widget to build',
    status: 'pending',
    tasks: [
      {
        title: 'Implement the widget',
        description: 'Write the widget code',
        done: false,
      },
    ],
  };

  async function setupCommonMocks(tunnelActive: boolean) {
    createTunnelServerCalls = [];
    createTunnelServerOptions = [];
    tunnelCloseCallCount = 0;
    capturedSpawnEnv = undefined;

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {},
        agents: {},
      })),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'Mock context'),
    }));

    // Mock tunnel client - parametrize whether tunnel is active
    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => tunnelActive),
    }));

    // Mock tunnel server - track calls and expose close spy
    await moduleMocker.mock('../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async (socketPath: string, options?: any) => {
        createTunnelServerCalls.push(socketPath);
        createTunnelServerOptions.push(options);
        return {
          close: mock(() => {
            tunnelCloseCallCount++;
          }),
        };
      }),
    }));

    await moduleMocker.mock('../executors/codex_cli/codex_runner.js', () => ({
      executeCodexStep: mock(async () => 'Codex done.'),
    }));

    await moduleMocker.mock('../executors/codex_cli/agent_helpers.js', () => ({
      loadAgentInstructionsFor: mock(async () => undefined),
    }));

    await moduleMocker.mock('../assignments/permissions_io.js', () => ({
      readSharedPermissions: mock(async () => ({ permissions: { allow: [] } })),
    }));
    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'test-repo' })),
    }));

    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => ({
        mcpConfigFile: '/tmp/mock-mcp-config.json',
        tempDir: '/tmp/mock-mcp-dir',
        socketServer: { close: mock(() => {}) },
        cleanup: mock(async () => {}),
      })),
    }));

    await moduleMocker.mock('../executors/claude_code/format.js', () => ({
      extractStructuredMessages: mock((results: any[]) => {
        return results
          .filter((r: any) => r.type === 'result' || r.type === 'assistant')
          .map((r: any) => r.resultText || r.rawMessage || '');
      }),
      formatJsonMessage: mock((line: string) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result') {
            return { type: 'result', resultText: parsed.result || '' };
          }
          if (parsed.type === 'assistant') {
            return { type: 'assistant', rawMessage: parsed.content || '' };
          }
          return { type: parsed.type };
        } catch {
          return { type: 'unknown' };
        }
      }),
      resetToolUseCache: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        capturedSpawnEnv = opts?.env;
        if (opts?.formatStdout) {
          const resultJson = JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: 'Claude execution complete.',
          });
          opts.formatStdout(resultJson + '\n');
        }
        return createStreamingProcessMock();
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));
  }

  beforeEach(async () => {
    clearPlanCache();
    stdoutWriteCalls = [];

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-tunnel-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
    await writePlanFile(planFilePath, basePlan);

    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((data: any) => {
      stdoutWriteCalls.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates tunnel server and passes TIM_OUTPUT_SOCKET when tunnel is inactive', async () => {
    await setupCommonMocks(false);

    const { handleSubagentCommand } = await import('./subagent.js');
    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    // createTunnelServer should have been called
    expect(createTunnelServerCalls).toHaveLength(1);
    expect(createTunnelServerCalls[0]).toContain('output.sock');

    // onPromptRequest handler should have been passed
    expect(createTunnelServerOptions).toHaveLength(1);
    expect(createTunnelServerOptions[0]).toBeDefined();
    expect(typeof createTunnelServerOptions[0].onPromptRequest).toBe('function');

    // The spawned process env should include TIM_OUTPUT_SOCKET
    expect(capturedSpawnEnv).toBeDefined();
    expect(capturedSpawnEnv!.TIM_OUTPUT_SOCKET).toBeDefined();
    expect(capturedSpawnEnv!.TIM_OUTPUT_SOCKET).toContain('output.sock');
  });

  test('does not create tunnel server when tunnel is already active', async () => {
    await setupCommonMocks(true);

    const { handleSubagentCommand } = await import('./subagent.js');
    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    // createTunnelServer should NOT have been called
    expect(createTunnelServerCalls).toHaveLength(0);

    // TIM_OUTPUT_SOCKET should NOT be in the spawned process env
    // (it may be inherited from process.env, but the subagent code should not set it explicitly)
    expect(capturedSpawnEnv).toBeDefined();
    // The code only sets TIM_OUTPUT_SOCKET when tunnelServer && tunnelSocketPath are defined.
    // Since no tunnel server was created, these are undefined.
    // The env spread from process.env might include it if the test env has it,
    // but the conditional spread in the code won't add it since tunnelServer is undefined.
  });

  test('calls tunnel server close on cleanup after successful execution', async () => {
    await setupCommonMocks(false);

    const { handleSubagentCommand } = await import('./subagent.js');
    await handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {});

    // Tunnel server close should have been called in the finally block
    expect(tunnelCloseCallCount).toBe(1);
  });

  test('calls tunnel server close on cleanup even after execution failure', async () => {
    createTunnelServerCalls = [];
    tunnelCloseCallCount = 0;
    capturedSpawnEnv = undefined;

    // Set up all mocks except the process mock, which we customize for failure
    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        executors: {},
        agents: {},
      })),
    }));
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));
    await moduleMocker.mock('../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'Mock context'),
    }));
    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => false),
    }));
    await moduleMocker.mock('../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async (socketPath: string) => {
        createTunnelServerCalls.push(socketPath);
        return {
          close: mock(() => {
            tunnelCloseCallCount++;
          }),
        };
      }),
    }));
    await moduleMocker.mock('../executors/codex_cli/codex_runner.js', () => ({
      executeCodexStep: mock(async () => 'Codex done.'),
    }));
    await moduleMocker.mock('../executors/codex_cli/agent_helpers.js', () => ({
      loadAgentInstructionsFor: mock(async () => undefined),
    }));
    await moduleMocker.mock('../assignments/permissions_io.js', () => ({
      readSharedPermissions: mock(async () => ({ permissions: { allow: [] } })),
    }));
    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'test-repo' })),
    }));
    await moduleMocker.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
      setupPermissionsMcp: mock(async () => ({
        mcpConfigFile: '/tmp/mock-mcp-config.json',
        tempDir: '/tmp/mock-mcp-dir',
        socketServer: { close: mock(() => {}) },
        cleanup: mock(async () => {}),
      })),
    }));
    await moduleMocker.mock('../executors/claude_code/format.js', () => ({
      extractStructuredMessages: mock(() => []),
      formatJsonMessage: mock(() => ({ type: 'unknown' })),
      resetToolUseCache: mock(() => {}),
    }));

    // Simulate a non-zero exit code with no result message to trigger an error
    await moduleMocker.mock('../../common/process.js', () => ({
      spawnWithStreamingIO: mock(async () => {
        return createStreamingProcessMock({ exitCode: 1 });
      }),
      createLineSplitter: () => (input: string) => input.split('\n').filter(Boolean),
      sendSinglePromptAndWait: sendSinglePromptAndWaitForTest,
    }));

    const { handleSubagentCommand } = await import('./subagent.js');

    // This should throw due to non-zero exit code
    await expect(
      handleSubagentCommand('implementer', planFilePath, { executor: 'claude-code' }, {})
    ).rejects.toThrow();

    // Tunnel server close should STILL have been called (in the finally block)
    expect(tunnelCloseCallCount).toBe(1);
  });

  test('does not pass TIM_OUTPUT_SOCKET to codex executor (codex handles its own tunneling)', async () => {
    await setupCommonMocks(false);

    const { handleSubagentCommand } = await import('./subagent.js');
    await handleSubagentCommand('implementer', planFilePath, { executor: 'codex-cli' }, {});

    // For codex path, spawnAndLogOutput is not called (codex uses executeCodexStep)
    // so capturedSpawnEnv should remain undefined
    expect(capturedSpawnEnv).toBeUndefined();
  });
});
