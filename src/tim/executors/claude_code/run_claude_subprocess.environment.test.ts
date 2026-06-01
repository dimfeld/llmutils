import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../common/process.js', () => ({
  spawnWithStreamingIO: vi.fn(async () => ({
    pid: 123,
    stdin: {
      write: vi.fn(),
      end: vi.fn(async () => {}),
    },
    result: Promise.resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }),
    kill: vi.fn(),
  })),
  createLineSplitter: vi.fn(() => (input: string) => input.split('\n').filter(Boolean)),
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => true),
}));

vi.mock('../../../logging/tunnel_server.js', () => ({
  createTunnelServer: vi.fn(),
}));

vi.mock('../../../logging/tunnel_prompt_handler.js', () => ({
  createPromptRequestHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../../../logging/tunnel_protocol.js', () => ({
  TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
}));

vi.mock('../../../common/subprocess_monitor.js', () => ({
  normalizeSubprocessMonitorRules: vi.fn(),
  startSubprocessMonitor: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./permissions_mcp_setup.js', () => ({
  setupPermissionsMcp: vi.fn(),
}));

vi.mock('./terminal_input_lifecycle.js', () => ({
  executeWithTerminalInput: vi.fn(() => ({
    resultPromise: Promise.resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }),
    cleanup: vi.fn(),
  })),
}));

vi.mock('./format.js', () => ({
  extractStructuredMessages: vi.fn(() => []),
  formatJsonMessage: vi.fn(() => ({ type: 'result', resultText: 'done' })),
  resetToolUseCache: vi.fn(),
}));

vi.mock('../../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => {
    throw new Error('not configured');
  }),
}));

vi.mock('../../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../db/permission.js', () => ({
  getPermissions: vi.fn(() => ({ allow: [] })),
}));

vi.mock('../../db/project.js', () => ({
  getOrCreateProject: vi.fn(),
}));

vi.mock('../../../logging.js', () => ({
  debugLog: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  sendStructured: vi.fn(),
  warn: vi.fn(),
}));

import { spawnWithStreamingIO } from '../../../common/process.js';
import { runClaudeSubprocess } from './run_claude_subprocess.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('runClaudeSubprocess project environment', () => {
  test('passes project environment options while preserving Claude overrides', async () => {
    const timEnvironment = {
      environment: {
        TIM_DATABASE_NAME: 'db_{{planId}}',
      },
      context: {
        planId: '374',
      },
    };

    await runClaudeSubprocess({
      prompt: 'hello',
      cwd: '/tmp/project',
      timConfig: {} as any,
      timEnvironment,
      claudeCodeOptions: {
        permissionsMcp: { enabled: false },
      },
      noninteractive: true,
      label: 'test',
      processFormattedMessages: vi.fn(),
    });

    expect(vi.mocked(spawnWithStreamingIO)).toHaveBeenCalledOnce();
    expect(vi.mocked(spawnWithStreamingIO).mock.calls[0][1]).toMatchObject({
      cwd: '/tmp/project',
      timEnvironment,
      env: {
        TIM_EXECUTOR: 'claude',
        TIM_NOTIFY_SUPPRESS: '1',
        TMPDIR: '/tmp/claude/',
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: 'true',
      },
    });
  });
});
