import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleSubagentCommand } from './subagent.js';
import {
  createStreamingProcessMock,
  makeSubagentPlanFixture,
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
  getRepositoryIdentity: vi.fn(),
  getDatabase: vi.fn(),
  getPermissions: vi.fn(),
  getOrCreateProject: vi.fn(),
  setupPermissionsMcp: vi.fn(),
  spawnWithStreamingIO: vi.fn(),
  createLineSplitter: vi.fn(),
  sendSinglePromptAndWait: vi.fn(),
  extractStructuredMessages: vi.fn(),
  formatJsonMessage: vi.fn(),
  resetToolUseCache: vi.fn(),
  executeWithTerminalInput: vi.fn(),
  createPromptRequestHandler: vi.fn(),
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
vi.mock('../../logging/tunnel_prompt_handler.js', () => ({
  createPromptRequestHandler: mocks.createPromptRequestHandler,
}));
vi.mock('../../logging.js', () => ({
  log: mocks.log,
  error: mocks.error,
  warn: mocks.warn,
  debugLog: mocks.debugLog,
  sendStructured: mocks.sendStructured,
}));
vi.mock('../../common/process.js', () => ({
  spawnWithStreamingIO: mocks.spawnWithStreamingIO,
  createLineSplitter: mocks.createLineSplitter,
  sendSinglePromptAndWait: mocks.sendSinglePromptAndWait,
}));
vi.mock('../executors/claude_code/format.js', () => ({
  extractStructuredMessages: mocks.extractStructuredMessages,
  formatJsonMessage: mocks.formatJsonMessage,
  resetToolUseCache: mocks.resetToolUseCache,
}));
vi.mock('../executors/claude_code/terminal_input_lifecycle.js', () => ({
  executeWithTerminalInput: mocks.executeWithTerminalInput,
}));
vi.mock('../../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: mocks.getRepositoryIdentity,
}));
vi.mock('../../db/database.js', () => ({
  getDatabase: mocks.getDatabase,
}));
vi.mock('../../db/permission.js', () => ({
  getPermissions: mocks.getPermissions,
}));
vi.mock('../../db/project.js', () => ({
  getOrCreateProject: mocks.getOrCreateProject,
}));
vi.mock('../executors/claude_code/permissions_mcp_setup.js', () => ({
  setupPermissionsMcp: mocks.setupPermissionsMcp,
}));

describe('subagent command - executeWithClaude error scenarios and tunnel behavior', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;
  let currentPlanData = makeSubagentPlanFixture();
  let stdoutWriteCalls: string[] = [];
  let originalConsoleLog: typeof console.log;
  let originalBunWrite: typeof Bun.write;
  let restoreIsTTY: (() => void) | null = null;
  let envSnapshot: Record<string, string | undefined> = {};
  let capturedClaudeSpawnArgs: string[] | undefined;
  let capturedSpawnEnv: Record<string, string> | undefined;
  let createTunnelServerCalls: string[] = [];
  let createTunnelServerOptions: any[] = [];
  let tunnelCloseCallCount = 0;
  let effectiveConfigOverride: any = null;

  beforeEach(async () => {
    vi.clearAllMocks();

    currentPlanData = {
      ...makeSubagentPlanFixture(),
      tasks: [
        {
          title: 'Implement the widget',
          description: 'Write the widget code',
          done: false,
        },
      ],
    };
    stdoutWriteCalls = [];
    capturedClaudeSpawnArgs = undefined;
    capturedSpawnEnv = undefined;
    createTunnelServerCalls = [];
    createTunnelServerOptions = [];
    tunnelCloseCallCount = 0;
    effectiveConfigOverride = null;
    restoreIsTTY = null;
    envSnapshot = {
      TIM_NONINTERACTIVE: process.env.TIM_NONINTERACTIVE,
      ALLOW_ALL_TOOLS: process.env.ALLOW_ALL_TOOLS,
      CLAUDE_CODE_MCP: process.env.CLAUDE_CODE_MCP,
    };
    delete process.env.TIM_NONINTERACTIVE;
    delete process.env.ALLOW_ALL_TOOLS;
    delete process.env.CLAUDE_CODE_MCP;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-claude-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    planFilePath = path.join(tasksDir, '42-test-plan.plan.md');
    await writePlanFixture(planFilePath, currentPlanData);

    originalBunWrite = Bun.write;
    Bun.write = (async (dest: any, data: any) => {
      if (dest === Bun.stdout) {
        stdoutWriteCalls.push(typeof data === 'string' ? data : data.toString());
        return (typeof data === 'string' ? data : data.toString()).length;
      }
      return originalBunWrite(dest, data);
    }) as typeof Bun.write;

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
    mocks.buildExecutionPromptWithoutSteps.mockImplementation(async () => 'Mock context');
    mocks.loadAgentInstructionsFor.mockImplementation(async () => undefined);
    mocks.isTunnelActive.mockReturnValue(false);
    mocks.createTunnelServer.mockImplementation(async (socketPath: string, options?: any) => {
      createTunnelServerCalls.push(socketPath);
      createTunnelServerOptions.push(options);
      return {
        close: vi.fn(() => {
          tunnelCloseCallCount++;
        }),
      };
    });
    mocks.createPromptRequestHandler.mockReturnValue(vi.fn());
    mocks.getRepositoryIdentity.mockResolvedValue({ repositoryId: 'test-repo' });
    mocks.getDatabase.mockReturnValue({} as any);
    mocks.getPermissions.mockReturnValue({ allow: [], deny: [] });
    mocks.getOrCreateProject.mockReturnValue({ id: 1 });
    mocks.setupPermissionsMcp.mockImplementation(async () => ({
      mcpConfigFile: '/tmp/mock-mcp-config.json',
      tempDir: '/tmp/mock-mcp-dir',
      socketServer: { close: vi.fn() },
      cleanup: vi.fn(async () => {}),
    }));
    mocks.extractStructuredMessages.mockImplementation((results: any[]) => {
      return results
        .filter((r: any) => r.type === 'result' || r.type === 'assistant')
        .map((r: any) => r.resultText || r.rawMessage || '');
    });
    mocks.formatJsonMessage.mockImplementation((line: string) => {
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
    });
    mocks.resetToolUseCache.mockImplementation(() => {});
    mocks.spawnWithStreamingIO.mockImplementation(async (args: string[], opts: any) => {
      capturedClaudeSpawnArgs = args;
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
    });
    mocks.createLineSplitter.mockReturnValue((input: string) => input.split('\n').filter(Boolean));
    mocks.sendSinglePromptAndWait.mockImplementation(
      async (streamingProcess: any, content: string) => {
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
    );
    mocks.executeWithTerminalInput.mockImplementation(({ streaming, prompt }: any) => {
      const inputMessage = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: prompt,
        },
      });
      streaming.stdin.write(`${inputMessage}\n`);
      void streaming.stdin.end();
      return {
        resultPromise: streaming.result,
        onResultMessage: vi.fn(),
        sendFollowUpMessage: vi.fn(),
        closeStdin: vi.fn(),
        cleanup: vi.fn(() => {}),
      };
    });
  });

  afterEach(async () => {
    restoreIsTTY?.();
    console.log = originalConsoleLog;
    Bun.write = originalBunWrite;
    if (envSnapshot.TIM_NONINTERACTIVE === undefined) {
      delete process.env.TIM_NONINTERACTIVE;
    } else {
      process.env.TIM_NONINTERACTIVE = envSnapshot.TIM_NONINTERACTIVE;
    }
    if (envSnapshot.ALLOW_ALL_TOOLS === undefined) {
      delete process.env.ALLOW_ALL_TOOLS;
    } else {
      process.env.ALLOW_ALL_TOOLS = envSnapshot.ALLOW_ALL_TOOLS;
    }
    if (envSnapshot.CLAUDE_CODE_MCP === undefined) {
      delete process.env.CLAUDE_CODE_MCP;
    } else {
      process.env.CLAUDE_CODE_MCP = envSnapshot.CLAUDE_CODE_MCP;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('delegates to claude when executor is claude-code', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs![0]).toBe('claude');
  });

  test('defaults to claude-code when executor option is empty', async () => {
    await handleSubagentCommand('implementer', 42, { executor: '' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs![0]).toBe('claude');
  });

  test('passes model to claude-code spawned process', async () => {
    await handleSubagentCommand(
      'implementer',
      42,
      { executor: 'claude-code', model: 'sonnet' },
      {}
    );

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const modelIdx = capturedClaudeSpawnArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![modelIdx + 1]).toBe('sonnet');
  });

  test('uses default opus model when no model specified for claude', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const modelIdx = capturedClaudeSpawnArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![modelIdx + 1]).toBe('opus');
  });

  test('uses subagents config model for claude subagent when CLI model is not set', async () => {
    effectiveConfigOverride = {
      paths: { tasks: tasksDir },
      models: {},
      executors: {},
      subagents: { implementer: { model: { claude: 'sonnet-4.6' } } },
      agents: {},
    };

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const modelIdx = capturedClaudeSpawnArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![modelIdx + 1]).toBe('sonnet-4.6');
  });

  test('uses legacy claude subagent model config as fallback', async () => {
    effectiveConfigOverride = {
      paths: { tasks: tasksDir },
      models: {},
      executors: { 'claude-code': { agents: { implementer: { model: 'legacy-sonnet' } } } },
      agents: {},
    };

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const modelIdx = capturedClaudeSpawnArgs!.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![modelIdx + 1]).toBe('legacy-sonnet');
  });

  test('claude-code path includes stream-json output format', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--output-format');
    const fmtIdx = capturedClaudeSpawnArgs!.indexOf('--output-format');
    expect(capturedClaudeSpawnArgs![fmtIdx + 1]).toBe('stream-json');
  });

  test('claude-code path includes --verbose and --input-format stream-json flags', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--verbose');
    expect(capturedClaudeSpawnArgs!).toContain('--input-format');
    const inputFormatIndex = capturedClaudeSpawnArgs!.indexOf('--input-format');
    expect(capturedClaudeSpawnArgs![inputFormatIndex + 1]).toBe('stream-json');
  });

  test('claude-code path writes prompt to stdin as stream-json line and closes stdin', async () => {
    const stdinWrite = vi.fn((_value: string) => {});
    const stdinEnd = vi.fn(async () => {});
    const streamingProcess = createStreamingProcessMock({
      stdin: { write: stdinWrite, end: stdinEnd },
    });
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (args: string[], opts: any) => {
      capturedClaudeSpawnArgs = args;
      capturedSpawnEnv = opts?.env;
      if (opts?.formatStdout) {
        const resultJson = JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'Claude execution complete.',
        });
        opts.formatStdout(resultJson + '\n');
      }
      return streamingProcess;
    });

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(stdinWrite).toHaveBeenCalledTimes(1);
    const sentLine = stdinWrite.mock.calls[0]?.[0];
    expect(typeof sentLine).toBe('string');
    expect(sentLine.endsWith('\n')).toBe(true);
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
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--no-session-persistence');
  });

  test('claude-code path includes allowed tools', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--allowedTools');
  });

  test('claude-code path respects allowAllTools config', async () => {
    effectiveConfigOverride = {
      paths: { tasks: tasksDir },
      models: {},
      executors: { 'claude-code': { allowAllTools: true } },
      agents: {},
    };

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--dangerously-skip-permissions');
    expect(capturedClaudeSpawnArgs!).not.toContain('--allowedTools');
  });

  test('claude-code path includes MCP config when configured', async () => {
    effectiveConfigOverride = {
      paths: { tasks: tasksDir },
      models: {},
      executors: { 'claude-code': { mcpConfigFile: '/path/to/mcp-config.json' } },
      agents: {},
    };

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs!).toContain('/path/to/mcp-config.json');
  });

  test('prints final message to stdout for claude executor', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Claude execution complete.');
  });

  test('throws error on non-zero exit code with no result message', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], _opts: any) => {
      return createStreamingProcessMock({ exitCode: 1 });
    });
    mocks.formatJsonMessage.mockImplementation((line: string) => {
      try {
        const parsed = JSON.parse(line);
        return { type: parsed.type };
      } catch {
        return { type: 'unknown' };
      }
    });
    mocks.extractStructuredMessages.mockReturnValue([]);

    await expect(
      handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {})
    ).rejects.toThrow('non-zero exit code');
  });

  test('non-zero exit code is tolerated when a result message was received', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        const resultJson = JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'Completed despite exit code.',
        });
        opts.formatStdout(resultJson + '\n');
      }
      return createStreamingProcessMock({ exitCode: 1 });
    });

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Completed despite exit code.');
  });

  test('throws error on timeout (killedByInactivity) with no result message', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], _opts: any) => {
      return createStreamingProcessMock({ killedByInactivity: true });
    });
    mocks.extractStructuredMessages.mockReturnValue([]);

    await expect(
      handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {})
    ).rejects.toThrow('timed out');
  });

  test('timeout is tolerated when a result message was received', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        const resultJson = JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'Completed before timeout.',
        });
        opts.formatStdout(resultJson + '\n');
      }
      return createStreamingProcessMock({ killedByInactivity: true });
    });

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Completed before timeout.');
  });

  test('throws error when no final message found in output', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        const logJson = JSON.stringify({ type: 'system', message: 'Starting...' });
        opts.formatStdout(logJson + '\n');
      }
      return createStreamingProcessMock();
    });
    mocks.extractStructuredMessages.mockReturnValue([]);

    await expect(
      handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {})
    ).rejects.toThrow('No final agent message found');
  });

  test('uses last assistant raw message when no result text is available', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        const assistantJson = JSON.stringify({
          type: 'assistant',
          content: 'Fallback assistant message.',
        });
        opts.formatStdout(assistantJson + '\n');
      }
      return createStreamingProcessMock();
    });

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(stdoutWriteCalls.join('')).toContain('Fallback assistant message.');
  });

  test('creates tunnel server and passes TIM_OUTPUT_SOCKET when tunnel is inactive', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(createTunnelServerCalls).toHaveLength(1);
    expect(createTunnelServerCalls[0]).toContain('output.sock');
    expect(createTunnelServerOptions).toHaveLength(1);
    expect(createTunnelServerOptions[0]).toBeDefined();
    expect(typeof createTunnelServerOptions[0].onPromptRequest).toBe('function');
    expect(capturedSpawnEnv).toBeDefined();
    expect(capturedSpawnEnv!.TIM_OUTPUT_SOCKET).toBeDefined();
    expect(capturedSpawnEnv!.TIM_OUTPUT_SOCKET).toContain('output.sock');
  });

  test('does not create tunnel server when tunnel is already active', async () => {
    mocks.isTunnelActive.mockReturnValue(true);

    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(createTunnelServerCalls).toHaveLength(0);
    expect(capturedSpawnEnv).toBeDefined();
  });

  test('calls tunnel server close on cleanup after successful execution', async () => {
    await handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {});

    expect(tunnelCloseCallCount).toBe(1);
  });

  test('calls tunnel server close on cleanup even after execution failure', async () => {
    mocks.spawnWithStreamingIO.mockImplementationOnce(async () => {
      return createStreamingProcessMock({ exitCode: 1 });
    });
    mocks.extractStructuredMessages.mockReturnValue([]);

    await expect(
      handleSubagentCommand('implementer', 42, { executor: 'claude-code' }, {})
    ).rejects.toThrow();

    expect(tunnelCloseCallCount).toBe(1);
  });
});
