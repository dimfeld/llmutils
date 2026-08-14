import { afterEach, describe, expect, test, vi } from 'vitest';
import * as net from 'node:net';
import { cleanupForTests, createClaudeMcpServer, setParentSocket } from './tim_mcp.js';
import {
  agentToolRequestSchema,
  agentToolResponseSchema,
  CLAUDE_ORCHESTRATOR_TOOL_NAMES,
  CLAUDE_SUBAGENT_TOOL_NAMES,
  claudeMcpRequestSchema,
  claudeMcpResponseSchema,
  permissionRequestSchema,
} from './claude_mcp_protocol.js';

describe('Claude tim MCP child server', () => {
  afterEach(() => {
    cleanupForTests();
  });

  test.each([
    {
      name: 'permission-only',
      approval: true,
      tools: [],
      expected: ['approval_prompt'],
    },
    {
      name: 'orchestrator combined',
      approval: true,
      tools: CLAUDE_ORCHESTRATOR_TOOL_NAMES,
      expected: ['approval_prompt', ...CLAUDE_ORCHESTRATOR_TOOL_NAMES],
    },
    {
      name: 'orchestrator tools-only',
      approval: false,
      tools: CLAUDE_ORCHESTRATOR_TOOL_NAMES,
      expected: [...CLAUDE_ORCHESTRATOR_TOOL_NAMES],
    },
    {
      name: 'subagent combined',
      approval: true,
      tools: CLAUDE_SUBAGENT_TOOL_NAMES,
      expected: ['approval_prompt', ...CLAUDE_SUBAGENT_TOOL_NAMES],
    },
    {
      name: 'subagent tools-only',
      approval: false,
      tools: CLAUDE_SUBAGENT_TOOL_NAMES,
      expected: [...CLAUDE_SUBAGENT_TOOL_NAMES],
    },
  ])('$name advertises only its installation tools', ({ approval, tools, expected }) => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: approval,
      agentToolNames: tools,
    });

    expect(result.toolNames).toEqual(expected);
    expect([...result.toolExecutors.keys()]).toEqual(
      expected.filter((name) => name !== 'approval_prompt')
    );
  });

  test('does not include a caller identity in agent tool requests and renders a correlated result', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents'],
    });
    const execute = result.toolExecutors.get('ListAgents');
    expect(execute).toBeDefined();

    const parentServer = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        expect(request).toEqual({
          type: 'agent_tool_request',
          requestId: expect.any(String),
          tool_name: 'ListAgents',
          input: {},
        });
        socket.write(
          JSON.stringify({
            type: 'agent_tool_response',
            requestId: request.requestId,
            success: true,
            result: { agents: [] },
          }) + '\n'
        );
      });
    });

    await new Promise<void>((resolve) => parentServer.listen(0, '127.0.0.1', resolve));
    const address = parentServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Parent server did not listen');
    const socket = net.createConnection(address.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    setParentSocket(socket);

    await expect(execute!({})).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ agents: [] }) }],
    });

    socket.destroy();
    await new Promise<void>((resolve) => parentServer.close(() => resolve()));
  });

  test('rejects a response with the wrong discriminated kind without resolving the child call', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents'],
    });
    const execute = result.toolExecutors.get('ListAgents');
    expect(execute).toBeDefined();

    const parentServer = net.createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        socket.write(
          JSON.stringify({
            type: 'permission_response',
            requestId: request.requestId,
            approved: true,
          }) + '\n'
        );
      });
    });
    await new Promise<void>((resolve) => parentServer.listen(0, '127.0.0.1', resolve));
    const address = parentServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Parent server did not listen');
    const socket = net.createConnection(address.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    setParentSocket(socket);

    await expect(execute!({})).rejects.toThrow('Unexpected response type');
    socket.destroy();
    await new Promise<void>((resolve) => parentServer.close(() => resolve()));
  });

  test('validates the permission and agent-tool envelopes as separate discriminated protocols', () => {
    expect(
      permissionRequestSchema.safeParse({
        type: 'permission_request',
        requestId: 'permission-1',
        tool_name: 'Bash',
        input: { command: 'pwd' },
      }).success
    ).toBe(true);
    expect(
      agentToolRequestSchema.safeParse({
        type: 'agent_tool_request',
        requestId: 'agent-1',
        tool_name: 'ListAgents',
        input: {},
      }).success
    ).toBe(true);

    expect(
      claudeMcpRequestSchema.safeParse({
        type: 'agent_tool_request',
        requestId: 'agent-2',
        tool_name: 'StartAgent',
        input: { source: 'forged' },
        caller: 'forged',
      }).success
    ).toBe(false);
    expect(
      claudeMcpResponseSchema.safeParse({
        type: 'agent_tool_response',
        requestId: 'agent-3',
        success: false,
        error: '',
      }).success
    ).toBe(false);
    expect(
      agentToolResponseSchema.safeParse({
        type: 'permission_response',
        requestId: 'agent-4',
        approved: true,
      }).success
    ).toBe(false);
  });

  test('correlates concurrent calls by request ID even when responses arrive out of order', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents', 'SendAgentMessage'],
    });
    const listAgents = result.toolExecutors.get('ListAgents');
    const sendAgentMessage = result.toolExecutors.get('SendAgentMessage');
    expect(listAgents).toBeDefined();
    expect(sendAgentMessage).toBeDefined();

    const parentServer = net.createServer((socket) => {
      let buffer = '';
      const requests: Array<{ requestId: string; toolName: string }> = [];
      socket.on('data', (data) => {
        buffer += data.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as {
            requestId: string;
            tool_name: string;
          };
          requests.push({ requestId: request.requestId, toolName: request.tool_name });
          if (requests.length === 2) {
            const second = requests[1];
            const first = requests[0];
            socket.write(
              JSON.stringify({
                type: 'agent_tool_response',
                requestId: second.requestId,
                success: true,
                result: { responseFor: second.toolName },
              }) + '\n'
            );
            socket.write(
              JSON.stringify({
                type: 'agent_tool_response',
                requestId: 'unknown-request-id',
                success: true,
                result: { responseFor: 'unknown' },
              }) + '\n'
            );
            socket.write(
              JSON.stringify({
                type: 'agent_tool_response',
                requestId: first.requestId,
                success: true,
                result: { responseFor: first.toolName },
              }) + '\n'
            );
          }
          newline = buffer.indexOf('\n');
        }
      });
    });

    await listen(parentServer);
    const address = parentServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Parent server did not listen');
    const socket = net.createConnection(address.port, '127.0.0.1');
    try {
      await onceConnected(socket);
      setParentSocket(socket);

      const [listResult, sendResult] = await Promise.all([
        listAgents!({}),
        sendAgentMessage!({ name: 'orchestrator', message: 'hello' }),
      ]);

      expect(listResult).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ responseFor: 'ListAgents' }) }],
      });
      expect(sendResult).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ responseFor: 'SendAgentMessage' }) }],
      });
    } finally {
      socket.destroy();
      await closeServer(parentServer);
    }
  });

  test('renders a correlated agent-tool failure as model-visible error content', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents'],
    });
    const execute = result.toolExecutors.get('ListAgents');
    expect(execute).toBeDefined();

    const parentServer = net.createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        socket.write(
          JSON.stringify({
            type: 'agent_tool_response',
            requestId: request.requestId,
            success: false,
            error: 'AgentManager rejected the request',
          }) + '\n'
        );
      });
    });

    await listen(parentServer);
    const address = parentServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Parent server did not listen');
    const socket = net.createConnection(address.port, '127.0.0.1');
    try {
      await onceConnected(socket);
      setParentSocket(socket);
      await expect(execute!({})).resolves.toEqual({
        content: [{ type: 'text', text: 'AgentManager rejected the request' }],
        isError: true,
      });
    } finally {
      socket.destroy();
      await closeServer(parentServer);
    }
  });

  test('clears a pending request timer when the child bridge is cleaned up', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents'],
    });
    const execute = result.toolExecutors.get('ListAgents');
    expect(execute).toBeDefined();

    const parentServer = net.createServer(() => {
      // Keep the request pending until the child test seam performs cleanup.
    });
    await listen(parentServer);
    const address = parentServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Parent server did not listen');
    const socket = net.createConnection(address.port, '127.0.0.1');
    try {
      await onceConnected(socket);
      setParentSocket(socket);
      vi.useFakeTimers();
      const pending = execute!({});
      expect(vi.getTimerCount()).toBe(1);

      cleanupForTests();

      await expect(pending).rejects.toThrow('MCP bridge test cleanup');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      socket.destroy();
      await closeServer(parentServer);
      vi.useRealTimers();
    }
  });
});

async function listen(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function onceConnected(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
