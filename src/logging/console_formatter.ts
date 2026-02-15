import chalk from 'chalk';
import type { StructuredMessage, FileChangeItem } from './structured_messages.js';
import { formatExecutionSummaryToLines } from '../tim/summary/format.js';
import { formatTodoLikeLines } from '../tim/executors/shared/todo_format.js';

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return timestamp;
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const TRUNCATE_LINES = 40;

function truncateLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= TRUNCATE_LINES) return text;
  const truncated = lines.length - TRUNCATE_LINES;
  return lines.slice(0, TRUNCATE_LINES).join('\n') + `\n... (${truncated} lines truncated)`;
}

function formatHeader(color: (value: string) => string, title: string, timestamp?: string): string {
  const ts = timestamp ? ` [${formatTimestamp(timestamp)}]` : '';
  return color(`### ${title}${ts}`);
}

function formatFileChange(change: FileChangeItem): string {
  if (change.kind === 'added') {
    return `${chalk.green('+')} ${change.path}`;
  }

  if (change.kind === 'updated') {
    return `${chalk.cyan('~')} ${change.path}`;
  }

  if (change.kind === 'removed') {
    return `${chalk.red('-')} ${change.path}`;
  }

  const _exhaustive: never = change.kind;
  return _exhaustive;
}

function colorizeDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return chalk.green(line);
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return chalk.red(line);
      }
      return line;
    })
    .join('\n');
}

export function formatStructuredMessage(message: StructuredMessage): string {
  switch (message.type) {
    case 'agent_session_start': {
      const details = [
        message.executor ? `Executor: ${message.executor}` : undefined,
        message.mode ? `Mode: ${message.mode}` : undefined,
        message.planId ? `Plan: ${message.planId}` : undefined,
      ].filter(Boolean);
      const suffix = details.length > 0 ? ` - ${details.join(', ')}` : '';
      return formatHeader(chalk.bold.green, 'Starting', message.timestamp) + suffix;
    }
    case 'agent_session_end': {
      const info: string[] = [];

      info.push(`Success: ${message.success ? chalk.green('yes') : chalk.red('no')}`);
      if (message.durationMs != null)
        info.push(`Duration: ${Math.round(message.durationMs / 1000)}s`);
      if (message.costUsd != null) info.push(`Cost: $${message.costUsd.toFixed(2)}`);
      if (message.turns != null) info.push(`Turns: ${message.turns}`);

      const line = formatHeader(chalk.bold.green, 'Done', message.timestamp) + ' - ' + info.join(', ');

      if (message.summary) return line + '\n' + message.summary;
      return line;
    }
    case 'agent_iteration_start':
      return [
        chalk.bold.blue(`### Iteration ${message.iterationNumber}`),
        message.taskTitle ? chalk.bold(message.taskTitle) : undefined,
        message.taskDescription,
      ]
        .filter(Boolean)
        .join('\n');
    case 'agent_step_start': {
      const phase = message.phase ? `Step Start: ${message.phase}` : 'Step Start';
      const lines = [formatHeader(chalk.bold.blue, phase, message.timestamp), message.message];
      return lines.filter(Boolean).join('\n');
    }
    case 'agent_step_end': {
      const phase = message.phase ? `Step End: ${message.phase}` : 'Step End';
      const statusColor = message.success ? chalk.green : chalk.red;
      const lines = [formatHeader(statusColor, phase, message.timestamp), message.summary];
      return lines.filter(Boolean).join('\n');
    }
    case 'llm_thinking':
      return `${formatHeader(chalk.blue, 'Thinking', message.timestamp)}\n${message.text}`;
    case 'llm_response':
      return `${formatHeader(chalk.bold.green, message.isUserRequest ? 'User' : 'Model Response', message.timestamp)}\n${message.text}`;
    case 'llm_tool_use':
      return [
        formatHeader(chalk.cyan, `Invoke Tool: ${message.toolName}`, message.timestamp),
        message.inputSummary,
      ]
        .filter(Boolean)
        .join('\n');
    case 'llm_tool_result':
      return [
        formatHeader(chalk.magenta, `Tool Result: ${message.toolName}`, message.timestamp),
        message.resultSummary
          ? message.toolName === 'Task'
            ? message.resultSummary
            : truncateLines(message.resultSummary)
          : undefined,
      ]
        .filter(Boolean)
        .join('\n');
    case 'llm_status':
      return [formatHeader(chalk.gray, 'Status', message.timestamp), message.status, message.detail]
        .filter(Boolean)
        .join('\n');
    case 'todo_update': {
      const lines = formatTodoLikeLines(
        message.items.map((item) => ({ label: item.label, status: item.status })),
        { includePriority: false }
      );
      return [formatHeader(chalk.blue, 'Todo Update', message.timestamp), ...lines]
        .filter(Boolean)
        .join('\n');
    }
    case 'file_write':
      return `${formatHeader(chalk.cyan, 'Invoke Tool: Write', message.timestamp)}\n${message.path} (${message.lineCount} lines)`;
    case 'file_edit':
      return `${formatHeader(chalk.cyan, 'Invoke Tool: Edit', message.timestamp)}\n${message.path}\n${colorizeDiff(message.diff)}`;
    case 'file_change_summary': {
      const lines = [formatHeader(chalk.cyan, 'File Changes', message.timestamp)];
      lines.push(...message.changes.map(formatFileChange));
      return lines.join('\n');
    }
    case 'command_exec':
      return `${formatHeader(chalk.cyan, 'Exec Begin', message.timestamp)}\n${message.command}${message.cwd ? `\n${chalk.gray(message.cwd)}` : ''}`;
    case 'command_result': {
      const lines: string[] = [
        `${formatHeader(chalk.cyan, 'Exec Finished', message.timestamp)}\n${message.command}`,
      ];
      if (message.cwd) lines.push(chalk.gray(message.cwd));
      if (message.exitCode !== 0) {
        lines.push(chalk.red(`Exit Code: ${message.exitCode}`));
      }
      if (message.stdout) lines.push(truncateLines(message.stdout));
      if (message.stderr) lines.push(chalk.red(truncateLines(message.stderr)));
      return lines.join('\n');
    }
    case 'review_start':
      return `${chalk.bold.cyan('### Executing Review')}\n${message.executor ?? 'unknown executor'}`;
    case 'review_result':
    case 'review_verdict':
      // Intentionally silent on console because `tim review` already renders
      // detailed human-facing output through explicit `log()` call to ensure
      // that calling agent sees it even when tunneling.
      // Call sites must pair `sendStructured()` for these types with explicit
      // logging to keep local console visibility.
      return '';
    case 'workflow_progress':
      return chalk.blue(message.phase ? `[${message.phase}] ${message.message}` : message.message);
    case 'failure_report': {
      const lines = [chalk.redBright(`FAILED: ${message.summary}`)];
      if (message.requirements) lines.push(chalk.yellow(`Requirements:\n${message.requirements}`));
      if (message.problems) lines.push(chalk.red(`Problems:\n${message.problems}`));
      if (message.solutions) lines.push(chalk.yellow(`Possible solutions:\n${message.solutions}`));
      if (message.sourceAgent) lines.push(chalk.gray(`Source: ${message.sourceAgent}`));
      return lines.join('\n');
    }
    case 'task_completion':
      return message.planComplete
        ? chalk.green(`Task complete: ${message.taskTitle ?? ''} (plan complete)`.trim())
        : chalk.green(`Task complete: ${message.taskTitle ?? ''}`.trim());
    case 'execution_summary':
      return formatExecutionSummaryToLines(message.summary).join('\n');
    case 'token_usage': {
      const parts = [
        message.inputTokens != null ? `input=${message.inputTokens}` : undefined,
        message.cachedInputTokens != null ? `cached=${message.cachedInputTokens}` : undefined,
        message.outputTokens != null ? `output=${message.outputTokens}` : undefined,
        message.reasoningTokens != null ? `reasoning=${message.reasoningTokens}` : undefined,
        message.totalTokens != null ? `total=${message.totalTokens}` : undefined,
      ].filter((part): part is string => part !== undefined);
      return parts.length > 0
        ? `${formatHeader(chalk.gray, 'Usage', message.timestamp)}\n${parts.join(' ')}`
        : formatHeader(chalk.gray, 'Usage', message.timestamp);
    }
    case 'input_required':
      // For now, intentionally silent without a prompt for local console output, since inquirer already prompts.
      // Transport adapters still forward the structured event for UI state tracking.
      return message.prompt ? chalk.yellow(`Input required: ${message.prompt}`) : '';
    case 'user_terminal_input':
      return chalk.cyan(`→ You: ${message.content}`);
    case 'prompt_request':
      // Display the prompt message for local console visibility.
      // The actual prompt rendering is handled by the prompt wrapper or tunnel handler.
      return chalk.yellow(`Prompt (${message.promptType}): ${message.promptConfig.message}`);
    case 'prompt_answered':
      // Silent for local console -- the prompt result is already visible from the inquirer prompt.
      // Transport adapters still forward the structured event for UI state tracking.
      return '';
    case 'plan_discovery':
      return chalk.green(`Found ready plan: ${message.planId} - ${message.title}`);
    case 'workspace_info':
      return `${chalk.cyan('Workspace:')} ${message.path}${message.planFile ? `\nPlan: ${message.planFile}` : ''}`;
    default: {
      const _exhaustive: never = message;
      return '';
    }
  }
}
