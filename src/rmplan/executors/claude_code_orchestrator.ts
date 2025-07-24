import { spawnAndLogOutput, createLineSplitter } from '../../common/process.ts';
import { getGitRoot } from '../../common/git.ts';
import { log, debugLog } from '../../logging.ts';
import type { ClaudeCodeExecutorOptions } from './claude_code.ts';
import { formatJsonMessage, type Message } from './claude_code/format.ts';
import chalk from 'chalk';

export interface ClaudeCodeGenerationConfig {
  planningPrompt: string;
  generationPrompt: string;
  options: ClaudeCodeExecutorOptions;
  model?: string;
}

/**
 * Orchestrates a two-step interaction with Claude Code:
 * 1. First call with planning prompt to analyze the task
 * 2. Second call with generation prompt using the same session
 *
 * @param config Configuration containing prompts and options
 * @returns The result of the generation phase
 */
export async function runClaudeCodeGeneration(config: ClaudeCodeGenerationConfig): Promise<string> {
  const { planningPrompt, generationPrompt, options, model } = config;
  const gitRoot = await getGitRoot();

  // Build base arguments for Claude Code
  const baseArgs = ['claude'];

  // Add model if specified
  if (model?.includes('haiku') || model?.includes('sonnet') || model?.includes('opus')) {
    baseArgs.push('--model', model);
  }

  // Add allowed/disallowed tools configuration
  const defaultAllowedTools =
    (options.includeDefaultTools ?? true)
      ? [
          'Edit',
          'MultiEdit',
          'Write',
          'WebFetch',
          'WebSearch',
          'Bash(cat:*)',
          'Bash(cd:*)',
          'Bash(cp:*)',
          'Bash(find:*)',
          'Bash(grep:*)',
          'Bash(ls:*)',
          'Bash(mkdir:*)',
          'Bash(mv:*)',
          'Bash(pwd)',
          'Bash(rg:*)',
          'Bash(sed:*)',
          'Bash(rm test-:*)',
          'Bash(rm -f test-:*)',
          'Bash(jj status)',
          'Bash(jj log:*)',
          'Bash(jj commit:*)',
          'Bash(npm test:*)',
          'Bash(npm run build:*)',
          'Bash(npm run check:*)',
          'Bash(npm run typecheck:*)',
          'Bash(npm run lint:*)',
          'Bash(npm install)',
          'Bash(npm add:*)',
          'Bash(pnpm test:*)',
          'Bash(pnpm run build:*)',
          'Bash(pnpm run check:*)',
          'Bash(pnpm run typecheck:*)',
          'Bash(pnpm run lint:*)',
          'Bash(pnpm install)',
          'Bash(pnpm add:*)',
          'Bash(yarn test:*)',
          'Bash(yarn run build:*)',
          'Bash(yarn run check:*)',
          'Bash(yarn run typecheck:*)',
          'Bash(yarn run lint:*)',
          'Bash(yarn install)',
          'Bash(yarn add:*)',
          'Bash(bun test:*)',
          'Bash(bun run build:*)',
          'Bash(bun run check:*)',
          'Bash(bun run typecheck:*)',
          'Bash(bun run lint:*)',
          'Bash(bun install)',
          'Bash(bun add:*)',
          'Bash(cargo add:*)',
          'Bash(cargo build)',
          'Bash(cargo test:*)',
        ]
      : [];

  let allowedTools = [...defaultAllowedTools, ...(options.allowedTools ?? [])];
  if (options.disallowedTools) {
    allowedTools = allowedTools.filter((t) => !options.disallowedTools?.includes(t));
  }

  if (allowedTools.length) {
    baseArgs.push('--allowedTools', allowedTools.join(','));
  }

  if (options.allowAllTools) {
    baseArgs.push('--dangerously-skip-permissions');
  }

  if (options.disallowedTools) {
    baseArgs.push('--disallowedTools', options.disallowedTools.join(','));
  }

  if (options.mcpConfigFile) {
    baseArgs.push('--mcp-config', options.mcpConfigFile);
  }

  // Common arguments for non-interactive mode
  baseArgs.push('--verbose', '--output-format', 'stream-json');

  let sessionId: string | undefined;

  // Step 1: Execute with planning prompt
  log(chalk.bold.blue('### Step 1: Planning Phase'));

  const planningArgs = [...baseArgs, '--print', planningPrompt];
  const splitter = createLineSplitter();

  const planningResult = await spawnAndLogOutput(planningArgs, {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
    },
    cwd: gitRoot,
    formatStdout: (output) => {
      const lines = splitter(output);
      const formatted = lines
        .map((line) => {
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
          return formatJsonMessage(line);
        })
        .filter(Boolean)
        .join('\n\n');
      return formatted ? formatted + '\n\n' : '';
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

  // Step 2: Execute with generation prompt, resuming the session
  log(chalk.bold.blue('### Step 2: Generation Phase'));
  log(`Resuming session: ${sessionId}`);

  const generationArgs = [...baseArgs, '-r', sessionId, '--print', generationPrompt];
  let generationOutput = '';

  const generationResult = await spawnAndLogOutput(generationArgs, {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.CLAUDE_API ? (process.env.ANTHROPIC_API_KEY ?? '') : '',
    },
    cwd: gitRoot,
    formatStdout: (output) => {
      const lines = splitter(output);
      let messages = lines.map((line) => JSON.parse(line) as Message);

      const resultMessage = messages.find((m) => m.type === 'result');
      if (resultMessage && resultMessage.subtype === 'success') {
        generationOutput = resultMessage.result;
      }

      const formatted = lines.map(formatJsonMessage).filter(Boolean).join('\n\n');
      return formatted ? formatted + '\n\n' : '';
    },
  });

  if (generationResult.exitCode !== 0) {
    throw new Error(
      `Claude generation phase exited with non-zero exit code: ${generationResult.exitCode}`
    );
  }

  return generationOutput;
}
