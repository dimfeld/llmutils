import chalk from 'chalk';
import { createLineSplitter, debug as processDebug } from '../../../common/process.ts';
import { debugLog } from '../../../logging.ts';

// Envelope for Codex CLI JSON stream lines
export interface CodexEnvelope<T = unknown> {
  id?: string | number;
  msg?: T;
  // Some initial line may not be under `msg` – accept arbitrary fields
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
  | { type: 'agent_message'; text?: string }
  | { type: string; [key: string]: any };

export interface FormattedCodexMessage {
  // Pretty-printed message to display to the console (optional for ignored types)
  message?: string;
  // A simplified type label for routing/logic
  type: string;
  // If this line carries or finalizes the agent message, include it here
  agentMessage?: string;
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

    const msg = obj.msg as CodexMessage | undefined;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
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
          message: chalk.blue(`### Thinking [${ts}]\n`) + text,
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
          message: chalk.cyan(`### Exec Begin [${ts}]\n`) + cmd + cwd,
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
        return { type: msg.type, message: `${header}\n${truncated}` };
      }
      case 'token_count': {
        const info = msg.info ?? {};
        const total = info.total_token_usage?.total_tokens ?? info.total_token_usage?.output_tokens;
        return {
          type: msg.type,
          message: chalk.gray(`### Token Count [${ts}]\n`) + JSON.stringify(info),
        };
      }
      case 'agent_message': {
        const text = msg.text ?? '';
        return {
          type: msg.type,
          message: chalk.bold.green(`### Agent Message [${ts}]`) + '\n' + text,
          agentMessage: text,
        };
      }
      default: {
        // Unknown but well-formed message; print compactly for debugging
        return { type: msg.type, message: JSON.stringify(msg) };
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

  function formatChunk(chunk: string): string {
    const lines = split(chunk);
    const out: string[] = [];
    for (const line of lines) {
      const fm = formatCodexJsonMessage(line);
      if (fm.agentMessage) {
        finalAgentMessage = fm.agentMessage;
      }
      if (fm.message) out.push(fm.message);
    }
    return out.length ? out.join('\n') + '\n' : '';
  }

  function getFinalAgentMessage(): string | undefined {
    return finalAgentMessage;
  }

  return { formatChunk, getFinalAgentMessage };
}

