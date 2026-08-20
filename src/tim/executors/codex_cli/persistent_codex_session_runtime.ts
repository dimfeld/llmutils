import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeSubprocessMonitorRules,
  startSubprocessMonitor,
  type SubprocessMonitorHandle,
} from '../../../common/subprocess_monitor.js';
import {
  getCurrentSessionProcessOwner,
  type SessionLogicalExecutorLifecycle,
} from '../../../common/session_process_control.js';
import { debugLog } from '../../../logging';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { createExecutorTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import type { AgentProviderExitClassification } from '../../agent_messaging/agent_manager_types.js';
import { CodexAppServerConnection } from './app_server_connection.js';
import type { ThreadStartParams } from './app_server_connection.js';
import { createApprovalHandler } from './app_server_approval.js';
import { createAppServerRequestHandler, startInitialThread } from './app_server_runner.js';
import {
  CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE,
  type CodexDynamicToolProvider,
} from './app_server_dynamic_tools.js';
import { normalizeCodexAppServerNotification } from './app_server_notifications.js';
import { isCodexAppServerEnabled } from './app_server_mode.js';
import type { CodexAgentToolContext } from './codex_agent_tools.js';
import type { CodexPersistentAgentLaunchOptions } from './persistent_codex_session.js';

export interface PersistentCodexRuntimeCallbacks {
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onUnexpectedExit: (error: Error) => void;
  readonly onGracefulEnd: () => void;
}

/**
 * Owns resources that outlive an individual Codex turn.
 *
 * Turn state and manager callbacks stay in the controller. This class only
 * creates the private app-server, output tunnel, monitor, and logical thread,
 * then closes those resources as one idempotent operation.
 */
export class PersistentCodexSessionRuntime {
  private connection: CodexAppServerConnection | undefined;
  private pendingTurnStartConnection: CodexAppServerConnection | undefined;
  private logicalExecutorLifecycle: SessionLogicalExecutorLifecycle | undefined;
  private monitorHandle: SubprocessMonitorHandle | undefined;
  private tunnelServer: TunnelServer | undefined;
  private tunnelTempDir: string | undefined;
  private tunnelSocketPath: string | undefined;
  private threadId: string | undefined;
  private ownedProcessControlId: string | undefined;
  private closePromise: Promise<Error | undefined> | undefined;
  private pendingThreadStartedNotification:
    | { readonly method: string; readonly params: unknown }
    | undefined;
  private threadStartPending = false;
  private callbacks: PersistentCodexRuntimeCallbacks | undefined;

  public constructor(private readonly options: CodexPersistentAgentLaunchOptions) {}

  public get currentConnection(): CodexAppServerConnection | undefined {
    return this.connection;
  }

  public get currentTurnStartConnection(): CodexAppServerConnection | undefined {
    return this.pendingTurnStartConnection;
  }

  public get currentThreadId(): string | undefined {
    return this.threadId;
  }

  public get processControlId(): string | undefined {
    return this.ownedProcessControlId ?? this.connection?.processControlId;
  }

  public get providerThreadId(): string | undefined {
    return this.threadId;
  }

  public get isAlive(): boolean {
    return this.connection?.isAlive === true && this.closePromise === undefined;
  }

  public get isClosing(): boolean {
    return this.closePromise !== undefined;
  }

  public async initialize(callbacks: PersistentCodexRuntimeCallbacks): Promise<void> {
    this.callbacks = callbacks;
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
      onGracefulEnd: callbacks.onGracefulEnd,
      env: {
        TIM_EXECUTOR: 'codex',
        AGENT: process.env.AGENT || '1',
        TIM_NOTIFY_SUPPRESS: '1',
        ...tunnelEnv,
      },
      timEnvironment: this.options.timEnvironment,
      onExit: ({ exitCode, signal }) => {
        if (this.closePromise !== undefined) return;
        callbacks.onUnexpectedExit(
          new Error(
            `Codex app-server exited unexpectedly with code ${exitCode}${signal ? ` (signal ${signal})` : ''}.`
          )
        );
      },
      onNotification: (method, params) => this.handleConnectionNotification(method, params),
      onServerRequest: createAppServerRequestHandler(
        this.options.dynamicToolProvider,
        approvalHandler
      ),
    });

    if (this.isClosing) {
      await connection.close().catch((error: unknown) => {
        debugLog('Persistent Codex late connection cleanup failed:', error);
      });
      return;
    }

    this.connection = connection;
    this.ownedProcessControlId = connection.processControlId;
    connection.setGracefulEndHandler(callbacks.onGracefulEnd);

    const monitorRules = this.options.timConfig.subprocessMonitor?.rules;
    if (monitorRules?.length && connection.pid !== undefined) {
      normalizeSubprocessMonitorRules(monitorRules);
      this.monitorHandle = startSubprocessMonitor({
        rootPid: connection.pid,
        rules: monitorRules,
        pollIntervalSeconds: this.options.timConfig.subprocessMonitor?.pollIntervalSeconds,
        logger: { warn: (...args: unknown[]) => debugLog(...args) },
      });
    }

    this.threadStartPending = true;
    let threadResult;
    try {
      threadResult = await startInitialThread(
        connection,
        this.buildThreadStartParams(approvalPolicy, sandbox),
        this.options.dynamicToolProvider
      );
    } finally {
      this.threadStartPending = false;
    }

    const earlyThreadStartedNotification = this.pendingThreadStartedNotification;
    this.pendingThreadStartedNotification = undefined;
    const earlyThreadId = earlyThreadStartedNotification
      ? normalizeCodexAppServerNotification(
          earlyThreadStartedNotification.method,
          earlyThreadStartedNotification.params
        ).threadId
      : undefined;
    if (earlyThreadId !== undefined && earlyThreadId !== threadResult.threadId) {
      throw new Error(
        `Codex reported conflicting thread IDs during startup: ${earlyThreadId} and ${threadResult.threadId}.`
      );
    }
    this.throwIfClosing();
    connection.updateMetadata({ threadId: threadResult.threadId });
    this.threadId = threadResult.threadId;
    this.registerLogicalThread(threadResult.threadId, callbacks.onGracefulEnd);
    if (earlyThreadStartedNotification !== undefined) {
      callbacks.onNotification(
        earlyThreadStartedNotification.method,
        earlyThreadStartedNotification.params
      );
    }
  }

  public markTurnStart(connection: CodexAppServerConnection): void {
    this.pendingTurnStartConnection = connection;
  }

  public clearTurnStart(connection: CodexAppServerConnection): void {
    if (this.pendingTurnStartConnection === connection) {
      this.pendingTurnStartConnection = undefined;
    }
  }

  public async close(
    classification: AgentProviderExitClassification = 'natural',
    error?: Error
  ): Promise<Error | undefined> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.finishClose(classification, error);
    return this.closePromise;
  }

  private async finishClose(
    classification: AgentProviderExitClassification,
    primaryError?: Error
  ): Promise<Error | undefined> {
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

    try {
      this.logicalExecutorLifecycle?.setGracefulEndHandler(undefined);
      this.logicalExecutorLifecycle?.markExited(
        classification === 'forced'
          ? { signal: 'SIGTERM' }
          : primaryError === undefined && cleanupError === undefined
            ? {}
            : { exitCode: 1 }
      );
    } catch (error) {
      cleanupError ??= toError(error);
      debugLog('Persistent Codex logical-thread cleanup failed:', error);
    }
    this.logicalExecutorLifecycle = undefined;

    try {
      this.tunnelServer?.close();
    } catch (error) {
      cleanupError ??= toError(error);
      debugLog('Persistent Codex tunnel cleanup failed:', error);
    }
    this.tunnelServer = undefined;
    if (this.tunnelTempDir !== undefined) {
      await fs.rm(this.tunnelTempDir, { recursive: true, force: true }).catch(() => {});
      this.tunnelTempDir = undefined;
    }
    return combineCloseErrors(primaryError, cleanupError);
  }

  private async createOutputTunnel(): Promise<void> {
    if (isTunnelActive()) return;

    const tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-'));
    const tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
    let tunnelServer: TunnelServer | undefined;
    try {
      tunnelServer = await createExecutorTunnelServer(tunnelSocketPath, {
        onPromptRequest: createPromptRequestHandler(),
      });
    } catch (error) {
      debugLog('Could not create persistent Codex output tunnel:', error);
      await fs.rm(tunnelTempDir, { recursive: true, force: true }).catch(() => {});
      return;
    }

    if (this.isClosing) {
      tunnelServer.close();
      await fs.rm(tunnelTempDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    this.tunnelTempDir = tunnelTempDir;
    this.tunnelSocketPath = tunnelSocketPath;
    this.tunnelServer = tunnelServer;
  }

  private buildThreadStartParams(
    approvalPolicy: string | undefined,
    sandbox: 'workspace-write' | 'danger-full-access'
  ): ThreadStartParams {
    const provider = this.options
      .dynamicToolProvider as CodexDynamicToolProvider<CodexAgentToolContext>;
    return {
      cwd: this.options.cwd,
      approvalPolicy,
      sandbox,
      model: this.options.model,
      dynamicTools: provider.definitions,
    };
  }

  private registerLogicalThread(threadId: string, onGracefulEnd: () => void): void {
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
    lifecycle.setGracefulEndHandler(onGracefulEnd);
    lifecycle.markStarted();
    this.logicalExecutorLifecycle = lifecycle;
  }

  private handleConnectionNotification(method: string, params: unknown): void {
    if (this.isClosing) return;
    const notification = normalizeCodexAppServerNotification(method, params);
    if (method === 'thread/started' && this.threadId === undefined && this.threadStartPending) {
      if (notification.threadId === undefined) return;
      const previous = this.pendingThreadStartedNotification;
      if (previous !== undefined) {
        const previousThreadId = normalizeCodexAppServerNotification(
          previous.method,
          previous.params
        ).threadId;
        if (previousThreadId !== undefined && previousThreadId !== notification.threadId) {
          this.callbacks?.onUnexpectedExit(
            new Error(
              `Codex reported conflicting startup thread IDs: ${previousThreadId} and ${notification.threadId}.`
            )
          );
          return;
        }
      }
      this.pendingThreadStartedNotification = { method, params };
      return;
    }
    this.callbacks?.onNotification(method, params);
  }

  private throwIfClosing(): void {
    if (this.isClosing) {
      throw new Error('Persistent Codex provider closed during startup.');
    }
    if (!isCodexAppServerEnabled()) {
      throw new Error(CODEX_DYNAMIC_TOOLS_APP_SERVER_REQUIRED_ERROR_MESSAGE);
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function combineCloseErrors(
  primary: Error | undefined,
  cleanup: Error | undefined
): Error | undefined {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined || cleanup === primary) return primary;
  const combined = new Error(
    `${primary.message}; persistent Codex cleanup also failed: ${cleanup.message}`
  );
  combined.cause = primary;
  return combined;
}
