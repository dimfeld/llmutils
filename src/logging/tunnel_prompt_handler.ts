import { confirm, select, input, checkbox } from '@inquirer/prompts';
import type { PromptRequestMessage } from './structured_messages.js';
import type { PromptRequestHandler } from './tunnel_server.js';
import type { TunnelPromptResponseMessage } from './tunnel_protocol.js';
import { getActiveInputSource } from '../common/input_pause_registry.js';
import { runPrefixPrompt } from '../common/prefix_prompt.js';

/**
 * Creates a PromptRequestHandler that renders inquirer prompts on behalf of
 * tunnel clients. When a client sends a `prompt_request` message, this handler
 * translates the message into the corresponding `@inquirer/prompts` call,
 * collects the user's answer, and sends the result back via the `respond` callback.
 *
 * Supports: confirm, select, input, checkbox.
 * Handles optional timeoutMs via AbortController.
 */
export function createPromptRequestHandler(): PromptRequestHandler {
  return async (
    message: PromptRequestMessage,
    respond: (response: TunnelPromptResponseMessage) => void
  ) => {
    const { requestId, promptType, promptConfig, timeoutMs } = message;

    // Set up abort controller for timeout if specified
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs != null && timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => {
        controller!.abort();
      }, timeoutMs);
    }

    const signal = controller?.signal;

    // Pause terminal input reader to avoid stdin contention with inquirer
    const inputSource = getActiveInputSource();
    inputSource?.pause();

    try {
      let value: unknown;

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
          respond({
            type: 'prompt_response',
            requestId,
            error: `Unsupported prompt type: ${promptType as string}`,
          });
          return;
        }
      }

      respond({
        type: 'prompt_response',
        requestId,
        value,
      });
    } catch (err) {
      respond({
        type: 'prompt_response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inputSource?.resume();
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}
