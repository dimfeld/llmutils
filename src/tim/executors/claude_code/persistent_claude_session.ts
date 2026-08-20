import type { SpawnAndLogOutputResult } from '../../../common/process.ts';
import type {
  SessionExecutorLifecycle,
  SessionProcessOwner,
} from '../../../common/session_process_control.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import type {
  AgentProviderControlResult,
  AgentProviderLifecycleControls,
  AgentProviderLifecycleObserver,
  ProcessControlId,
} from '../../agent_messaging/agent_manager_types.js';
import {
  AgentProviderControlError,
  AgentProviderForceNotAcceptedError,
} from '../../agent_messaging/agent_manager_types.js';
import type { AgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import type { FormattedClaudeMessage } from './format.ts';
import type { ExecuteWithTerminalInputResult } from './terminal_input_lifecycle.ts';
import type {
  ClaudePersistentAgentCompletion,
  ClaudePersistentAgentLaunchHandle,
} from './persistent_agent_contract.js';
import type { ClaudePersistentAgentState } from './persistent_agent_contract.js';

export interface PersistentClaudeSessionRuntimeOptions {
  readonly label: string;
  readonly processLabel: AgentProcessLabel;
  readonly debugLog: (...args: unknown[]) => void;
  readonly sendStructured: (message: StructuredMessage) => void;
  readonly onOutputActivity?: () => void | Promise<void>;
  readonly sessionProcessOwner?: SessionProcessOwner;
  readonly lifecycleObserver?: AgentProviderLifecycleObserver;
}

/**
 * Owns one persistent Claude provider after common process setup has started.
 * The turn controller owns provider input state; this object owns everything
 * around that boundary: lifecycle controls, completion facts, observers, and
 * finalization.
 */
export class PersistentClaudeSessionRuntime {
  private readonly completionDeferred = createDeferred<ClaudePersistentAgentCompletion>();
  private readonly lifecycleObservers = new Set<AgentProviderLifecycleObserver>();
  private inputController: ExecuteWithTerminalInputResult['persistentAgent'];
  private terminalInputResult: ExecuteWithTerminalInputResult | undefined;
  private cleanupResources: (() => Promise<void>) | undefined;
  private sessionProcessLifecycle: SessionExecutorLifecycle | undefined;
  private completionStarted = false;
  private completionFinalized = false;
  private exitNotified = false;
  private lastCompletedAssistantMessage: string | undefined;
  private lastSessionEndMessage: StructuredMessage | undefined;
  private settledResultText: string | undefined;
  private closeAfterTurnRequested = false;
  private gracefulShutdownAccepted = false;
  private gracefulShutdownRequest: Promise<AgentProviderControlResult> | undefined;
  private forcedShutdownAccepted = false;
  private forcedShutdownRequest: Promise<AgentProviderControlResult> | undefined;

  public readonly lifecycle: AgentProviderLifecycleControls;

  public constructor(private readonly options: PersistentClaudeSessionRuntimeOptions) {
    if (options.lifecycleObserver !== undefined) {
      this.lifecycleObservers.add(options.lifecycleObserver);
    }
    this.lifecycle = {
      requestGracefulShutdown: (instruction: string): Promise<AgentProviderControlResult> =>
        this.requestGracefulShutdown(instruction),
      requestCloseAfterCurrentTurn: (): Promise<AgentProviderControlResult> =>
        this.requestCloseAfterCurrentTurn(),
      requestForcedShutdown: (): Promise<AgentProviderControlResult> =>
        this.requestForcedShutdown(),
      subscribe: (observer: AgentProviderLifecycleObserver): (() => void) => {
        this.lifecycleObservers.add(observer);
        return (): void => {
          this.lifecycleObservers.delete(observer);
        };
      },
    };
  }

  public get ready(): Promise<void> {
    return this.requireInput().ready;
  }

  public get completion(): Promise<ClaudePersistentAgentCompletion> {
    return this.completionDeferred.promise;
  }

  public get providerState(): ClaudePersistentAgentState {
    return this.requireInput().state;
  }

  public get input(): NonNullable<ExecuteWithTerminalInputResult['persistentAgent']> {
    return this.requireInput();
  }

  public get processControlId(): ProcessControlId | undefined {
    return this.sessionProcessLifecycle?.processId as ProcessControlId | undefined;
  }

  /** Bind the controller and the full ordered resource cleanup. */
  public attach(
    terminalInputResult: ExecuteWithTerminalInputResult,
    cleanupResources: () => Promise<void>
  ): void {
    if (this.inputController !== undefined || this.terminalInputResult !== undefined) {
      throw new Error(`Claude ${this.options.label} persistent runtime is already attached`);
    }
    const inputController = terminalInputResult.persistentAgent;
    if (inputController === undefined) {
      throw new Error(`Claude ${this.options.label} persistent runtime has no input controller`);
    }
    this.inputController = inputController;
    this.terminalInputResult = terminalInputResult;
    this.cleanupResources = cleanupResources;
  }

  /** Capture the safe process capability and bind the graceful end hook. */
  public attachProcessLifecycle(lifecycle: SessionExecutorLifecycle): void {
    this.sessionProcessLifecycle = lifecycle;
    lifecycle.setGracefulEndHandler(() => this.terminalInputResult?.endSession());
  }

  public clearProcessLifecycleHandler(): void {
    this.sessionProcessLifecycle?.setGracefulEndHandler(undefined);
  }

  /** Start the passive completion observer. It never blocks launch readiness. */
  public startCompletion(processCompletion: Promise<SpawnAndLogOutputResult>): void {
    if (this.completionStarted) return;
    this.completionStarted = true;
    void this.finalizeCompletion(processCompletion);
  }

  /** Route one fully parsed Claude message into persistent turn handling. */
  public observeFormattedMessage(formatted: FormattedClaudeMessage): void {
    if (this.completionFinalized) return;
    const input = this.inputController;
    if (input === undefined) return;
    input.observeFormattedMessage(formatted);

    if (formatted.structured !== undefined) {
      const structured = Array.isArray(formatted.structured)
        ? formatted.structured
        : [formatted.structured];
      for (const message of structured) {
        if (message.type === 'agent_session_end') {
          this.lastSessionEndMessage = message;
        }
      }
    }

    if (formatted.type === 'result') {
      input.onResultMessage(formatted.resultInfo?.success !== false, formatted.resultText);
    }

    if (formatted.type === 'assistant' && formatted.rawMessage?.trim()) {
      this.lastCompletedAssistantMessage = formatted.rawMessage;
      this.notifyObservers((observer) => observer.completedAssistantMessage(formatted.rawMessage!));
    }
  }

  /** Keep only per-turn structured output; session end is emitted at exit. */
  public filterStructuredMessages(messages: StructuredMessage[]): StructuredMessage[] {
    return messages.filter((message) => message.type !== 'agent_session_end');
  }

  public notifyOutputActivity(): void {
    try {
      const result = this.options.onOutputActivity?.();
      void Promise.resolve(result).catch((error: unknown) => {
        this.options.debugLog(
          `Claude ${this.options.label} output activity callback failed:`,
          error
        );
      });
    } catch (error) {
      this.options.debugLog(`Claude ${this.options.label} output activity callback failed:`, error);
    }
    this.notifyObservers((observer) => observer.outputActivity());
  }

  public notifyTurnComplete(
    successful: boolean,
    generation: number,
    resultText: string | undefined
  ): void {
    this.settledResultText = resultText;
    this.notifyObservers((observer) => observer.turnComplete());
    this.options.debugLog(
      `Claude ${this.options.label} persistent turn ${generation} settled (${successful ? 'success' : 'failure'})`
    );
  }

  public createHandle(): ClaudePersistentAgentLaunchHandle {
    const input = this.requireInput();
    return {
      mode: 'persistent-agent',
      executor: 'claude-code',
      processLabel: this.options.processLabel,
      get providerState() {
        return input.state;
      },
      input,
      ready: input.ready,
      completion: this.completion,
      lifecycle: this.lifecycle,
      ...(this.processControlId === undefined ? {} : { processControlId: this.processControlId }),
      release: async (): Promise<void> => {
        input.cleanup();
        await this.cleanup();
      },
    };
  }

  public async cleanup(): Promise<void> {
    this.inputController?.cleanup();
    await this.cleanupResources?.();
  }

  private async requestGracefulShutdown(instruction: string): Promise<AgentProviderControlResult> {
    if (this.gracefulShutdownRequest !== undefined) return this.gracefulShutdownRequest;
    if (this.completionFinalized || this.inputController === undefined) return 'already-exited';

    this.gracefulShutdownRequest = (async (): Promise<AgentProviderControlResult> => {
      try {
        const input = this.requireInput();
        const delivery = await Promise.resolve(input.sendContent(instruction));
        if (delivery === 'temporarily-unavailable') {
          throw new AgentProviderControlError(
            'graceful-shutdown',
            'Claude persistent input is temporarily unavailable for graceful shutdown'
          );
        }
        this.closeAfterTurnRequested = true;
        if (input.state === 'idle') {
          input.forceCloseInputNow();
        } else {
          input.requestCloseAfterCurrentResult('graceful');
        }
        this.gracefulShutdownAccepted = true;
        return 'accepted';
      } catch (error) {
        if (this.inputController?.state === 'exited' || this.completionFinalized) {
          return 'already-exited';
        }
        if (error instanceof AgentProviderControlError) throw error;
        throw new AgentProviderControlError(
          'graceful-shutdown',
          `Claude persistent graceful shutdown failed: ${String(error)}`,
          { cause: error }
        );
      }
    })();
    return this.gracefulShutdownRequest;
  }

  private async requestCloseAfterCurrentTurn(): Promise<AgentProviderControlResult> {
    if (this.completionFinalized || this.inputController === undefined) return 'already-exited';
    if (this.closeAfterTurnRequested) return 'accepted';

    const input = this.requireInput();
    if (input.state === 'exited' || input.state === 'failed' || input.state === 'closing') {
      return input.state === 'closing' ? 'accepted' : 'already-exited';
    }

    this.closeAfterTurnRequested = true;
    try {
      if (input.state === 'idle') {
        if (input.generation === 0) {
          this.closeAfterTurnRequested = false;
          throw new AgentProviderControlError(
            'close-after-current-turn',
            'Claude persistent agent has no current turn to close'
          );
        }
        input.forceCloseInputNow();
      } else {
        input.requestCloseAfterCurrentResult();
      }
      return 'accepted';
    } catch (error) {
      const stateAfterError = input.state as ClaudePersistentAgentState;
      if (stateAfterError === 'exited' || stateAfterError === 'failed') {
        return 'already-exited';
      }
      if (error instanceof AgentProviderControlError) throw error;
      throw new AgentProviderControlError(
        'close-after-current-turn',
        `Claude persistent close-after-turn failed: ${String(error)}`,
        { cause: error }
      );
    }
  }

  private requestForcedShutdown(): Promise<AgentProviderControlResult> {
    if (this.forcedShutdownRequest !== undefined) return this.forcedShutdownRequest;
    if (this.completionFinalized || this.inputController === undefined) {
      return Promise.resolve('already-exited');
    }
    if (this.inputController.state === 'exited') return Promise.resolve('already-exited');
    if (this.forcedShutdownAccepted) return Promise.resolve('accepted');

    this.forcedShutdownRequest = (async (): Promise<AgentProviderControlResult> => {
      const processLifecycle = this.sessionProcessLifecycle;
      const processOwner = this.options.sessionProcessOwner;
      if (processLifecycle === undefined || processOwner === undefined) {
        throw new AgentProviderForceNotAcceptedError(
          'Claude persistent forced shutdown has no captured safe process capability'
        );
      }

      let result: ReturnType<SessionProcessOwner['terminateExecutor']>;
      try {
        result = processOwner.terminateExecutor(processLifecycle.processId);
      } catch (error) {
        throw new AgentProviderForceNotAcceptedError(
          `Claude persistent forced shutdown failed before acceptance: ${String(error)}`,
          { cause: error }
        );
      }

      switch (result) {
        case 'terminated':
        case 'requested':
          this.forcedShutdownAccepted = true;
          return 'accepted';
        case 'already_exited':
          return 'already-exited';
        default:
          throw new AgentProviderForceNotAcceptedError(
            `Claude persistent forced shutdown was not accepted by the safe process owner (${result})`
          );
      }
    })();

    this.forcedShutdownRequest = this.forcedShutdownRequest.catch((error: unknown) => {
      if (error instanceof AgentProviderForceNotAcceptedError) {
        this.forcedShutdownRequest = undefined;
      }
      throw error;
    });
    return this.forcedShutdownRequest;
  }

  private async finalizeCompletion(
    processCompletion: Promise<SpawnAndLogOutputResult>
  ): Promise<void> {
    let processResult: Awaited<typeof processCompletion> | undefined;
    let processError: Error | undefined;
    try {
      processResult = await processCompletion;
      if (this.inputController?.state === 'failed') {
        processError = toError(
          this.inputController.inputWriter.lastError ??
            new Error(`Claude ${this.options.label} persistent input failed`)
        );
      }
    } catch (error) {
      processError = toError(error);
    }

    let cleanupError: Error | undefined;
    try {
      await this.cleanup();
    } catch (error) {
      cleanupError = toError(error);
      this.options.debugLog(
        `Claude ${this.options.label} persistent cleanup failed:`,
        cleanupError
      );
    }

    if (processError !== undefined) {
      this.inputController?.markProviderFailed(processError);
    } else {
      this.inputController?.markProviderExited();
    }

    if (this.lastSessionEndMessage !== undefined) {
      try {
        this.options.sendStructured(this.lastSessionEndMessage);
      } catch (error) {
        this.options.debugLog(`Claude ${this.options.label} final session message failed:`, error);
      }
    }

    const exitError =
      processError ??
      cleanupError ??
      (processResult !== undefined && processResult.exitCode !== 0
        ? new Error(`Claude ${this.options.label} exited with code ${processResult.exitCode}`)
        : undefined);
    const classification = this.forcedShutdownAccepted
      ? 'forced'
      : exitError === undefined
        ? this.closeAfterTurnRequested || this.gracefulShutdownAccepted
          ? 'graceful'
          : 'natural'
        : 'failed';
    this.notifyExit(classification, exitError);
    this.lifecycleObservers.clear();

    if (this.completionFinalized) return;
    this.completionFinalized = true;
    this.completionDeferred.resolve(
      Object.freeze({
        ...(exitError === undefined ? {} : { error: exitError }),
        ...(processResult?.exitCode === undefined ? {} : { exitCode: processResult.exitCode }),
        ...(processResult?.signal === undefined ? {} : { signal: processResult.signal }),
        ...(processResult?.killedByInactivity === undefined
          ? {}
          : { killedByInactivity: processResult.killedByInactivity }),
        ...(this.settledResultText === undefined ? {} : { resultText: this.settledResultText }),
        ...(this.lastCompletedAssistantMessage === undefined
          ? {}
          : { lastCompletedAssistantMessage: this.lastCompletedAssistantMessage }),
        ...(this.settledResultText !== undefined || this.lastCompletedAssistantMessage !== undefined
          ? {
              finalMessage:
                this.settledResultText !== undefined
                  ? this.settledResultText
                  : this.lastCompletedAssistantMessage,
            }
          : {}),
      })
    );
  }

  private notifyExit(
    classification: 'natural' | 'graceful' | 'forced' | 'failed',
    error?: Error
  ): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.notifyObservers((observer) => observer.exit(classification, error));
  }

  private notifyObservers(callback: (observer: AgentProviderLifecycleObserver) => void): void {
    for (const observer of this.lifecycleObservers) {
      try {
        callback(observer);
      } catch (error) {
        this.options.debugLog(`Claude ${this.options.label} lifecycle callback failed:`, error);
      }
    }
  }

  private requireInput(): NonNullable<ExecuteWithTerminalInputResult['persistentAgent']> {
    if (this.inputController === undefined) {
      throw new Error(`Claude ${this.options.label} persistent runtime is not attached`);
    }
    return this.inputController;
  }
}

function createDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
