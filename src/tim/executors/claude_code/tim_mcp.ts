/**
 * Standalone Claude MCP bridge for permission approval and agent management.
 *
 * The process receives only a discoverability manifest. Trusted identity and
 * authorization remain in the parent tim process.
 */

import { FastMCP } from 'fastmcp';
import * as z from 'zod/v4';
import * as net from 'node:net';
import * as fs from 'node:fs';

import {
  CLAUDE_AGENT_TOOL_NAMES,
  CLAUDE_APPROVAL_TOOL_NAME,
  claudeMcpResponseSchema,
  type AgentToolResponse,
  type ClaudeAgentToolName,
  type ClaudeMcpRequest,
  type ClaudeMcpResponse,
  type PermissionResponse,
} from './claude_mcp_protocol.js';
import {
  finishAgentArgumentsSchema,
  listAgentsArgumentsSchema,
  sendAgentMessageArgumentsSchema,
  startAgentArgumentsSchema,
  stopAgentArgumentsSchema,
} from '../../agent_messaging/contracts.js';

export const PermissionInputSchema = z.object({
  tool_name: z.string().describe('The tool requesting permission'),
  input: z.object({}).passthrough().describe('The input for the tool'),
});

export interface PermissionResponseData {
  approved: boolean;
  updatedInput?: unknown;
}

export interface ClaudeMcpServerOptions {
  /** Whether the approval_prompt tool should be advertised. */
  readonly interactiveApprovalEnabled?: boolean;
  /** Untrusted child-side discoverability list supplied by the parent. */
  readonly agentToolNames?: readonly string[];
}

export interface ClaudeMcpServerHandle {
  readonly server: FastMCP;
  readonly toolNames: readonly string[];
  /** Direct executor seam for protocol tests; production uses FastMCP stdio. */
  readonly toolExecutors: ReadonlyMap<string, (input: unknown) => Promise<unknown>>;
}

const MAX_JSON_SIZE = 1024 * 1024;
const PARENT_REQUEST_TIMEOUT_MS = 1000 * 60 * 600;

let parentSocket: net.Socket | null = null;
let messageBuffer = '';
let requestCounter = 0;
let logFilePath: string | undefined;

type PendingRequest = {
  readonly expectedResponseType: 'permission_response' | 'agent_tool_response';
  readonly resolve: (response: ClaudeMcpResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type ClaudeMcpRequestResponseMap = {
  permission_request: {
    readonly request: Omit<Extract<ClaudeMcpRequest, { type: 'permission_request' }>, 'requestId'>;
    readonly response: PermissionResponse;
  };
  agent_tool_request: {
    readonly request: Omit<Extract<ClaudeMcpRequest, { type: 'agent_tool_request' }>, 'requestId'>;
    readonly response: AgentToolResponse;
  };
};

type ClaudeMcpRequestType = keyof ClaudeMcpRequestResponseMap;

const responseTypeByRequestType: {
  readonly [K in ClaudeMcpRequestType]: ClaudeMcpRequestResponseMap[K]['response']['type'];
} = {
  permission_request: 'permission_response',
  agent_tool_request: 'agent_tool_response',
};

const pendingRequests = new Map<string, PendingRequest>();

function formatLogValue(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeLog(message: string, ...values: unknown[]): void {
  if (!logFilePath) return;
  const renderedValues = values.map(formatLogValue);
  const line = `[${new Date().toISOString()}] ${[message, ...renderedValues].join(' ')}\n`;
  try {
    fs.appendFileSync(logFilePath, line);
  } catch (error) {
    console.error('Failed to write tim MCP log:', error);
  }
}

function configureLogging(nextLogFilePath: string | undefined): void {
  logFilePath = nextLogFilePath;
  if (!logFilePath) return;
  writeLog('tim MCP log initialized:', logFilePath);

  process.on('uncaughtException', (error: Error) => {
    writeLog('Uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    writeLog('Unhandled rejection:', reason);
  });
}

function generateRequestId(): string {
  return `req_${Date.now()}_${++requestCounter}`;
}

function rejectPendingRequest(requestId: string, error: Error): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.reject(error);
}

function rejectAllPendingRequests(error: Error): void {
  for (const requestId of pendingRequests.keys()) {
    rejectPendingRequest(requestId, error);
  }
}

function handleParentResponse(value: unknown): void {
  const parsed = claudeMcpResponseSchema.safeParse(value);
  if (!parsed.success) {
    const requestId =
      typeof value === 'object' && value !== null && 'requestId' in value
        ? (value as { requestId?: unknown }).requestId
        : undefined;
    if (typeof requestId === 'string') {
      rejectPendingRequest(requestId, new Error('Invalid response from tim MCP parent'));
    }
    writeLog('Ignoring invalid parent response:', parsed.error.issues);
    return;
  }

  const response = parsed.data;
  const pending = pendingRequests.get(response.requestId);
  if (!pending) {
    writeLog('No pending request found for requestId:', response.requestId);
    return;
  }

  if (pending.expectedResponseType !== response.type) {
    rejectPendingRequest(
      response.requestId,
      new Error(
        `Unexpected response type ${response.type} for ${pending.expectedResponseType} request`
      )
    );
    return;
  }

  pendingRequests.delete(response.requestId);
  clearTimeout(pending.timer);
  pending.resolve(response);
}

function handleParentData(data: Buffer): void {
  messageBuffer += data.toString();
  let newlineIndex = messageBuffer.indexOf('\n');
  while (newlineIndex !== -1) {
    const message = messageBuffer.slice(0, newlineIndex);
    messageBuffer = messageBuffer.slice(newlineIndex + 1);
    if (message.length > MAX_JSON_SIZE) {
      writeLog('Message too large, ignoring:', message.length);
    } else if (message.length > 0) {
      try {
        handleParentResponse(JSON.parse(message));
      } catch (error) {
        writeLog('Failed to parse parent response:', error);
      }
    }
    newlineIndex = messageBuffer.indexOf('\n');
  }

  if (messageBuffer.length > MAX_JSON_SIZE) {
    writeLog('Message buffer too large, clearing:', messageBuffer.length);
    messageBuffer = '';
  }
}

function installParentSocketHandlers(socket: net.Socket, exitOnClose: boolean): void {
  socket.on('data', handleParentData);
  socket.on('error', (error: Error) => {
    writeLog('Parent socket error:', error);
    rejectAllPendingRequests(new Error('Socket connection error', { cause: error }));
    if (exitOnClose) process.exit(1);
  });
  socket.on('close', () => {
    writeLog('Parent socket closed');
    rejectAllPendingRequests(new Error('Socket connection closed'));
    if (exitOnClose) process.exit(0);
  });
}

/** Test seam for exercising the real child request/response correlation. */
export function setParentSocket(socket: net.Socket | null): void {
  if (parentSocket && parentSocket !== socket) {
    parentSocket.removeAllListeners('data');
    parentSocket.removeAllListeners('error');
    parentSocket.removeAllListeners('close');
  }
  rejectAllPendingRequests(new Error('Parent socket replaced'));
  parentSocket = socket;
  messageBuffer = '';
  if (socket) installParentSocketHandlers(socket, false);
}

/** Test cleanup that also settles every pending child call. */
export function cleanupForTests(): void {
  rejectAllPendingRequests(new Error('MCP bridge test cleanup'));
  if (parentSocket) {
    parentSocket.removeAllListeners('data');
    parentSocket.removeAllListeners('error');
    parentSocket.removeAllListeners('close');
    parentSocket = null;
  }
  messageBuffer = '';
  logFilePath = undefined;
}

function connectToParent(socketPath: string): void {
  writeLog('Connecting to parent socket:', socketPath);
  parentSocket = net.createConnection(socketPath, () => {
    writeLog('Connected to parent socket');
  });
  installParentSocketHandlers(parentSocket, true);
}

function requestParent(
  request: ClaudeMcpRequestResponseMap['permission_request']['request']
): Promise<ClaudeMcpRequestResponseMap['permission_request']['response']>;
function requestParent(
  request: ClaudeMcpRequestResponseMap['agent_tool_request']['request']
): Promise<ClaudeMcpRequestResponseMap['agent_tool_request']['response']>;
function requestParent(
  request:
    | ClaudeMcpRequestResponseMap['permission_request']['request']
    | ClaudeMcpRequestResponseMap['agent_tool_request']['request']
): Promise<ClaudeMcpResponse>;
async function requestParent(
  request:
    | ClaudeMcpRequestResponseMap['permission_request']['request']
    | ClaudeMcpRequestResponseMap['agent_tool_request']['request']
): Promise<ClaudeMcpResponse> {
  if (!parentSocket || parentSocket.destroyed) {
    throw new Error('Not connected to tim MCP parent');
  }

  const requestId = generateRequestId();
  const expectedResponseType = responseTypeByRequestType[request.type];
  // Keep correlation metadata before potentially large tool input so the parent
  // can return a bounded, correlated error for an oversized frame.
  const fullRequest = { requestId, ...request };
  return new Promise<ClaudeMcpResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      rejectPendingRequest(requestId, new Error('MCP request timed out'));
    }, PARENT_REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, {
      expectedResponseType,
      resolve,
      reject,
      timer,
    });

    try {
      parentSocket?.write(`${JSON.stringify(fullRequest)}\n`);
      writeLog('Sent parent request:', fullRequest);
    } catch (error) {
      rejectPendingRequest(requestId, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function requestPermissionFromParent(
  tool_name: string,
  input: Record<string, unknown>
): Promise<PermissionResponse> {
  return requestParent({ type: 'permission_request', tool_name, input });
}

async function requestAgentToolFromParent(
  tool_name: ClaudeAgentToolName,
  input: unknown
): Promise<AgentToolResponse> {
  return requestParent({ type: 'agent_tool_request', tool_name, input });
}

function modelVisibleAgentResult(response: AgentToolResponse): {
  content: [{ type: 'text'; text: string }];
  isError?: boolean;
} {
  if (response.success) {
    return {
      content: [{ type: 'text', text: JSON.stringify(response.result) }],
    };
  }
  return {
    content: [{ type: 'text', text: response.error }],
    isError: true,
  };
}

function addAgentTool(
  server: FastMCP,
  toolNames: string[],
  toolExecutors: Map<string, (input: unknown) => Promise<unknown>>,
  name: ClaudeAgentToolName,
  parameters: Parameters<typeof server.addTool>[0]
): void {
  server.addTool(parameters);
  toolNames.push(name);
  toolExecutors.set(name, parameters.execute as unknown as (input: unknown) => Promise<unknown>);
}

/** Create one role-scoped MCP server for one Claude process. */
export function createClaudeMcpServer(options: ClaudeMcpServerOptions = {}): ClaudeMcpServerHandle {
  const server = new FastMCP({
    name: 'tim',
    version: '0.0.1',
  });
  const toolNames: string[] = [];
  const toolExecutors = new Map<string, (input: unknown) => Promise<unknown>>();

  if (options.interactiveApprovalEnabled !== false) {
    const executeApprovalPrompt = async ({
      tool_name,
      input,
    }: {
      tool_name: string;
      input: Record<string, unknown>;
    }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      try {
        const response = await requestPermissionFromParent(tool_name, input);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                response.approved
                  ? { behavior: 'allow', updatedInput: response.updatedInput ?? input }
                  : {
                      behavior: 'deny',
                      message: `User denied permission for tool: ${tool_name}`,
                    }
              ),
            },
          ],
        };
      } catch (error) {
        writeLog('Permission request failed:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                behavior: 'deny',
                message: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
            },
          ],
        };
      }
    };

    server.addTool({
      name: CLAUDE_APPROVAL_TOOL_NAME,
      description: 'Prompts the user for permission to execute a tool',
      parameters: PermissionInputSchema,
      execute: executeApprovalPrompt,
    });
    toolNames.push(CLAUDE_APPROVAL_TOOL_NAME);
    toolExecutors.set(
      CLAUDE_APPROVAL_TOOL_NAME,
      executeApprovalPrompt as unknown as (input: unknown) => Promise<unknown>
    );
  }

  const requestedToolNames = new Set(options.agentToolNames ?? []);
  if (requestedToolNames.has('StartAgent')) {
    addAgentTool(server, toolNames, toolExecutors, 'StartAgent', {
      name: 'StartAgent',
      description: 'Start a named Claude or Codex subagent',
      parameters: startAgentArgumentsSchema,
      execute: async (input) =>
        modelVisibleAgentResult(await requestAgentToolFromParent('StartAgent', input)),
    });
  }
  if (requestedToolNames.has('ListAgents')) {
    addAgentTool(server, toolNames, toolExecutors, 'ListAgents', {
      name: 'ListAgents',
      description: 'List active agents in this tim session',
      parameters: listAgentsArgumentsSchema,
      execute: async (input) =>
        modelVisibleAgentResult(await requestAgentToolFromParent('ListAgents', input)),
    });
  }
  if (requestedToolNames.has('SendAgentMessage')) {
    addAgentTool(server, toolNames, toolExecutors, 'SendAgentMessage', {
      name: 'SendAgentMessage',
      description: 'Send a message to an active agent',
      parameters: sendAgentMessageArgumentsSchema,
      execute: async (input) =>
        modelVisibleAgentResult(await requestAgentToolFromParent('SendAgentMessage', input)),
    });
  }
  if (requestedToolNames.has('StopAgent')) {
    addAgentTool(server, toolNames, toolExecutors, 'StopAgent', {
      name: 'StopAgent',
      description: 'Gracefully or forcefully stop an active subagent',
      parameters: stopAgentArgumentsSchema,
      execute: async (input) =>
        modelVisibleAgentResult(await requestAgentToolFromParent('StopAgent', input)),
    });
  }
  if (requestedToolNames.has('FinishAgent')) {
    addAgentTool(server, toolNames, toolExecutors, 'FinishAgent', {
      name: 'FinishAgent',
      description: 'Mark this subagent complete after its current turn',
      parameters: finishAgentArgumentsSchema,
      execute: async (input) =>
        modelVisibleAgentResult(await requestAgentToolFromParent('FinishAgent', input)),
    });
  }

  return {
    server,
    toolNames: Object.freeze(toolNames),
    toolExecutors,
  };
}

function parseServerOptions(value: string | undefined): ClaudeMcpServerOptions {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const agentToolNames = Array.isArray(record.agentToolNames)
      ? record.agentToolNames.filter(
          (name): name is ClaudeAgentToolName =>
            typeof name === 'string' &&
            (CLAUDE_AGENT_TOOL_NAMES as readonly string[]).includes(name)
        )
      : undefined;
    return {
      interactiveApprovalEnabled:
        record.interactiveApprovalEnabled === undefined
          ? undefined
          : record.interactiveApprovalEnabled === true,
      agentToolNames,
    };
  } catch {
    return {};
  }
}

if (import.meta.main) {
  const socketPath = process.argv[2];
  const nextLogFilePath = process.argv[3];
  configureLogging(nextLogFilePath);
  if (!socketPath) {
    console.error('Unix socket path must be provided as a command line argument');
    process.exit(1);
  }

  connectToParent(socketPath);
  process.stdin.on('close', () => parentSocket?.end());

  const { server } = createClaudeMcpServer(parseServerOptions(process.argv[4]));
  writeLog('Starting tim MCP server');
  await server.start({ transportType: 'stdio' });
}
