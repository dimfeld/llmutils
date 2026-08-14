import { afterEach, describe, expect, test, vi } from 'vitest';
import * as net from 'node:net';
import { cleanupForTests, createClaudeMcpServer, setParentSocket } from './tim_mcp.js';
import {
  CLAUDE_AGENT_ARGUMENT_SCHEMAS,
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
    expect([...result.toolExecutors.keys()]).toEqual(expected);
  });

  test('filters unknown capability-manifest names from child tool installation', () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents', 'not-a-tim-tool', 'FinishAgent'],
    });

    expect(result.toolNames).toEqual(['ListAgents', 'FinishAgent']);
    expect([...result.toolExecutors.keys()]).toEqual(['ListAgents', 'FinishAgent']);
  });

  test('renders the real approval_prompt allow, deny, and updated-input responses', async () => {
    const result = createClaudeMcpServer({ interactiveApprovalEnabled: true });
    const approvalPrompt = result.toolExecutors.get('approval_prompt');
    expect(approvalPrompt).toBeDefined();

    const parentServer = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const request = JSON.parse(buffer.slice(0, newline)) as {
            requestId: string;
            tool_name: string;
          };
          buffer = buffer.slice(newline + 1);
          const approved = request.tool_name === 'Bash';
          socket.write(
            JSON.stringify({
              type: 'permission_response',
              requestId: request.requestId,
              approved,
              ...(approved ? { updatedInput: { command: 'pwd && ls' } } : {}),
            }) + '\n'
          );
          newline = buffer.indexOf('\n');
        }
      });
    });

    await listen(parentServer);
    const address = parentServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Parent server did not listen');
    }
    const socket = net.createConnection(address.port, '127.0.0.1');
    try {
      await onceConnected(socket);
      setParentSocket(socket);

      const allowed = await approvalPrompt!({ tool_name: 'Bash', input: { command: 'pwd' } });
      expect(JSON.parse(allowed.content[0].text)).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'pwd && ls' },
      });

      const denied = await approvalPrompt!({ tool_name: 'Read', input: {} });
      expect(JSON.parse(denied.content[0].text)).toEqual({
        behavior: 'deny',
        message: 'User denied permission for tool: Read',
      });
    } finally {
      socket.destroy();
      await closeServer(parentServer);
    }
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

  test.each([
    {
      toolName: 'StartAgent' as const,
      input: { type: 'tester', executor: 'claude-code', initialMessage: 'check this' },
    },
    { toolName: 'ListAgents' as const, input: {} },
    {
      toolName: 'SendAgentMessage' as const,
      input: { name: 'orchestrator', message: 'status' },
    },
    { toolName: 'StopAgent' as const, input: { name: 'worker-a', force: true } },
    { toolName: 'FinishAgent' as const, input: { message: 'complete' } },
  ])('$toolName uses the shared strict argument schema', ({ toolName, input }) => {
    const schema = CLAUDE_AGENT_ARGUMENT_SCHEMAS[toolName];

    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, source: 'forged-caller' }).success).toBe(false);
  });

  test('does not allow FinishAgent to target another agent', () => {
    expect(CLAUDE_AGENT_ARGUMENT_SCHEMAS.FinishAgent.safeParse({ name: 'worker-a' }).success).toBe(
      false
    );
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

  test('does not cross-resolve a permission response and an agent-tool response', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: true,
      agentToolNames: ['ListAgents'],
    });
    const approvalPrompt = result.toolExecutors.get('approval_prompt');
    const listAgents = result.toolExecutors.get('ListAgents');
    expect(approvalPrompt).toBeDefined();
    expect(listAgents).toBeDefined();

    const parentServer = net.createServer((socket) => {
      let buffer = '';
      const requests: Array<{ requestId: string; type: string }> = [];
      socket.on('data', (data) => {
        buffer += data.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const request = JSON.parse(buffer.slice(0, newline)) as {
            requestId: string;
            type: string;
          };
          buffer = buffer.slice(newline + 1);
          requests.push(request);
          if (requests.length === 2) {
            const [first, second] = requests;
            socket.write(
              JSON.stringify({
                type:
                  second.type === 'permission_request'
                    ? 'permission_response'
                    : 'agent_tool_response',
                requestId: second.requestId,
                ...(second.type === 'permission_request'
                  ? { approved: true }
                  : { success: true, result: { agents: [] } }),
              }) + '\n'
            );
            socket.write(
              JSON.stringify({
                type:
                  first.type === 'permission_request'
                    ? 'permission_response'
                    : 'agent_tool_response',
                requestId: first.requestId,
                ...(first.type === 'permission_request'
                  ? { approved: true }
                  : { success: true, result: { agents: [] } }),
              }) + '\n'
            );
          }
          newline = buffer.indexOf('\n');
        }
      });
    });

    await listen(parentServer);
    const address = parentServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Parent server did not listen');
    }
    const socket = net.createConnection(address.port, '127.0.0.1');
    try {
      await onceConnected(socket);
      setParentSocket(socket);

      const [permissionResult, agentResult] = await Promise.all([
        approvalPrompt!({ tool_name: 'Read', input: {} }),
        listAgents!({}),
      ]);
      expect(JSON.parse(permissionResult.content[0].text)).toEqual({
        behavior: 'allow',
        updatedInput: {},
      });
      expect(agentResult).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ agents: [] }) }],
      });
    } finally {
      socket.destroy();
      await closeServer(parentServer);
    }
  });

  test('accepts parent responses split across chunks without mixing response kinds', async () => {
    const result = createClaudeMcpServer({
      interactiveApprovalEnabled: false,
      agentToolNames: ['ListAgents'],
    });
    const listAgents = result.toolExecutors.get('ListAgents');
    expect(listAgents).toBeDefined();

    const parentServer = net.createServer((socket) => {
      socket.once('data', (data) => {
        const request = JSON.parse(data.toString()) as { requestId: string };
        const response = JSON.stringify({
          type: 'agent_tool_response',
          requestId: request.requestId,
          success: true,
          result: { agents: [] },
        });
        const midpoint = Math.floor(response.length / 2);
        socket.write(response.slice(0, midpoint));
        socket.write(`${response.slice(midpoint)}\n`);
      });
    });

    await listen(parentServer);
    const address = parentServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Parent server did not listen');
    }
    const socket = net.createConnection(address.port, '127.0.0.1');
    try {
      await onceConnected(socket);
      setParentSocket(socket);
      await expect(listAgents!({})).resolves.toEqual({
        content: [{ type: 'text', text: JSON.stringify({ agents: [] }) }],
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
