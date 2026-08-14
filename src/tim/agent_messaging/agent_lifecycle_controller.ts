import {
  STOP_AGENT_INACTIVITY_TIMEOUT_MS,
  type FinishAgentResult,
  type StopAgentResult,
} from './contracts.js';
import {
  AgentManagerError,
  AgentProviderForceNotAcceptedError,
  type AgentManagerScheduler,
  type AgentProviderControlResult,
  type AgentProviderExit,
  type AgentProviderLifecycleControls,
  type AgentProviderLifecycleObserver,
  type AgentLaunchHandle,
} from './agent_manager_types.js';
import type { AgentDirectory, SubagentDirectoryRecord } from './agent_directory.js';
import type { AgentName } from './agent_names.js';
import type { AgentMessagingSessionRuntime, SessionRegistrationHandle } from './session_runtime.js';
import {
  formatTerminalNotification,
  type TerminalNotificationCause,
  type TerminalNotificationInput,
} from './terminal_notifications.js';
import { debugLog } from '../../logging.js';
import { randomUUID } from 'node:crypto';

const STANDARD_GRACEFUL_STOP_INSTRUCTION =
  'The orchestrator has requested a graceful shutdown. Complete your current work, then provide your final status update or result before ending your session.';

type RestorableStopPhase = NoneStopPhase | GracefulStopPhase;

interface NoneStopPhase {
  readonly kind: 'none';
}

interface GracefulStopPhase {
  kind: 'graceful-pending' | 'graceful-requesting' | 'graceful-active';
  readonly instruction: string;
  lastActivityAt: number;
  activityGeneration: number;
  timerGeneration: number;
  timerHandle: unknown;
  lastError?: unknown;
}

interface ForcePendingStopPhase {
  readonly kind: 'force-pending';
  readonly previous: RestorableStopPhase;
  operation?: Promise<StopAgentResult>;
  lastError?: unknown;
}

interface ForceAcceptedStopPhase {
  readonly kind: 'force-accepted';
}

interface ForceUnknownStopPhase {
  readonly kind: 'force-unknown';
  readonly previous: RestorableStopPhase;
  readonly error: unknown;
}

type StopLifecyclePhase =
  | RestorableStopPhase
  | ForcePendingStopPhase
  | ForceAcceptedStopPhase
  | ForceUnknownStopPhase;

interface TerminalLifecycleState {
  readonly terminalPromise: Promise<void>;
  readonly resolveTerminal: () => void;
  terminalClaimed: boolean;
  cause: TerminalNotificationCause | undefined;
  finishRequested: boolean;
  finishFallbackMessage?: string;
  closeAfterTurnRequested: boolean;
  notificationAttempt?: Promise<void>;
}

interface SuccessfulOutboundSnapshot {
  readonly sequence: number;
  readonly target: AgentName;
  readonly content: string;
}

export interface AgentLifecycleCleanup {
  disposeMailbox(): void;
  removeDirectoryRecord(): void;
  onRemoved(): void;
}

export interface AgentLifecycleControllerOptions {
  readonly record: SubagentDirectoryRecord;
  readonly directory: AgentDirectory;
  readonly scheduler: AgentManagerScheduler;
  readonly sessionRuntime: AgentMessagingSessionRuntime;
  readonly rootRegistration: SessionRegistrationHandle;
  readonly cleanup: AgentLifecycleCleanup;
  readonly nextOutboundSequence: () => number;
  readonly onStartupExit: (exit: AgentProviderExit) => void;
}

function buildGracefulStopInstruction(message: string | undefined): string {
  if (message === undefined || message.length === 0) return STANDARD_GRACEFUL_STOP_INSTRUCTION;
  return `${STANDARD_GRACEFUL_STOP_INSTRUCTION}\n\nAdditional shutdown context:\n---\n${message}\n---`;
}

function createTerminalLifecycleState(): TerminalLifecycleState {
  let resolveTerminal: (() => void) | undefined;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    terminalPromise,
    resolveTerminal: (): void => resolveTerminal?.(),
    terminalClaimed: false,
    cause: undefined,
    finishRequested: false,
    closeAfterTurnRequested: false,
  };
}

function createNoneStopPhase(): NoneStopPhase {
  return { kind: 'none' };
}

function isGracefulStopPhase(phase: StopLifecyclePhase): phase is GracefulStopPhase {
  return (
    phase.kind === 'graceful-pending' ||
    phase.kind === 'graceful-requesting' ||
    phase.kind === 'graceful-active'
  );
}

function isForceNotAccepted(error: unknown): boolean {
  return error instanceof AgentProviderForceNotAcceptedError;
}

/** Owns all lifecycle state and cleanup for one subagent. */
export class AgentLifecycleController {
  private readonly terminal: TerminalLifecycleState = createTerminalLifecycleState();
  private phase: StopLifecyclePhase = createNoneStopPhase();
  private providerLifecycle: AgentProviderLifecycleControls | undefined;
  private providerHandle: AgentLaunchHandle | undefined;
  private unsubscribeProvider: (() => void) | undefined;
  private providerExit: AgentProviderExit | undefined;
  private lastCompletedAssistantMessage: string | undefined;
  private lastSuccessfulOutbound: SuccessfulOutboundSnapshot | undefined;
  private disposed = false;

  public constructor(private readonly options: AgentLifecycleControllerOptions) {}

  public get record(): SubagentDirectoryRecord {
    return this.options.record;
  }

  public get terminalPromise(): Promise<void> {
    return this.terminal.terminalPromise;
  }

  public get isTerminalClaimed(): boolean {
    return this.terminal.terminalClaimed;
  }

  public get providerExitInfo(): AgentProviderExit | undefined {
    return this.providerExit;
  }

  /** Retry a pending startup stop after the provider becomes ready. */
  public providerReady(): void {
    this.maybeRequestProviderStop();
  }

  /** Bind one handle-scoped observer. The captured record protects reused names. */
  public bindProvider(handle: AgentLaunchHandle): void {
    this.providerHandle = handle;
    this.providerLifecycle = handle.lifecycle;
    this.unsubscribeProvider?.();
    const observer: AgentProviderLifecycleObserver = {
      outputActivity: (): void => this.handleOutputActivity(),
      completedAssistantMessage: (message: string): void =>
        this.handleCompletedAssistantMessage(message),
      turnComplete: (): void => this.handleTurnComplete(),
      exit: (classification, error): void => this.handleProviderExit(classification, error),
    };
    this.unsubscribeProvider = handle.lifecycle.subscribe(observer);
    this.maybeRequestProviderStop();
  }

  public finish(message: string | undefined): FinishAgentResult {
    if (this.providerExit !== undefined || this.terminal.terminalClaimed) {
      throw new AgentManagerError(
        'finish_not_available',
        'FinishAgent is not available after the provider has exited'
      );
    }
    if (this.options.record.state === 'finishing') {
      if (!this.terminal.finishRequested) {
        throw new AgentManagerError(
          'finish_not_available',
          'FinishAgent was not the operation that started this finishing transition'
        );
      }
      this.saveFinishFallback(message);
      return Object.freeze({ state: 'finishing' });
    }
    if (this.options.record.state !== 'running-active') {
      throw new AgentManagerError(
        'finish_not_available',
        'FinishAgent is only available during an active provider turn'
      );
    }
    if (this.providerLifecycle === undefined) {
      throw new AgentManagerError(
        'finish_not_available',
        'The provider lifecycle is not ready for FinishAgent'
      );
    }

    this.options.record.state = 'finishing';
    this.terminal.finishRequested = true;
    this.saveFinishFallback(message);
    return Object.freeze({ state: 'finishing' });
  }

  public stop(force: boolean, message: string | undefined): Promise<StopAgentResult> {
    if (this.terminal.terminalClaimed || this.providerExit !== undefined) {
      return Promise.resolve(this.alreadyStoppingResult());
    }
    if (force) return this.requestForcedStop(true);
    if (this.options.record.state === 'finishing' || this.options.record.state === 'stopping') {
      return Promise.resolve(this.alreadyStoppingResult());
    }

    this.options.record.state = 'stopping';
    this.phase = this.createGracefulPendingPhase(buildGracefulStopInstruction(message));
    this.maybeRequestProviderStop();
    return Promise.resolve(
      Object.freeze({
        name: this.options.record.name,
        mode: 'graceful-requested',
        state: 'stopping',
      })
    );
  }

  /** Start or join graceful shutdown as part of the manager's root fan-out. */
  public requestRootTeardown(): Promise<void> {
    if (this.terminal.terminalClaimed) return this.terminal.terminalPromise;

    if (this.options.record.state === 'finishing') {
      if (this.phase.kind === 'none') {
        this.phase = this.createGracefulActivePhase('');
        this.armStopInactivityTimer(this.phase);
      }
    } else if (this.phase.kind === 'none') {
      this.options.record.state = 'stopping';
      this.phase = this.createGracefulPendingPhase(STANDARD_GRACEFUL_STOP_INSTRUCTION);
      this.maybeRequestProviderStop();
    }

    this.maybeRequestProviderStop();
    return this.terminal.terminalPromise;
  }

  public recordSuccessfulOutbound(target: AgentName, content: string): void {
    if (!this.isCurrent() || this.terminal.terminalClaimed) return;
    this.lastSuccessfulOutbound = Object.freeze({
      sequence: this.options.nextOutboundSequence(),
      target,
      content,
    });
  }

  /** Stop callbacks and timers for a startup rollback without notifying. */
  public cancelBeforeLaunch(): void {
    if (this.terminal.terminalClaimed) return;
    this.dispose();
    this.terminal.resolveTerminal();
  }

  /** Release callback references after manager shutdown. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelStopTimer();
    this.unsubscribeProvider?.();
    this.unsubscribeProvider = undefined;
  }

  private saveFinishFallback(message: string | undefined): void {
    if (
      message !== undefined &&
      message.trim().length > 0 &&
      this.terminal.finishFallbackMessage === undefined
    ) {
      this.terminal.finishFallbackMessage = message;
    }
  }

  private createGracefulPendingPhase(instruction: string): GracefulStopPhase {
    return {
      kind: 'graceful-pending',
      instruction,
      lastActivityAt: this.options.scheduler.now(),
      activityGeneration: 0,
      timerGeneration: 0,
      timerHandle: undefined,
    };
  }

  private createGracefulActivePhase(instruction: string): GracefulStopPhase {
    return {
      kind: 'graceful-active',
      instruction,
      lastActivityAt: this.options.scheduler.now(),
      activityGeneration: 0,
      timerGeneration: 0,
      timerHandle: undefined,
    };
  }

  private maybeRequestProviderStop(): void {
    if (
      this.providerLifecycle === undefined ||
      !this.options.record.launchReady ||
      this.providerExit !== undefined
    )
      return;
    if (this.phase.kind === 'force-pending' && this.phase.operation === undefined) {
      void this.startForcedStopOperation(this.phase, false);
      return;
    }
    if (this.phase.kind === 'graceful-pending') this.requestGracefulStop(this.phase);
  }

  private requestGracefulStop(phase: GracefulStopPhase): void {
    if (this.providerLifecycle === undefined || this.phase !== phase) return;
    phase.kind = 'graceful-requesting';
    const requestGeneration = phase.activityGeneration;
    let request: Promise<AgentProviderControlResult>;
    try {
      request = this.providerLifecycle.requestGracefulShutdown(phase.instruction);
    } catch (error) {
      this.handleGracefulFailure(phase, error);
      return;
    }
    void Promise.resolve(request).then(
      (result): void => this.handleGracefulResult(phase, result, requestGeneration),
      (error: unknown): void => this.handleGracefulFailure(phase, error)
    );
  }

  private handleGracefulResult(
    phase: GracefulStopPhase,
    result: AgentProviderControlResult,
    requestGeneration: number
  ): void {
    const forcePendingForPhase =
      this.phase.kind === 'force-pending' && this.phase.previous === phase;
    if (
      !this.isCurrent() ||
      this.terminal.terminalClaimed ||
      (this.phase !== phase && !forcePendingForPhase)
    )
      return;
    if (result === 'accepted') {
      phase.kind = 'graceful-active';
      if (phase.activityGeneration === requestGeneration) {
        phase.lastActivityAt = this.options.scheduler.now();
        phase.activityGeneration += 1;
      }
      if (this.phase === phase) this.armStopInactivityTimer(phase);
      return;
    }
    if (this.phase === phase) this.cancelStopTimer();
    this.synthesizeProviderExit('natural');
  }

  private handleGracefulFailure(phase: GracefulStopPhase, error: unknown): void {
    const forcePendingForPhase =
      this.phase.kind === 'force-pending' && this.phase.previous === phase;
    if (
      !this.isCurrent() ||
      this.terminal.terminalClaimed ||
      (this.phase !== phase && !forcePendingForPhase)
    )
      return;
    phase.kind = 'graceful-active';
    phase.lastError = error;
    phase.lastActivityAt = phase.lastActivityAt || this.options.scheduler.now();
    if (this.phase === phase) this.armStopInactivityTimer(phase);
  }

  private handleOutputActivity(): void {
    if (!this.isCurrent() || this.providerExit !== undefined || this.terminal.terminalClaimed)
      return;
    const phase = isGracefulStopPhase(this.phase)
      ? this.phase
      : this.phase.kind === 'force-pending' && isGracefulStopPhase(this.phase.previous)
        ? this.phase.previous
        : undefined;
    if (phase === undefined) return;
    phase.lastActivityAt = this.options.scheduler.now();
    phase.activityGeneration += 1;
    if (this.phase === phase && phase.kind === 'graceful-active') {
      this.armStopInactivityTimer(phase);
    }
  }

  private handleCompletedAssistantMessage(message: string): void {
    if (!this.isCurrent() || this.providerExit !== undefined || this.terminal.terminalClaimed)
      return;
    this.lastCompletedAssistantMessage = message;
    this.handleOutputActivity();
  }

  private handleTurnComplete(): void {
    if (!this.isCurrent() || this.providerExit !== undefined || this.terminal.terminalClaimed)
      return;
    if (this.options.record.state !== 'finishing' || !this.terminal.finishRequested) return;
    if (this.terminal.closeAfterTurnRequested || this.providerLifecycle === undefined) return;

    // Claim before provider code runs. A provider can synchronously report an
    // exit from inside requestCloseAfterCurrentTurn().
    this.terminal.closeAfterTurnRequested = true;
    try {
      const closeAfterTurn = this.providerLifecycle.requestCloseAfterCurrentTurn();
      void Promise.resolve(closeAfterTurn).then(
        (result): undefined => {
          if (result === 'already-exited') this.synthesizeProviderExit('natural');
          return undefined;
        },
        (error: unknown): undefined => {
          this.logDiagnostic('close-after-turn request', error);
          return undefined;
        }
      );
    } catch (error) {
      this.logDiagnostic('close-after-turn request', error);
    }
  }

  private handleProviderExit(
    classification: AgentProviderExit['classification'],
    error?: Error
  ): void {
    if (!this.isCurrent() || this.providerExit !== undefined) return;
    this.providerExit = Object.freeze({
      classification,
      ...(error === undefined ? {} : { error }),
    });
    if (!this.options.record.launchReady) {
      this.options.onStartupExit(this.providerExit);
      return;
    }
    void this.beginTerminal(this.selectTerminalCause(this.providerExit));
  }

  private synthesizeProviderExit(classification: AgentProviderExit['classification']): void {
    if (this.providerExit !== undefined) return;
    this.handleProviderExit(classification);
  }

  private selectTerminalCause(event: AgentProviderExit): TerminalNotificationCause {
    if (event.classification === 'failed') return 'provider-failure';
    if (event.classification === 'natural') {
      if (
        this.terminal.finishRequested &&
        this.phase.kind !== 'force-accepted' &&
        this.phase.kind !== 'force-pending'
      ) {
        return 'self-finish';
      }
      return 'natural';
    }
    if (event.classification === 'forced') return 'forced-stop';
    if (this.phase.kind === 'force-accepted') return 'forced-stop';
    if (this.terminal.finishRequested) return 'self-finish';
    return 'graceful-stop';
  }

  private captureRestorableStopPhase(previous: RestorableStopPhase): RestorableStopPhase {
    if (previous.kind === 'none') return previous;
    this.cancelPhaseTimer(previous);
    return previous;
  }

  private restoreGracefulPhaseAfterForceNotAccepted(previous: RestorableStopPhase): void {
    if (previous.kind === 'none') {
      this.phase = previous;
      return;
    }
    previous.kind = 'graceful-active';
    this.phase = previous;
    this.armStopInactivityTimer(previous);
  }

  private requestForcedStop(explicit: boolean): Promise<StopAgentResult> {
    if (this.phase.kind === 'force-accepted') return Promise.resolve(this.forcedResult());
    if (this.phase.kind === 'force-unknown') {
      if (!explicit) return Promise.resolve(this.alreadyStoppingResult());
      return Promise.reject(this.createUnknownForceError(this.phase.error));
    }
    if (this.phase.kind === 'force-pending') {
      return (
        this.phase.operation ??
        Promise.resolve(
          Object.freeze({ name: this.options.record.name, mode: 'forced', state: 'stopping' })
        )
      );
    }

    const previous = this.captureRestorableStopPhase(this.phase);
    this.options.record.state = 'stopping';
    const phase: ForcePendingStopPhase = { kind: 'force-pending', previous };
    this.phase = phase;
    if (this.providerLifecycle === undefined || !this.options.record.launchReady) {
      return Promise.resolve(this.forcedResult());
    }
    return this.startForcedStopOperation(phase, explicit);
  }

  private startForcedStopOperation(
    phase: ForcePendingStopPhase,
    explicit: boolean
  ): Promise<StopAgentResult> {
    if (this.providerLifecycle === undefined || this.phase !== phase) {
      return Promise.resolve(this.forcedResult());
    }
    let request: Promise<AgentProviderControlResult>;
    try {
      request = this.providerLifecycle.requestForcedShutdown();
    } catch (error) {
      return Promise.resolve(this.handleForcedFailure(phase, explicit, error));
    }
    const operation = Promise.resolve(request).then(
      (result): StopAgentResult => {
        if (!this.isCurrent()) return this.forcedResult();
        if (this.phase !== phase) return this.forcedResult();
        if (result === 'accepted') {
          this.phase = { kind: 'force-accepted' };
        } else {
          this.phase = phase.previous;
          this.synthesizeProviderExit('natural');
        }
        return this.forcedResult();
      },
      (error: unknown): StopAgentResult => this.handleForcedFailure(phase, explicit, error)
    );
    phase.operation = operation;
    return operation;
  }

  private handleForcedFailure(
    phase: ForcePendingStopPhase,
    explicit: boolean,
    error: unknown
  ): StopAgentResult {
    if (this.phase !== phase) return this.forcedResult();
    phase.lastError = error;
    if (isForceNotAccepted(error)) {
      this.restoreGracefulPhaseAfterForceNotAccepted(phase.previous);
      if (!explicit) return this.alreadyStoppingResult();
      throw new AgentManagerError(
        'force_failed',
        `Forced shutdown was not accepted for agent ${this.options.record.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }

    this.phase = { kind: 'force-unknown', previous: phase.previous, error };
    if (explicit) throw this.createUnknownForceError(error);
    return this.alreadyStoppingResult();
  }

  private createUnknownForceError(error: unknown): AgentManagerError {
    return new AgentManagerError(
      'force_failed',
      `Forced shutdown status is unknown for agent ${this.options.record.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  private armStopInactivityTimer(phase: GracefulStopPhase): void {
    if (
      !this.isCurrent() ||
      this.providerExit !== undefined ||
      this.terminal.terminalClaimed ||
      this.phase !== phase ||
      phase.kind !== 'graceful-active'
    ) {
      return;
    }
    this.cancelPhaseTimer(phase);
    const expectedActivityGeneration = phase.activityGeneration;
    const expectedTimerGeneration = ++phase.timerGeneration;
    const remaining = Math.max(
      0,
      phase.lastActivityAt + STOP_AGENT_INACTIVITY_TIMEOUT_MS - this.options.scheduler.now()
    );
    phase.timerHandle = this.options.scheduler.setTimeout((): void => {
      if (
        !this.isCurrent() ||
        this.providerExit !== undefined ||
        this.terminal.terminalClaimed ||
        this.phase !== phase ||
        phase.timerGeneration !== expectedTimerGeneration ||
        phase.activityGeneration !== expectedActivityGeneration
      ) {
        return;
      }
      phase.timerHandle = undefined;
      const timeRemaining =
        phase.lastActivityAt + STOP_AGENT_INACTIVITY_TIMEOUT_MS - this.options.scheduler.now();
      if (timeRemaining > 0) {
        this.armStopInactivityTimer(phase);
        return;
      }
      void this.requestForcedStop(false).catch(() => undefined);
    }, remaining);
  }

  private cancelPhaseTimer(phase: GracefulStopPhase): void {
    phase.timerGeneration += 1;
    if (phase.timerHandle !== undefined) {
      this.options.scheduler.clearTimeout(phase.timerHandle);
      phase.timerHandle = undefined;
    }
  }

  private cancelStopTimer(): void {
    if (isGracefulStopPhase(this.phase)) this.cancelPhaseTimer(this.phase);
  }

  private async beginTerminal(cause: TerminalNotificationCause): Promise<void> {
    if (this.terminal.terminalClaimed) return this.terminal.terminalPromise;
    this.terminal.terminalClaimed = true;
    this.terminal.cause = cause;
    this.cancelStopTimer();
    this.unsubscribeProvider?.();
    this.unsubscribeProvider = undefined;

    const notificationInput: TerminalNotificationInput = Object.freeze({
      agentName: this.options.record.name,
      cause,
      ...(this.lastCompletedAssistantMessage === undefined
        ? {}
        : { lastCompletedAssistantMessage: this.lastCompletedAssistantMessage }),
      ...(this.terminal.finishFallbackMessage === undefined
        ? {}
        : { finishFallbackMessage: this.terminal.finishFallbackMessage }),
      ...(this.lastSuccessfulOutbound === undefined
        ? {}
        : {
            lastSuccessfulOutbound: Object.freeze({
              target: this.lastSuccessfulOutbound.target,
              content: this.lastSuccessfulOutbound.content,
            }),
          }),
    });
    const decision = formatTerminalNotification(notificationInput);
    this.terminal.notificationAttempt =
      decision.suppressed || decision.content === undefined
        ? Promise.resolve()
        : this.deliverTerminalNotification(decision.content);
    void this.cleanupTerminal();
    return this.terminal.terminalPromise;
  }

  private async deliverTerminalNotification(content: string): Promise<void> {
    try {
      const acknowledgement = await this.options.sessionRuntime.sendMessage(
        { id: this.options.record.id, name: this.options.record.name },
        {
          id: this.options.rootRegistration.registration.id,
          name: this.options.rootRegistration.registration.name,
        },
        { requestId: randomUUID(), content }
      );
      if (!acknowledgement.success) {
        this.logDiagnostic(
          'terminal notification delivery',
          new AgentManagerError(
            'transport_error',
            `Terminal notification delivery failed (${acknowledgement.error.code}): ${acknowledgement.error.message}`
          )
        );
      }
    } catch (error) {
      this.logDiagnostic('terminal notification delivery', error);
    }
  }

  private async cleanupTerminal(): Promise<void> {
    try {
      await this.terminal.notificationAttempt;
    } catch (error) {
      this.logDiagnostic('terminal notification', error);
    }

    try {
      this.options.cleanup.disposeMailbox();
    } catch (error) {
      this.logDiagnostic('mailbox disposal', error);
    }
    try {
      await this.providerHandle?.release?.();
    } catch (error) {
      this.logDiagnostic('provider release', error);
    }
    try {
      await this.options.record.mailbox?.deregister();
    } catch (error) {
      this.logDiagnostic('mailbox deregistration', error);
    }
    try {
      this.options.cleanup.removeDirectoryRecord();
    } catch (error) {
      this.logDiagnostic('directory removal', error);
    }
    try {
      this.options.cleanup.onRemoved();
    } catch (error) {
      this.logDiagnostic('lifecycle removal', error);
    } finally {
      this.terminal.resolveTerminal();
    }
  }

  private logDiagnostic(operation: string, error: unknown): void {
    debugLog(`[agent lifecycle] ${operation} failed for ${this.options.record.name}:`, error);
  }

  private forcedResult(): StopAgentResult {
    return Object.freeze({ name: this.options.record.name, mode: 'forced', state: 'stopping' });
  }

  private alreadyStoppingResult(): StopAgentResult {
    return Object.freeze({
      name: this.options.record.name,
      mode: 'already-stopping',
      state: this.options.record.state,
    });
  }

  private isCurrent(): boolean {
    return (
      !this.disposed &&
      this.options.directory.getRecord(this.options.record.id) === this.options.record
    );
  }
}
