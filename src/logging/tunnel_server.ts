import net from 'node:net';
import fs from 'node:fs';
import {
  log,
  error,
  warn,
  writeStdout,
  writeStderr,
  debugLog,
  sendStructured,
} from '../logging.js';
import { CleanupRegistry } from '../common/cleanup_registry.js';
import { getLoggerAdapter } from './adapter.js';
import { ConsoleAdapter } from './console.js';
import { indentEveryLine } from './console_formatter.js';
import type {
  ServerTunnelMessage,
  TunnelMessage,
  TunnelProcessMessage,
  TunnelPromptResponseMessage,
  TunnelUserInputMessage,
} from './tunnel_protocol.js';
import { isStructuredTunnelMessage, isTunnelProcessMessage } from './tunnel_protocol.js';
import {
  structuredMessageTypeList,
  type StructuredMessage,
  type PromptRequestMessage,
} from './structured_messages.js';
import { HeadlessAdapter } from './headless_adapter.js';
import {
  isProcessId,
  isSessionProcessTerminationResult,
  type ProcessId,
  type SessionProcessRegistry,
} from '../common/session_process.js';

export const structuredMessageTypes = new Set<StructuredMessage['type']>(structuredMessageTypeList);

const fileChangeKinds = new Set(['added', 'updated', 'removed']);
const fileChangeStatuses = new Set(['in_progress', 'completed', 'failed', 'declined']);
const reviewSeverities = new Set(['critical', 'major', 'minor', 'info', 'note']);
const reviewCategories = new Set([
  'security',
  'performance',
  'bug',
  'style',
  'compliance',
  'testing',
  'other',
]);
const reviewVerdicts = new Set(['ACCEPTABLE', 'NEEDS_FIXES', 'UNKNOWN']);
const executionSummaryModes = new Set(['serial', 'batch']);
const todoStatuses = new Set(['pending', 'in_progress', 'completed', 'blocked', 'unknown']);
const promptTypes = new Set(['input', 'confirm', 'select', 'checkbox', 'prefix_select']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPrimitiveValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

function isJsonSerializableValue(value: unknown): boolean {
  if (value == null) {
    return true;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return Number.isFinite(value) || typeof value !== 'number';
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonSerializableValue(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((item) => isJsonSerializableValue(item));
}

function isValidStepOutput(output: unknown): boolean {
  if (!isRecord(output) || typeof output.content !== 'string') {
    return false;
  }

  if (
    output.steps != null &&
    (!Array.isArray(output.steps) ||
      !output.steps.every(
        (step) => isRecord(step) && typeof step.title === 'string' && typeof step.body === 'string'
      ))
  ) {
    return false;
  }

  if (
    output.metadata != null &&
    (!isRecord(output.metadata) || !isJsonSerializableValue(output.metadata))
  ) {
    return false;
  }

  if (output.failureDetails != null) {
    if (!isRecord(output.failureDetails)) {
      return false;
    }

    for (const key of ['sourceAgent', 'requirements', 'problems', 'solutions']) {
      const value = output.failureDetails[key];
      if (value != null && typeof value !== 'string') {
        return false;
      }
    }
  }

  return true;
}

function isValidReviewIssue(issue: unknown): boolean {
  if (!isRecord(issue)) {
    return false;
  }

  return (
    typeof issue.severity === 'string' &&
    reviewSeverities.has(issue.severity) &&
    typeof issue.category === 'string' &&
    reviewCategories.has(issue.category) &&
    typeof issue.content === 'string' &&
    typeof issue.file === 'string' &&
    typeof issue.line === 'string' &&
    typeof issue.suggestion === 'string'
  );
}

function isValidExecutionSummary(summary: unknown): boolean {
  if (!isRecord(summary)) {
    return false;
  }

  if (
    typeof summary.planId !== 'string' ||
    typeof summary.planTitle !== 'string' ||
    typeof summary.planFilePath !== 'string' ||
    typeof summary.mode !== 'string' ||
    !executionSummaryModes.has(summary.mode) ||
    typeof summary.startedAt !== 'string' ||
    !Array.isArray(summary.steps) ||
    !isStringArray(summary.changedFiles) ||
    !isStringArray(summary.errors) ||
    !isRecord(summary.metadata) ||
    typeof summary.metadata.totalSteps !== 'number' ||
    typeof summary.metadata.failedSteps !== 'number'
  ) {
    return false;
  }

  if (
    !summary.steps.every(
      (step) =>
        isRecord(step) &&
        typeof step.title === 'string' &&
        typeof step.executor === 'string' &&
        typeof step.success === 'boolean' &&
        (step.output == null || isValidStepOutput(step.output))
    )
  ) {
    return false;
  }

  if (summary.endedAt != null && typeof summary.endedAt !== 'string') {
    return false;
  }

  if (summary.durationMs != null && typeof summary.durationMs !== 'number') {
    return false;
  }

  if (summary.createdFiles != null && !isStringArray(summary.createdFiles)) {
    return false;
  }

  if (summary.deletedFiles != null && !isStringArray(summary.deletedFiles)) {
    return false;
  }

  if (summary.planInfo != null && !isRecord(summary.planInfo)) {
    return false;
  }

  if (
    summary.metadata.batchIterations != null &&
    typeof summary.metadata.batchIterations !== 'number'
  ) {
    return false;
  }

  return true;
}

function isOptionalNumberField(message: Record<string, unknown>, key: string): boolean {
  return message[key] == null || typeof message[key] === 'number';
}

function isUserTerminalInputSource(value: unknown): value is 'terminal' | 'gui' {
  return value === 'terminal' || value === 'gui';
}

function isValidStructuredMessagePayload(message: unknown): message is StructuredMessage {
  if (!isRecord(message)) {
    return false;
  }

  const structured = message;
  if (typeof structured.type !== 'string' || typeof structured.timestamp !== 'string') {
    return false;
  }

  const structuredType = structured.type as StructuredMessage['type'];
  if (!structuredMessageTypes.has(structuredType)) {
    return false;
  }

  switch (structuredType) {
    case 'agent_session_start':
    case 'review_start':
    case 'input_required':
      return true;
    case 'user_terminal_input':
      return (
        typeof structured.content === 'string' &&
        (structured.source == null || isUserTerminalInputSource(structured.source))
      );
    case 'token_usage':
      return (
        isOptionalNumberField(structured, 'inputTokens') &&
        isOptionalNumberField(structured, 'cachedInputTokens') &&
        isOptionalNumberField(structured, 'outputTokens') &&
        isOptionalNumberField(structured, 'reasoningTokens') &&
        isOptionalNumberField(structured, 'totalTokens')
      );
    case 'agent_session_end':
      return typeof structured.success === 'boolean';
    case 'agent_iteration_start':
      return typeof structured.iterationNumber === 'number';
    case 'agent_step_start':
      return typeof structured.phase === 'string';
    case 'agent_step_end':
      return typeof structured.phase === 'string' && typeof structured.success === 'boolean';
    case 'llm_thinking':
    case 'llm_response':
      return typeof structured.text === 'string';
    case 'llm_tool_use':
      return (
        typeof structured.toolName === 'string' &&
        (structured.input == null || isJsonSerializableValue(structured.input))
      );
    case 'llm_tool_result':
      return (
        typeof structured.toolName === 'string' &&
        (structured.result == null || isJsonSerializableValue(structured.result))
      );
    case 'llm_status':
      return typeof structured.status === 'string';
    case 'todo_update':
      return (
        Array.isArray(structured.items) &&
        structured.items.every((item) => {
          if (!isRecord(item)) {
            return false;
          }

          return (
            typeof item.label === 'string' &&
            typeof item.status === 'string' &&
            todoStatuses.has(item.status) &&
            (item.detail == null || typeof item.detail === 'string')
          );
        }) &&
        (structured.turnId == null || typeof structured.turnId === 'string') &&
        (structured.explanation == null || typeof structured.explanation === 'string')
      );
    case 'file_write':
      return typeof structured.path === 'string' && typeof structured.lineCount === 'number';
    case 'file_edit':
      return typeof structured.path === 'string' && typeof structured.diff === 'string';
    case 'file_change_summary':
      return (
        (structured.id == null || typeof structured.id === 'string') &&
        (structured.status == null ||
          (typeof structured.status === 'string' && fileChangeStatuses.has(structured.status))) &&
        Array.isArray(structured.changes) &&
        structured.changes.every((change) => {
          if (!isRecord(change)) {
            return false;
          }
          return (
            typeof change.path === 'string' &&
            typeof change.kind === 'string' &&
            fileChangeKinds.has(change.kind) &&
            (change.diff == null || typeof change.diff === 'string')
          );
        })
      );
    case 'command_exec':
      return typeof structured.command === 'string';
    case 'command_result':
      return typeof structured.exitCode === 'number';
    case 'review_result':
      return (
        typeof structured.verdict === 'string' &&
        reviewVerdicts.has(structured.verdict) &&
        (structured.fixInstructions == null || typeof structured.fixInstructions === 'string') &&
        Array.isArray(structured.issues) &&
        structured.issues.every((issue) => isValidReviewIssue(issue)) &&
        isStringArray(structured.recommendations) &&
        isStringArray(structured.actionItems)
      );
    case 'workflow_progress':
      return typeof structured.message === 'string';
    case 'failure_report':
      return typeof structured.summary === 'string';
    case 'task_completion':
      return typeof structured.planComplete === 'boolean';
    case 'execution_summary':
      return isValidExecutionSummary(structured.summary);
    case 'prompt_request': {
      if (typeof structured.requestId !== 'string') return false;
      if (typeof structured.promptType !== 'string' || !promptTypes.has(structured.promptType))
        return false;
      if (!isRecord(structured.promptConfig)) return false;
      if (typeof structured.promptConfig.message !== 'string') return false;

      // Validate optional fields in promptConfig
      const config = structured.promptConfig;
      if (config.default != null && !isPrimitiveValue(config.default)) return false;
      if (config.pageSize != null && typeof config.pageSize !== 'number') return false;
      if (config.validationHint != null && typeof config.validationHint !== 'string') return false;
      if (config.header != null && typeof config.header !== 'string') return false;
      if (config.question != null && typeof config.question !== 'string') return false;

      // Validate choices array if present
      if (config.choices != null) {
        if (!Array.isArray(config.choices)) return false;
        for (const choice of config.choices) {
          if (!isRecord(choice)) return false;
          if (typeof choice.name !== 'string') return false;
          if (!isPrimitiveValue(choice.value)) return false;
          if (choice.description != null && typeof choice.description !== 'string') return false;
          if (choice.checked != null && typeof choice.checked !== 'boolean') return false;
        }
      }

      // Validate optional timeoutMs
      if (structured.timeoutMs != null && typeof structured.timeoutMs !== 'number') return false;

      return true;
    }
    case 'prompt_answered':
      return (
        typeof structured.requestId === 'string' &&
        typeof structured.promptType === 'string' &&
        promptTypes.has(structured.promptType) &&
        typeof structured.source === 'string' &&
        (structured.source === 'terminal' || structured.source === 'websocket')
      );
    case 'prompt_cancelled':
      return typeof structured.requestId === 'string';
    case 'plan_discovery':
      return typeof structured.planId === 'number' && typeof structured.title === 'string';
    case 'workspace_info':
      return typeof structured.path === 'string';
    default: {
      const _exhaustive: never = structuredType;
      return false;
    }
  }
}

/**
 * Creates a line splitter function that handles message framing across TCP chunks.
 * Buffers partial lines and returns complete newline-terminated lines.
 * Matches the pattern from createLineSplitter in src/common/process.ts.
 */
function createLineSplitter(): (input: string) => string[] {
  let fragment: string = '';

  return function splitLines(input: string): string[] {
    const fullInput = fragment + input;
    const lines = fullInput.split('\n');
    // Last element is the new fragment (empty if input ends with newline)
    fragment = lines.pop() || '';
    return lines;
  };
}

/**
 * Validates that a parsed JSON object has the expected structure for a TunnelMessage.
 * Returns true if the message is valid, false otherwise.
 */
function isValidOptionalPid(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function isValidOptionalString(value: unknown, maxLength: number = 2048): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function isValidOptionalProcessId(value: unknown): boolean {
  return value === undefined || isProcessId(value);
}

function isValidProcessMessage(message: Record<string, unknown>): boolean {
  switch (message.type) {
    case 'process_register':
      return (
        isProcessId(message.processId) &&
        (message.parentProcessId === undefined || isProcessId(message.parentProcessId)) &&
        (message.ownerProcessId === undefined || isProcessId(message.ownerProcessId)) &&
        (message.kind === 'tim' || message.kind === 'executor') &&
        typeof message.label === 'string' &&
        message.label.trim().length > 0 &&
        message.label.length <= 512 &&
        isValidOptionalPid(message.pid) &&
        isValidOptionalString(message.command) &&
        isValidOptionalString(message.startIdentity) &&
        isValidOptionalString(message.startedAt, 512) &&
        (message.state === undefined || message.state === 'starting' || message.state === 'running')
      );
    case 'process_update':
      return (
        isProcessId(message.processId) &&
        isValidOptionalProcessId(message.parentProcessId) &&
        isValidOptionalProcessId(message.ownerProcessId) &&
        (message.label === undefined ||
          (typeof message.label === 'string' &&
            message.label.trim().length > 0 &&
            message.label.length <= 512)) &&
        (message.pid === undefined ||
          message.pid === null ||
          (typeof message.pid === 'number' && Number.isInteger(message.pid) && message.pid > 0)) &&
        (message.command === undefined ||
          message.command === null ||
          typeof message.command === 'string') &&
        (message.startIdentity === undefined ||
          message.startIdentity === null ||
          typeof message.startIdentity === 'string') &&
        (message.state === undefined ||
          message.state === 'starting' ||
          message.state === 'running' ||
          message.state === 'exited' ||
          message.state === 'orphaned') &&
        Object.keys(message).some((key) => key !== 'type' && key !== 'processId')
      );
    case 'process_exit':
      return (
        isProcessId(message.processId) &&
        isValidOptionalString(message.endedAt, 512) &&
        (message.exitCode === undefined ||
          message.exitCode === null ||
          (typeof message.exitCode === 'number' && Number.isInteger(message.exitCode))) &&
        isValidOptionalString(message.signal, 128)
      );
    case 'process_remove':
      return (
        isProcessId(message.processId) &&
        (message.subtree === undefined || typeof message.subtree === 'boolean')
      );
    case 'terminate_executor_result':
      return (
        isProcessId(message.executorId) &&
        typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        message.requestId.length <= 256 &&
        isSessionProcessTerminationResult(message.result) &&
        isValidOptionalString(message.error, 4096)
      );
    default:
      return false;
  }
}

export function isValidTunnelMessage(message: unknown): message is TunnelMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case 'log':
    case 'error':
    case 'warn':
    case 'debug':
      return Array.isArray(msg.args) && msg.args.every((a: unknown) => typeof a === 'string');
    case 'stdout':
    case 'stderr':
      return (
        typeof msg.data === 'string' && (msg.origin === undefined || msg.origin === 'lifecycle')
      );
    case 'structured':
      return isValidStructuredMessagePayload(msg.message);
    case 'process_register':
    case 'process_update':
    case 'process_exit':
    case 'process_remove':
    case 'terminate_executor_result':
      return isValidProcessMessage(msg);
    default:
      return false;
  }
}

/**
 * Dispatches a parsed tunnel message to the appropriate logging function.
 * Malformed or unrecognized messages are silently dropped.
 */
function dispatchMessage(message: TunnelMessage): void {
  if (isTunnelProcessMessage(message)) {
    return;
  }

  const shouldIndent = shouldIndentForTerminalOutput();

  if (isStructuredTunnelMessage(message)) {
    sendStructured(
      shouldIndent
        ? {
            ...message.message,
            transportSource: 'tunnel',
          }
        : message.message
    );
    return;
  }

  switch (message.type) {
    case 'log':
      log(...indentArgs(message.args, shouldIndent));
      break;
    case 'error':
      error(...indentArgs(message.args, shouldIndent));
      break;
    case 'warn':
      warn(...indentArgs(message.args, shouldIndent));
      break;
    case 'debug':
      debugLog(...indentArgs(message.args, shouldIndent));
      break;
    case 'stdout':
      writeStdout(indentText(message.data, shouldIndent), { origin: message.origin });
      break;
    case 'stderr':
      writeStderr(indentText(message.data, shouldIndent), { origin: message.origin });
      break;
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
}

function shouldIndentForTerminalOutput(): boolean {
  const adapter = getLoggerAdapter();
  return (
    adapter === undefined || adapter instanceof ConsoleAdapter || adapter instanceof HeadlessAdapter
  );
}

function indentText(value: string, shouldIndent: boolean): string {
  return shouldIndent ? indentEveryLine(value) : value;
}

function indentArgs(values: string[], shouldIndent: boolean): string[] {
  if (!shouldIndent) {
    return values;
  }

  return values.map((value) => indentEveryLine(value));
}

/**
 * Handler function for prompt requests received from tunnel clients.
 * The handler should render the prompt (e.g. via inquirer) and call `respond`
 * with the result or error.
 */
export type PromptRequestHandler = (
  message: PromptRequestMessage,
  respond: (response: TunnelPromptResponseMessage) => void
) => void | Promise<void>;

/** A stable channel for one connected tunnel client. */
export interface TunnelClientChannel {
  readonly id: string;
  readonly connected: boolean;
  send: (message: ServerTunnelMessage) => boolean;
}

export type TunnelControlResult =
  | { ok: true; clientId: string }
  | {
      ok: false;
      reason:
        | 'unknown_executor'
        | 'not_executor'
        | 'stale_executor'
        | 'owner_not_registered'
        | 'owner_not_connected'
        | 'send_failed';
    };

/**
 * Options for creating a tunnel server.
 */
export interface TunnelServerOptions {
  /**
   * Optional handler for prompt_request messages from clients.
   * When provided, the server will call this handler for prompt_request messages
   * and write the response back to the originating client socket.
   * When not provided, prompt_request messages are dispatched via sendStructured()
   * but no response is sent back (the client will hang or timeout).
   */
  onPromptRequest?: PromptRequestHandler;
  /**
   * Optional callback invoked for every valid tunnel message received from clients.
   * This runs before the message is dispatched to normal logging handlers.
   */
  onMessage?: (message: TunnelMessage, client: TunnelClientChannel) => void;
  /** Receives a stable channel as soon as a client connects. */
  onClientConnect?: (client: TunnelClientChannel) => void;
  /** Receives the same channel after the client disconnects. */
  onClientDisconnect?: (client: TunnelClientChannel) => void;
  /** Receives validated process lifecycle messages after registry handling. */
  onProcessMessage?: (message: TunnelProcessMessage, client: TunnelClientChannel) => void;
  /** Optional authoritative in-memory registry for lifecycle messages and routing. */
  processRegistry?: SessionProcessRegistry;
}

/**
 * Result of createTunnelServer, providing access to the server and a close method.
 */
export interface TunnelServer {
  /** The underlying net.Server instance */
  server: net.Server;
  /** Stable channels for currently connected clients, keyed by channel ID. */
  clients: ReadonlyMap<string, TunnelClientChannel>;
  /** Broadcasts user terminal input to all connected clients */
  sendUserInput: (content: string) => void;
  /** Sends one server-to-client control message over a specific channel. */
  sendToClient: (clientId: string, message: ServerTunnelMessage) => boolean;
  /** Binds a registered tim owner to a connected client channel. */
  bindOwnerToClient: (ownerProcessId: ProcessId, clientId: string) => boolean;
  /** Routes a targeted executor termination request to its registered owner. */
  sendExecutorTermination: (executorId: ProcessId, requestId?: string) => TunnelControlResult;
  /** Alias used by callers that route more than termination controls. */
  sendExecutorControl: (executorId: ProcessId, requestId?: string) => TunnelControlResult;
  /** Closes the server and removes the socket file */
  close: () => void;
}

/**
 * Creates a Unix domain socket server that receives JSONL-encoded tunnel messages
 * from child tim processes and re-emits them through the local logging system.
 *
 * The server handles:
 * - Multiple concurrent client connections
 * - Message framing across TCP chunks (via line splitting)
 * - Malformed JSON messages (silently dropped)
 * - Bidirectional prompt request/response handling (when onPromptRequest is provided)
 * - Cleanup on process exit (via CleanupRegistry)
 *
 * @param socketPath - Path where the Unix domain socket will be created
 * @param options - Optional configuration including a prompt request handler
 * @returns A promise that resolves with a TunnelServer once the server is listening
 */
export function createTunnelServer(
  socketPath: string,
  options?: TunnelServerOptions
): Promise<TunnelServer> {
  const {
    onPromptRequest,
    onMessage,
    onClientConnect,
    onClientDisconnect,
    onProcessMessage,
    processRegistry,
  } = options ?? {};

  return new Promise<TunnelServer>((resolve, reject) => {
    // Remove any stale socket file from a previous run
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // File doesn't exist, that's fine
    }

    interface TrackedTunnelProcess {
      processId: ProcessId;
      parentProcessId?: ProcessId;
      ownerProcessId?: ProcessId;
      kind: 'tim' | 'executor';
      state: 'starting' | 'running' | 'exited' | 'orphaned';
      clientId: string;
    }

    interface TunnelClientState {
      socket: net.Socket;
      channel: TunnelClientChannel;
      connected: boolean;
      processIds: Set<ProcessId>;
    }

    const clients = new Map<string, TunnelClientChannel>();
    const clientStates = new Map<string, TunnelClientState>();
    const trackedProcesses = new Map<ProcessId, TrackedTunnelProcess>();

    const removeTrackedProcess = (processId: ProcessId): void => {
      const tracked = trackedProcesses.get(processId);
      if (!tracked) {
        return;
      }
      trackedProcesses.delete(processId);
      clientStates.get(tracked.clientId)?.processIds.delete(processId);
    };

    const removeTrackedSubtree = (processId: ProcessId): void => {
      for (const tracked of Array.from(trackedProcesses.values())) {
        if (tracked.parentProcessId === processId) {
          removeTrackedSubtree(tracked.processId);
        }
      }
      removeTrackedProcess(processId);
    };

    let disconnectClient: (clientId: string) => void = () => {};

    const createClientChannel = (socket: net.Socket): TunnelClientState => {
      const clientId = crypto.randomUUID();
      const state = {} as TunnelClientState;
      const channel: TunnelClientChannel = {
        id: clientId,
        get connected(): boolean {
          return state.connected && !socket.destroyed;
        },
        send: (message: ServerTunnelMessage): boolean => {
          if (!state.connected || socket.destroyed) {
            return false;
          }
          try {
            socket.write(`${JSON.stringify(message)}\n`);
            return true;
          } catch {
            state.connected = false;
            disconnectClient(clientId);
            return false;
          }
        },
      };
      state.socket = socket;
      state.channel = channel;
      state.connected = true;
      state.processIds = new Set<ProcessId>();
      clients.set(clientId, channel);
      clientStates.set(clientId, state);
      processRegistry?.registerOwnerChannelSender(clientId, (executorId, requestId) =>
        channel.send({
          type: 'terminate_executor',
          executorId,
          ...(requestId ? { requestId } : {}),
        })
      );
      return state;
    };

    const handleProcessMessage = (
      message: TunnelProcessMessage,
      client: TunnelClientChannel
    ): boolean => {
      switch (message.type) {
        case 'process_register': {
          const ownerProcessId = message.ownerProcessId ?? message.parentProcessId;
          const tracked = trackedProcesses.get(message.processId);
          if (
            tracked &&
            (tracked.clientId !== client.id ||
              tracked.kind !== message.kind ||
              tracked.parentProcessId !== message.parentProcessId ||
              tracked.ownerProcessId !== ownerProcessId)
          ) {
            return false;
          }

          if (message.kind === 'executor' && ownerProcessId && processRegistry) {
            const owner = processRegistry.get(ownerProcessId);
            if (
              !owner ||
              owner.kind !== 'tim' ||
              processRegistry.getOwnerChannel(ownerProcessId) !== client.id
            ) {
              return false;
            }
          }

          const node = processRegistry?.register(
            {
              processId: message.processId,
              parentProcessId: message.parentProcessId,
              kind: message.kind,
              label: message.label,
              ownerProcessId,
              pid: message.pid,
              command: message.command,
              startIdentity: message.startIdentity,
              startedAt: message.startedAt,
              state: message.state,
            },
            message.kind === 'tim' ? { ownerChannelId: client.id } : {}
          );
          if (processRegistry && !node) {
            return false;
          }

          const state = node?.state ?? message.state ?? 'running';
          trackedProcesses.set(message.processId, {
            processId: message.processId,
            parentProcessId: message.parentProcessId,
            ownerProcessId,
            kind: message.kind,
            state,
            clientId: client.id,
          });
          clientStates.get(client.id)?.processIds.add(message.processId);
          return true;
        }
        case 'process_update': {
          const tracked = trackedProcesses.get(message.processId);
          if (tracked && tracked.clientId !== client.id) {
            return false;
          }
          if (!tracked && processRegistry?.has(message.processId)) {
            return false;
          }
          if (processRegistry && !processRegistry.has(message.processId)) {
            return true;
          }
          if (!processRegistry && !tracked) {
            return true;
          }
          const node = processRegistry?.update(message.processId, {
            parentProcessId: message.parentProcessId,
            ownerProcessId: message.ownerProcessId,
            label: message.label,
            pid: message.pid,
            command: message.command,
            startIdentity: message.startIdentity,
            state: message.state,
          });
          if (processRegistry && !node) {
            return false;
          }
          if (tracked) {
            tracked.parentProcessId = message.parentProcessId ?? tracked.parentProcessId;
            tracked.ownerProcessId = message.ownerProcessId ?? tracked.ownerProcessId;
            tracked.state = message.state ?? tracked.state;
          }
          return true;
        }
        case 'process_exit': {
          const tracked = trackedProcesses.get(message.processId);
          if (tracked && tracked.clientId !== client.id) {
            return false;
          }
          if (!tracked && processRegistry?.has(message.processId)) {
            return false;
          }
          if (processRegistry && processRegistry.has(message.processId)) {
            processRegistry.exit(message.processId, {
              endedAt: message.endedAt,
              exitCode: message.exitCode,
              signal: message.signal,
            });
          }
          if (tracked) {
            tracked.state = 'exited';
          }
          // An exit event is intentionally accepted after cleanup. This makes
          // normal exit/finally races idempotent.
          return true;
        }
        case 'process_remove': {
          const tracked = trackedProcesses.get(message.processId);
          if (tracked && tracked.clientId !== client.id) {
            return false;
          }
          if (!tracked && processRegistry?.has(message.processId)) {
            return false;
          }
          if (message.subtree === false) {
            processRegistry?.remove(message.processId, false);
            removeTrackedProcess(message.processId);
          } else {
            processRegistry?.removeSubtree(message.processId);
            removeTrackedSubtree(message.processId);
          }
          // Removal is idempotent, including a late message after disconnect.
          return true;
        }
        case 'terminate_executor_result': {
          const tracked = trackedProcesses.get(message.executorId);
          if (!tracked || tracked.clientId !== client.id || tracked.kind !== 'executor') {
            return false;
          }
          processRegistry?.emitTerminationResult({
            executorId: message.executorId,
            requestId: message.requestId,
            result: message.result,
            error: message.error,
          });
          return true;
        }
      }
    };

    disconnectClient = (clientId: string): void => {
      const state = clientStates.get(clientId);
      if (!state) {
        return;
      }
      state.connected = false;
      clients.delete(clientId);
      clientStates.delete(clientId);
      processRegistry?.unregisterOwnerChannelSender(clientId);
      const processIds = [...state.processIds];
      if (processRegistry) {
        const removed = processRegistry.releaseChannel(clientId, 'remove');
        for (const processId of removed) {
          removeTrackedSubtree(processId);
          removeTrackedProcess(processId);
        }
      }
      for (const processId of processIds) {
        removeTrackedSubtree(processId);
        removeTrackedProcess(processId);
      }
      try {
        onClientDisconnect?.(state.channel);
      } catch {
        // Disconnect observers must not affect other clients.
      }
    };

    const sendToClient = (clientId: string, message: ServerTunnelMessage): boolean => {
      return clients.get(clientId)?.send(message) ?? false;
    };

    const bindOwnerToClient = (ownerProcessId: ProcessId, clientId: string): boolean => {
      const client = clients.get(clientId);
      if (!client) {
        return false;
      }
      if (processRegistry) {
        if (!processRegistry.bindOwnerToChannel(ownerProcessId, clientId)) {
          return false;
        }
      } else {
        const owner = trackedProcesses.get(ownerProcessId);
        if (!owner || owner.kind !== 'tim' || owner.clientId !== clientId) {
          return false;
        }
      }
      clientStates.get(clientId)?.processIds.add(ownerProcessId);
      return true;
    };

    const sendExecutorTermination = (
      executorId: ProcessId,
      requestId?: string
    ): TunnelControlResult => {
      if (!isProcessId(executorId)) {
        return { ok: false, reason: 'unknown_executor' };
      }

      let ownerProcessId: ProcessId | undefined;
      let channelId: string | undefined;
      if (processRegistry) {
        const executor = processRegistry.get(executorId);
        if (!executor) {
          return { ok: false, reason: 'unknown_executor' };
        }
        if (executor.kind !== 'executor') {
          return { ok: false, reason: 'not_executor' };
        }
        if (executor.state === 'exited' || executor.state === 'orphaned') {
          return { ok: false, reason: 'stale_executor' };
        }
        ownerProcessId = executor.ownerProcessId;
        if (!ownerProcessId) {
          return { ok: false, reason: 'owner_not_registered' };
        }
        const owner = processRegistry.get(ownerProcessId);
        if (!owner || owner.kind !== 'tim') {
          return { ok: false, reason: 'owner_not_registered' };
        }
        if (owner.state === 'exited' || owner.state === 'orphaned') {
          return { ok: false, reason: 'stale_executor' };
        }
        channelId = processRegistry.getExecutorOwnerChannel(executorId);
        if (!channelId) {
          return { ok: false, reason: 'owner_not_connected' };
        }
      } else {
        const executor = trackedProcesses.get(executorId);
        if (!executor) {
          return { ok: false, reason: 'unknown_executor' };
        }
        if (executor.kind !== 'executor') {
          return { ok: false, reason: 'not_executor' };
        }
        if (executor.state === 'exited' || executor.state === 'orphaned') {
          return { ok: false, reason: 'stale_executor' };
        }
        ownerProcessId = executor.ownerProcessId;
        if (!ownerProcessId) {
          return { ok: false, reason: 'owner_not_registered' };
        }
        const owner = trackedProcesses.get(ownerProcessId);
        if (!owner || owner.kind !== 'tim') {
          return { ok: false, reason: 'owner_not_registered' };
        }
        if (owner.state === 'exited' || owner.state === 'orphaned') {
          return { ok: false, reason: 'stale_executor' };
        }
        channelId = owner.clientId;
      }

      const client = channelId ? clients.get(channelId) : undefined;
      if (!client || !client.connected) {
        return { ok: false, reason: 'owner_not_connected' };
      }
      const sent = client.send({
        type: 'terminate_executor',
        executorId,
        requestId,
      });
      return sent ? { ok: true, clientId: channelId! } : { ok: false, reason: 'send_failed' };
    };

    const sendExecutorControl = sendExecutorTermination;

    const sendUserInput = (content: string): void => {
      const message: TunnelUserInputMessage = { type: 'user_input', content };
      for (const client of clients.values()) {
        client.send(message);
      }
    };

    const server = net.createServer((socket) => {
      const state = createClientChannel(socket);
      const { channel } = state;
      const splitLines = createLineSplitter();

      try {
        onClientConnect?.(channel);
      } catch {
        // A connect observer must not prevent protocol handling.
      }

      /** Writes a prompt response back to this stable client channel. */
      const writeResponse = (response: TunnelPromptResponseMessage): void => {
        channel.send(response);
      };

      socket.on('data', (data) => {
        const lines = splitLines(data.toString());
        for (const line of lines) {
          if (!line) {
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Malformed JSON - silently drop
            continue;
          }

          if (!isValidTunnelMessage(parsed)) {
            // Invalid structure - silently drop
            continue;
          }

          if (onMessage) {
            try {
              onMessage(parsed, channel);
            } catch {
              // Ignore callback errors to avoid affecting tunnel behavior
            }
          }

          if (isTunnelProcessMessage(parsed)) {
            if (handleProcessMessage(parsed, channel)) {
              try {
                onProcessMessage?.(parsed, channel);
              } catch {
                // Process observers must not affect protocol handling.
              }
            }
            continue;
          }

          // Check if this is a prompt_request that needs special handling
          if (
            isStructuredTunnelMessage(parsed) &&
            parsed.message.type === 'prompt_request' &&
            onPromptRequest
          ) {
            const promptMessage = parsed.message;
            // Still dispatch for logging/visibility
            sendStructured(promptMessage);
            const { requestId } = promptMessage;
            // Call the prompt handler with a respond function bound to this socket.
            // Handle both sync throws and async rejections so that handler errors
            // send an error response back to the client instead of leaving it hanging.
            try {
              const result = onPromptRequest(promptMessage, writeResponse);
              if (result && typeof result.catch === 'function') {
                result.catch((err: unknown) => {
                  writeResponse({
                    type: 'prompt_response',
                    requestId,
                    error: `Prompt handler error: ${err instanceof Error ? err.message : String(err)}`,
                  });
                });
              }
            } catch (err) {
              writeResponse({
                type: 'prompt_response',
                requestId,
                error: `Prompt handler error: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          } else {
            dispatchMessage(parsed);
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected or errored; close performs the cleanup.
      });
      socket.on('close', () => {
        disconnectClient(channel.id);
      });
    });

    // Register cleanup to ensure socket is removed on process exit.
    // The unregister variable is assigned after the close function is defined,
    // but always before close can be called (since close is only callable after
    // the server is listening or on error).
    let unregister: (() => void) | undefined;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      unregister?.();
      for (const state of Array.from(clientStates.values())) {
        state.socket.destroy();
        disconnectClient(state.channel.id);
      }
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Socket file already removed
      }
    };

    unregister = CleanupRegistry.getInstance().register(close);

    let listening = false;

    server.on('error', (err) => {
      if (!listening) {
        // Pre-listen error: the server never started, so reject the promise
        // and clean up the registry entry.
        unregister();
        reject(err);
      } else {
        // Post-listen error: log but don't remove cleanup handler since the
        // server may still need cleanup on process exit.
        error('Tunnel server error:', `${err}`);
      }
    });

    server.listen(socketPath, () => {
      listening = true;
      resolve({
        server,
        clients,
        sendUserInput,
        sendToClient,
        bindOwnerToClient,
        sendExecutorTermination,
        sendExecutorControl,
        close,
      });
    });
  });
}
