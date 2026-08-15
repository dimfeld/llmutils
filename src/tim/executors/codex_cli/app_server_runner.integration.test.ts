import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AgentIdentity } from '../../agent_messaging/agent_manager_types.js';
import {
  CODEX_ORCHESTRATOR_TOOL_NAMES,
  CODEX_SUBAGENT_TOOL_NAMES,
  createCodexAgentToolProvider,
  type CodexAgentToolDispatcher,
} from './codex_agent_tools.js';
import {
  CODEX_DYNAMIC_TOOLS_COMPATIBILITY_ERROR_MESSAGE,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';
import { TIM_CODEX_APP_SERVER_SOCKET } from './app_server_connection.js';
import { executeCodexStepViaAppServer } from './app_server_runner.js';

type ScriptedServerMode = 'normal' | 'reject-initialize' | 'reject-thread-start';

interface ScriptedAppServer {
  readonly rootDir: string;
  readonly socketPath: string;
  readonly requests: Record<string, unknown>[];
  readonly responses: Record<string, unknown>[];
  readonly toolResponse: Promise<Record<string, unknown>>;
  readonly server: Bun.Server;
}

function createIdentity(role: AgentIdentity['role']): AgentIdentity {
  if (role === 'orchestrator') {
    return {
      id: 'root-id' as never,
      name: 'orchestrator' as never,
      role,
      executor: 'codex-cli',
    };
  }

  return {
    id: 'worker-id' as never,
    name: 'worker-a' as never,
    role,
    type: 'tester',
    executor: 'codex-cli',
  };
}

function createProvider(role: AgentIdentity['role']): CodexDynamicToolProvider {
  const dispatcher: CodexAgentToolDispatcher = {
    startAgent: async () => {
      throw new Error('StartAgent is not part of this integration call.');
    },
    listAgents: () => ({ agents: [] }),
    sendAgentMessage: async () => {
      throw new Error('SendAgentMessage is not part of this integration call.');
    },
    stopAgent: async () => {
      throw new Error('StopAgent is not part of this integration call.');
    },
    finishAgent: async () => {
      throw new Error('FinishAgent is not part of this integration call.');
    },
  };

  return createCodexAgentToolProvider({
    caller: createIdentity(role),
    dispatcher,
  });
}

async function createScriptedAppServer(mode: ScriptedServerMode): Promise<ScriptedAppServer> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runner-integration-'));
  const socketPath = path.join(rootDir, 'codex.sock');
  const requests: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  let resolveToolResponse: (response: Record<string, unknown>) => void = () => {};
  const toolResponse = new Promise<Record<string, unknown>>((resolve) => {
    resolveToolResponse = resolve;
  });

  const server = Bun.serve({
    unix: socketPath,
    fetch(request, serverHandle) {
      if (serverHandle.upgrade(request)) return;
      return new Response('Expected websocket upgrade', { status: 426 });
    },
    websocket: {
      message(websocket, rawMessage) {
        const message = JSON.parse(String(rawMessage)) as Record<string, unknown>;
        if (typeof message.method === 'string') {
          requests.push(message);
        } else if (message.id !== undefined) {
          responses.push(message);
          if (message.id === 42) {
            resolveToolResponse(message);
            if (message.result && typeof message.result === 'object') {
              websocket.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'item/completed',
                  params: {
                    threadId: 'thread-1',
                    item: { type: 'agentMessage', text: 'done' },
                  },
                })
              );
              websocket.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'turn/completed',
                  params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
                })
              );
            }
          }
          return;
        }

        const requestId = message.id;
        if (typeof message.method !== 'string' || requestId === undefined) {
          return;
        }

        if (message.method === 'initialize') {
          if (mode === 'reject-initialize') {
            websocket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                error: { code: -32602, message: 'experimentalApi is not supported' },
              })
            );
          } else {
            websocket.send(
              JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { capabilities: {} } })
            );
          }
          return;
        }

        if (message.method === 'thread/start') {
          if (mode === 'reject-thread-start') {
            websocket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                error: { code: -32602, message: 'dynamicTools is not supported' },
              })
            );
          } else {
            websocket.send(
              JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { threadId: 'thread-1' } })
            );
          }
          return;
        }

        if (message.method === 'turn/start') {
          websocket.send(
            JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { turnId: 'turn-1' } })
          );
          setTimeout(() => {
            websocket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 42,
                method: 'item/tool/call',
                params: {
                  threadId: 'thread-1',
                  turnId: 'turn-1',
                  callId: 'call-1',
                  tool: 'ListAgents',
                  arguments: {},
                },
              })
            );
          }, 0);
          return;
        }

        if (message.method === 'turn/interrupt') {
          websocket.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: {} }));
        }
      },
    },
  });

  return { rootDir, socketPath, requests, responses, toolResponse, server };
}

async function closeScriptedAppServer(fixture: ScriptedAppServer): Promise<void> {
  fixture.server.stop(true);
  await fs.rm(fixture.rootDir, { recursive: true, force: true });
}

describe('Codex app-server runner dynamic-tool integration', () => {
  const originalSocket = process.env[TIM_CODEX_APP_SERVER_SOCKET];
  const originalAppServerMode = process.env.CODEX_USE_APP_SERVER;

  afterEach(() => {
    if (originalSocket === undefined) {
      delete process.env[TIM_CODEX_APP_SERVER_SOCKET];
    } else {
      process.env[TIM_CODEX_APP_SERVER_SOCKET] = originalSocket;
    }
    if (originalAppServerMode === undefined) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalAppServerMode;
    }
  });

  test.each([
    ['orchestrator', CODEX_ORCHESTRATOR_TOOL_NAMES],
    ['subagent', CODEX_SUBAGENT_TOOL_NAMES],
  ] as const)('negotiates and dispatches the exact %s role tool set', async (role, toolNames) => {
    const fixture = await createScriptedAppServer('normal');
    process.env[TIM_CODEX_APP_SERVER_SOCKET] = fixture.socketPath;
    delete process.env.CODEX_USE_APP_SERVER;

    try {
      const provider = createProvider(role);
      const output = await executeCodexStepViaAppServer(
        'prompt',
        fixture.rootDir,
        {},
        {
          dynamicToolProvider: provider,
        }
      );

      expect(output).toBe('done');
      const initializeRequest = fixture.requests.find((request) => request.method === 'initialize');
      const threadStartRequest = fixture.requests.find(
        (request) => request.method === 'thread/start'
      );
      expect(initializeRequest).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ capabilities: { experimentalApi: true } }),
        })
      );
      expect(threadStartRequest?.params).toEqual(
        expect.objectContaining({ dynamicTools: provider.definitions })
      );
      expect(provider.definitions.map((definition) => definition.name)).toEqual(toolNames);
      expect(fixture.responses).toContainEqual(
        expect.objectContaining({
          id: 42,
          result: {
            contentItems: [{ type: 'inputText', text: '{"agents":[]}' }],
            success: true,
          },
        })
      );
      expect(
        fixture.requests.filter((request) => request.method?.includes('requestApproval'))
      ).toEqual([]);
    } finally {
      await closeScriptedAppServer(fixture);
    }
  });

  test.each([
    ['reject-initialize', 'initialize'],
    ['reject-thread-start', 'thread/start'],
  ] as const)(
    'wraps inherited %s rejection before starting a turn',
    async (mode, rejectedMethod) => {
      const fixture = await createScriptedAppServer(mode);
      process.env[TIM_CODEX_APP_SERVER_SOCKET] = fixture.socketPath;
      delete process.env.CODEX_USE_APP_SERVER;
      const provider = createProvider('orchestrator');
      const spawnSpy = vi.spyOn(Bun, 'spawn');

      try {
        const error = await executeCodexStepViaAppServer(
          'prompt',
          fixture.rootDir,
          {},
          {
            dynamicToolProvider: provider,
          }
        ).catch((caught: unknown) => caught);

        expect(error).toMatchObject({
          name: 'CodexDynamicToolsCompatibilityError',
          message: CODEX_DYNAMIC_TOOLS_COMPATIBILITY_ERROR_MESSAGE,
          cause: expect.objectContaining({
            message: expect.stringContaining(
              rejectedMethod === 'initialize' ? 'experimentalApi' : 'dynamicTools'
            ),
          }),
        });
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(fixture.requests.map((request) => request.method)).toEqual(
          rejectedMethod === 'initialize'
            ? ['initialize']
            : ['initialize', 'initialized', 'thread/start']
        );
        expect(fixture.requests.some((request) => request.method === 'turn/start')).toBe(false);
      } finally {
        spawnSpy.mockRestore();
        await closeScriptedAppServer(fixture);
      }
    }
  );
});
