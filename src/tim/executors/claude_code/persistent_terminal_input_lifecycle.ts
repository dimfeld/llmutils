import type { SpawnAndLogOutputResult } from '../../../common/process.ts';
import { PersistentClaudeTurnController } from './persistent_agent_lifecycle.ts';
import type { FormattedClaudeMessage } from './format.ts';
import type {
  ExecuteWithTerminalInputOptions,
  ExecuteWithTerminalInputResult,
} from './terminal_input_lifecycle.ts';

/**
 * Owns the persistent input branch of Claude execution.
 *
 * This path has no terminal, tunnel, or headless handlers. The turn
 * controller owns provider state and the stream writer only owns serialized
 * sink mechanics.
 */
export function executePersistentWithTerminalInput(
  options: ExecuteWithTerminalInputOptions & {
    readonly persistentAgent: NonNullable<ExecuteWithTerminalInputOptions['persistentAgent']>;
  }
): ExecuteWithTerminalInputResult {
  const { streaming, debugLog, persistentAgent } = options;
  const controller = new PersistentClaudeTurnController({
    ...persistentAgent,
    initialPrompt: persistentAgent.initialPrompt ?? options.prompt,
    stdin: streaming.stdin,
    debugLog,
  });

  let cleanupStarted = false;
  const handleProcessSigterm = (): void => {
    controller.forceCloseInputNow();
    streaming.kill('SIGTERM');
  };
  process.on('SIGTERM', handleProcessSigterm);

  controller.start();

  const resultPromise: Promise<SpawnAndLogOutputResult> = streaming.result.then(
    (result) => {
      controller.markProviderExited();
      return result;
    },
    (error: unknown) => {
      controller.markProviderFailed(error);
      throw error;
    }
  );

  const sendFollowUp = (content: string): void => {
    if (cleanupStarted) return;
    void Promise.resolve(controller.sendContent(content)).catch((error: unknown) => {
      debugLog('Failed to send persistent Claude input: %s', error);
    });
  };

  return {
    resultPromise,
    onResultMessage: (resultWasSuccessful: boolean, resultText?: string): void => {
      if (cleanupStarted) return;
      controller.onResultMessage(resultWasSuccessful, resultText);
    },
    observeFormattedMessage: (formatted: FormattedClaudeMessage): void => {
      if (cleanupStarted) return;
      controller.observeFormattedMessage(formatted);
    },
    sendFollowUpForInterceptedResult: sendFollowUp,
    acceptedSuccessfulFinalResult: (): boolean => false,
    endSession: (): void => {
      if (cleanupStarted) return;
      controller.forceCloseInputNow();
    },
    cleanup: (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      controller.cleanup();
      process.off('SIGTERM', handleProcessSigterm);
    },
    persistentAgent: controller,
  };
}
