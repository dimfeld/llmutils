import { afterEach, describe, expect, test, vi } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import { setupPermissionsMcp, validateClaudeAgentToolContext } from './permissions_mcp_setup.js';
import {
  CLAUDE_AGENT_TOOL_NAMES,
  CLAUDE_ORCHESTRATOR_TOOL_NAMES,
  CLAUDE_SUBAGENT_TOOL_NAMES,
  createClaudeAgentToolDispatcher,
  type ClaudeAgentToolName,
  type ClaudeAgentToolContext,
} from './claude_mcp_protocol.js';
import type { AgentManager } from '../../agent_messaging/agent_manager.js';
import type { AgentId, AgentName } from '../../agent_messaging/agent_names.js';

type TestSocket = {
  readonly socket: net.Socket;
  readonly responses: Promise<Record<string, unknown>[]>;
};

function identity(role: 'orchestrator' | 'subagent'): ClaudeAgentToolContext['caller'] {
  return role === 'orchestrator'
    ? {
        id: 'orchestrator-id' as AgentId,
        name: 'orchestrator' as AgentName,
        role: 'orchestrator' as const,
        executor: 'claude-code' as const,
      }
    : {
        id: 'subagent-id' as AgentId,
        name: 'worker-a' as AgentName,
        role: 'subagent' as const,
        type: 'tester' as const,
        executor: 'claude-code' as const,
      };
}

async function connectAndSend(socketPath: string, requests: unknown[]): Promise<TestSocket> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const responses = new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const values: Record<string, unknown>[] = [];
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP responses')), 5000);
    socket.on('data', (data) => {
      buffer += data.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) values.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf('\n');
      }
      if (values.length === requests.length) {
        clearTimeout(timer);
        resolve(values);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  for (const request of requests) socket.write(`${JSON.stringify(request)}\n`);
  return { socket, responses };
}

async function connectRawAndCollect(
  socketPath: string,
  writes: string[],
  responseCount: number
): Promise<TestSocket> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const responses = new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const values: Record<string, unknown>[] = [];
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP responses')), 5000);
    socket.on('data', (data) => {
      buffer += data.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) values.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf('\n');
      }
      if (values.length === responseCount) {
        clearTimeout(timer);
        resolve(values);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  for (const write of writes) socket.write(write);
  return { socket, responses };
}

describe('Claude MCP parent agent-tool router', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  test('dispatches a valid orchestrator request with trusted caller data', async () => {
    const dispatcher = {
      startAgent: vi.fn(async () => ({
        name: 'worker-a',
        id: 'worker-id',
        type: 'tester',
        executor: 'claude-code',
        state: 'starting',
      })),
      listAgents: vi.fn(async () => ({ agents: [] })),
      sendAgentMessage: vi.fn(async () => ({
        name: 'worker-a',
        messageId: 'message-id',
        delivery: 'queued',
      })),
      stopAgent: vi.fn(async () => ({ name: 'worker-a', mode: 'forced', state: 'stopping' })),
      finishAgent: vi.fn(async () => ({ state: 'finishing' })),
    };
    const context: ClaudeAgentToolContext = {
      caller: identity('orchestrator'),
      allowedTools: new Set(CLAUDE_ORCHESTRATOR_TOOL_NAMES),
      dispatcher,
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      agentToolContext: context,
    });
    cleanups.push(result.cleanup);

    const client = await connectAndSend(pathFor(result), [
      {
        type: 'agent_tool_request',
        requestId: 'start-1',
        tool_name: 'StartAgent',
        input: { type: 'tester', executor: 'claude-code', initialMessage: 'test this' },
      },
    ]);
    const responses = await client.responses;

    expect(responses).toEqual([
      {
        type: 'agent_tool_response',
        requestId: 'start-1',
        success: true,
        result: {
          name: 'worker-a',
          id: 'worker-id',
          type: 'tester',
          executor: 'claude-code',
          state: 'starting',
        },
      },
    ]);
    expect(dispatcher.startAgent).toHaveBeenCalledWith(
      { id: 'orchestrator-id', role: 'orchestrator' },
      { type: 'tester', executor: 'claude-code', initialMessage: 'test this' }
    );
    expect(dispatcher.startAgent.mock.calls[0]?.[1]).not.toHaveProperty('source');
    client.socket.destroy();
  });

  test('routes a real Unix-socket request through the AgentManager adapter', async () => {
    const manager = {
      startAgent: vi.fn().mockResolvedValue({
        name: 'worker-a',
        id: 'worker-id',
        type: 'tester',
        executor: 'claude-code',
        state: 'starting',
      }),
      listAgents: vi.fn().mockResolvedValue({ agents: [] }),
      sendAgentMessage: vi.fn().mockResolvedValue({
        name: 'worker-a',
        messageId: 'message-id',
        delivery: 'steered',
      }),
      stopAgent: vi.fn().mockResolvedValue({
        name: 'worker-a',
        mode: 'graceful-requested',
        state: 'stopping',
      }),
      finishAgent: vi.fn().mockResolvedValue({ state: 'finishing' }),
    } as unknown as Pick<
      AgentManager,
      'startAgent' | 'listAgents' | 'sendAgentMessage' | 'stopAgent' | 'finishAgent'
    >;
    const context: ClaudeAgentToolContext = {
      caller: identity('orchestrator'),
      allowedTools: new Set(CLAUDE_ORCHESTRATOR_TOOL_NAMES),
      dispatcher: createClaudeAgentToolDispatcher(manager),
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      agentToolContext: context,
    });
    cleanups.push(result.cleanup);

    const client = await connectAndSend(pathFor(result), [
      {
        type: 'agent_tool_request',
        requestId: 'adapter-list',
        tool_name: 'ListAgents',
        input: {},
      },
      {
        type: 'agent_tool_request',
        requestId: 'adapter-send',
        tool_name: 'SendAgentMessage',
        input: { name: 'worker-a', message: 'hello' },
      },
    ]);
    const responses = await client.responses;
    const responseById = new Map(responses.map((response) => [response.requestId, response]));

    expect(responseById.get('adapter-list')).toMatchObject({
      type: 'agent_tool_response',
      requestId: 'adapter-list',
      success: true,
      result: { agents: [] },
    });
    expect(responseById.get('adapter-send')).toMatchObject({
      type: 'agent_tool_response',
      requestId: 'adapter-send',
      success: true,
      result: { name: 'worker-a', delivery: 'steered' },
    });
    expect(manager.listAgents).toHaveBeenCalledOnce();
    expect(manager.sendAgentMessage).toHaveBeenCalledWith(
      { id: 'orchestrator-id', role: 'orchestrator' },
      { name: 'worker-a', message: 'hello' }
    );
    client.socket.destroy();
  });

  test('rejects fabricated orchestrator tools on a subagent-bound socket', async () => {
    const dispatcher = {
      startAgent: vi.fn(),
      listAgents: vi.fn(async () => ({ agents: [] })),
      sendAgentMessage: vi.fn(async () => ({
        name: 'orchestrator',
        messageId: 'message-id',
        delivery: 'steered',
      })),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(async () => ({ state: 'finishing' })),
    };
    const context: ClaudeAgentToolContext = {
      caller: identity('subagent'),
      allowedTools: new Set(CLAUDE_SUBAGENT_TOOL_NAMES),
      dispatcher,
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      agentToolContext: context,
    });
    cleanups.push(result.cleanup);

    const client = await connectAndSend(pathFor(result), [
      {
        type: 'agent_tool_request',
        requestId: 'forged-stop',
        tool_name: 'StopAgent',
        input: { name: 'worker-a', force: true },
      },
      {
        type: 'agent_tool_request',
        requestId: 'forged-start',
        tool_name: 'StartAgent',
        input: { type: 'tester', executor: 'claude-code', initialMessage: 'nope' },
      },
    ]);
    const responses = await client.responses;

    expect(responses).toEqual([
      {
        type: 'agent_tool_response',
        requestId: 'forged-stop',
        success: false,
        error: 'Agent tool StopAgent is not allowed for this caller',
      },
      {
        type: 'agent_tool_response',
        requestId: 'forged-start',
        success: false,
        error: 'Agent tool StartAgent is not allowed for this caller',
      },
    ]);
    expect(dispatcher.stopAgent).not.toHaveBeenCalled();
    expect(dispatcher.startAgent).not.toHaveBeenCalled();
    client.socket.destroy();
  });

  test.each([
    {
      role: 'orchestrator' as const,
      allowedTools: CLAUDE_ORCHESTRATOR_TOOL_NAMES,
      forbiddenTools: ['FinishAgent'] as const,
    },
    {
      role: 'subagent' as const,
      allowedTools: CLAUDE_SUBAGENT_TOOL_NAMES,
      forbiddenTools: ['StartAgent', 'StopAgent'] as const,
    },
  ])(
    '$role receives exactly its role-authorized tool set',
    async ({ role, allowedTools, forbiddenTools }) => {
      const dispatcher = {
        startAgent: vi.fn(async () => ({
          name: 'worker-a',
          id: 'worker-id',
          type: 'tester',
          executor: 'claude-code',
          state: 'starting',
        })),
        listAgents: vi.fn(async () => ({ agents: [] })),
        sendAgentMessage: vi.fn(async () => ({
          name: 'worker-a',
          messageId: 'message-id',
          delivery: 'queued',
        })),
        stopAgent: vi.fn(async () => ({ name: 'worker-a', mode: 'forced', state: 'stopping' })),
        finishAgent: vi.fn(async () => ({ state: 'finishing' })),
      };
      const context: ClaudeAgentToolContext = {
        caller: identity(role),
        allowedTools: new Set(allowedTools),
        dispatcher,
      };
      const result = await setupPermissionsMcp({
        allowedTools: [],
        interactiveApprovalEnabled: false,
        agentToolContext: context,
      });
      cleanups.push(result.cleanup);

      const inputs: Record<ClaudeAgentToolName, unknown> = {
        StartAgent: { type: 'tester', executor: 'claude-code', initialMessage: 'start' },
        ListAgents: {},
        SendAgentMessage: { name: 'orchestrator', message: 'hello' },
        StopAgent: { name: 'worker-a' },
        FinishAgent: { message: 'done' },
      };
      const client = await connectAndSend(
        pathFor(result),
        CLAUDE_AGENT_TOOL_NAMES.map((toolName) => ({
          type: 'agent_tool_request',
          requestId: `role-${toolName}`,
          tool_name: toolName,
          input: inputs[toolName],
        }))
      );
      const responses = await client.responses;
      const responseById = new Map(responses.map((response) => [response.requestId, response]));

      expect(responses).toHaveLength(CLAUDE_AGENT_TOOL_NAMES.length);
      for (const toolName of allowedTools) {
        expect(responseById.get(`role-${toolName}`)).toMatchObject({
          type: 'agent_tool_response',
          requestId: `role-${toolName}`,
          success: true,
        });
      }
      for (const toolName of forbiddenTools) {
        expect(responseById.get(`role-${toolName}`)).toEqual({
          type: 'agent_tool_response',
          requestId: `role-${toolName}`,
          success: false,
          error: `Agent tool ${toolName} is not allowed for this caller`,
        });
      }
      for (const toolName of forbiddenTools) {
        const method = {
          StartAgent: dispatcher.startAgent,
          StopAgent: dispatcher.stopAgent,
          FinishAgent: dispatcher.finishAgent,
        }[toolName];
        expect(method).not.toHaveBeenCalled();
      }
      client.socket.destroy();
    }
  );

  test.each([
    {
      role: 'orchestrator' as const,
      forbiddenTool: 'FinishAgent' as const,
    },
    {
      role: 'subagent' as const,
      forbiddenTool: 'StartAgent' as const,
    },
  ])('$role context rejects a role-forbidden allowed tool', ({ role, forbiddenTool }) => {
    const context: ClaudeAgentToolContext = {
      caller: identity(role),
      allowedTools: new Set([forbiddenTool]),
      dispatcher: {
        startAgent: vi.fn(),
        listAgents: vi.fn(),
        sendAgentMessage: vi.fn(),
        stopAgent: vi.fn(),
        finishAgent: vi.fn(),
      },
    };

    expect(() => validateClaudeAgentToolContext(context)).toThrow(
      `Claude agent tool ${forbiddenTool} is not allowed for ${role} callers`
    );
  });

  test('returns manager errors without changing the permission path', async () => {
    const dispatcher = {
      startAgent: vi.fn(),
      listAgents: vi.fn(async () => ({ agents: [] })),
      sendAgentMessage: vi.fn(async () => {
        throw new Error('AgentManager rejected SendAgentMessage');
      }),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
    };
    const context: ClaudeAgentToolContext = {
      caller: identity('orchestrator'),
      allowedTools: new Set(CLAUDE_ORCHESTRATOR_TOOL_NAMES),
      dispatcher,
    };
    const coordinator = {
      enqueue: vi.fn(),
      cancelRequester: vi.fn(),
      dispose: vi.fn(),
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      agentToolContext: context,
      permissionPromptCoordinator: coordinator,
    });
    cleanups.push(result.cleanup);

    const client = await connectAndSend(pathFor(result), [
      {
        type: 'agent_tool_request',
        requestId: 'manager-error',
        tool_name: 'SendAgentMessage',
        input: { name: 'worker-a', message: 'hello' },
      },
      {
        type: 'permission_request',
        requestId: 'permission-denied',
        tool_name: 'Read',
        input: {},
      },
    ]);
    const responses = await client.responses;
    const responseById = new Map(responses.map((response) => [response.requestId, response]));

    expect(responseById.get('manager-error')).toEqual({
      type: 'agent_tool_response',
      requestId: 'manager-error',
      success: false,
      error: 'AgentManager rejected SendAgentMessage',
    });
    expect(responseById.get('permission-denied')).toEqual({
      type: 'permission_response',
      requestId: 'permission-denied',
      approved: false,
    });
    expect(dispatcher.sendAgentMessage).toHaveBeenCalledWith(
      { id: 'orchestrator-id', role: 'orchestrator' },
      { name: 'worker-a', message: 'hello' }
    );
    expect(coordinator.enqueue).not.toHaveBeenCalled();
    client.socket.destroy();
  });

  test('interleaves an auto-approved permission request with an agent-tool request', async () => {
    const dispatcher = {
      startAgent: vi.fn(),
      listAgents: vi.fn(async () => ({ agents: [] })),
      sendAgentMessage: vi.fn(),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
    };
    const context: ClaudeAgentToolContext = {
      caller: identity('orchestrator'),
      allowedTools: new Set(CLAUDE_ORCHESTRATOR_TOOL_NAMES),
      dispatcher,
    };
    const result = await setupPermissionsMcp({
      allowedTools: ['Read'],
      interactiveApprovalEnabled: true,
      agentToolContext: context,
    });
    cleanups.push(result.cleanup);

    const client = await connectAndSend(pathFor(result), [
      {
        type: 'agent_tool_request',
        requestId: 'interleave-agent',
        tool_name: 'ListAgents',
        input: {},
      },
      {
        type: 'permission_request',
        requestId: 'interleave-permission',
        tool_name: 'Read',
        input: {},
      },
    ]);
    const responses = await client.responses;
    const responseById = new Map(responses.map((response) => [response.requestId, response]));

    expect(responseById.get('interleave-agent')).toEqual({
      type: 'agent_tool_response',
      requestId: 'interleave-agent',
      success: true,
      result: { agents: [] },
    });
    expect(responseById.get('interleave-permission')).toEqual({
      type: 'permission_response',
      requestId: 'interleave-permission',
      approved: true,
    });
    expect(dispatcher.listAgents).toHaveBeenCalledOnce();
    client.socket.destroy();
  });

  test('ignores malformed and oversized frames without dispatching them', async () => {
    const dispatcher = {
      startAgent: vi.fn(),
      listAgents: vi.fn(async () => ({ agents: [] })),
      sendAgentMessage: vi.fn(async () => ({
        name: 'worker-a',
        messageId: 'message-id',
        delivery: 'queued',
      })),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
    };
    const context: ClaudeAgentToolContext = {
      caller: identity('orchestrator'),
      allowedTools: new Set(CLAUDE_ORCHESTRATOR_TOOL_NAMES),
      dispatcher,
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      agentToolContext: context,
    });
    cleanups.push(result.cleanup);

    const client = await connectRawAndCollect(
      pathFor(result),
      [
        '{not-json}\n',
        `${'x'.repeat(1024 * 1024 + 1)}\n`,
        `${JSON.stringify({
          type: 'agent_tool_request',
          requestId: 'valid-after-invalid',
          tool_name: 'ListAgents',
          input: {},
        })}\n`,
      ],
      1
    );
    const responses = await client.responses;

    expect(responses).toEqual([
      {
        type: 'agent_tool_response',
        requestId: 'valid-after-invalid',
        success: true,
        result: { agents: [] },
      },
    ]);
    expect(dispatcher.listAgents).toHaveBeenCalledTimes(1);
    client.socket.destroy();
  });

  test('returns a correlated error for an oversized request and keeps the socket usable', async () => {
    const dispatcher = {
      startAgent: vi.fn(),
      listAgents: vi.fn(async () => ({ agents: [] })),
      sendAgentMessage: vi.fn(),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
    };
    const context: ClaudeAgentToolContext = {
      caller: identity('orchestrator'),
      allowedTools: new Set(CLAUDE_ORCHESTRATOR_TOOL_NAMES),
      dispatcher,
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      agentToolContext: context,
    });
    cleanups.push(result.cleanup);

    const oversized = JSON.stringify({
      requestId: 'oversized-agent',
      type: 'agent_tool_request',
      tool_name: 'SendAgentMessage',
      input: { name: 'orchestrator', message: 'x'.repeat(1024 * 1024) },
    });
    const client = await connectRawAndCollect(
      pathFor(result),
      [
        `${oversized}\n`,
        `${JSON.stringify({
          requestId: 'after-oversized',
          type: 'agent_tool_request',
          tool_name: 'ListAgents',
          input: {},
        })}\n`,
      ],
      2
    );
    const responses = await client.responses;

    expect(responses).toContainEqual({
      type: 'agent_tool_response',
      requestId: 'oversized-agent',
      success: false,
      error: 'Claude MCP request exceeded the maximum JSON line size',
    });
    expect(responses).toContainEqual({
      type: 'agent_tool_response',
      requestId: 'after-oversized',
      success: true,
      result: { agents: [] },
    });
    expect(dispatcher.listAgents).toHaveBeenCalledOnce();
    client.socket.destroy();
  });

  test('makes cleanup idempotent and cancels an open requester once', async () => {
    const cancelled: string[] = [];
    const coordinator = {
      enqueue: vi.fn(),
      cancelRequester: vi.fn((token: string) => cancelled.push(token)),
      dispose: vi.fn(),
    };
    const result = await setupPermissionsMcp({
      allowedTools: [],
      interactiveApprovalEnabled: false,
      permissionPromptCoordinator: coordinator,
    });

    const socket = net.createConnection(pathFor(result));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    await Promise.all([result.cleanup(), result.cleanup()]);

    expect(cancelled).toHaveLength(1);
    await expect(fs.access(result.tempDir)).rejects.toThrow();
    socket.destroy();
  });

  test('cancels each requester token when its client socket exits', async () => {
    const cancelled: string[] = [];
    const coordinator = {
      enqueue: vi.fn(async <T>(request: { run: (signal: AbortSignal) => Promise<T> }) =>
        request.run(new AbortController().signal)
      ),
      cancelRequester: vi.fn((token: string) => cancelled.push(token)),
      dispose: vi.fn(),
    };
    const result = await setupPermissionsMcp({
      allowedTools: ['Read'],
      permissionPromptCoordinator: coordinator,
    });
    cleanups.push(result.cleanup);

    const first = net.createConnection(pathFor(result));
    const second = net.createConnection(pathFor(result));
    await Promise.all(
      [first, second].map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
          })
      )
    );
    first.end();
    second.end();
    await waitFor(() => cancelled.length === 2);

    expect(cancelled).toHaveLength(2);
    expect(new Set(cancelled).size).toBe(2);
  });
});

function pathFor(result: { readonly tempDir: string }): string {
  return `${result.tempDir}/permissions.sock`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error('Timed out waiting for test condition');
}
