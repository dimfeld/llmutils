import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TimConfig } from '../../configSchema.js';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import {
  normalizeSubprocessMonitorRules,
  startSubprocessMonitor,
  type SubprocessMonitorHandle,
} from '../../../common/subprocess_monitor.js';
import {
  getCurrentSessionProcessOwner,
  type SessionLogicalExecutorLifecycle,
  type SessionProcessOwner,
} from '../../../common/session_process_control.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import { debugLog, sendStructured } from '../../../logging';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createExecutorTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import type {
  AgentIdentity,
  AgentInputAdapter,
  AgentInputActivity,
  AgentInputDelivery,
  AgentInputMessage,
  AgentProviderControlResult,
  AgentProviderExitClassification,
  AgentProviderLifecycleControls,
  AgentProviderLifecycleObserver,
  ProcessControlId,
  ProviderThreadId,
} from '../../agent_messaging/agent_manager_types.js';
import type { AgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import {
  validateCodexAgentToolProvider,
  validateCodexDynamicToolCaller,
  type CodexAgentToolContext,
} from './codex_agent_tools.js';
import { CodexAppServerConnection, type ThreadStartParams } from './app_server_connection.js';
import {
  CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';
import { createApprovalHandler } from './app_server_approval.js';
import { createAppServerFormatter } from './app_server_format.js';
import { createAppServerRequestHandler, startInitialThread } from './app_server_runner.js';
import { isCodexAppServerEnabled } from './app_server_mode.js';
import type { CodexReasoningLevel } from '../schemas.js';
import {
  CODEX_PERSISTENT_AGENT_MODE,
  type CodexPersistentAgentCompletion,
  type CodexPersistentAgentLaunchHandle,
  type CodexPersistentAgentLifecycleCallbacks,
  type CodexPersistentAgentState,
  validateCodexPersistentAgentLifecycleCallbacks,
} from './persistent_agent_contract.js';

export interface CodexPersistentAgentLaunchOptions {
  readonly mode: typeof CODEX_PERSISTENT_AGENT_MODE;
  readonly identity: AgentIdentity;
  readonly prompt: string;
  readonly cwd: string;
  readonly timConfig: TimConfig;
  readonly model?: string;
  readonly reasoningLevel?: CodexReasoningLevel;
  readonly timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
  readonly dynamicToolProvider: CodexDynamicToolProvider<CodexAgentToolContext>;
  readonly processLabel: AgentProcessLabel;
  readonly lifecycleCallbacks: CodexPersistentAgentLifecycleCallbacks;
  readonly outputSchema?: Record<string, unknown>;
  readonly outputSchemaPath?: string;
  readonly terminalInput?: boolean;
  /** Test seam; production callers use the ambient session process owner. */
  readonly sessionProcessOwner?: Pick<SessionProcessOwner, 'prepareLogicalExecutor'>;
}

/**
 * Validate every static persistent-agent requirement before allocating any
 * tunnel, temporary directory, lifecycle node, or provider process.
 */
export function validateCodexPersistentAgentLaunchOptions(
  options: unknown
): asserts options is CodexPersistentAgentLaunchOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Codex persistent-agent launch options must be an object');
  }

  const value = options as Record<string, unknown>;
  if (value.mode !== CODEX_PERSISTENT_AGENT_MODE) {
    throw new TypeError('Codex persistent-agent mode must be persistent-agent');
  }
  if (typeof value.prompt !== 'string') {
    throw new TypeError('Codex persistent-agent prompt must be a string');
  }
  if (typeof value.cwd !== 'string' || value.cwd.trim().length === 0) {
    throw new TypeError('Codex persistent-agent cwd must be a non-empty string');
  }
  if (typeof value.timConfig !== 'object' || value.timConfig === null) {
    throw new TypeError('Codex persistent-agent timConfig must be an object');
  }
  if (value.identity === undefined) {
    throw new TypeError('Codex persistent-agent identity is required');
  }
  validateCodexDynamicToolCaller(value.identity);
  const identity = value.identity as AgentIdentity;
  if (identity.role !== 'subagent') {
    throw new TypeError('Codex persistent-agent identity must be a subagent');
  }
  if (typeof value.processLabel !== 'string' || value.processLabel.trim().length === 0) {
    throw new TypeError('Codex persistent-agent process label must be a non-empty string');
  }
  const expectedProcessLabel = formatAgentProcessLabel('codex-cli', identity.name);
  if (value.processLabel !== expectedProcessLabel) {
    throw new TypeError(`Codex persistent-agent process label must be ${expectedProcessLabel}`);
  }
  if (value.outputSchema !== undefined || value.outputSchemaPath !== undefined) {
    throw new TypeError('Codex persistent agents do not support output schemas');
  }
  if (value.appServerMode !== undefined) {
    throw new TypeError('Codex persistent agents select app-server mode themselves');
  }
  if (value.inactivityTimeoutMs !== undefined) {
    throw new TypeError('Codex persistent agents do not accept one-shot inactivity timeouts');
  }
  if (value.terminalInput === true) {
    throw new TypeError('Codex persistent agents do not support terminal input');
  }
  if (value.dynamicToolProvider === undefined) {
    throw new TypeError('Codex persistent-agent dynamic tool provider is required');
  }
  validateCodexAgentToolProvider(
    value.dynamicToolProvider as CodexDynamicToolProvider<CodexAgentToolContext>
  );
  assertProviderIdentity(
    value.dynamicToolProvider as CodexDynamicToolProvider<CodexAgentToolContext>,
    identity
  );
  validateCodexPersistentAgentLifecycleCallbacks(value.lifecycleCallbacks);
  if (!isCodexAppServerEnabled()) {
    throw new Error(CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE);
  }
}

/** Start one private, named Codex app-server session and its first turn. */
export async function startPersistentCodexAgent(
  options: CodexPersistentAgentLaunchOptions
): Promise<CodexPersistentAgentLaunchHandle> {
  validateCodexPersistentAgentLaunchOptions(options);

  const monitorRules = options.timConfig.subprocessMonitor?.rules;
  if (monitorRules?.length) {
    normalizeSubprocessMonitorRules(monitorRules);
  }

  const session = new PersistentCodexSession(options);
  try {
    return await session.start();
  } catch (error) {
    await session.close('failed', toError(error));
    throw error;
  }
}

class PersistentCodexInputAdapter implements AgentInputAdapter {
  private readyState = false;
  private currentActivity: AgentInputActivity = 'not-ready';
  private readonly availabilityListeners = new Set<() => void>();
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: unknown) => void) | undefined;

  public constructor(private readonly onRelease: () => Promise<void>) {}

  public get ready(): Promise<void> {
    return this.readyPromise;
  }

  public get isReady(): boolean {
    return this.readyState;
  }

  public get activity(): AgentInputActivity {
    return this.currentActivity;
  }

  public readonly readyPromise = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });

  public markReady(): void {
    if (this.readyState) return;
    this.readyState = true;
    this.currentActivity = 'active';
    this.resolveReady?.();
    this.notifyAvailabilityChange();
  }

  public failReady(error: unknown): void {
    this.rejectReady?.(error);
  }

  public markIdle(): void {
    if (!this.readyState) return;
    this.currentActivity = 'idle';
    this.notifyAvailabilityChange();
  }

  public markNotReady(): void {
    this.readyState = false;
    this.currentActivity = 'not-ready';
    this.notifyAvailabilityChange();
  }

  public deliver(_message: AgentInputMessage): AgentInputDelivery {
    return 'temporarily-unavailable';
  }

  public onAvailabilityChange(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return (): void => {
      this.availabilityListeners.delete(listener);
    };
  }

  public async release(): Promise<void> {
    await this.onRelease();
  }

  private notifyAvailabilityChange(): void {
    for (const listener of this.availabilityListeners) {
      listener();
    }
  }
}

class PersistentCodexSession {
  private readonly completionDeferred = createDeferred<CodexPersistentAgentCompletion>();
  private readonly input: PersistentCodexInputAdapter;
  private readonly observers = new Set<AgentProviderLifecycleObserver>();
  private state: CodexPersistentAgentState = 'starting';
  private connection: CodexAppServerConnection | undefined;
  private logicalExecutorLifecycle: SessionLogicalExecutorLifecycle | undefined;
  private monitorHandle: SubprocessMonitorHandle | undefined;
  private tunnelServer: TunnelServer | undefined;
  private tunnelTempDir: string | undefined;
  private tunnelSocketPath: string | undefined;
  private currentTurnId: string | undefined;
  private threadId: string | undefined;
  private lastCompletedAssistantMessage: string | undefined;
  private closeAfterCurrentTurn = false;
  private closePromise: Promise<void> | undefined;
  private exitNotified = false;
  private cleaned = false;

  public constructor(private readonly options: CodexPersistentAgentLaunchOptions) {
    this.input = new PersistentCodexInputAdapter(() => this.close('forced'));
    this.observers.add(options.lifecycleCallbacks);
  }

  public async start(): Promise<CodexPersistentAgentLaunchHandle> {
    const allowAllTools = ['true', '1'].includes(process.env.ALLOW_ALL_TOOLS || '');
    const writableRoots = [this.options.cwd];
    if (
      this.options.timConfig.isUsingExternalStorage &&
      this.options.timConfig.externalRepositoryConfigDir &&
      !writableRoots.includes(this.options.timConfig.externalRepositoryConfigDir)
    ) {
      writableRoots.push(this.options.timConfig.externalRepositoryConfigDir);
    }

    const approvalPolicy = allowAllTools ? 'never' : undefined;
    const sandbox = allowAllTools ? 'danger-full-access' : 'workspace-write';
    const approvalHandler = createApprovalHandler({
      sandboxAllowsFileWrites: !allowAllTools,
      writableRoots,
    });

    await this.createOutputTunnel();

    const tunnelEnv: Record<string, string> =
      this.tunnelServer && this.tunnelSocketPath
        ? { [TIM_OUTPUT_SOCKET]: this.tunnelSocketPath }
        : {};

    this.connection = await CodexAppServerConnection.create({
      cwd: this.options.cwd,
      privateOwner: true,
      experimentalApi: true,
      sessionProcessLabel: `Codex app-server (${this.options.identity.name})`,
      onGracefulEnd: () => {
        void this.close('graceful');
      },
      env: {
        TIM_EXECUTOR: 'codex',
        AGENT: process.env.AGENT || '1',
        TIM_NOTIFY_SUPPRESS: '1',
        ...tunnelEnv,
      },
      timEnvironment: this.options.timEnvironment,
      onExit: ({ exitCode, signal }) => {
        void this.close(
          'failed',
          new Error(
            `Codex app-server exited unexpectedly with code ${exitCode}${signal ? ` (signal ${signal})` : ''}.`
          )
        );
      },
      onNotification: (method, params) => {
        this.handleNotification(method, params);
      },
      onServerRequest: createAppServerRequestHandler(
        this.options.dynamicToolProvider,
        approvalHandler
      ),
    });

    const connection = this.connection;
    connection.setGracefulEndHandler(() => {
      void this.close('graceful');
    });

    if (this.options.timConfig.subprocessMonitor?.rules?.length && connection.pid !== undefined) {
      this.monitorHandle = startSubprocessMonitor({
        rootPid: connection.pid,
        rules: this.options.timConfig.subprocessMonitor.rules,
        pollIntervalSeconds: this.options.timConfig.subprocessMonitor.pollIntervalSeconds,
        logger: { warn: (...args: unknown[]) => debugLog(...args) },
      });
    }

    const threadResult = await startInitialThread(
      connection,
      this.buildThreadStartParams(approvalPolicy, sandbox),
      this.options.dynamicToolProvider
    );
    connection.updateMetadata({ threadId: threadResult.threadId });
    this.threadId = threadResult.threadId;
    this.registerLogicalThread(threadResult.threadId);

    this.state = 'running-active-starting';
    const turnResult = await connection.turnStart({
      threadId: threadResult.threadId,
      input: [{ type: 'text', text: this.options.prompt }],
      model: this.options.model,
      effort: this.options.reasoningLevel ?? 'medium',
    });
    this.currentTurnId = turnResult.turnId;
    this.state = 'running-active';
    this.input.markReady();

    return this.createHandle();
  }

  public async close(
    classification: AgentProviderExitClassification = 'natural',
    error?: Error
  ): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.state = classification === 'forced' ? 'stopping-forced' : 'terminal';
    this.input.markNotReady();
    this.closePromise = this.finishClose(classification, error);
    return this.closePromise;
  }

  private async finishClose(
    classification: AgentProviderExitClassification,
    error?: Error
  ): Promise<void> {
    this.monitorHandle?.stop();
    this.monitorHandle = undefined;

    const connection = this.connection;
    await connection?.close();
    connection?.setGracefulEndHandler(undefined);
    this.connection = undefined;

    // Keep both End callbacks installed until the provider close has joined
    // the shared close promise. A second process-tree End request that races
    // cleanup must converge on this operation instead of seeing a half-cleaned
    // logical thread and returning a misleading unsupported-control result.
    this.logicalExecutorLifecycle?.setGracefulEndHandler(undefined);
    this.logicalExecutorLifecycle?.markExited(error === undefined ? {} : { exitCode: 1 });
    this.logicalExecutorLifecycle = undefined;

    this.tunnelServer?.close();
    this.tunnelServer = undefined;
    if (this.tunnelTempDir !== undefined) {
      await fs.rm(this.tunnelTempDir, { recursive: true, force: true }).catch(() => {});
      this.tunnelTempDir = undefined;
    }
    this.cleaned = true;
    this.state = 'terminal';

    if (!this.exitNotified) {
      this.exitNotified = true;
      this.notifyObservers((observer) => observer.exit(classification, error));
    }
    this.completionDeferred.resolve({
      ...(error === undefined ? {} : { error }),
      ...(this.lastCompletedAssistantMessage === undefined
        ? {}
        : {
            lastCompletedAssistantMessage: this.lastCompletedAssistantMessage,
            finalMessage: this.lastCompletedAssistantMessage,
          }),
    });
    this.observers.clear();
  }

  private async createOutputTunnel(): Promise<void> {
    if (isTunnelActive()) return;

    this.tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-'));
    this.tunnelSocketPath = path.join(this.tunnelTempDir, 'output.sock');
    try {
      const promptHandler = createPromptRequestHandler();
      this.tunnelServer = await createExecutorTunnelServer(this.tunnelSocketPath, {
        onPromptRequest: promptHandler,
      });
    } catch (error) {
      debugLog('Could not create persistent Codex output tunnel:', error);
    }
  }

  private buildThreadStartParams(
    approvalPolicy: string | undefined,
    sandbox: 'workspace-write' | 'danger-full-access'
  ): ThreadStartParams {
    return {
      cwd: this.options.cwd,
      approvalPolicy,
      sandbox,
      model: this.options.model,
      dynamicTools: this.options.dynamicToolProvider.definitions,
    };
  }

  private registerLogicalThread(threadId: string): void {
    const owner = this.options.sessionProcessOwner ?? getCurrentSessionProcessOwner();
    if (owner === undefined) {
      throw new Error('Persistent Codex agents require an active session process owner');
    }

    const lifecycle = owner.prepareLogicalExecutor({
      label: `Codex thread (${this.options.identity.name})`,
      command: `codex thread ${threadId}`,
      threadId,
    });
    if (lifecycle === undefined) {
      throw new Error('Could not register the persistent Codex logical thread');
    }
    lifecycle.setGracefulEndHandler(() => {
      void this.close('graceful');
    });
    lifecycle.markStarted();
    this.logicalExecutorLifecycle = lifecycle;
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.cleaned) return;
    const formatter = this.formatter;
    const message = formatter.handleNotification(method, params);
    sendFormattedStructured(message.structured);

    this.notifyObservers((observer) => observer.outputActivity());
    if (message.agentMessage !== undefined && message.agentMessage.trim().length > 0) {
      this.lastCompletedAssistantMessage = message.agentMessage;
      this.notifyObservers((observer) => observer.completedAssistantMessage(message.agentMessage!));
    }

    if (method === 'turn/started') {
      const turnId = extractTurnId(params);
      if (turnId !== undefined) this.currentTurnId = turnId;
      this.state = 'running-active';
      return;
    }

    if (method !== 'turn/completed') return;
    this.currentTurnId = undefined;
    this.notifyObservers((observer) => observer.turnComplete());
    if (this.closeAfterCurrentTurn) {
      void this.close('graceful');
    } else {
      this.state = 'running-idle';
      this.input.markIdle();
    }
  }

  private get formatter(): ReturnType<typeof createAppServerFormatter> {
    if (this.formatterInstance === undefined) {
      this.formatterInstance = createAppServerFormatter(this.options.model);
    }
    return this.formatterInstance;
  }

  private formatterInstance: ReturnType<typeof createAppServerFormatter> | undefined;

  private createHandle(): CodexPersistentAgentLaunchHandle {
    const lifecycle: AgentProviderLifecycleControls = {
      requestGracefulShutdown: (instruction: string): Promise<AgentProviderControlResult> =>
        this.requestGracefulShutdown(instruction),
      requestCloseAfterCurrentTurn: (): Promise<AgentProviderControlResult> =>
        this.requestCloseAfterCurrentTurn(),
      requestForcedShutdown: (): Promise<AgentProviderControlResult> =>
        this.requestForcedShutdown(),
      subscribe: (observer: AgentProviderLifecycleObserver): (() => void) => {
        this.observers.add(observer);
        return (): void => {
          this.observers.delete(observer);
        };
      },
    };

    const getProviderState = (): CodexPersistentAgentState => this.state;
    return {
      mode: CODEX_PERSISTENT_AGENT_MODE,
      executor: 'codex-cli',
      processLabel: this.options.processLabel,
      get providerState(): CodexPersistentAgentState {
        return getProviderState();
      },
      input: this.input,
      ready: this.input.ready,
      completion: this.completionDeferred.promise,
      lifecycle,
      ...(this.connection?.processControlId === undefined
        ? {}
        : { processControlId: this.connection.processControlId as unknown as ProcessControlId }),
      ...(this.logicalExecutorLifecycle === undefined
        ? {}
        : { providerThreadId: this.threadId as unknown as ProviderThreadId }),
      release: async (): Promise<void> => {
        await this.close('forced');
      },
    };
  }

  private requestCloseAfterCurrentTurn(): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal') return Promise.resolve('already-exited');
    this.closeAfterCurrentTurn = true;
    if (this.currentTurnId === undefined) {
      return this.close('graceful').then(() => 'accepted');
    }
    this.state = 'finishing';
    return Promise.resolve('accepted');
  }

  private requestGracefulShutdown(_instruction: string): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal') return Promise.resolve('already-exited');
    return this.requestCloseAfterCurrentTurn();
  }

  private requestForcedShutdown(): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal') return Promise.resolve('already-exited');
    return this.close('forced').then(() => 'accepted');
  }

  private notifyObservers(callback: (observer: AgentProviderLifecycleObserver) => void): void {
    for (const observer of this.observers) {
      try {
        callback(observer);
      } catch (error) {
        debugLog('Persistent Codex lifecycle callback failed:', error);
      }
    }
  }
}

function assertProviderIdentity(
  provider: CodexDynamicToolProvider<CodexAgentToolContext>,
  identity: AgentIdentity
): void {
  const caller = provider.context.caller;
  if (
    caller.id !== identity.id ||
    caller.name !== identity.name ||
    caller.role !== identity.role ||
    caller.executor !== identity.executor ||
    caller.role !== 'subagent' ||
    identity.role !== 'subagent' ||
    caller.type !== identity.type
  ) {
    throw new TypeError(
      'Codex dynamic tool provider is not bound to the persistent agent identity'
    );
  }
}

function extractTurnId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const payload = params as Record<string, unknown>;
  const turn = payload.turn;
  if (turn && typeof turn === 'object' && !Array.isArray(turn)) {
    const nestedId = (turn as Record<string, unknown>).id;
    if (typeof nestedId === 'string' && nestedId.length > 0) return nestedId;
  }
  return typeof payload.turnId === 'string' && payload.turnId.length > 0
    ? payload.turnId
    : undefined;
}

function sendFormattedStructured(
  structured: StructuredMessage | StructuredMessage[] | undefined
): void {
  if (structured === undefined) return;
  if (Array.isArray(structured)) {
    for (const message of structured) sendStructured(message);
    return;
  }
  sendStructured(structured);
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
    reject: (error: unknown): void => rejectPromise?.(error),
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
