import { afterEach, describe, expect, test } from 'vitest';
import * as net from 'node:net';
import { cleanupForTests, createClaudeMcpServer, setParentSocket } from './permissions_mcp.js';
import {
  CLAUDE_ORCHESTRATOR_TOOL_NAMES,
  CLAUDE_SUBAGENT_TOOL_NAMES,
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
});
