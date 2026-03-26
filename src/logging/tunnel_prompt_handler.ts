import { confirm, select, input, checkbox } from '@inquirer/prompts';
import type { PromptRequestMessage } from './structured_messages.js';
import type { PromptRequestHandler } from './tunnel_server.js';
import type { TunnelPromptResponseMessage } from './tunnel_protocol.js';
import { getActiveInputSource } from '../common/input_pause_registry.js';
import { runPrefixPrompt } from '../common/prefix_prompt.js';
import { sendStructured } from '../logging.js';
import { getLoggerAdapter } from './adapter.js';
import { HeadlessAdapter } from './headless_adapter.js';

function getHeadlessAdapter(): HeadlessAdapter | undefined {
  const adapter = getLoggerAdapter();
  return adapter instanceof HeadlessAdapter ? adapter : undefined;
}

/**
 * Creates a PromptRequestHandler that renders inquirer prompts on behalf of
 * tunnel clients. When a client sends a `prompt_request` message, this handler
 * translates the message into the corresponding `@inquirer/prompts` call,
 * collects the user's answer, and sends the result back via the `respond` callback.
 *
 * When a HeadlessAdapter is active (web UI connected), the handler races the
 * terminal inquirer prompt against a websocket response from the web UI, so
 * the prompt can be answered from either channel.
 *
 * Supports: confirm, select, input, checkbox, prefix_select.
 * Handles optional timeoutMs via AbortController.
 */
export function createPromptRequestHandler(): PromptRequestHandler {
  return async (
    message: PromptRequestMessage,
    respond: (response: TunnelPromptResponseMessage) => void
  ) => {
    const { requestId, promptType, promptConfig, timeoutMs } = message;

    // Set up abort controller for timeout if specified
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutSignals: AbortSignal[] = [];
    if (timeoutMs != null && timeoutMs > 0) {
      const controller = new AbortController();
      timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
      timeoutSignals.push(controller.signal);
    }

    // If the headless adapter is active, race against websocket responses
    const headlessAdapter = getHeadlessAdapter();
    let cancelWs: (() => void) | undefined;
    let wsPromise: Promise<unknown> | undefined;

    if (headlessAdapter) {
      const wsAbortController = new AbortController();
      const ws = headlessAdapter.waitForPromptResponse(requestId);
      wsPromise = ws.promise;
      cancelWs = ws.cancel;
      // Suppress unhandled rejection (cancel() rejects the promise)
      wsPromise.catch(() => {});
      // When ws resolves or is rejected, abort the terminal prompt
      wsPromise.then(
        () => wsAbortController.abort(),
        () => wsAbortController.abort()
      );
      timeoutSignals.push(wsAbortController.signal);
    }

    const signal =
      timeoutSignals.length === 1
        ? timeoutSignals[0]
        : timeoutSignals.length > 1
          ? AbortSignal.any(timeoutSignals)
          : undefined;

    // Pause terminal input reader to avoid stdin contention with inquirer
    const inputSource = getActiveInputSource();
    inputSource?.pause();

    try {
      let value: unknown;
      let source: 'terminal' | 'websocket' = 'terminal';

      try {
        switch (promptType) {
          case 'confirm': {
            value = await confirm(
              {
                message: promptConfig.message,
                default: promptConfig.default as boolean | undefined,
              },
              signal ? { signal } : undefined
            );
            break;
          }

          case 'select': {
            const choices = (promptConfig.choices ?? []).map((c) => ({
              name: c.name,
              value: c.value,
              description: c.description,
            }));

            value = await select(
              {
                message: promptConfig.message,
                choices,
                default: promptConfig.default,
                pageSize: promptConfig.pageSize,
              },
              signal ? { signal } : undefined
            );
            break;
          }

          case 'input': {
            value = await input(
              {
                message: promptConfig.message,
                default: promptConfig.default as string | undefined,
              },
              signal ? { signal } : undefined
            );
            break;
          }

          case 'checkbox': {
            const choices = (promptConfig.choices ?? []).map((c) => ({
              name: c.name,
              value: c.value,
              checked: c.checked,
              description: c.description,
            }));

            value = await checkbox(
              {
                message: promptConfig.message,
                choices,
                pageSize: promptConfig.pageSize,
              },
              signal ? { signal } : undefined
            );
            break;
          }

          case 'prefix_select': {
            value = await runPrefixPrompt(
              {
                message: promptConfig.message,
                command: typeof promptConfig.command === 'string' ? promptConfig.command : '',
              },
              signal ? { signal } : undefined
            );
            break;
          }

          default: {
            cancelWs?.();
            respond({
              type: 'prompt_response',
              requestId,
              error: `Unsupported prompt type: ${promptType as string}`,
            });
            return;
          }
        }

        // Terminal won the race
        cancelWs?.();
      } catch (err) {
        // Terminal was aborted. Check if websocket responded.
        cancelWs?.();
        if (wsPromise) {
          try {
            value = await wsPromise;
            source = 'websocket';
          } catch {
            // WS was also cancelled/failed — propagate the original error
            throw err;
          }
        } else {
          throw err;
        }
      }

      respond({
        type: 'prompt_response',
        requestId,
        value,
      });
      sendStructured({
        type: 'prompt_answered',
        timestamp: new Date().toISOString(),
        requestId,
        promptType,
        value,
        source,
      });
    } catch (err) {
      respond({
        type: 'prompt_response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendStructured({
        type: 'prompt_cancelled',
        timestamp: new Date().toISOString(),
        requestId,
      });
    } finally {
      inputSource?.resume();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  };
}
