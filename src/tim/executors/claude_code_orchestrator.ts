import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawnAndLogOutput, createLineSplitter } from '../../common/process.ts';
import { getGitRoot } from '../../common/git.ts';
import { log, debugLog, warn } from '../../logging.ts';
import type { ClaudeCodeExecutorOptions } from './claude_code.ts';
import {
  extractStructuredMessagesFromLines,
  resetToolUseCache,
  type Message,
} from './claude_code/format.ts';
import chalk from 'chalk';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { createTunnelServer, type TunnelServer } from '../../logging/tunnel_server.js';
import { TIM_OUTPUT_SOCKET } from '../../logging/tunnel_protocol.js';

export interface ClaudeCodeGenerationConfig {
  planningPrompt: string;
  generationPrompt: string;
  researchPrompt?: string;
  options: ClaudeCodeExecutorOptions;
  model?: string;
}

export interface ClaudeCodeGenerationResult {
  generationOutput: string;
  researchOutput?: string;
}

/**
 * Orchestrates a multi-step interaction with Claude Code:
 * 1. First call with planning prompt to analyze the task
 * 2. Optional research preservation call to capture findings
 * 3. Final call with generation prompt using the same session
 *
 * @param config Configuration containing prompts and options
 * @returns Generation result along with any captured research output
 */
export async function runClaudeCodeGeneration(
  config: ClaudeCodeGenerationConfig
): Promise<ClaudeCodeGenerationResult> {
  const { planningPrompt, generationPrompt, researchPrompt, options, model } = config;
  const gitRoot = await getGitRoot();

  // Create tunnel server for output forwarding from child processes
  let tunnelServer: TunnelServer | undefined;
  let tunnelTempDir: string | undefined;
  let tunnelSocketPath: string | undefined;
  if (!isTunnelActive()) {
    try {
      tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-'));
      tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
      tunnelServer = await createTunnelServer(tunnelSocketPath);
    } catch (err) {
      debugLog('Could not create tunnel server for output forwarding:', err);
    }
  }

  const tunnelEnv: Record<string, string> =
    tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {};

  try {
    // Build base arguments for Claude Code
    const baseArgs = ['claude'];

    const extractResultFromMessages = (messages: Message[]): string | undefined => {
      const resultMessage = messages.find((m) => m.type === 'result');
      if (resultMessage && resultMessage.subtype === 'success' && resultMessage.result) {
        return resultMessage.result;
      }

      const lastAssistant = messages.findLast((m) => m.type === 'assistant');
      if (lastAssistant?.message) {
        const lastText = lastAssistant.message.content.findLast((c) => c.type === 'text');
        if (lastText) {
          return lastText.text;
        }
      }

      return undefined;
    };

    // Add model if specified
    if (model?.includes('haiku') || model?.includes('sonnet') || model?.includes('opus')) {
      baseArgs.push('--model', model);
    }

    // Add allowed/disallowed tools configuration
    const defaultAllowedTools =
      (options.includeDefaultTools ?? true)
        ? [
            'WebFetch',
            'WebSearch',
            'Bash(cat:*)',
            'Bash(cd:*)',
            'Bash(cp:*)',
            'Bash(find:*)',
            'Bash(grep:*)',
            'Bash(ls:*)',
            'Bash(mkdir:*)',
            'Bash(pwd)',
            'Bash(rg:*)',
            'Bash(sed:*)',
            'Bash(jj status)',
            'Bash(jj log:*)',
          ]
        : [];

    let allowedTools = [...defaultAllowedTools, ...(options.allowedTools ?? [])];
    if (options.disallowedTools) {
      allowedTools = allowedTools.filter((t) => !options.disallowedTools?.includes(t));
    }

    let disallowedTools = [
      'Edit',
      'MultiEdit',
      'Write',
      'NotebookEdit',
      ...(options.disallowedTools ?? []),
    ];

    if (allowedTools.length) {
      baseArgs.push('--allowedTools', allowedTools.join(','));
    }

    if (options.allowAllTools) {
      baseArgs.push('--dangerously-skip-permissions');
    }

    baseArgs.push('--disallowedTools', disallowedTools.join(','));

    if (options.mcpConfigFile) {
      baseArgs.push('--mcp-config', options.mcpConfigFile);
    }

    // Common arguments for non-interactive mode
    baseArgs.push('--verbose', '--output-format', 'stream-json');

    let sessionId: string | undefined;

    // Step 1: Execute with planning prompt
    log(chalk.bold.blue('### Step 1: Planning Phase'));

    const planningArgs = [...baseArgs, '--print', planningPrompt];
    const planningSplitter = createLineSplitter();

    resetToolUseCache();
    const planningResult = await spawnAndLogOutput(planningArgs, {
      env: {
        ...process.env,
        TIM_NOTIFY_SUPPRESS: '1',
        ...tunnelEnv,
        ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
      },
      cwd: gitRoot,
      formatStdout: (output) => {
        const lines = planningSplitter(output);
        for (const line of lines) {
          // Try to parse each line to extract session ID
          try {
            const parsed = JSON.parse(line);
            if (parsed.session_id && !sessionId) {
              sessionId = parsed.session_id;
              debugLog(`Captured session ID: ${sessionId}`);
            }
          } catch {
            // Not JSON, ignore
          }
        }
        const structuredMessages = extractStructuredMessagesFromLines(lines);

        return structuredMessages.length > 0 ? structuredMessages : '';
      },
    });

    if (planningResult.exitCode !== 0) {
      throw new Error(
        `Claude planning phase exited with non-zero exit code: ${planningResult.exitCode}`
      );
    }

    if (!sessionId) {
      throw new Error('Failed to extract session ID from planning phase output');
    }

    let researchOutput: string | undefined;

    if (researchPrompt) {
      log(chalk.bold.blue('### Step 2: Research Preservation Phase'));
      log(`Resuming session: ${sessionId}`);

      const researchArgs = [...baseArgs, '-r', sessionId, '--print', researchPrompt];
      const researchSplitter = createLineSplitter();

      try {
        resetToolUseCache();
        const researchResult = await spawnAndLogOutput(researchArgs, {
          env: {
            ...process.env,
            TIM_NOTIFY_SUPPRESS: '1',
            ...tunnelEnv,
            ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
          },
          cwd: gitRoot,
          formatStdout: (output) => {
            const lines = researchSplitter(output);
            const messages: Message[] = lines
              .map((line) => {
                try {
                  return JSON.parse(line) as Message;
                } catch {
                  return undefined;
                }
              })
              .filter((msg): msg is Message => Boolean(msg));

            const candidate = extractResultFromMessages(messages);
            if (candidate) {
              researchOutput = candidate;
            }

            const structuredMessages = extractStructuredMessagesFromLines(lines);
            return structuredMessages.length > 0 ? structuredMessages : '';
          },
        });

        if (researchResult.exitCode !== 0) {
          warn(
            `Claude research phase exited with non-zero exit code (${researchResult.exitCode}). Continuing without research preservation.`
          );
        }
      } catch (error) {
        warn(
          `Claude research phase failed: ${(error as Error).message}. Continuing without research preservation.`
        );
        debugLog('Research phase error details:', error);
      }
    }

    const generationStepNumber = researchPrompt
      ? '### Step 3: Generation Phase'
      : '### Step 2: Generation Phase';
    log(chalk.bold.blue(generationStepNumber));
    log(`Resuming session: ${sessionId}`);

    const generationArgs = [...baseArgs, '-r', sessionId, '--print', generationPrompt];
    let generationOutput = '';
    const generationSplitter = createLineSplitter();

    resetToolUseCache();
    const generationResult = await spawnAndLogOutput(generationArgs, {
      env: {
        ...process.env,
        TIM_NOTIFY_SUPPRESS: '1',
        ...tunnelEnv,
        ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
      },
      cwd: gitRoot,
      formatStdout: (output) => {
        const lines = generationSplitter(output);
        const messages: Message[] = lines
          .map((line) => {
            try {
              return JSON.parse(line) as Message;
            } catch {
              return undefined;
            }
          })
          .filter((msg): msg is Message => Boolean(msg));

        const candidate = extractResultFromMessages(messages);
        if (candidate) {
          generationOutput = candidate;
        }

        const structuredMessages = extractStructuredMessagesFromLines(lines);
        return structuredMessages.length > 0 ? structuredMessages : '';
      },
    });

    if (generationResult.exitCode !== 0) {
      throw new Error(
        `Claude generation phase exited with non-zero exit code: ${generationResult.exitCode}`
      );
    }

    return {
      generationOutput,
      researchOutput,
    };
  } finally {
    // Clean up tunnel server and temp directory
    tunnelServer?.close();
    if (tunnelTempDir) {
      await fs.rm(tunnelTempDir, { recursive: true, force: true });
    }
  }
}
