import chalk from 'chalk';
import { createLineSplitter, debug as processDebug } from '../../../common/process.ts';
import { debugLog } from '../../../logging.ts';

// Envelope for Codex CLI JSON stream lines
export interface CodexEnvelope<T = unknown> {
  id?: string | number;
  msg?: T;
  // Some initial line may not be under `msg` – accept arbitrary fields
  [key: Exclude<string, 'id' | 'msg'>]: any;
}

interface AnyMessage {
  type: string;

  [key: string]: any;
}

// Known Codex message variants (inside envelope.msg)
export type CodexMessage =
  | { type: 'task_started'; model_context_window?: number }
  | { type: 'agent_reasoning'; text?: string }
  | { type: 'agent_reasoning_section_break' }
  | {
      type: 'exec_command_begin';
      call_id: string;
      command: string[];
      cwd?: string;
      parsed_cmd?: unknown;
    }
  | {
      type: 'exec_command_output_delta';
      call_id: string;
      stream: 'stdout' | 'stderr';
      chunk: string; // often base64-encoded
      encoding?: 'base64' | 'utf8';
    }
  | {
      type: 'exec_command_end';
      call_id: string;
      stdout?: string;
      stderr?: string;
      exit_code: number;
      duration?: { secs?: number; nanos?: number };
      formatted_output?: string;
      aggregated_output?: string;
    }
  | { type: 'token_count'; info: any }
  | { type: 'agent_message'; message?: string }
  | { type: 'turn_diff'; unified_diff?: string }
  | {
      type: 'patch_apply_begin';
      call_id: string;
      auto_approved?: boolean;
      changes: Record<
        string,
        | {
            add: { content: string };
          }
        | { update: { unified_diff?: string; move_path: string | null } }
      >;
    }
  | {
      type: 'patch_apply_end';
      call_id: string;
      stdout?: string;
      stderr?: string;
      success?: boolean;
    };

export interface FormattedCodexMessage {
  // Pretty-printed message to display to the console (optional for ignored types)
  message?: string;
  // A simplified type label for routing/logic
  type: string;
  // If this line carries or finalizes the agent message, include it here
  agentMessage?: string;
  // Failure detection info for agent messages
  failed?: boolean;
}

function truncateToLines(input: string | undefined, maxLines = 20): string {
  if (!input) return '';
  const lines = input.split('\n');
  if (lines.length <= maxLines) return input;
  return [...lines.slice(0, maxLines), '(truncated long output...)'].join('\n');
}

// Some codex lines may be plain objects describing initial run config (before `task_started`).
function tryFormatInitial(lineObj: CodexEnvelope): FormattedCodexMessage | undefined {
  if (lineObj && !lineObj.msg && (lineObj.model || lineObj.provider || lineObj.sandbox)) {
    const ts = new Date().toTimeString().split(' ')[0];
    const desc = [
      lineObj.model ? `Model: ${lineObj.model}` : undefined,
      lineObj.provider ? `Provider: ${lineObj.provider}` : undefined,
      lineObj.sandbox ? `Sandbox: ${lineObj.sandbox}` : undefined,
      lineObj.workdir ? `Workdir: ${lineObj.workdir}` : undefined,
      lineObj.approval ? `Approval: ${lineObj.approval}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return { message: chalk.bold.green(`### Start [${ts}]\n`) + desc, type: 'init' };
  }
  return undefined;
}

export function formatCodexJsonMessage(jsonLine: string): FormattedCodexMessage {
  try {
    if (!jsonLine || jsonLine.trim() === '') return { type: '' };
    const obj = JSON.parse(jsonLine) as CodexEnvelope<CodexMessage>;

    // Initial line without msg
    const initial = tryFormatInitial(obj);
    if (initial) return initial;

    const msg = obj.msg;
    if (msg == null || typeof msg !== 'object' || !('type' in msg)) {
      return { type: 'unknown' };
    }

    const ts = new Date().toTimeString().split(' ')[0];

    switch (msg.type) {
      case 'task_started': {
        return {
          type: msg.type,
          message: chalk.bold.green(`### Task Started [${ts}]`),
        };
      }
      case 'agent_reasoning': {
        const text = msg.text ?? '';
        return {
          type: msg.type,
          message: chalk.blue(`### Thinking [${ts}]\n\n`) + text,
        };
      }
      case 'agent_reasoning_section_break': {
        return { type: msg.type }; // ignore quietly
      }
      case 'exec_command_begin': {
        const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command);
        const cwd = msg.cwd ? `\nCWD: ${msg.cwd}` : '';
        return {
          type: msg.type,
          message: chalk.cyan(`### Exec Begin [${ts}]\n\n`) + cmd + cwd,
        };
      }
      case 'exec_command_output_delta': {
        // Streamed deltas can be noisy; skip detailed printing. We'll show final output on end.
        return { type: msg.type };
      }
      case 'exec_command_end': {
        const out = msg.formatted_output ?? msg.aggregated_output ?? msg.stdout ?? '';
        const truncated = truncateToLines(out, 20);
        const header = chalk.cyan(`### Exec End [${ts}] (exit ${msg.exit_code})`);
        return { type: msg.type, message: `${header}\n\n${truncated}` };
      }
      case 'token_count': {
        const info = msg.info ?? {};
        const total = info.total_token_usage;
        const last = info.last_token_usage;
        const contextWindow = info.model_context_window;

        const parts = [];
        if (total) {
          const totalTokens = total.total_tokens || 0;
          const inputTokens = total.input_tokens || 0;
          const cachedInputTokens = total.cached_input_tokens || 0;
          const outputTokens = total.output_tokens || 0;
          const reasoningTokens = total.reasoning_output_tokens || 0;

          parts.push(`Total: ${totalTokens.toLocaleString()} tokens`);
          parts.push(
            `  Input: ${inputTokens.toLocaleString()} (${cachedInputTokens.toLocaleString()} cached)`
          );
          if (reasoningTokens > 0) {
            parts.push(
              `  Output: ${outputTokens.toLocaleString()} + ${reasoningTokens.toLocaleString()} reasoning`
            );
          } else {
            parts.push(`  Output: ${outputTokens.toLocaleString()}`);
          }
        }

        if (last && last.total_tokens) {
          parts.push(`Last: ${last.total_tokens.toLocaleString()} tokens`);
        }

        if (contextWindow) {
          parts.push(`Context Window: ${contextWindow.toLocaleString()}`);
        }

        return {
          type: msg.type,
          message: chalk.gray(`### Token Count [${ts}]\n\n`) + parts.join('\n'),
        };
      }
      case 'agent_message': {
        const text = msg.message ?? '';
        // Failure detection: recognize standardized FAILED: protocol on first non-empty line
        const failed = /^\s*FAILED:\s*/.test((text || '').replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim() !== '') ?? '');
        return {
          type: msg.type,
          message: chalk.bold.green(`### Agent Message [${ts}]`) + '\n\n' + text,
          agentMessage: text,
          failed: failed || undefined,
        };
      }
      case 'turn_diff': {
        const diff = msg.unified_diff ?? '';
        // Extract filenames from +++ and --- lines in the unified diff
        const fileMatches = diff.match(/^(?:\+\+\+|---) (.+)$/gm) || [];
        const filenames = fileMatches
          .map((match) => match.replace(/^(?:\+\+\+|---) /, '').replace(/\t.*$/, ''))
          .filter((filename) => filename !== '/dev/null') // Skip /dev/null entries
          .map((filename) => {
            // Strip a/ and b/ prefixes from git diff format
            if (filename.startsWith('a/') || filename.startsWith('b/')) {
              return filename.substring(2);
            }
            return filename;
          });
        const uniqueFiles = [...new Set(filenames)];

        // Count added and removed lines
        const diffLines = diff.split('\n');
        let addedLines = 0;
        let removedLines = 0;
        for (const line of diffLines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            addedLines++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            removedLines++;
          }
        }

        const fileCount = uniqueFiles.length;
        const fileText = fileCount === 1 ? '1 file' : `${fileCount} files`;
        const fileList =
          uniqueFiles.length <= 3
            ? uniqueFiles.join(', ')
            : `${uniqueFiles.slice(0, 3).join(', ')} and ${uniqueFiles.length - 3} more`;

        const changeStats = [];
        if (addedLines > 0) changeStats.push(chalk.green(`+${addedLines}`));
        if (removedLines > 0) changeStats.push(chalk.red(`-${removedLines}`));
        const statsText = changeStats.length > 0 ? ` (${changeStats.join(', ')})` : '';

        return {
          type: msg.type,
          message:
            chalk.magenta(`### Turn Diff [${ts}]\n\n`) +
            `Changes to ${fileText}${uniqueFiles.length > 0 ? `: ${fileList}` : ''}${statsText}`,
        };
      }
      case 'patch_apply_begin': {
        const autoApproved = msg.auto_approved ? ' (auto-approved)' : '';
        const changes = msg.changes;
        const changeCount = Object.keys(changes).length;
        const changeText = changeCount === 1 ? '1 file' : `${changeCount} files`;

        const header =
          chalk.yellow(`### Patch Apply Begin [${ts}]${autoApproved}\n\n`) +
          `Applying changes to ${changeText}:\n\n`;

        const fileDetails = Object.entries(changes)
          .map(([filePath, change]) => {
            if ('add' in change) {
              const content = truncateToLines(change.add.content, 10);
              return `${chalk.green('ADD')} ${filePath}:\n${content}`;
            } else if ('update' in change) {
              const diff = change.update.unified_diff || '';
              const movePath = change.update.move_path;
              const content = truncateToLines(diff, 10);
              const moveText = movePath ? ` -> ${movePath}` : '';
              return `${chalk.cyan('UPDATE')} ${filePath}${moveText}:\n${content}`;
            } else if ('remove' in change) {
              return `${chalk.red('REMOVE')} ${filePath}`;
            }

            return `${chalk.gray('UNKNOWN')} ${JSON.stringify(change)}`;
          })
          .join('\n\n');

        return {
          type: msg.type,
          message: header + fileDetails,
        };
      }
      case 'patch_apply_end': {
        const success = msg.success ? 'SUCCESS' : 'FAILED';
        const color = msg.success ? chalk.green : chalk.red;
        const output = msg.stdout || msg.stderr || '';
        const truncated = truncateToLines(output, 10);
        return {
          type: msg.type,
          message: color(`### Patch Apply End [${ts}] - ${success}\n\n`) + truncated,
        };
      }
      default: {
        // Unknown but well-formed message; print compactly for debugging
        return { type: (msg as AnyMessage).type, message: JSON.stringify(msg) };
      }
    }
  } catch (err) {
    debugLog('Failed to parse Codex JSON line:', jsonLine, err);
    return { type: 'parse_error', message: jsonLine };
  }
}

/**
 * Utility to integrate with spawnAndLogOutput.formatStdout. Handles chunk splitting,
 * line-by-line JSON parsing/formatting, and captures the final agent message.
 */
export function createCodexStdoutFormatter() {
  const split = createLineSplitter();
  let finalAgentMessage: string | undefined;
  let lastFailedAgentMessage: string | undefined;

  function formatChunk(chunk: string): string {
    const lines = split(chunk);
    const out: string[] = [];
    for (const line of lines) {
      const fm = formatCodexJsonMessage(line);
      if (fm.agentMessage) {
        finalAgentMessage = fm.agentMessage;
        if (fm.failed) lastFailedAgentMessage = fm.agentMessage;
      }
      if (fm.message) out.push(fm.message);
    }
    return out.length ? out.join('\n\n') + '\n\n' : '';
  }

  function getFinalAgentMessage(): string | undefined {
    return finalAgentMessage;
  }

  function getFailedAgentMessage(): string | undefined {
    return lastFailedAgentMessage;
  }

  return { formatChunk, getFinalAgentMessage, getFailedAgentMessage };
}
