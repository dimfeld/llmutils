import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

const selectResponses: Array<string | Error> = [];
const checkboxResponses: Array<string[] | Error> = [];
const inputResponses: Array<string | Error> = [];
const prefixPromptResponses: Array<{ exact: boolean; command: string } | Error> = [];

const mockPromptSelect = vi.fn(async () => {
  const next = selectResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (typeof next !== 'string') {
    throw new Error('No queued select response');
  }
  return next;
});

const mockPromptCheckbox = vi.fn(async () => {
  const next = checkboxResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (!Array.isArray(next)) {
    throw new Error('No queued checkbox response');
  }
  return next;
});

const mockPromptInput = vi.fn(async () => {
  const next = inputResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (typeof next !== 'string') {
    throw new Error('No queued input response');
  }
  return next;
});

const mockPromptPrefixSelect = vi.fn(async () => {
  const next = prefixPromptResponses.shift();
  if (next instanceof Error) {
    throw next;
  }
  if (!next) {
    throw new Error('No queued prefix prompt response');
  }
  return next;
});

vi.mock('../../../common/input.js', () => ({
  promptSelect: mockPromptSelect,
  promptCheckbox: mockPromptCheckbox,
  promptInput: mockPromptInput,
  promptPrefixSelect: mockPromptPrefixSelect,
  isPromptTimeoutError: (err: unknown) =>
    err instanceof Error &&
    (err.name === 'AbortPromptError' || err.message.startsWith('Prompt request timed out')),
}));

const { mergeClaudeMcpConfig, readUserMcpConfig, resolvePermissionsMcpPath, setupPermissionsMcp } =
  await import('./permissions_mcp_setup.js');
const { FifoClaudePermissionPromptCoordinator } =
  await import('./claude_permission_prompt_coordinator.js');

interface PermissionTestClient {
  readonly socket: net.Socket;
  readonly responses: Array<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function connectPermissionTestClient(socketPath: string): Promise<PermissionTestClient> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once('connect', () => resolve(client));
    client.once('error', reject);
  });
  const responses: Array<Record<string, unknown>> = [];
  let buffer = '';
  const waiters = new Map<
    string,
    {
      resolve: (response: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  socket.on('data', (data) => {
    buffer += data.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      responses.push(response);
      const requestId = typeof response.requestId === 'string' ? response.requestId : undefined;
      const waiter = requestId === undefined ? undefined : waiters.get(requestId);
      if (waiter !== undefined) {
        waiters.delete(requestId!);
        clearTimeout(waiter.timer);
        waiter.resolve(response);
      }
      newline = buffer.indexOf('\n');
    }
  });
  socket.on('error', (error) => {
    for (const [requestId, waiter] of waiters) {
      waiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  socket.on('close', () => {
    const error = new Error('Permission test client closed');
    for (const [requestId, waiter] of waiters) {
      waiters.delete(requestId);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  return {
    socket,
    responses,
    send: (message) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const requestId = message.requestId;
        if (typeof requestId !== 'string') {
          reject(new Error('Permission test messages need a requestId'));
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(requestId);
          reject(new Error(`Timed out waiting for ${requestId}`));
        }, 5000);
        waiters.set(requestId, { resolve, reject, timer });
        socket.write(`${JSON.stringify(message)}\n`);
      }),
  };
}

function makeSubagentToolContext(name: string) {
  return {
    caller: { id: `${name}-id`, name, role: 'subagent' as const },
    allowedTools: new Set(['ListAgents' as const]),
    dispatcher: {
      startAgent: vi.fn(),
      listAgents: vi.fn(),
      sendAgentMessage: vi.fn(),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
    },
  };
}

describe('Claude MCP config validation and merging', () => {
  test('preserves user servers and root fields while adding the tim server', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-mcp-config-'));
    const userConfigPath = path.join(tempRoot, 'user.json');
    const userConfig = {
      customRootField: { enabled: true },
      mcpServers: {
        github: {
          command: './github-server',
          args: ['--repo', 'example'],
          env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG_LEVEL: 'debug' },
        },
        local: { type: 'sse', url: 'http://127.0.0.1:8123' },
      },
    };

    try {
      await fs.writeFile(userConfigPath, JSON.stringify(userConfig));
      const result = await setupPermissionsMcp({
        allowedTools: [],
        interactiveApprovalEnabled: false,
        mcpConfigFile: userConfigPath,
      });

      const generated = JSON.parse(await fs.readFile(result.mcpConfigFile, 'utf8')) as {
        customRootField: unknown;
        mcpServers: Record<string, unknown>;
      };
      expect(generated.customRootField).toEqual(userConfig.customRootField);
      expect(generated.mcpServers.github).toEqual(userConfig.mcpServers.github);
      expect(generated.mcpServers.local).toEqual(userConfig.mcpServers.local);
      expect(generated.mcpServers.tim).toMatchObject({
        type: 'stdio',
        command: 'bun',
      });
      expect(JSON.parse(await fs.readFile(userConfigPath, 'utf8'))).toEqual(userConfig);
      await result.cleanup();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects a reserved tim server collision', async () => {
    const userConfig = await readUserMcpConfig(undefined);
    expect(() =>
      mergeClaudeMcpConfig(
        { ...userConfig, mcpServers: { tim: { command: 'user-server' } } },
        { type: 'stdio', command: 'bun', args: [] }
      )
    ).toThrow('reserved for tim');
  });

  test('setup rejects a reserved tim server collision before creating a temp directory', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-mcp-config-'));
    const userConfigPath = path.join(tempRoot, 'user.json');
    const mkdtempCallsBefore = vi.mocked(fs.mkdtemp).mock.calls.length;
    try {
      await fs.writeFile(
        userConfigPath,
        JSON.stringify({ mcpServers: { tim: { command: 'user-server' } } })
      );
      await expect(
        setupPermissionsMcp({
          allowedTools: [],
          mcpConfigFile: userConfigPath,
        })
      ).rejects.toThrow('reserved for tim');
      expect(vi.mocked(fs.mkdtemp)).toHaveBeenCalledTimes(mkdtempCallsBefore);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['invalid JSON', '{'],
    ['non-object root', '[]'],
    ['null root', 'null'],
    ['invalid mcpServers', JSON.stringify({ mcpServers: [] })],
  ])('rejects %s before setup allocation', async (_name, content) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-mcp-config-'));
    const userConfigPath = path.join(tempRoot, 'user.json');
    const mkdtempCallsBefore = vi.mocked(fs.mkdtemp).mock.calls.length;
    try {
      await fs.writeFile(userConfigPath, content);
      await expect(
        setupPermissionsMcp({ allowedTools: [], mcpConfigFile: userConfigPath })
      ).rejects.toThrow(/Claude MCP config file/);
      expect(vi.mocked(fs.mkdtemp)).toHaveBeenCalledTimes(mkdtempCallsBefore);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    { name: 'permission-only', interactiveApprovalEnabled: true, agentToolNames: [] },
    {
      name: 'tools-only',
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents', 'SendAgentMessage', 'FinishAgent'],
    },
    {
      name: 'combined',
      interactiveApprovalEnabled: true,
      agentToolNames: ['StartAgent', 'ListAgents', 'SendAgentMessage', 'StopAgent'],
    },
  ])('writes the correct child capability manifest for $name', async (mode) => {
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: mode.interactiveApprovalEnabled,
      agentToolContext:
        mode.agentToolNames.length === 0
          ? undefined
          : {
              caller: {
                id: 'caller-id',
                name: 'caller',
                role: mode.agentToolNames.includes('StartAgent') ? 'orchestrator' : 'subagent',
              },
              allowedTools: new Set(mode.agentToolNames),
              dispatcher: {
                startAgent: vi.fn(),
                listAgents: vi.fn(),
                sendAgentMessage: vi.fn(),
                stopAgent: vi.fn(),
                finishAgent: vi.fn(),
              },
            },
    });

    try {
      const config = JSON.parse(await fs.readFile(result.mcpConfigFile, 'utf8')) as {
        mcpServers: { tim: { args: string[] } };
      };
      if (mode.name === 'permission-only') {
        expect(config.mcpServers.tim.args).toHaveLength(3);
        expect(config.mcpServers.tim.args.at(-1)).toBe(result.logFile);
      } else {
        const manifest = JSON.parse(config.mcpServers.tim.args.at(-1) ?? '{}') as {
          interactiveApprovalEnabled?: boolean;
          agentToolNames?: string[];
        };

        expect(manifest).toEqual({
          interactiveApprovalEnabled: mode.interactiveApprovalEnabled,
          agentToolNames: mode.agentToolNames,
        });
      }
    } finally {
      await result.cleanup();
    }
  });
});

describe('permissions MCP path resolution', () => {
  test('prefers the compiled tim_mcp.js under the executable directory', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-permissions-path-'));
    const execDir = path.join(tempRoot, 'exec');
    const jsPath = path.join(execDir, 'claude_code', 'tim_mcp.js');

    try {
      await fs.mkdir(path.dirname(jsPath), { recursive: true });
      await fs.writeFile(jsPath, '');

      await expect(resolvePermissionsMcpPath(execDir)).resolves.toBe(jsPath);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('falls back to the local tim_mcp.ts when compiled script is missing', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-permissions-path-'));
    const execDir = path.join(tempRoot, 'exec');
    const localSourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tim_mcp.ts');

    try {
      await fs.mkdir(execDir, { recursive: true });

      await expect(resolvePermissionsMcpPath(execDir)).resolves.toBe(localSourcePath);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('shared permission prompt coordination over real MCP sockets', () => {
  test('serializes prompts by arrival order and uses the trusted requester label', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const promptMessages: string[] = [];
    let releaseFirstPrompt!: () => void;
    let firstShownResolve!: () => void;
    const firstShown = new Promise<void>((resolve) => {
      firstShownResolve = resolve;
    });
    const firstPromptGate = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });

    mockPromptSelect.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { message: string };
      promptMessages.push(options.message);
      if (promptMessages.length === 1) {
        firstShownResolve();
        await firstPromptGate;
      }
      return 'allow';
    });

    const setup = async (name: string) =>
      setupPermissionsMcp({
        allowedTools: [],
        interactiveApprovalEnabled: true,
        permissionPromptCoordinator: coordinator,
        agentToolContext: {
          caller: { id: `${name}-id`, name, role: 'subagent' },
          allowedTools: new Set(['ListAgents']),
          dispatcher: {
            startAgent: vi.fn(),
            listAgents: vi.fn(),
            sendAgentMessage: vi.fn(),
            stopAgent: vi.fn(),
            finishAgent: vi.fn(),
          },
        },
      });

    const firstSetup = await setup('implementer-api');
    const secondSetup = await setup('tester-api');

    const sendPermission = (
      socketPath: string,
      requestId: string
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.write(
            `${JSON.stringify({
              type: 'permission_request',
              requestId,
              tool_name: 'Read',
              input: {},
            })}\n`
          );
        });
        let buffer = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Timed out waiting for permission response'));
        }, 5000);
        socket.on('data', (data) => {
          buffer += data.toString();
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          clearTimeout(timer);
          const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          socket.end();
          resolve(response);
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

    try {
      const firstResponse = sendPermission(
        path.join(firstSetup.tempDir, 'permissions.sock'),
        'fifo-first'
      );
      await firstShown;
      const secondResponse = sendPermission(
        path.join(secondSetup.tempDir, 'permissions.sock'),
        'fifo-second'
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(promptMessages).toHaveLength(1);
      expect(promptMessages[0]).toContain('Claude agent implementer-api');

      releaseFirstPrompt();
      await expect(firstResponse).resolves.toMatchObject({
        type: 'permission_response',
        requestId: 'fifo-first',
        approved: true,
      });
      await expect(secondResponse).resolves.toMatchObject({
        type: 'permission_response',
        requestId: 'fifo-second',
        approved: true,
      });
      expect(promptMessages).toHaveLength(2);
      expect(promptMessages[1]).toContain('Claude agent tester-api');
    } finally {
      await firstSetup.cleanup();
      await secondSetup.cleanup();
      await coordinator.dispose();
      mockPromptSelect.mockImplementation(async () => {
        const next = selectResponses.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== 'string') throw new Error('No queued select response');
        return next;
      });
    }
  });

  test('does not enqueue an automatically approved permission request', async () => {
    const enqueue = vi.fn();
    const coordinator = {
      enqueue,
      cancelRequester: vi.fn(),
      dispose: vi.fn(),
    };
    const result = await setupPermissionsMcp({
      allowedTools: ['Read'],
      permissionPromptCoordinator: coordinator,
    });
    const socket = net.createConnection(path.join(result.tempDir, 'permissions.sock'));

    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            `${JSON.stringify({
              type: 'permission_request',
              requestId: 'auto-approved',
              tool_name: 'Read',
              input: {},
            })}\n`
          );
        });
        let buffer = '';
        socket.on('data', (data) => {
          buffer += data.toString();
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        });
      });

      expect(response).toEqual({
        type: 'permission_response',
        requestId: 'auto-approved',
        approved: true,
      });
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await result.cleanup();
    }
  });

  test('holds one queue slot across every AskUserQuestion subprompt', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    let secondQuestionShown!: () => void;
    const secondQuestion = new Promise<void>((resolve) => {
      secondQuestionShown = resolve;
    });
    let releaseSecondQuestion!: () => void;
    const secondQuestionGate = new Promise<void>((resolve) => {
      releaseSecondQuestion = resolve;
    });
    let promptCount = 0;
    mockPromptSelect.mockImplementation(async () => {
      promptCount += 1;
      if (promptCount === 2) {
        secondQuestionShown();
        await secondQuestionGate;
        return 'Option B';
      }
      return promptCount === 1 ? 'Option A' : 'allow';
    });

    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
    });
    const socket = net.createConnection(path.join(result.tempDir, 'permissions.sock'));
    let buffer = '';
    const responses: Record<string, unknown>[] = [];
    socket.on('data', (data) => {
      buffer += data.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        responses.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            `${JSON.stringify({
              type: 'permission_request',
              requestId: 'ask-first',
              tool_name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    header: 'First',
                    question: 'First question?',
                    options: [{ label: 'Option A' }, { label: 'Option B' }],
                  },
                  {
                    header: 'Second',
                    question: 'Second question?',
                    options: [{ label: 'Option A' }, { label: 'Option B' }],
                  },
                ],
              },
            })}\n`
          );
          resolve();
        });
      });
      await secondQuestion;

      socket.write(
        `${JSON.stringify({
          type: 'permission_request',
          requestId: 'ask-second',
          tool_name: 'Read',
          input: {},
        })}\n`
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(promptCount).toBe(2);

      releaseSecondQuestion();
      const deadline = Date.now() + 2000;
      while (responses.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(responses).toHaveLength(2);
      expect(responses[0]).toMatchObject({
        type: 'permission_response',
        requestId: 'ask-first',
        approved: true,
      });
      expect(responses[1]).toMatchObject({
        type: 'permission_response',
        requestId: 'ask-second',
        approved: true,
      });
      expect(promptCount).toBe(3);
    } finally {
      socket.destroy();
      await result.cleanup();
      await coordinator.dispose();
      mockPromptSelect.mockImplementation(async () => {
        const next = selectResponses.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== 'string') throw new Error('No queued select response');
        return next;
      });
    }
  });

  test('cancels an active requester and immediately advances the next live socket', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const promptMessages: string[] = [];
    let firstShownResolve!: () => void;
    const firstShown = new Promise<void>((resolve) => {
      firstShownResolve = resolve;
    });
    let firstAbortedResolve!: () => void;
    const firstAborted = new Promise<void>((resolve) => {
      firstAbortedResolve = resolve;
    });
    let firstOperationFinishedResolve!: () => void;
    const firstOperationFinished = new Promise<void>((resolve) => {
      firstOperationFinishedResolve = resolve;
    });

    mockPromptSelect.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { message: string; signal?: AbortSignal };
      const promptOptions = options;
      promptMessages.push(options.message);
      if (promptMessages.length === 1) {
        firstShownResolve();
        await new Promise<void>((resolve) => {
          promptOptions?.signal?.addEventListener(
            'abort',
            () => {
              firstAbortedResolve();
              resolve();
            },
            { once: true }
          );
        });
        const error = new Error('Prompt was aborted');
        error.name = 'AbortPromptError';
        firstOperationFinishedResolve();
        throw error;
      }
      return 'allow';
    });

    const firstSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-a'),
    });
    const secondSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-b'),
    });
    const firstClient = await connectPermissionTestClient(
      path.join(firstSetup.tempDir, 'permissions.sock')
    );
    const secondClient = await connectPermissionTestClient(
      path.join(secondSetup.tempDir, 'permissions.sock')
    );

    try {
      const firstResponse = firstClient.send({
        type: 'permission_request',
        requestId: 'cancel-active-first',
        tool_name: 'Read',
        input: {},
      });
      void firstResponse.catch(() => undefined);
      await firstShown;

      const secondResponse = secondClient.send({
        type: 'permission_request',
        requestId: 'cancel-active-second',
        tool_name: 'Read',
        input: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      firstClient.socket.end();
      await firstAborted;
      await firstOperationFinished;

      await expect(secondResponse).resolves.toEqual({
        type: 'permission_response',
        requestId: 'cancel-active-second',
        approved: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(firstClient.responses).toEqual([]);
      expect(promptMessages).toHaveLength(2);
      expect(promptMessages[0]).toContain('Claude agent agent-a');
      expect(promptMessages[1]).toContain('Claude agent agent-b');
    } finally {
      secondClient.socket.end();
      await firstSetup.cleanup();
      await secondSetup.cleanup();
      await coordinator.dispose();
      mockPromptSelect.mockImplementation(async () => {
        const next = selectResponses.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== 'string') throw new Error('No queued select response');
        return next;
      });
    }
  });

  test('removes a queued requester before display and preserves FIFO order for live sockets', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const promptMessages: string[] = [];
    let firstShownResolve!: () => void;
    const firstShown = new Promise<void>((resolve) => {
      firstShownResolve = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    mockPromptSelect.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { message: string };
      promptMessages.push(options.message);
      if (promptMessages.length === 1) {
        firstShownResolve();
        await firstGate;
      }
      return 'allow';
    });

    const firstSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-a'),
    });
    const secondSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-b'),
    });
    const thirdSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-c'),
    });
    const firstClient = await connectPermissionTestClient(
      path.join(firstSetup.tempDir, 'permissions.sock')
    );
    const secondClient = await connectPermissionTestClient(
      path.join(secondSetup.tempDir, 'permissions.sock')
    );
    const thirdClient = await connectPermissionTestClient(
      path.join(thirdSetup.tempDir, 'permissions.sock')
    );

    try {
      const firstResponse = firstClient.send({
        type: 'permission_request',
        requestId: 'queued-first',
        tool_name: 'Read',
        input: {},
      });
      await firstShown;

      const secondResponse = secondClient.send({
        type: 'permission_request',
        requestId: 'queued-cancelled',
        tool_name: 'Read',
        input: {},
      });
      void secondResponse.catch(() => undefined);
      const thirdResponse = thirdClient.send({
        type: 'permission_request',
        requestId: 'queued-third',
        tool_name: 'Read',
        input: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      await secondSetup.cleanup();
      releaseFirst();

      await expect(firstResponse).resolves.toMatchObject({
        type: 'permission_response',
        requestId: 'queued-first',
        approved: true,
      });
      await expect(thirdResponse).resolves.toEqual({
        type: 'permission_response',
        requestId: 'queued-third',
        approved: true,
      });
      expect(promptMessages).toHaveLength(2);
      expect(promptMessages[0]).toContain('Claude agent agent-a');
      expect(promptMessages[1]).toContain('Claude agent agent-c');
      expect(promptMessages.join('\n')).not.toContain('agent-b');
      expect(secondClient.responses).toEqual([]);
    } finally {
      firstClient.socket.end();
      thirdClient.socket.destroy();
      await firstSetup.cleanup();
      await secondSetup.cleanup();
      await thirdSetup.cleanup();
      await coordinator.dispose();
      mockPromptSelect.mockImplementation(async () => {
        const next = selectResponses.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== 'string') throw new Error('No queued select response');
        return next;
      });
    }
  });

  test('cancels an active AskUserQuestion exchange without releasing its slot early', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    let secondQuestionShownResolve!: () => void;
    const secondQuestionShown = new Promise<void>((resolve) => {
      secondQuestionShownResolve = resolve;
    });
    let promptCount = 0;
    mockPromptSelect.mockImplementation(async (...args: unknown[]) => {
      const promptOptions = args[0] as { signal?: AbortSignal } | undefined;
      promptCount += 1;
      const callNumber = promptCount;
      if (callNumber === 1) return 'Option A';
      if (callNumber === 2) {
        secondQuestionShownResolve();
        await new Promise<void>((resolve) => {
          promptOptions?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        const error = new Error('Prompt was aborted');
        error.name = 'AbortPromptError';
        throw error;
      }
      return 'allow';
    });

    const firstSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-questions'),
    });
    const secondSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-next'),
    });
    const firstClient = await connectPermissionTestClient(
      path.join(firstSetup.tempDir, 'permissions.sock')
    );
    const secondClient = await connectPermissionTestClient(
      path.join(secondSetup.tempDir, 'permissions.sock')
    );

    try {
      const firstResponse = firstClient.send({
        type: 'permission_request',
        requestId: 'ask-cancelled',
        tool_name: 'AskUserQuestion',
        input: {
          questions: [
            {
              header: 'First',
              question: 'First question?',
              options: [{ label: 'Option A' }, { label: 'Option B' }],
            },
            {
              header: 'Second',
              question: 'Second question?',
              options: [{ label: 'Option A' }, { label: 'Option B' }],
            },
          ],
        },
      });
      void firstResponse.catch(() => undefined);
      await secondQuestionShown;

      const secondResponse = secondClient.send({
        type: 'permission_request',
        requestId: 'ask-next',
        tool_name: 'Read',
        input: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      firstClient.socket.end();

      await expect(secondResponse).resolves.toEqual({
        type: 'permission_response',
        requestId: 'ask-next',
        approved: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(firstClient.responses).toEqual([]);
      expect(promptCount).toBe(3);
    } finally {
      secondClient.socket.destroy();
      await firstSetup.cleanup();
      await secondSetup.cleanup();
      await coordinator.dispose();
      mockPromptSelect.mockImplementation(async () => {
        const next = selectResponses.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== 'string') throw new Error('No queued select response');
        return next;
      });
    }
  });

  test('holds the queue slot through Bash prefix selection and cancels it with the requester', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    let prefixShownResolve!: () => void;
    const prefixShown = new Promise<void>((resolve) => {
      prefixShownResolve = resolve;
    });
    let prefixSignal: AbortSignal | undefined;

    mockPromptSelect.mockImplementation(async () => 'session_allow');
    mockPromptPrefixSelect.mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { signal?: AbortSignal };
      prefixSignal = options.signal;
      prefixShownResolve();
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const error = new Error('Prompt was aborted');
      error.name = 'AbortPromptError';
      throw error;
    });

    const firstSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-prefix'),
    });
    const secondSetup = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: true,
      permissionPromptCoordinator: coordinator,
      agentToolContext: makeSubagentToolContext('agent-after-prefix'),
    });
    const firstClient = await connectPermissionTestClient(
      path.join(firstSetup.tempDir, 'permissions.sock')
    );
    const secondClient = await connectPermissionTestClient(
      path.join(secondSetup.tempDir, 'permissions.sock')
    );

    try {
      const firstResponse = firstClient.send({
        type: 'permission_request',
        requestId: 'prefix-cancelled',
        tool_name: 'Bash',
        input: { command: 'git status --short' },
      });
      void firstResponse.catch(() => undefined);
      await prefixShown;

      const secondResponse = secondClient.send({
        type: 'permission_request',
        requestId: 'prefix-next',
        tool_name: 'Read',
        input: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      firstClient.socket.end();

      await expect(secondResponse).resolves.toEqual({
        type: 'permission_response',
        requestId: 'prefix-next',
        approved: true,
      });
      expect(prefixSignal).toBeDefined();
      expect(firstClient.responses).toEqual([]);
    } finally {
      secondClient.socket.destroy();
      await firstSetup.cleanup();
      await secondSetup.cleanup();
      await coordinator.dispose();
      mockPromptSelect.mockImplementation(async () => {
        const next = selectResponses.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== 'string') throw new Error('No queued select response');
        return next;
      });
      mockPromptPrefixSelect.mockImplementation(async () => {
        const next = prefixPromptResponses.shift();
        if (next instanceof Error) throw next;
        if (!next) throw new Error('No queued prefix prompt response');
        return next;
      });
    }
  });
});

describe('permissions socket server line buffering', () => {
  let cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    selectResponses.length = 0;
    checkboxResponses.length = 0;
    inputResponses.length = 0;
    prefixPromptResponses.length = 0;
    mockPromptPrefixSelect.mockClear();
    mockPromptSelect.mockClear();
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(
    socketPath: string,
    writes: string[]
  ): Promise<{ type: string; requestId: string; approved: boolean }> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        // Send each write chunk separately
        for (const chunk of writes) {
          client.write(chunk);
        }
      });

      let buffer = '';
      client.on('data', (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          client.end();
          resolve(JSON.parse(msg));
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for response'));
      }, 5000);
    });
  }

  test('handles a complete message in one chunk', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-1',
      tool_name: 'Edit',
      input: {},
    });

    const response = await sendAndReceive(socketPath, [request + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'test-1',
      approved: true,
    });
  });

  test('passes logfile path to the generated MCP config', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const config = JSON.parse(await fs.readFile(result.mcpConfigFile, 'utf8'));
    const args = config.mcpServers.tim.args;

    expect(result.logFile).toBe(path.join(result.tempDir, 'tim-mcp.log'));
    expect(args.at(-2)).toBe(path.join(result.tempDir, 'permissions.sock'));
    expect(args.at(-1)).toBe(result.logFile);
  });

  test('handles a message split across two chunks', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-2',
      tool_name: 'Edit',
      input: {},
    });

    // Split the message in the middle
    const midpoint = Math.floor(request.length / 2);
    const chunk1 = request.slice(0, midpoint);
    const chunk2 = request.slice(midpoint) + '\n';

    const response = await sendAndReceive(socketPath, [chunk1, chunk2]);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'test-2',
      approved: true,
    });
  });

  test('handles two messages coalesced into one chunk', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit', 'Read'],
    });
    cleanups.push(result.cleanup);

    const request1 = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-3a',
      tool_name: 'Edit',
      input: {},
    });
    const request2 = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-3b',
      tool_name: 'Read',
      input: {},
    });

    // Send both messages in a single write
    const responses = await new Promise<any[]>((resolve, reject) => {
      const client = net.createConnection(path.join(result.tempDir, 'permissions.sock'), () => {
        client.write(request1 + '\n' + request2 + '\n');
      });

      let buffer = '';
      const received: any[] = [];
      client.on('data', (data) => {
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (msg) {
            received.push(JSON.parse(msg));
          }
          if (received.length === 2) {
            client.end();
            resolve(received);
          }
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for responses'));
      }, 5000);
    });

    expect(responses).toHaveLength(2);
    const sorted = responses.toSorted((a, b) => a.requestId.localeCompare(b.requestId));
    expect(sorted[0]).toEqual({
      type: 'permission_response',
      requestId: 'test-3a',
      approved: true,
    });
    expect(sorted[1]).toEqual({
      type: 'permission_response',
      requestId: 'test-3b',
      approved: true,
    });
  });

  test('ignores malformed JSON lines', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Edit'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    // Send a malformed line followed by a valid one
    const validRequest = JSON.stringify({
      type: 'permission_request',
      requestId: 'test-4',
      tool_name: 'Edit',
      input: {},
    });

    const response = await sendAndReceive(socketPath, ['this is not json\n' + validRequest + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'test-4',
      approved: true,
    });
  });
});

describe('Bash command cd-prefix stripping for auto-approval', () => {
  let cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(
    socketPath: string,
    writes: string[]
  ): Promise<{ type: string; requestId: string; approved: boolean }> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        for (const chunk of writes) {
          client.write(chunk);
        }
      });

      let buffer = '';
      client.on('data', (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          client.end();
          resolve(JSON.parse(msg));
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for response'));
      }, 5000);
    });
  }

  test('approves Bash command matching prefix directly', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Bash(tim tools update-plan-tasks:*)'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'cd-test-1',
      tool_name: 'Bash',
      input: { command: 'tim tools update-plan-tasks --plan 261' },
    });

    const response = await sendAndReceive(socketPath, [request + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'cd-test-1',
      approved: true,
    });
  });

  test('approves Bash command with cd prefix before allowed command', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Bash(tim tools update-plan-tasks:*)'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'cd-test-2',
      tool_name: 'Bash',
      input: { command: 'cd /some/workspace && tim tools update-plan-tasks --plan 261' },
    });

    const response = await sendAndReceive(socketPath, [request + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'cd-test-2',
      approved: true,
    });
  });

  test('approves Bash command with quoted cd path before allowed command', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: ['Bash(git commit:*)'],
    });
    cleanups.push(result.cleanup);

    const socketPath = path.join(result.tempDir, 'permissions.sock');
    const request = JSON.stringify({
      type: 'permission_request',
      requestId: 'cd-test-3',
      tool_name: 'Bash',
      input: { command: 'cd "/path with spaces" && git commit -m "test"' },
    });

    const response = await sendAndReceive(socketPath, [request + '\n']);
    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'cd-test-3',
      approved: true,
    });
  });
});

describe('permissions socket server AskUserQuestion handling', () => {
  let cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    selectResponses.length = 0;
    checkboxResponses.length = 0;
    inputResponses.length = 0;
    prefixPromptResponses.length = 0;
    mockPromptPrefixSelect.mockClear();
    mockPromptSelect.mockClear();
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify(request) + '\n');
      });

      let buffer = '';
      client.on('data', (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          client.end();
          resolve(JSON.parse(msg));
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for response'));
      }, 5000);
    });
  }

  test('handles single-select questions and returns updatedInput payload', async () => {
    selectResponses.push('Summary');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const questions = [
      {
        question: 'How should I format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief overview' },
          { label: 'Detailed', description: 'Full explanation' },
        ],
        multiSelect: false,
      },
    ];

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-1',
      tool_name: 'AskUserQuestion',
      input: { questions },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-1',
      approved: true,
      updatedInput: {
        questions,
        answers: {
          'How should I format the output?': 'Summary',
        },
      },
    });

    expect(mockPromptSelect.mock.calls[0]?.[0]?.choices).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '__free_text__' })])
    );
    expect(mockPromptSelect.mock.calls[0]?.[0]).toMatchObject({
      header: 'Format',
      question: 'How should I format the output?',
    });
  });

  test('ignores configured timeout for AskUserQuestion prompts', async () => {
    selectResponses.push('Summary');

    const result = await setupPermissionsMcp({
      allowedTools: [],
      timeout: 1,
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-timeout-ignore',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            options: [{ label: 'Summary', description: 'Brief overview' }],
            multiSelect: false,
          },
        ],
      },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-timeout-ignore',
      approved: true,
      updatedInput: {
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            options: [{ label: 'Summary', description: 'Brief overview' }],
            multiSelect: false,
          },
        ],
        answers: {
          'How should I format the output?': 'Summary',
        },
      },
    });
    expect(mockPromptSelect.mock.calls[0]?.[0]?.timeoutMs).toBeUndefined();
  });

  test('handles multi-select questions and joins selected labels', async () => {
    checkboxResponses.push(['Introduction', 'Conclusion']);

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const questions = [
      {
        question: 'Which sections should be included?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Add intro' },
          { label: 'Body', description: 'Add details' },
          { label: 'Conclusion', description: 'Add wrap-up' },
        ],
        multiSelect: true,
      },
    ];

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-2',
      tool_name: 'AskUserQuestion',
      input: { questions },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-2',
      approved: true,
      updatedInput: {
        questions,
        answers: {
          'Which sections should be included?': 'Introduction, Conclusion',
        },
      },
    });

    expect(mockPromptCheckbox.mock.calls[0]?.[0]?.choices).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: '__free_text__' })])
    );
    expect(mockPromptCheckbox.mock.calls[0]?.[0]).toMatchObject({
      header: 'Sections',
      question: 'Which sections should be included?',
    });
  });

  test('handles free-text single-select answers', async () => {
    selectResponses.push('__free_text__');
    inputResponses.push('custom answer');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-3',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'What else should I include?',
            header: 'Extras',
            options: [
              { label: 'None', description: 'No additions' },
              { label: 'Appendix', description: 'Add appendix' },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    expect(response.updatedInput.answers).toEqual({
      'What else should I include?': 'custom answer',
    });
  });

  test('handles free-text multi-select answers', async () => {
    checkboxResponses.push(['Option1', '__free_text__']);
    inputResponses.push('also this');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-4',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Pick all relevant items',
            header: 'Items',
            options: [
              { label: 'Option1', description: 'First option' },
              { label: 'Option2', description: 'Second option' },
            ],
            multiSelect: true,
          },
        ],
      },
    });

    expect(response.updatedInput.answers).toEqual({
      'Pick all relevant items': 'Option1, also this',
    });
  });

  test('handles multiple questions sequentially', async () => {
    selectResponses.push('Detailed');
    checkboxResponses.push(['Introduction', 'Conclusion']);

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const questions = [
      {
        question: 'How should I format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief' },
          { label: 'Detailed', description: 'Long form' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which sections should be included?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Intro' },
          { label: 'Body', description: 'Main body' },
          { label: 'Conclusion', description: 'Close' },
        ],
        multiSelect: true,
      },
    ];

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-5',
      tool_name: 'AskUserQuestion',
      input: { questions },
    });

    expect(response.updatedInput).toEqual({
      questions,
      answers: {
        'How should I format the output?': 'Detailed',
        'Which sections should be included?': 'Introduction, Conclusion',
      },
    });
  });

  test('denies AskUserQuestion when prompt times out', async () => {
    const timeoutError = new Error('The prompt timed out');
    timeoutError.name = 'AbortPromptError';
    selectResponses.push(timeoutError);

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-6',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            options: [
              { label: 'Summary', description: 'Brief' },
              { label: 'Detailed', description: 'Long form' },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-6',
      approved: false,
    });
  });

  test('denies AskUserQuestion when questions array is empty', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);

    const response = await sendAndReceive(path.join(result.tempDir, 'permissions.sock'), {
      type: 'permission_request',
      requestId: 'ask-7',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [],
      },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'ask-7',
      approved: false,
    });
  });
});

describe('permissions socket server allowlist persistence behavior', () => {
  let cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    selectResponses.length = 0;
    checkboxResponses.length = 0;
    inputResponses.length = 0;
    prefixPromptResponses.length = 0;
    mockPromptPrefixSelect.mockClear();
    mockPromptSelect.mockClear();
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups = [];
  });

  function sendAndReceive(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify(request) + '\n');
      });

      let buffer = '';
      client.on('data', (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          const msg = buffer.slice(0, newlineIdx);
          client.end();
          resolve(JSON.parse(msg));
        }
      });

      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('Timed out waiting for response'));
      }, 5000);
    });
  }

  test('always allow persists non-Bash tool and auto-approves subsequent request', async () => {
    selectResponses.push('always_allow');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const firstResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'persist-1',
      tool_name: 'Read',
      input: {},
    });
    expect(firstResponse).toEqual({
      type: 'permission_response',
      requestId: 'persist-1',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);

    const secondResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'persist-2',
      tool_name: 'Read',
      input: {},
    });
    expect(secondResponse).toEqual({
      type: 'permission_response',
      requestId: 'persist-2',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('auto-approves piped update-plan-tasks commands by suffix without prompting', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const response = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-suffix-piped',
      tool_name: 'Bash',
      input: {
        command: 'echo \'{"plan":"42","tasks":[]}\' | tim tools update-plan-tasks',
      },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'bash-suffix-piped',
      approved: true,
    });
    expect(mockPromptSelect).not.toHaveBeenCalled();
    expect(mockPromptPrefixSelect).not.toHaveBeenCalled();
  });

  test('auto-approves direct update-plan-tasks commands by suffix without prompting', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const response = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-suffix-direct',
      tool_name: 'Bash',
      input: { command: 'tim tools update-plan-tasks' },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'bash-suffix-direct',
      approved: true,
    });
    expect(mockPromptSelect).not.toHaveBeenCalled();
    expect(mockPromptPrefixSelect).not.toHaveBeenCalled();
  });

  test('auto-approves update-plan-tasks commands with trailing whitespace', async () => {
    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const response = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-suffix-whitespace',
      tool_name: 'Bash',
      input: { command: 'tim tools update-plan-tasks   ' },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'bash-suffix-whitespace',
      approved: true,
    });
    expect(mockPromptSelect).not.toHaveBeenCalled();
    expect(mockPromptPrefixSelect).not.toHaveBeenCalled();
  });

  test('still prompts for unrelated Bash commands', async () => {
    selectResponses.push('disallow');

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const response = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-suffix-negative',
      tool_name: 'Bash',
      input: { command: 'tim tools list-ready-plans' },
    });

    expect(response).toEqual({
      type: 'permission_response',
      requestId: 'bash-suffix-negative',
      approved: false,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('always allow for Bash uses prefixPrompt and persists selected prefix', async () => {
    selectResponses.push('always_allow');
    prefixPromptResponses.push({ exact: false, command: 'git status' });

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const firstResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-persist-1',
      tool_name: 'Bash',
      input: { command: 'git status --short' },
    });
    expect(firstResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-persist-1',
      approved: true,
    });
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);

    const secondResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-persist-2',
      tool_name: 'Bash',
      input: { command: 'git status --porcelain' },
    });
    expect(secondResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-persist-2',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });

  test('session allow for Bash uses prefixPrompt without persistence', async () => {
    selectResponses.push('session_allow');
    prefixPromptResponses.push({ exact: false, command: 'jj status' });

    const result = await setupPermissionsMcp({
      allowedTools: [],
    });
    cleanups.push(result.cleanup);
    const socketPath = path.join(result.tempDir, 'permissions.sock');

    const firstResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-session-1',
      tool_name: 'Bash',
      input: { command: 'jj status -v' },
    });
    expect(firstResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-session-1',
      approved: true,
    });
    expect(mockPromptPrefixSelect).toHaveBeenCalledTimes(1);

    const secondResponse = await sendAndReceive(socketPath, {
      type: 'permission_request',
      requestId: 'bash-session-2',
      tool_name: 'Bash',
      input: { command: 'jj status --summary' },
    });
    expect(secondResponse).toEqual({
      type: 'permission_response',
      requestId: 'bash-session-2',
      approved: true,
    });
    expect(mockPromptSelect).toHaveBeenCalledTimes(1);
  });
});
