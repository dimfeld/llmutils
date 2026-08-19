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
  return session.start();
}

class PersistentCodexInputAdapter implements AgentInputAdapter {
  private readyState = false;
  private currentActivity: AgentInputActivity = 'not-ready';
  private readonly availabilityListeners = new Set<() => void>();
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: unknown) => void) | undefined;

  public constructor(
    private readonly onDeliver: (
      message: AgentInputMessage
    ) => AgentInputDelivery | Promise<AgentInputDelivery>,
    private readonly onRelease: () => Promise<void>
  ) {}

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

  public markActive(): void {
    if (!this.readyState) return;
    this.currentActivity = 'active';
    this.notifyAvailabilityChange();
  }

  public markTemporarilyUnavailable(): void {
    if (!this.readyState) return;
    this.currentActivity = 'temporarily-unavailable';
    this.notifyAvailabilityChange();
  }

  public markNotReady(): void {
    this.readyState = false;
    this.currentActivity = 'not-ready';
    this.notifyAvailabilityChange();
  }

  public deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery> {
    return this.onDeliver(message);
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

interface PersistentCodexTurn {
  readonly generation: number;
  turnId?: string;
  settled: boolean;
  assistantMessage?: string;
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
  private currentTurn: PersistentCodexTurn | undefined;
  private nextTurnGeneration = 0;
  private threadId: string | undefined;
  private ownedProcessControlId: ProcessControlId | undefined;
  private lastCompletedAssistantMessage: string | undefined;
  private closeAfterCurrentTurn = false;
  private closePromise: Promise<void> | undefined;
  private exitNotified = false;
  private cleaned = false;
  private deliveryInFlight = false;

  public constructor(private readonly options: CodexPersistentAgentLaunchOptions) {
    this.input = new PersistentCodexInputAdapter(
      (message) => this.deliver(message),
      () => this.close('forced')
    );
    this.observers.add(options.lifecycleCallbacks);
  }

  /**
   * Return the provider handle at the manager launch boundary.
   *
   * Provider setup continues in the background. The manager binds the handle
   * and mailbox before `ready` settles, so input received during startup stays
   * in the manager-owned FIFO rather than being lost or handled by a second
   * provider queue.
   */
  public start(): CodexPersistentAgentLaunchHandle {
    const handle = this.createHandle();
    void this.initialize().catch((error: unknown) => {
      debugLog('Persistent Codex startup failed:', error);
    });
    return handle;
  }

  private async initialize(): Promise<void> {
    try {
      await this.initializeProvider();
    } catch (error) {
      const startupError = toError(error);
      this.input.failReady(startupError);
      try {
        await this.close('failed', startupError);
      } catch (cleanupError) {
        debugLog('Persistent Codex startup cleanup failed:', cleanupError);
      }
    }
  }

  private async initializeProvider(): Promise<void> {
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

    const connection = await CodexAppServerConnection.create({
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

    if (this.isClosing()) {
      await connection.close().catch((error: unknown) => {
        debugLog('Persistent Codex late connection cleanup failed:', error);
      });
      return;
    }
    this.connection = connection;
    this.ownedProcessControlId = connection.processControlId as ProcessControlId | undefined;
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
    this.throwIfClosing();
    connection.updateMetadata({ threadId: threadResult.threadId });
    this.threadId = threadResult.threadId;
    this.registerLogicalThread(threadResult.threadId);

    const initialTurn = this.beginTurn();
    await this.startTurn(initialTurn, this.options.prompt);
    this.throwIfClosing();
    this.input.markReady();
    this.syncInputActivity();
  }

  public async close(
    classification: AgentProviderExitClassification = 'natural',
    error?: Error
  ): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.state = classification === 'forced' ? 'stopping-forced' : 'terminal';
    if (!this.input.isReady) {
      this.input.failReady(
        error ?? new Error(`Persistent Codex provider closed before startup completed.`)
      );
    }
    this.input.markNotReady();
    this.closePromise = this.finishClose(classification, error);
    return this.closePromise;
  }

  private async finishClose(
    classification: AgentProviderExitClassification,
    error?: Error
  ): Promise<void> {
    let cleanupError: Error | undefined;

    try {
      this.monitorHandle?.stop();
    } catch (error) {
      cleanupError = toError(error);
      debugLog('Persistent Codex monitor cleanup failed:', cleanupError);
    }
    this.monitorHandle = undefined;

    const connection = this.connection;
    try {
      connection?.setGracefulEndHandler(undefined);
      await connection?.close();
    } catch (error) {
      cleanupError ??= toError(error);
      debugLog('Persistent Codex connection cleanup failed:', error);
    }
    this.connection = undefined;

    // Keep both End callbacks installed until the provider close has joined
    // the shared close promise. A second process-tree End request that races
    // cleanup must converge on this operation instead of seeing a half-cleaned
    // logical thread and returning a misleading unsupported-control result.
    try {
      this.logicalExecutorLifecycle?.setGracefulEndHandler(undefined);
      this.logicalExecutorLifecycle?.markExited(error === undefined ? {} : { exitCode: 1 });
    } catch (lifecycleError) {
      cleanupError ??= toError(lifecycleError);
      debugLog('Persistent Codex logical-thread cleanup failed:', lifecycleError);
    }
    this.logicalExecutorLifecycle = undefined;

    try {
      this.tunnelServer?.close();
    } catch (tunnelError) {
      cleanupError ??= toError(tunnelError);
      debugLog('Persistent Codex tunnel cleanup failed:', tunnelError);
    }
    this.tunnelServer = undefined;
    if (this.tunnelTempDir !== undefined) {
      await fs.rm(this.tunnelTempDir, { recursive: true, force: true }).catch(() => {});
      this.tunnelTempDir = undefined;
    }
    this.cleaned = true;
    this.state = 'terminal';

    const completionError = error ?? cleanupError;
    const exitClassification = cleanupError === undefined ? classification : 'failed';

    if (!this.exitNotified) {
      this.exitNotified = true;
      this.notifyObservers((observer) => observer.exit(exitClassification, completionError));
    }
    this.completionDeferred.resolve({
      ...(completionError === undefined ? {} : { error: completionError }),
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
    if (this.cleaned || this.closePromise !== undefined) return;
    if (!this.isOwnedThreadNotification(method, params)) return;

    const formatter = this.formatter;
    const message = formatter.handleNotification(method, params);
    sendFormattedStructured(message.structured);

    if (this.isProviderActivity(method, params)) {
      this.notifyObservers((observer) => observer.outputActivity());
    }

    const turn = this.currentTurn;
    const notificationTurnId = extractTurnId(params);
    const belongsToCurrentTurn =
      turn !== undefined &&
      (notificationTurnId === undefined ||
        turn.turnId === undefined ||
        notificationTurnId === turn.turnId);
    if (
      belongsToCurrentTurn &&
      turn !== undefined &&
      !turn.settled &&
      message.agentMessage !== undefined
    ) {
      turn.assistantMessage = message.agentMessage;
    }

    if (method === 'turn/started') {
      const turnId = extractTurnId(params);
      if (turn !== undefined && !turn.settled) {
        if (turnId !== undefined) {
          if (turn.turnId !== undefined && turn.turnId !== turnId) {
            void this.failProvider(
              new Error(`Codex reported conflicting turn IDs for generation ${turn.generation}.`)
            );
            return;
          }
          turn.turnId = turnId;
        }
        this.setState('running-active');
      }
      return;
    }

    if (
      method === 'turn/completed' ||
      (method === 'thread/status/changed' && extractThreadStatusType(params) === 'idle')
    ) {
      this.completeTurn(params);
    }
  }

  private deliver(message: AgentInputMessage): Promise<AgentInputDelivery> {
    if (this.deliveryInFlight) return Promise.resolve('temporarily-unavailable');
    this.deliveryInFlight = true;

    const delivery = (async (): Promise<AgentInputDelivery> => {
      if (!this.input.isReady || this.isClosing() || !this.connection?.isAlive) {
        return 'temporarily-unavailable';
      }
      if (
        this.state === 'starting' ||
        this.state === 'running-active-starting' ||
        this.state === 'finishing' ||
        this.state === 'stopping-gracefully' ||
        this.state === 'stopping-forced' ||
        this.state === 'terminal'
      ) {
        return 'temporarily-unavailable';
      }

      if (this.state === 'running-active') {
        const turn = this.currentTurn;
        const turnId = turn?.turnId;
        const threadId = this.threadId;
        if (turn === undefined || turn.settled || turnId === undefined || threadId === undefined) {
          return 'temporarily-unavailable';
        }

        this.input.markTemporarilyUnavailable();
        try {
          await this.connection.turnSteer({
            threadId,
            input: [{ type: 'text', text: message.content }],
            expectedTurnId: turnId,
          });
          if (this.isClosing() || !this.connection?.isAlive) {
            return 'temporarily-unavailable';
          }
          return 'steered';
        } catch (error) {
          if (!this.connection?.isAlive) {
            await this.failProvider(toError(error));
            throw error;
          }
          return 'temporarily-unavailable';
        } finally {
          this.syncInputActivity();
        }
      }

      if (this.state === 'running-idle') {
        const turn = this.beginTurn();
        try {
          await this.startTurn(turn, message.content);
          if (this.isClosing() || !this.connection?.isAlive) {
            return 'temporarily-unavailable';
          }
          return 'started-idle-turn';
        } finally {
          this.syncInputActivity();
        }
      }

      return 'temporarily-unavailable';
    })();

    return delivery.finally(() => {
      this.deliveryInFlight = false;
      this.syncInputActivity();
    });
  }

  private beginTurn(): PersistentCodexTurn {
    if (this.currentTurn !== undefined && !this.currentTurn.settled) {
      throw new Error('Codex persistent session already has an active turn');
    }
    const turn: PersistentCodexTurn = {
      generation: ++this.nextTurnGeneration,
      settled: false,
    };
    this.currentTurn = turn;
    this.setState('running-active-starting');
    return turn;
  }

  private async startTurn(turn: PersistentCodexTurn, content: string): Promise<void> {
    const connection = this.connection;
    const threadId = this.threadId;
    if (connection === undefined || threadId === undefined) {
      throw new Error('Codex persistent session is not ready to start a turn');
    }

    try {
      const turnResult = await connection.turnStart({
        threadId,
        input: [{ type: 'text', text: content }],
        model: this.options.model,
        effort: this.options.reasoningLevel ?? 'medium',
      });
      if (turn.turnId !== undefined && turn.turnId !== turnResult.turnId) {
        throw new Error(`Codex reported conflicting turn IDs for generation ${turn.generation}.`);
      }
      turn.turnId = turnResult.turnId;
      if (turn.settled) {
        if (this.currentTurn === turn) this.currentTurn = undefined;
        return;
      }
      if (this.currentTurn === turn) this.setState('running-active');
    } catch (error) {
      if (!turn.settled) {
        if (this.currentTurn === turn) this.currentTurn = undefined;
        await this.failProvider(toError(error));
      }
      throw error;
    }
  }

  private completeTurn(params: unknown): void {
    const turn = this.currentTurn;
    if (turn === undefined || turn.settled) return;

    const turnId = extractTurnId(params);
    if (turnId !== undefined) {
      if (turn.turnId !== undefined && turn.turnId !== turnId) {
        void this.failProvider(
          new Error(`Codex reported conflicting turn IDs for generation ${turn.generation}.`)
        );
        return;
      }
      turn.turnId = turnId;
    }

    const status = extractTurnStatus(params);
    if (status.toLowerCase() !== 'completed') {
      turn.settled = true;
      this.currentTurn = undefined;
      void this.failProvider(new Error(`Codex persistent turn ended with status "${status}".`));
      return;
    }

    turn.settled = true;
    this.currentTurn = undefined;
    this.setStateWithoutAvailability('running-idle');

    if (turn.assistantMessage !== undefined && turn.assistantMessage.trim().length > 0) {
      this.lastCompletedAssistantMessage = turn.assistantMessage;
      this.notifyObservers((observer) =>
        observer.completedAssistantMessage(turn.assistantMessage!)
      );
    }
    this.notifyObservers((observer) => observer.turnComplete());

    if (this.closeAfterCurrentTurn) {
      void this.close('graceful');
    } else {
      this.input.markIdle();
    }
  }

  private setState(state: CodexPersistentAgentState): void {
    this.state = state;
    this.syncInputActivity();
  }

  private setStateWithoutAvailability(state: CodexPersistentAgentState): void {
    this.state = state;
  }

  private syncInputActivity(): void {
    if (!this.input.isReady) return;

    switch (this.state) {
      case 'running-active':
        this.input.markActive();
        return;
      case 'running-idle':
        this.input.markIdle();
        return;
      case 'running-active-starting':
        this.input.markTemporarilyUnavailable();
        return;
      case 'starting':
      case 'finishing':
      case 'stopping-gracefully':
      case 'stopping-forced':
      case 'terminal':
        this.input.markTemporarilyUnavailable();
        return;
    }
  }

  private isOwnedThreadNotification(method: string, params: unknown): boolean {
    const threadId = extractThreadId(params);
    if (threadId !== undefined) return threadId === this.threadId;

    const lowerMethod = method.toLowerCase();
    return (
      lowerMethod.startsWith('turn/') ||
      lowerMethod.startsWith('item/') ||
      lowerMethod.startsWith('thread/status/') ||
      lowerMethod.startsWith('codex/event/') ||
      lowerMethod.startsWith('llm/item/')
    );
  }

  private isProviderActivity(method: string, params: unknown): boolean {
    const lowerMethod = method.toLowerCase();
    if (
      lowerMethod.startsWith('account/') ||
      lowerMethod === 'thread/tokenusage/updated' ||
      lowerMethod.startsWith('thread/tokenusage/')
    ) {
      return false;
    }
    if (lowerMethod.startsWith('item/') && isUserMessageItem(params)) {
      return false;
    }
    return (
      lowerMethod === 'thread/started' ||
      lowerMethod.startsWith('thread/status/') ||
      lowerMethod.startsWith('turn/') ||
      lowerMethod.startsWith('item/') ||
      lowerMethod.startsWith('codex/event/') ||
      lowerMethod.startsWith('llm/item/')
    );
  }

  private async failProvider(error: Error): Promise<void> {
    if (this.isClosing()) return;
    await this.close('failed', error);
  }

  private get formatter(): ReturnType<typeof createAppServerFormatter> {
    if (this.formatterInstance === undefined) {
      this.formatterInstance = createAppServerFormatter(this.options.model);
    }
    return this.formatterInstance;
  }

  private formatterInstance: ReturnType<typeof createAppServerFormatter> | undefined;

  private createHandle(): CodexPersistentAgentLaunchHandle {
    const getProcessControlId = (): ProcessControlId | undefined => this.processControlId;
    const getProviderThreadId = (): ProviderThreadId | undefined => this.providerThreadId;
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
      get processControlId(): ProcessControlId | undefined {
        return getProcessControlId();
      },
      get providerThreadId(): ProviderThreadId | undefined {
        return getProviderThreadId();
      },
      release: async (): Promise<void> => {
        await this.close('forced');
      },
    };
  }

  private get processControlId(): ProcessControlId | undefined {
    return (
      this.ownedProcessControlId ??
      (this.connection?.processControlId as ProcessControlId | undefined)
    );
  }

  private get providerThreadId(): ProviderThreadId | undefined {
    return this.threadId as ProviderThreadId | undefined;
  }

  private isClosing(): boolean {
    return this.closePromise !== undefined || this.cleaned;
  }

  private throwIfClosing(): void {
    if (this.isClosing()) {
      throw new Error('Persistent Codex provider closed during startup.');
    }
  }

  private requestCloseAfterCurrentTurn(): Promise<AgentProviderControlResult> {
    if (this.state === 'terminal') return Promise.resolve('already-exited');
    this.closeAfterCurrentTurn = true;
    if (this.currentTurn?.turnId === undefined) {
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
    const turnPayload = turn as Record<string, unknown>;
    const nestedId = turnPayload.id ?? turnPayload.turnId ?? turnPayload.turn_id;
    if (typeof nestedId === 'string' && nestedId.length > 0) return nestedId;
  }
  const directId = payload.turnId ?? payload.turn_id;
  return typeof directId === 'string' && directId.length > 0 ? directId : undefined;
}

function extractThreadId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const payload = params as Record<string, unknown>;
  const directId = payload.threadId ?? payload.thread_id;
  if (typeof directId === 'string' && directId.length > 0) return directId;

  const thread = payload.thread;
  if (thread && typeof thread === 'object' && !Array.isArray(thread)) {
    const nestedId = (thread as Record<string, unknown>).id;
    if (typeof nestedId === 'string' && nestedId.length > 0) return nestedId;
  }

  const turn = payload.turn;
  if (turn && typeof turn === 'object' && !Array.isArray(turn)) {
    const turnPayload = turn as Record<string, unknown>;
    const nestedTurnThreadId = turnPayload.threadId ?? turnPayload.thread_id;
    if (typeof nestedTurnThreadId === 'string' && nestedTurnThreadId.length > 0) {
      return nestedTurnThreadId;
    }
  }

  const item = payload.item;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const itemPayload = item as Record<string, unknown>;
    const itemThreadId = itemPayload.threadId ?? itemPayload.thread_id;
    if (typeof itemThreadId === 'string' && itemThreadId.length > 0) return itemThreadId;
  }

  return undefined;
}

function extractTurnStatus(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'completed';
  const payload = params as Record<string, unknown>;
  const turn = payload.turn;
  if (turn && typeof turn === 'object' && !Array.isArray(turn)) {
    const status = (turn as Record<string, unknown>).status;
    return typeof status === 'string' ? status : 'completed';
  }
  return typeof payload.status === 'string' ? payload.status : 'completed';
}

function extractThreadStatusType(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const status = (params as Record<string, unknown>).status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined;
  const type = (status as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

function isUserMessageItem(params: unknown): boolean {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const item = (params as Record<string, unknown>).item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const type = (item as Record<string, unknown>).type;
  return typeof type === 'string' && type.toLowerCase() === 'usermessage';
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
