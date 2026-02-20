import { loadEffectiveConfig } from '../configLoader.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from '../executors/index.js';
import { ClaudeCodeExecutorName, CodexCliExecutorName } from '../executors/schemas.js';
import { isCodexAppServerEnabled } from '../executors/codex_cli/app_server_mode.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { resolveOptionalPromptInput, type PromptResolverDeps } from './prompt_input.js';

const CHAT_COMPATIBLE_EXECUTORS = new Set([ClaudeCodeExecutorName, CodexCliExecutorName]);
const CHAT_EXECUTOR_ALIASES = new Map<string, string>([
  ['claude', ClaudeCodeExecutorName],
  [ClaudeCodeExecutorName, ClaudeCodeExecutorName],
  ['codex', CodexCliExecutorName],
  [CodexCliExecutorName, CodexCliExecutorName],
]);

export interface ChatCommandOptions {
  executor?: string;
  model?: string;
  promptFile?: string;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  headlessAdapter?: boolean;
}

export interface ChatGlobalOptions {
  config?: string;
}

function resolveChatExecutor(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  return CHAT_EXECUTOR_ALIASES.get(input.trim().toLowerCase());
}

export async function resolveOptionalPromptText(
  promptText: string | undefined,
  options: { promptFile?: string; stdinIsTTY?: boolean; tunnelActive?: boolean },
  deps: PromptResolverDeps = {}
): Promise<string | undefined> {
  const tunnelActive = options.tunnelActive ?? false;
  const hasPromptFile = Boolean(options.promptFile);
  const shouldReadStdinWhenNotTTY = !tunnelActive && !hasPromptFile;

  return resolveOptionalPromptInput(
    {
      promptText,
      promptFile: options.promptFile,
      stdinIsTTY: options.stdinIsTTY,
      readStdinWhenNotTTY: shouldReadStdinWhenNotTTY,
      preferPositionalPrompt: true,
    },
    deps
  );
}

export async function handleChatCommand(
  promptText: string | undefined,
  options: ChatCommandOptions,
  globalOpts: ChatGlobalOptions
): Promise<void> {
  const config = await loadEffectiveConfig(globalOpts.config);
  const requestedExecutorRaw = options.executor ?? config.defaultExecutor;
  const requestedExecutor = resolveChatExecutor(requestedExecutorRaw);
  if (requestedExecutorRaw && !requestedExecutor) {
    const allowed = [...CHAT_EXECUTOR_ALIASES.keys()].join(', ');
    if (options.executor) {
      throw new Error(
        `Executor '${requestedExecutorRaw}' is not supported by 'tim chat'. Supported executors: ${allowed}`
      );
    }
    // config.defaultExecutor is incompatible, fall back to DEFAULT_EXECUTOR
    console.warn(
      `Warning: defaultExecutor '${requestedExecutorRaw}' is not supported by 'tim chat'. Falling back to '${DEFAULT_EXECUTOR}'.`
    );
  }
  const executorName = requestedExecutor ?? DEFAULT_EXECUTOR;
  const tunnelActive = isTunnelActive();
  const prompt = await resolveOptionalPromptText(promptText, {
    promptFile: options.promptFile,
    stdinIsTTY: process.stdin.isTTY,
    tunnelActive,
  });
  const codexAppServerEnabled = isCodexAppServerEnabled();

  const noninteractive = options.nonInteractive === true;
  const canUseTerminalInput =
    !noninteractive &&
    process.stdin.isTTY === true &&
    options.terminalInput !== false &&
    config.terminalInput !== false;
  const terminalInputEnabled =
    executorName === CodexCliExecutorName && !codexAppServerEnabled ? false : canUseTerminalInput;

  if (executorName === CodexCliExecutorName && !codexAppServerEnabled && !prompt) {
    throw new Error(
      'codex-cli requires an explicit prompt. Provide a prompt via argument, --prompt-file, or stdin.'
    );
  }

  if (!prompt && !terminalInputEnabled && !tunnelActive) {
    throw new Error(
      'No input provided. Pass a prompt argument, --prompt-file, or stdin when running without terminal input.'
    );
  }

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: process.cwd(),
    model: options.model,
    noninteractive: noninteractive ? true : undefined,
    terminalInput: terminalInputEnabled,
    closeTerminalInputOnResult: false,
    disableInactivityTimeout: true,
  };
  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);
  const promptForExecution =
    executorName === CodexCliExecutorName && codexAppServerEnabled ? (prompt ?? '') : prompt;

  await runWithHeadlessAdapterIfEnabled({
    enabled: options.headlessAdapter === true || !tunnelActive,
    command: 'chat',
    config,
    callback: async () => {
      await executor.execute(promptForExecution, {
        planId: 'chat',
        planTitle: 'Chat Session',
        planFilePath: '',
        executionMode: 'bare',
      });
    },
  });
}
