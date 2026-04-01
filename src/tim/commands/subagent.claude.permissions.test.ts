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
  createPromptRequestHandler: vi.fn(),
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
}));
vi.mock('../../logging/tunnel_prompt_handler.js', () => ({
  createPromptRequestHandler: mocks.createPromptRequestHandler,
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

describe('subagent claude permissions MCP integration', () => {
  let tempDir: string;
  let stdoutWriteCalls: string[] = [];
  let originalBunWrite: typeof Bun.write;
  let originalConsoleLog: typeof console.log;
  let restoreIsTTY: (() => void) | null = null;
  let envSnapshot: Record<string, string | undefined> = {};
  let capturedClaudeSpawnArgs: string[] | undefined;
  let capturedPermissionsMcpSetupOptions: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    stdoutWriteCalls = [];
    capturedClaudeSpawnArgs = undefined;
    capturedPermissionsMcpSetupOptions = undefined;
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
        return { type: 'result', resultText: 'done' };
      }
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
    expect(capturedClaudeSpawnArgs!).toContain('mcp__permissions__approval_prompt');
    expect(capturedClaudeSpawnArgs!).toContain('--mcp-config');
    expect(capturedClaudeSpawnArgs!).toContain('/tmp/mock-mcp-config.json');
  });

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

  test('permissions MCP config takes priority over mcpConfigFile', async () => {
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
    expect(capturedClaudeSpawnArgs!).not.toContain('/path/to/user-mcp-config.json');
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
