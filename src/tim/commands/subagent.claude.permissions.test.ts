import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStreamingProcessMock } from './subagent.test-helpers.js';
import { runClaudeSubprocess } from '../executors/claude_code/run_claude_subprocess.js';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debugLog: vi.fn(),
  sendStructured: vi.fn(),
  isTunnelActive: vi.fn(),
  createTunnelServer: vi.fn(),
  createExecutorTunnelServer: vi.fn(),
  createPromptRequestHandler: vi.fn(),
  getRepositoryIdentity: vi.fn(),
  getDatabase: vi.fn(),
  getPermissions: vi.fn(),
  getOrCreateProject: vi.fn(),
  setupPermissionsMcp: vi.fn(),
  spawnWithStreamingIO: vi.fn(),
  createLineSplitter: vi.fn(),
  extractStructuredMessages: vi.fn(),
  formatJsonMessage: vi.fn(),
  createClaudeMessageFormatter: vi.fn(() => ({
    formatJsonMessage: mocks.formatJsonMessage,
  })),
  executeWithTerminalInput: vi.fn(),
}));

vi.mock('../../logging.js', () => ({
  log: mocks.log,
  error: mocks.error,
  warn: mocks.warn,
  debugLog: mocks.debugLog,
  sendStructured: mocks.sendStructured,
}));
vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: mocks.isTunnelActive,
}));
vi.mock('../../logging/tunnel_server.js', () => ({
  createTunnelServer: mocks.createTunnelServer,
  createExecutorTunnelServer: mocks.createTunnelServer,
}));
vi.mock('../../logging/tunnel_prompt_handler.js', () => ({
  createPromptRequestHandler: mocks.createPromptRequestHandler,
}));
vi.mock('../../common/process.js', () => ({
  spawnWithStreamingIO: mocks.spawnWithStreamingIO,
  createLineSplitter: mocks.createLineSplitter,
}));
vi.mock('../executors/claude_code/format.js', () => ({
  extractStructuredMessages: mocks.extractStructuredMessages,
  createClaudeMessageFormatter: mocks.createClaudeMessageFormatter,
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

describe('subagent claude permissions MCP integration', () => {
  let tempDir: string;
  let stdoutWriteCalls: string[] = [];
  let originalBunWrite: typeof Bun.write;
  let originalConsoleLog: typeof console.log;
  let restoreIsTTY: (() => void) | null = null;
  let envSnapshot: Record<string, string | undefined> = {};
  let capturedClaudeSpawnArgs: string[] | undefined;
  let capturedPermissionsMcpSetupOptions: any;
  let sawResultMessage = false;

  beforeEach(async () => {
    vi.clearAllMocks();

    stdoutWriteCalls = [];
    capturedClaudeSpawnArgs = undefined;
    capturedPermissionsMcpSetupOptions = undefined;
    sawResultMessage = false;
    restoreIsTTY = null;
    envSnapshot = {
      TIM_NONINTERACTIVE: process.env.TIM_NONINTERACTIVE,
      ALLOW_ALL_TOOLS: process.env.ALLOW_ALL_TOOLS,
      CLAUDE_CODE_MCP: process.env.CLAUDE_CODE_MCP,
    };
    delete process.env.TIM_NONINTERACTIVE;
    delete process.env.ALLOW_ALL_TOOLS;
    delete process.env.CLAUDE_CODE_MCP;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-subagent-mcp-test-'));
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
    restoreIsTTY = (() => {
      const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      return () => {
        if (descriptor) {
          Object.defineProperty(process.stdin, 'isTTY', descriptor);
        } else {
          delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
      };
    })();

    mocks.isTunnelActive.mockReturnValue(false);
    mocks.createTunnelServer.mockImplementation(async () => ({ close: vi.fn() }));
    mocks.createPromptRequestHandler.mockReturnValue(vi.fn());
    mocks.getRepositoryIdentity.mockResolvedValue({ repositoryId: 'test-repo' });
    mocks.getDatabase.mockReturnValue({} as any);
    mocks.getPermissions.mockReturnValue({ allow: [], deny: [] });
    mocks.getOrCreateProject.mockReturnValue({ id: 1 });
    mocks.setupPermissionsMcp.mockImplementation(async (options: any) => {
      capturedPermissionsMcpSetupOptions = options;
      return {
        mcpConfigFile: '/tmp/mock-mcp-config.json',
        tempDir: '/tmp/mock-mcp-dir',
        socketServer: { close: vi.fn() },
        cleanup: vi.fn(async () => {}),
      };
    });
    mocks.extractStructuredMessages.mockImplementation((results: any[]) => {
      return results
        .filter((r: any) => r.type === 'result' || r.type === 'assistant')
        .map((r: any) => r.resultText || r.rawMessage || '');
    });
    mocks.formatJsonMessage.mockImplementation((line: string) => {
      if (line === 'FILEPATH_EVENT') {
        return { type: 'assistant', filePaths: ['generated.txt'] };
      }
      if (line === 'RESULT_EVENT') {
        sawResultMessage = true;
        return { type: 'result', resultText: 'done' };
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result') {
          sawResultMessage = true;
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
    mocks.spawnWithStreamingIO.mockImplementation(async (args: string[], opts: any) => {
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
    });
    mocks.createLineSplitter.mockReturnValue((input: string) => input.split('\n').filter(Boolean));
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
        notifyBackgroundActivity: vi.fn(() => {}),
        sendFollowUpForInterceptedResult: vi.fn(),
        acceptedSuccessfulFinalResult: vi.fn(() => true),
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

  test('includes --permission-prompt-tool and --mcp-config when permissionsMcp is enabled', async () => {
    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {
        permissionsMcp: {
          enabled: true,
        },
      },
      noninteractive: false,
      label: 'subagent',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('--permission-prompt-tool');
    expect(capturedClaudeSpawnArgs!).toContain('mcp__tim__approval_prompt');
    expect(capturedClaudeSpawnArgs!).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs!).toContain('/tmp/mock-mcp-config.json');
  });

  test.each([
    {
      name: 'not installed',
      claudeCodeOptions: {},
      noninteractive: true,
      setupExpected: false,
      approvalExpected: false,
    },
    {
      name: 'permission-only',
      claudeCodeOptions: { permissionsMcp: { enabled: true } },
      noninteractive: false,
      setupExpected: true,
      approvalExpected: true,
    },
    {
      name: 'requested-approval-noninteractive',
      claudeCodeOptions: { permissionsMcp: { enabled: true } },
      noninteractive: true,
      setupExpected: false,
      approvalExpected: false,
    },
    {
      name: 'requested-approval-allow-all',
      claudeCodeOptions: {
        allowAllTools: true,
        permissionsMcp: { enabled: true },
      },
      noninteractive: false,
      setupExpected: false,
      approvalExpected: false,
    },
    {
      name: 'tools-only',
      claudeCodeOptions: {
        agentToolContext: {
          caller: { id: 'orchestrator-id', name: 'orchestrator', role: 'orchestrator' },
          allowedTools: new Set([
            'StartTimAgent',
            'ListTimAgents',
            'SendTimAgentMessage',
            'StopTimAgent',
          ]),
          dispatcher: {
            startAgent: vi.fn(),
            listAgents: vi.fn(),
            sendAgentMessage: vi.fn(),
            stopAgent: vi.fn(),
            finishAgent: vi.fn(),
          },
        },
      },
      noninteractive: true,
      setupExpected: true,
      approvalExpected: false,
    },
    {
      name: 'combined',
      claudeCodeOptions: {
        permissionsMcp: { enabled: true },
        agentToolContext: {
          caller: { id: 'orchestrator-id', name: 'orchestrator', role: 'orchestrator' },
          allowedTools: new Set([
            'StartTimAgent',
            'ListTimAgents',
            'SendTimAgentMessage',
            'StopTimAgent',
          ]),
          dispatcher: {
            startAgent: vi.fn(),
            listAgents: vi.fn(),
            sendAgentMessage: vi.fn(),
            stopAgent: vi.fn(),
            finishAgent: vi.fn(),
          },
        },
      },
      noninteractive: false,
      setupExpected: true,
      approvalExpected: true,
    },
  ])(
    'installs the $name Claude MCP capability state with independent approval flags',
    async ({ claudeCodeOptions, noninteractive, setupExpected, approvalExpected }) => {
      await runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: tempDir,
        claudeCodeOptions,
        noninteractive,
        label: 'subagent',
        processFormattedMessages: vi.fn(),
      });

      const args = capturedClaudeSpawnArgs!;
      expect(mocks.setupPermissionsMcp).toHaveBeenCalledTimes(setupExpected ? 1 : 0);
      expect(args.includes('--mcp-config')).toBe(setupExpected);
      const permissionFlagIndex = args.indexOf('--permission-prompt-tool');
      expect(permissionFlagIndex >= 0).toBe(approvalExpected);
      if (approvalExpected) {
        expect(args[permissionFlagIndex + 1]).toBe('mcp__tim__approval_prompt');
      }
      if (setupExpected) {
        expect(capturedPermissionsMcpSetupOptions.interactiveApprovalEnabled).toBe(
          approvalExpected
        );
      }
    }
  );

  test('does not include --permission-prompt-tool when permissionsMcp is not enabled', async () => {
    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {},
      noninteractive: false,
      label: 'subagent',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).not.toContain('--permission-prompt-tool');
  });

  test('passes the original user MCP config directly when no internal bridge is needed', async () => {
    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {
        mcpConfigFile: '/path/to/user-mcp-config.json',
      },
      noninteractive: true,
      label: 'subagent',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedClaudeSpawnArgs).toBeDefined();
    const mcpConfigIndex = capturedClaudeSpawnArgs!.indexOf('--mcp-config');
    expect(mcpConfigIndex).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![mcpConfigIndex + 1]).toBe('/path/to/user-mcp-config.json');
    expect(mocks.setupPermissionsMcp).not.toHaveBeenCalled();
  });

  test('passes the user MCP config to the internal bridge for merging', async () => {
    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {
        mcpConfigFile: '/path/to/user-mcp-config.json',
        permissionsMcp: {
          enabled: true,
        },
      },
      noninteractive: false,
      label: 'subagent',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).toContain('/tmp/mock-mcp-config.json');
    expect(capturedPermissionsMcpSetupOptions.mcpConfigFile).toBe('/path/to/user-mcp-config.json');
  });

  test('resolves a relative user MCP config against the Claude execution cwd', async () => {
    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {
        mcpConfigFile: 'config/user-mcp.json',
        permissionsMcp: { enabled: true },
      },
      noninteractive: false,
      label: 'subagent',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedPermissionsMcpSetupOptions.mcpConfigFile).toBe(
      path.join(tempDir, 'config/user-mcp.json')
    );
  });

  test('disables permissions MCP when allowAllTools is true', async () => {
    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {
        allowAllTools: true,
        permissionsMcp: {
          enabled: true,
        },
      },
      noninteractive: false,
      label: 'subagent',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedClaudeSpawnArgs).toBeDefined();
    expect(capturedClaudeSpawnArgs!).not.toContain('--permission-prompt-tool');
    expect(capturedClaudeSpawnArgs!).toContain('--dangerously-skip-permissions');
  });

  test('installs explicit agent tools in noninteractive mode without approval prompting', async () => {
    const context = {
      caller: { id: 'orchestrator-id', name: 'orchestrator', role: 'orchestrator' },
      allowedTools: new Set([
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
      ]),
      dispatcher: {
        startAgent: vi.fn(),
        listAgents: vi.fn(),
        sendAgentMessage: vi.fn(),
        stopAgent: vi.fn(),
        finishAgent: vi.fn(),
      },
    };

    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: { agentToolContext: context },
      noninteractive: true,
      label: 'orchestrator',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedPermissionsMcpSetupOptions).toMatchObject({
      interactiveApprovalEnabled: false,
      agentToolContext: context,
    });
    expect(capturedClaudeSpawnArgs).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs).not.toContain('--permission-prompt-tool');
    const allowedToolsIndex = capturedClaudeSpawnArgs!.indexOf('--allowedTools');
    expect(allowedToolsIndex).toBeGreaterThan(-1);
    expect(capturedClaudeSpawnArgs![allowedToolsIndex + 1]).toContain('mcp__tim__StartTimAgent');
    expect(capturedClaudeSpawnArgs![allowedToolsIndex + 1]).toContain('mcp__tim__ListTimAgents');
    expect(capturedClaudeSpawnArgs![allowedToolsIndex + 1]).toContain(
      'mcp__tim__SendTimAgentMessage'
    );
    expect(capturedClaudeSpawnArgs![allowedToolsIndex + 1]).toContain('mcp__tim__StopTimAgent');
  });

  test('keeps explicit agent tools installed in allow-all mode', async () => {
    const context = {
      caller: { id: 'orchestrator-id', name: 'orchestrator', role: 'orchestrator' },
      allowedTools: new Set([
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
      ]),
      dispatcher: {
        startAgent: vi.fn(),
        listAgents: vi.fn(),
        sendAgentMessage: vi.fn(),
        stopAgent: vi.fn(),
        finishAgent: vi.fn(),
      },
    };

    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: { allowAllTools: true, agentToolContext: context },
      noninteractive: false,
      label: 'orchestrator',
      processFormattedMessages: vi.fn(),
    });

    expect(capturedPermissionsMcpSetupOptions.interactiveApprovalEnabled).toBe(false);
    expect(capturedClaudeSpawnArgs).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs).not.toContain('--permission-prompt-tool');
    expect(capturedClaudeSpawnArgs).toContain('--dangerously-skip-permissions');
  });

  test('fails before spawning Claude when required agent tool setup fails', async () => {
    const context = {
      caller: { id: 'orchestrator-id', name: 'orchestrator', role: 'orchestrator' },
      allowedTools: new Set([
        'StartTimAgent',
        'ListTimAgents',
        'SendTimAgentMessage',
        'StopTimAgent',
      ]),
      dispatcher: {
        startAgent: vi.fn(),
        listAgents: vi.fn(),
        sendAgentMessage: vi.fn(),
        stopAgent: vi.fn(),
        finishAgent: vi.fn(),
      },
    };
    mocks.setupPermissionsMcp.mockRejectedValueOnce(new Error('bridge setup failed'));

    await expect(
      runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: tempDir,
        claudeCodeOptions: { agentToolContext: context },
        noninteractive: true,
        label: 'orchestrator',
        processFormattedMessages: vi.fn(),
      })
    ).rejects.toThrow('bridge setup failed');
    expect(mocks.spawnWithStreamingIO).not.toHaveBeenCalled();
  });

  test('rejects disallowed agent tools before spawning Claude', async () => {
    const context = {
      caller: { id: 'orchestrator-id', name: 'orchestrator', role: 'orchestrator' },
      allowedTools: new Set(['StartTimAgent']),
      dispatcher: {
        startAgent: vi.fn(),
        listAgents: vi.fn(),
        sendAgentMessage: vi.fn(),
        stopAgent: vi.fn(),
        finishAgent: vi.fn(),
      },
    };

    await expect(
      runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: tempDir,
        claudeCodeOptions: {
          agentToolContext: context,
          disallowedTools: ['mcp__tim__StartTimAgent'],
        },
        noninteractive: true,
        label: 'orchestrator',
        processFormattedMessages: vi.fn(),
      })
    ).rejects.toThrow('mcp__tim__StartTimAgent');
    expect(mocks.setupPermissionsMcp).not.toHaveBeenCalled();
    expect(mocks.spawnWithStreamingIO).not.toHaveBeenCalled();
  });

  test('passes autoApproveCreatedFileDeletion and tracked files into permissions MCP setup', async () => {
    const processFormattedMessages = vi.fn();
    mocks.spawnWithStreamingIO.mockImplementationOnce(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('FILEPATH_EVENT\nRESULT_EVENT\n');
      }
      return createStreamingProcessMock();
    });

    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: tempDir,
      claudeCodeOptions: {
        permissionsMcp: {
          enabled: true,
          autoApproveCreatedFileDeletion: true,
        },
      },
      noninteractive: false,
      label: 'subagent',
      processFormattedMessages,
    });

    expect(capturedPermissionsMcpSetupOptions).toBeDefined();
    expect(capturedPermissionsMcpSetupOptions.autoApproveCreatedFileDeletion).toBe(true);
    expect(capturedPermissionsMcpSetupOptions.workingDirectory).toBe(tempDir);
    expect(capturedPermissionsMcpSetupOptions.trackedFiles).toBeInstanceOf(Set);
    expect(
      capturedPermissionsMcpSetupOptions.trackedFiles.has(path.join(tempDir, 'generated.txt'))
    ).toBe(true);
  });
});
