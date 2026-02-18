import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../../testing.js';
import { addPermission } from '../../db/permission.js';
import { closeDatabaseForTesting, getDatabase } from '../../db/database.js';
import { getOrCreateProject } from '../../db/project.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('runClaudeSubprocess shared permissions DB integration', () => {
  let tempDir: string;
  let configDir: string;
  let repoDir: string;
  let originalEnv: Partial<Record<string, string>>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-claude-subprocess-db-test-'));
    configDir = path.join(tempDir, 'config');
    repoDir = path.join(tempDir, 'repo');

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;
    closeDatabaseForTesting();
  });

  afterEach(async () => {
    moduleMocker.clear();
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

  test('includes DB shared allow permissions in subprocess --allowedTools', async () => {
    const repositoryId = 'repo-with-shared-permissions';
    const sharedTool = 'Bash(custom-shared-command:*)';

    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    addPermission(db, project.id, 'allow', sharedTool);

    let spawnedArgs: string[] | null = null;

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async (args: string[]) => {
        spawnedArgs = args;
        return {
          stdin: {
            write: mock(() => {}),
            end: mock(async () => {}),
          },
          result: Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }),
          kill: mock(() => {}),
        };
      }),
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendInitialPrompt: () => {},
      sendFollowUpMessage: () => {},
      closeStdinAndWait: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      }),
      sendSinglePromptAndWait: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      }),
    }));

    const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

    await runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: repoDir,
      label: 'test',
      noninteractive: true,
      claudeCodeOptions: {
        includeDefaultTools: false,
      },
      processFormattedMessages: () => {},
    });

    expect(spawnedArgs).not.toBeNull();
    const allowedToolsIndex = spawnedArgs!.indexOf('--allowedTools');
    expect(allowedToolsIndex).toBeGreaterThan(-1);
    expect(spawnedArgs![allowedToolsIndex + 1]).toContain(sharedTool);
  });

  test('uses streaming terminal input path when terminalInput is enabled', async () => {
    const repositoryId = 'repo-with-terminal-input';
    const awaitAndCleanupSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const setupTerminalInputSpy = mock(() => ({
      started: true,
      onResultMessage: mock(() => {}),
      awaitAndCleanup: awaitAndCleanupSpy,
    }));
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async () => ({
        stdin: {
          write: mock(() => {}),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));
    await moduleMocker.mock('./terminal_input_lifecycle.js', () => ({
      setupTerminalInput: setupTerminalInputSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

      await runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: repoDir,
        label: 'test',
        noninteractive: false,
        terminalInput: true,
        claudeCodeOptions: {
          includeDefaultTools: false,
        },
        processFormattedMessages: () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(setupTerminalInputSpy).toHaveBeenCalledTimes(1);
    expect(awaitAndCleanupSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
  });

  test('closes stdin on result message so subprocess result can resolve in terminal input mode', async () => {
    const repositoryId = 'repo-with-terminal-input-deadlock';
    const onResultMessageSpy = mock(() => {});
    const awaitAndCleanupSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const setupTerminalInputSpy = mock(() => ({
      started: true,
      onResultMessage: onResultMessageSpy,
      awaitAndCleanup: awaitAndCleanupSpy,
    }));
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const resultLine =
      '{"type":"result","subtype":"success","total_cost_usd":0,"duration_ms":1,"duration_api_ms":1,"is_error":false,"num_turns":1,"result":"done","session_id":"session"}';

    let formatStdout: ((output: string) => unknown) | undefined;
    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        formatStdout = opts.formatStdout;
        return {
          stdin: {
            write: mock(() => {}),
            end: mock(async () => {}),
          },
          result: Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }),
          kill: mock(() => {}),
        };
      }),
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));
    await moduleMocker.mock('./terminal_input_lifecycle.js', () => ({
      setupTerminalInput: setupTerminalInputSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('runClaudeSubprocess did not resolve')), 250);
      });
      await Promise.race([
        runClaudeSubprocess({
          prompt: 'test prompt',
          cwd: repoDir,
          label: 'test',
          noninteractive: false,
          terminalInput: true,
          claudeCodeOptions: {
            includeDefaultTools: false,
          },
          processFormattedMessages: () => {},
        }),
        timeoutPromise,
      ]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    formatStdout?.(`${resultLine}\n`);
    expect(onResultMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
  });

  test('logs terminal input hint when terminal lifecycle starts', async () => {
    const repositoryId = 'repo-with-terminal-follow-up';
    const awaitAndCleanupSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const setupTerminalInputSpy = mock(() => ({
      started: true,
      onResultMessage: mock(() => {}),
      awaitAndCleanup: awaitAndCleanupSpy,
    }));
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const logSpy = mock(() => {});

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async () => ({
        stdin: {
          write: mock(() => {}),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      debugLog: mock(() => {}),
      error: mock(() => {}),
      log: logSpy,
      sendStructured: mock(() => {}),
    }));

    await moduleMocker.mock('./terminal_input_lifecycle.js', () => ({
      setupTerminalInput: setupTerminalInputSpy,
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

      await runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: repoDir,
        label: 'test',
        noninteractive: false,
        terminalInput: true,
        claudeCodeOptions: {
          includeDefaultTools: false,
        },
        processFormattedMessages: () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(setupTerminalInputSpy).toHaveBeenCalledTimes(1);
    expect(awaitAndCleanupSpy).toHaveBeenCalledTimes(1);
    expect(
      logSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' && arg.includes('Type a message and press Enter to send input')
        )
      )
    ).toBe(true);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
  });

  test('emits user_terminal_input structured message even when follow-up send throws', async () => {
    const repositoryId = 'repo-terminal-input-send-error';
    const sendStructuredSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {
      throw new Error('write failed');
    });
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));
    const debugLogSpy = mock(() => {});

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async () => ({
        stdin: {
          write: mock(() => {}),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      debugLog: debugLogSpy,
      error: mock(() => {}),
      log: mock(() => {}),
      sendStructured: sendStructuredSpy,
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
    }));

    await moduleMocker.mock('./terminal_input.js', () => ({
      TerminalInputReader: class {
        private readonly onLine: (line: string) => void;

        constructor(options: { onLine: (line: string) => void }) {
          this.onLine = options.onLine;
        }

        start() {
          this.onLine('follow-up');
          return true;
        }

        stop() {}
      },
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

      await runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: repoDir,
        label: 'test',
        noninteractive: false,
        terminalInput: true,
        claudeCodeOptions: {
          includeDefaultTools: false,
        },
        processFormattedMessages: () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
    expect(
      sendStructuredSpy.mock.calls.some(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          call[0].type === 'user_terminal_input' &&
          call[0].source === 'terminal'
      )
    ).toBe(true);
    expect(debugLogSpy).toHaveBeenCalled();
  });

  test('falls back to single prompt path when terminal input is disabled by noninteractive mode', async () => {
    const repositoryId = 'repo-terminal-input-noninteractive';
    const sendInitialPromptSpy = mock(() => {});
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async () => ({
        stdin: {
          write: mock(() => {}),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('./terminal_input.js', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: () => false,
      TunnelAdapter: class {},
    }));

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

      await runClaudeSubprocess({
        prompt: 'test prompt',
        cwd: repoDir,
        label: 'test',
        noninteractive: true,
        terminalInput: false,
        claudeCodeOptions: {
          includeDefaultTools: false,
        },
        processFormattedMessages: () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(0);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(1);
  });

  test('forwards tunnel adapter user_input to subprocess stdin and unregisters on cleanup', async () => {
    const repositoryId = 'repo-terminal-input-tunnel-forward';
    const sendInitialPromptSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {});
    const sendSinglePromptAndWaitSpy = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));

    class TestTunnelAdapter {
      private callback: ((content: string) => void) | undefined;

      log(): void {}
      error(): void {}
      warn(): void {}
      debug(): void {}
      debugLog(): void {}
      sendStructured(): void {}
      writeStdout(): void {}
      writeStderr(): void {}
      flush?(): void {}
      destroySync?(): void {}
      destroy?(): Promise<void> {
        return Promise.resolve();
      }

      setUserInputHandler(callback: ((content: string) => void) | undefined): void {
        this.callback = callback;
      }

      emitUserInput(content: string): void {
        this.callback?.(content);
      }
    }

    const adapter = new TestTunnelAdapter();
    const resultLine =
      '{"type":"result","subtype":"success","total_cost_usd":0,"duration_ms":1,"duration_api_ms":1,"is_error":false,"num_turns":1,"result":"done","session_id":"session"}';
    let formatStdout: ((output: string) => unknown) | undefined;
    let resolveResult:
      | ((value: {
          exitCode: number;
          stdout: string;
          stderr: string;
          signal: null;
          killedByInactivity: boolean;
        }) => void)
      | undefined;

    const stdin = {
      write: mock(() => {}),
      end: mock(async () => {}),
    };

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      createLineSplitter: () => (value: string) => value.split('\n').filter(Boolean),
      spawnWithStreamingIO: mock(async (_args: string[], opts: any) => {
        formatStdout = opts.formatStdout;
        return {
          stdin,
          result: new Promise((resolve) => {
            resolveResult = resolve;
          }),
          kill: mock(() => {}),
        };
      }),
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: () => adapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: () => true,
      TunnelAdapter: TestTunnelAdapter,
    }));

    await moduleMocker.mock('./streaming_input.js', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: sendFollowUpMessageSpy,
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');
    const runPromise = runClaudeSubprocess({
      prompt: 'test prompt',
      cwd: repoDir,
      label: 'test',
      noninteractive: true,
      terminalInput: false,
      claudeCodeOptions: {
        includeDefaultTools: false,
      },
      processFormattedMessages: () => {},
    });
    const setupStart = Date.now();
    while (!resolveResult && Date.now() - setupStart < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    adapter.emitUserInput('forward this');
    formatStdout?.(`${resultLine}\n`);
    adapter.emitUserInput('ignored after result');
    resolveResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await runPromise;

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(0);
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy).toHaveBeenCalledWith(stdin, 'forward this');

    adapter.emitUserInput('ignored after cleanup');
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
  });
});
