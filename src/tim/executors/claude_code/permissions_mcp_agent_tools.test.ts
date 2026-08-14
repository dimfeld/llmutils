import { afterEach, describe, expect, test, vi } from 'vitest';
import * as net from 'node:net';
import { setupPermissionsMcp } from './permissions_mcp_setup.js';
import {
  CLAUDE_ORCHESTRATOR_TOOL_NAMES,
  CLAUDE_SUBAGENT_TOOL_NAMES,
  type ClaudeAgentToolContext,
} from './claude_mcp_protocol.js';
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
