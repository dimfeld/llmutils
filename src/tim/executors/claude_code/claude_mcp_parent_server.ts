import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';

import { debugLog, log } from '../../../logging.js';
import {
  agentToolRequestSchema,
  callerIdentityFromAgent,
  getClaudeAgentArgumentSchema,
  getClaudeAgentToolNames,
  type ClaudeAgentToolContext,
  type ClaudePermissionPromptCoordinator,
} from './claude_mcp_protocol.js';

const MAX_CLAUDE_MCP_JSON_SIZE = 1024 * 1024;

export interface ClaudeMcpRequester {
  readonly name: string;
  readonly token: string;
}

export interface ClaudeMcpParentServerOptions {
  readonly allowedToolsMap: Map<string, true | string[]>;
  readonly interactiveApprovalEnabled?: boolean;
  readonly agentToolContext?: ClaudeAgentToolContext;
  readonly permissionPromptCoordinator?: ClaudePermissionPromptCoordinator;
  readonly handlePermissionRequest: (
    rawMessage: unknown,
    socket: net.Socket,
    requester: ClaudeMcpRequester
  ) => Promise<void>;
}

export interface ClaudeMcpParentServerResources {
  readonly server: net.Server;
  readonly sockets: Map<net.Socket, string>;
}

export function writeClaudeMcpSocketMessage(socket: net.Socket, value: unknown): void {
  if (socket.destroyed) return;
  try {
    socket.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    debugLog('Could not write Claude MCP response:', error);
  }
}

function writeAgentToolError(socket: net.Socket, requestId: string, error: unknown): void {
  writeClaudeMcpSocketMessage(socket, {
    type: 'agent_tool_response',
    requestId,
    success: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

type ClaudeMcpFrame =
  | { readonly kind: 'line'; readonly value: string }
  | { readonly kind: 'oversized'; readonly prefix: string };

function createBoundedLineSplitter(): (input: string) => ClaudeMcpFrame[] {
  let fragment = '';
  let oversizedPrefix: string | undefined;
  return (input: string): ClaudeMcpFrame[] => {
    const frames: ClaudeMcpFrame[] = [];
    let remaining = input;

    if (oversizedPrefix !== undefined) {
      const newlineIndex = remaining.indexOf('\n');
      if (newlineIndex === -1) return frames;
      frames.push({ kind: 'oversized', prefix: oversizedPrefix });
      oversizedPrefix = undefined;
      remaining = remaining.slice(newlineIndex + 1);
    }

    const lines = (fragment + remaining).split('\n');
    fragment = lines.pop() ?? '';
    for (const line of lines) {
      frames.push(
        line.length <= MAX_CLAUDE_MCP_JSON_SIZE
          ? { kind: 'line', value: line }
          : { kind: 'oversized', prefix: line.slice(0, 4096) }
      );
    }

    if (fragment.length > MAX_CLAUDE_MCP_JSON_SIZE) {
      oversizedPrefix = fragment.slice(0, 4096);
      fragment = '';
    }
    return frames;
  };
}

function parseJsonStringCapture(capture: string | undefined): string | undefined {
  if (capture === undefined) return undefined;
  try {
    const parsed = JSON.parse(`"${capture}"`);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function handleOversizedFrame(prefix: string, socket: net.Socket): void {
  const requestId = parseJsonStringCapture(
    /"requestId"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(prefix)?.[1]
  );
  const type = /"type"\s*:\s*"(permission_request|agent_tool_request)"/.exec(prefix)?.[1];
  log(chalk.yellow('Claude MCP rejected an oversized request frame'));
  if (requestId === undefined) return;
  if (type === 'permission_request') {
    writeClaudeMcpSocketMessage(socket, {
      type: 'permission_response',
      requestId,
      approved: false,
    });
  } else if (type === 'agent_tool_request') {
    writeAgentToolError(
      socket,
      requestId,
      'Claude MCP request exceeded the maximum JSON line size'
    );
  }
}

async function handleAgentToolRequest(
  rawMessage: unknown,
  socket: net.Socket,
  context: ClaudeAgentToolContext | undefined
): Promise<void> {
  if (!isRecord(rawMessage) || rawMessage.type !== 'agent_tool_request') return;

  const requestId = getRequestId(rawMessage);
  if (requestId === undefined) {
    debugLog('Agent tool request is missing requestId');
    return;
  }

  const parsed = agentToolRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    writeAgentToolError(socket, requestId, 'Agent tool request is invalid');
    return;
  }

  const { tool_name: toolName, input } = parsed.data;
  const roleTools = new Set(
    context === undefined ? [] : getClaudeAgentToolNames(context.caller.role)
  );
  if (context === undefined || !roleTools.has(toolName) || !context.allowedTools.has(toolName)) {
    writeAgentToolError(socket, requestId, `Agent tool ${toolName} is not allowed for this caller`);
    return;
  }

  const validatedInput = getClaudeAgentArgumentSchema(toolName).safeParse(input);
  if (!validatedInput.success) {
    writeAgentToolError(socket, requestId, `Arguments for ${toolName} are invalid`);
    return;
  }

  const caller = callerIdentityFromAgent(context.caller);
  try {
    let result: unknown;
    switch (toolName) {
      case 'StartAgent':
        result = await context.dispatcher.startAgent(caller, validatedInput.data);
        break;
      case 'ListAgents':
        result = await context.dispatcher.listAgents(caller);
        break;
      case 'SendAgentMessage':
        result = await context.dispatcher.sendAgentMessage(caller, validatedInput.data);
        break;
      case 'StopAgent':
        result = await context.dispatcher.stopAgent(caller, validatedInput.data);
        break;
      case 'FinishAgent':
        result = await context.dispatcher.finishAgent(caller, validatedInput.data);
        break;
      default: {
        const exhaustive: never = toolName;
        writeAgentToolError(socket, requestId, `Unknown agent tool ${String(exhaustive)}`);
        return;
      }
    }

    writeClaudeMcpSocketMessage(socket, {
      type: 'agent_tool_response',
      requestId,
      success: true,
      result,
    });
  } catch (error) {
    writeAgentToolError(socket, requestId, error);
  }
}

function getRequestId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.requestId === 'string' ? value.requestId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleClaudeMcpLine(
  line: string,
  socket: net.Socket,
  requester: ClaudeMcpRequester,
  options: ClaudeMcpParentServerOptions
): Promise<void> {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(line);
  } catch (error) {
    debugLog('Failed to parse Claude MCP request JSON:', error);
    return;
  }
  if (!isRecord(rawMessage)) return;

  if (rawMessage.type === 'permission_request') {
    if (options.interactiveApprovalEnabled === false) {
      const requestId = getRequestId(rawMessage);
      if (requestId !== undefined) {
        writeClaudeMcpSocketMessage(socket, {
          type: 'permission_response',
          requestId,
          approved: false,
        });
      }
      return;
    }
    await options.handlePermissionRequest(rawMessage, socket, requester);
    return;
  }

  if (rawMessage.type === 'agent_tool_request') {
    await handleAgentToolRequest(rawMessage, socket, options.agentToolContext);
  }
}

/** Create one parent socket server for a single Claude MCP bridge. */
export function createClaudeMcpParentServer(
  socketPath: string,
  options: ClaudeMcpParentServerOptions
): Promise<ClaudeMcpParentServerResources> {
  return new Promise((resolve, reject) => {
    const sockets = new Map<net.Socket, string>();
    const server = net.createServer((socket) => {
      const requester: ClaudeMcpRequester = {
        name: options.agentToolContext?.caller.name ?? '',
        token: randomUUID(),
      };
      sockets.set(socket, requester.token);
      const splitLines = createBoundedLineSplitter();

      socket.on('data', (data) => {
        for (const frame of splitLines(data.toString())) {
          if (frame.kind === 'oversized') {
            handleOversizedFrame(frame.prefix, socket);
            continue;
          }
          if (!frame.value) continue;
          void handleClaudeMcpLine(frame.value, socket, requester, options).catch((error) => {
            debugLog('Claude MCP request handler failed:', error);
          });
        }
      });
      socket.on('error', (error) => {
        debugLog('Claude MCP client socket failed:', error);
      });
      const cancelRequester = (): void => {
        if (sockets.delete(socket)) {
          options.permissionPromptCoordinator?.cancelRequester(requester.token);
        }
      };
      socket.on('end', cancelRequester);
      socket.on('close', cancelRequester);
    });

    server.on('error', reject);
    server.listen(socketPath, () => resolve({ server, sockets }));
  });
}

export async function closeClaudeMcpParentServer(
  resources: ClaudeMcpParentServerResources,
  permissionPromptCoordinator?: ClaudePermissionPromptCoordinator
): Promise<void> {
  let firstError: unknown;
  for (const [socket, requesterToken] of resources.sockets) {
    try {
      permissionPromptCoordinator?.cancelRequester(requesterToken);
    } catch (error) {
      firstError ??= error;
    }
    try {
      socket.destroy();
    } catch (error) {
      firstError ??= error;
    }
  }
  resources.sockets.clear();
  if (resources.server.listening) {
    await new Promise<void>((resolve) => resources.server.close(() => resolve()));
  }
  if (firstError !== undefined) throw firstError;
}
