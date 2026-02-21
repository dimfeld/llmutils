import type { FormattedCodexMessage } from './format';
import type { StructuredMessage } from '../../../logging/structured_messages';
import {
  buildCommandResult,
  buildSessionStart,
  buildUnknownStatus,
} from '../shared/structured_message_builders';

interface FormatterState {
  finalAgentMessage?: string;
  failedAgentMessage?: string;
  threadId?: string;
  sessionId?: string;
  latestUsage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  latestRateLimits: Map<string, Record<string, unknown>>;
}

function detectFailure(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }

  const firstContentLine = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .find((line) => line.trim().length > 0);
  if (!firstContentLine) {
    return false;
  }
  return /^\s*FAILED:\s*/.test(firstContentLine);
}

function normalizeCommand(command: unknown): string | undefined {
  if (typeof command === 'string') {
    return command;
  }
  if (Array.isArray(command)) {
    return command.map((part) => String(part)).join(' ');
  }
  return undefined;
}

function normalizeFileChangeKind(kind: unknown): 'added' | 'updated' | 'removed' {
  const normalized = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (normalized === 'create' || normalized === 'add' || normalized === 'added') {
    return 'added';
  }
  if (normalized === 'delete' || normalized === 'remove' || normalized === 'removed') {
    return 'removed';
  }
  return 'updated';
}

function normalizeFileChangeStatus(
  status: unknown
): 'inProgress' | 'completed' | 'failed' | 'declined' {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'inprogress' || normalized === 'in_progress' || normalized === 'active') {
    return 'inProgress';
  }
  if (normalized === 'failed' || normalized === 'error') {
    return 'failed';
  }
  if (normalized === 'declined' || normalized === 'rejected') {
    return 'declined';
  }
  return 'completed';
}

function normalizePlanStepStatus(status: unknown): 'pending' | 'inProgress' | 'completed' {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'completed' || normalized === 'done') {
    return 'completed';
  }
  if (normalized === 'inprogress' || normalized === 'in_progress' || normalized === 'active') {
    return 'inProgress';
  }
  return 'pending';
}

function extractTextField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractItemText(item: Record<string, unknown>): string {
  const text = item.text;
  if (typeof text === 'string') {
    return text;
  }
  const message = item.message;
  if (typeof message === 'string') {
    return message;
  }
  const content = item.content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const textPart = (part as Record<string, unknown>).text;
      if (typeof textPart === 'string' && textPart.length > 0) {
        textParts.push(textPart);
      }
    }
    if (textParts.length > 0) {
      return textParts.join('');
    }
  }
  return '';
}

function extractItemSummary(item: Record<string, unknown>): string {
  const summary = item.summary;
  if (Array.isArray(summary)) {
    const lines = summary
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  const summaryText = item.summary_text;
  if (Array.isArray(summaryText)) {
    const lines = summaryText
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  return '';
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(usage: Record<string, unknown>): {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
} {
  return {
    inputTokens: toNumber(usage.inputTokens) ?? toNumber(usage.input_tokens),
    cachedInputTokens: toNumber(usage.cachedInputTokens) ?? toNumber(usage.cached_input_tokens),
    outputTokens: toNumber(usage.outputTokens) ?? toNumber(usage.output_tokens),
    reasoningTokens: toNumber(usage.reasoningTokens) ?? toNumber(usage.reasoning_tokens),
    totalTokens: toNumber(usage.totalTokens) ?? toNumber(usage.total_tokens),
  };
}

function normalizeThreadTokenUsage(payload: Record<string, unknown>): {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
} {
  const tokenUsage =
    payload.tokenUsage && typeof payload.tokenUsage === 'object'
      ? (payload.tokenUsage as Record<string, unknown>)
      : {};
  const total =
    tokenUsage.total && typeof tokenUsage.total === 'object'
      ? (tokenUsage.total as Record<string, unknown>)
      : undefined;
  const last =
    tokenUsage.last && typeof tokenUsage.last === 'object'
      ? (tokenUsage.last as Record<string, unknown>)
      : undefined;
  const source = total ?? last ?? {};

  return {
    inputTokens: toNumber(source.inputTokens) ?? toNumber(source.input_tokens),
    cachedInputTokens: toNumber(source.cachedInputTokens) ?? toNumber(source.cached_input_tokens),
    outputTokens: toNumber(source.outputTokens) ?? toNumber(source.output_tokens),
    reasoningTokens:
      toNumber(source.reasoningTokens) ??
      toNumber(source.reasoning_tokens) ??
      toNumber(source.reasoningOutputTokens) ??
      toNumber(source.reasoning_output_tokens),
    totalTokens: toNumber(source.totalTokens) ?? toNumber(source.total_tokens),
  };
}

function mergeUsage(
  existing: FormatterState['latestUsage'],
  next: FormatterState['latestUsage']
): FormatterState['latestUsage'] {
  const merged = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value != null) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function normalizeRateLimitPayload(rateLimit: Record<string, unknown>): Record<string, unknown> {
  const primary =
    rateLimit.primary && typeof rateLimit.primary === 'object'
      ? (rateLimit.primary as Record<string, unknown>)
      : undefined;
  const secondary =
    rateLimit.secondary && typeof rateLimit.secondary === 'object'
      ? (rateLimit.secondary as Record<string, unknown>)
      : undefined;
  const credits =
    rateLimit.credits && typeof rateLimit.credits === 'object'
      ? (rateLimit.credits as Record<string, unknown>)
      : undefined;

  return {
    limitId: rateLimit.limitId ?? rateLimit.limit_id ?? 'unknown',
    limitName: rateLimit.limitName ?? rateLimit.limit_name ?? undefined,
    primary: primary
      ? {
          usedPercent: primary.usedPercent ?? primary.used_percent ?? undefined,
          windowDurationMins: primary.windowDurationMins ?? primary.window_minutes ?? undefined,
          resetsAt: primary.resetsAt ?? primary.resets_at ?? undefined,
          resetsInSeconds: primary.resetsInSeconds ?? primary.resets_in_seconds ?? undefined,
        }
      : undefined,
    secondary: secondary
      ? {
          usedPercent: secondary.usedPercent ?? secondary.used_percent ?? undefined,
          windowDurationMins: secondary.windowDurationMins ?? secondary.window_minutes ?? undefined,
          resetsAt: secondary.resetsAt ?? secondary.resets_at ?? undefined,
          resetsInSeconds: secondary.resetsInSeconds ?? secondary.resets_in_seconds ?? undefined,
        }
      : undefined,
    credits: credits
      ? {
          hasCredits: credits.hasCredits ?? credits.has_credits ?? undefined,
          unlimited: credits.unlimited ?? undefined,
          balance: credits.balance ?? undefined,
        }
      : undefined,
    planType: rateLimit.planType ?? rateLimit.plan_type ?? undefined,
  };
}

function extractRateLimitKey(rateLimit: Record<string, unknown>): string {
  const normalized = normalizeRateLimitPayload(rateLimit);
  const limitId = normalized.limitId;
  return typeof limitId === 'string' && limitId.length > 0 ? limitId : 'unknown';
}

function extractThreadId(params: Record<string, unknown>): string | undefined {
  if (typeof params.threadId === 'string') {
    return params.threadId;
  }
  const thread = params.thread;
  if (thread && typeof thread === 'object') {
    const threadId = (thread as Record<string, unknown>).id;
    if (typeof threadId === 'string') {
      return threadId;
    }
  }
  return undefined;
}

function extractSessionId(params: Record<string, unknown>): string | undefined {
  if (typeof params.sessionId === 'string') {
    return params.sessionId;
  }
  const session = params.session;
  if (session && typeof session === 'object') {
    const sessionId = (session as Record<string, unknown>).id;
    if (typeof sessionId === 'string') {
      return sessionId;
    }
  }
  return undefined;
}

function extractChangeDiff(data: Record<string, unknown>): string | undefined {
  const diff = data.diff ?? data.unifiedDiff ?? data.unified_diff ?? data.patch;
  return extractTextField(diff);
}

function formatPlanItem(
  step: unknown
): { label: string; status: 'pending' | 'inProgress' | 'completed' } | undefined {
  if (typeof step === 'string') {
    const label = step.trim();
    if (label.length === 0) {
      return undefined;
    }
    return { label, status: 'pending' };
  }
  if (!step || typeof step !== 'object') {
    return undefined;
  }
  const data = step as Record<string, unknown>;
  const label =
    extractTextField(data.step) ??
    extractTextField(data.label) ??
    extractTextField(data.text) ??
    extractTextField(data.title);
  if (!label) {
    return undefined;
  }
  const explicitStatus = normalizePlanStepStatus(data.status);
  const completedOverride =
    typeof data.completed === 'boolean' ? (data.completed ? 'completed' : 'pending') : undefined;
  return {
    label,
    status: completedOverride ?? explicitStatus,
  };
}

function formatPlanUpdate(
  method: string,
  params: Record<string, unknown>,
  ts: string
): FormattedCodexMessage {
  const sourcePlan = Array.isArray(params.plan)
    ? params.plan
    : Array.isArray(params.steps)
      ? params.steps
      : [];
  const items = sourcePlan.map((entry) => formatPlanItem(entry)).filter((item) => Boolean(item));
  const normalizedItems = items as {
    label: string;
    status: 'pending' | 'inProgress' | 'completed';
  }[];

  return {
    type: method,
    structured: {
      type: 'todo_update',
      timestamp: ts,
      source: 'codex',
      turnId: extractTextField(params.turnId) ?? extractTextField(params.turn_id),
      explanation:
        extractTextField(params.explanation) ??
        extractTextField(params.reasoning) ??
        extractTextField(params.text),
      items: normalizedItems,
    },
  };
}

export function createAppServerFormatter() {
  const state: FormatterState = {
    latestRateLimits: new Map(),
  };

  function handleItem(
    item: Record<string, unknown>,
    method: string,
    ts: string
  ): FormattedCodexMessage {
    const itemType = typeof item.type === 'string' ? item.type.toLowerCase() : 'unknown';

    if (itemType === 'agentmessage') {
      if (method === 'item/started') {
        return { type: method };
      }
      const text = extractItemText(item);
      const failed = detectFailure(text);
      if (text.trim().length > 0) {
        state.finalAgentMessage = text;
      }
      if (failed) {
        state.failedAgentMessage = text;
      }

      return {
        type: method,
        agentMessage: text || undefined,
        failed: failed || undefined,
        structured: {
          type: 'llm_response',
          timestamp: ts,
          text,
        },
      };
    }

    if (itemType === 'reasoning') {
      const text = extractItemText(item) || extractItemSummary(item);
      if (text.trim().length === 0) {
        return { type: method };
      }
      return {
        type: method,
        structured: {
          type: 'llm_thinking',
          timestamp: ts,
          text,
        },
      };
    }

    if (itemType === 'commandexecution') {
      const command = normalizeCommand(item.command);
      const output =
        typeof item.aggregatedOutput === 'string'
          ? item.aggregatedOutput
          : typeof item.stdout === 'string'
            ? item.stdout
            : '';
      const stderr = typeof item.stderr === 'string' ? item.stderr : '';
      const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
      const exitCode =
        typeof item.exitCode === 'number' ? item.exitCode : status === 'failed' ? 1 : 0;

      if (method === 'item/started') {
        return {
          type: method,
          structured: {
            type: 'command_exec',
            timestamp: ts,
            command: command ?? '',
            cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          },
        };
      }

      return {
        type: method,
        structured: buildCommandResult(ts, {
          command,
          exitCode,
          stdout: output,
          stderr,
        }),
      };
    }

    if (itemType === 'filechange') {
      if (method !== 'item/completed') {
        return { type: method };
      }

      const status = normalizeFileChangeStatus(item.status);
      if (status !== 'completed') {
        return { type: method };
      }

      const changes = Array.isArray(item.changes) ? item.changes : [];
      const normalizedChanges = changes.flatMap((change) => {
        if (!change || typeof change !== 'object') {
          return [];
        }
        const data = change as Record<string, unknown>;
        if (typeof data.path !== 'string') {
          return [];
        }
        const normalized = {
          path: data.path,
          kind: normalizeFileChangeKind(data.kind),
          diff: extractChangeDiff(data),
        };
        return [normalized];
      });

      return {
        type: method,
        structured: {
          type: 'file_change_summary',
          timestamp: ts,
          id:
            typeof item.id === 'string'
              ? item.id
              : typeof item.id === 'number'
                ? String(item.id)
                : undefined,
          status: 'completed',
          changes: normalizedChanges,
        },
      };
    }

    if (itemType === 'plan') {
      return {
        type: method,
        structured: {
          type: 'llm_status',
          timestamp: ts,
          source: 'codex',
          status: 'codex.plan',
          detail: extractItemText(item),
        },
      };
    }

    if (itemType === 'mcptoolcall') {
      const toolName =
        typeof item.toolName === 'string'
          ? item.toolName
          : typeof item.name === 'string'
            ? item.name
            : 'unknown';
      const toolStatus = typeof item.status === 'string' ? item.status : 'unknown';
      return {
        type: method,
        structured: {
          type: 'llm_status',
          timestamp: ts,
          source: 'codex',
          status: `codex.mcp_tool.${toolStatus}`,
          detail: toolName,
        },
      };
    }

    if (itemType === 'websearch') {
      const query =
        typeof item.query === 'string'
          ? item.query
          : typeof item.searchQuery === 'string'
            ? item.searchQuery
            : '';
      return {
        type: method,
        structured: {
          type: 'llm_status',
          timestamp: ts,
          source: 'codex',
          status: 'codex.web_search',
          detail: query,
        },
      };
    }

    if (itemType === 'usermessage') {
      return { type: method };
    }

    return {
      type: method,
      structured: {
        type: 'llm_status',
        timestamp: ts,
        source: 'codex',
        status: `codex.item.${itemType}`,
        detail: JSON.stringify(item),
      },
    };
  }

  return {
    handleNotification(method: string, params: unknown): FormattedCodexMessage {
      const ts = new Date().toISOString();
      const payload =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      const lowerMethod = method.toLowerCase();

      if (lowerMethod.includes('delta') || lowerMethod.startsWith('codex/event/')) {
        return { type: method };
      }

      if (lowerMethod === 'account/ratelimits/updated') {
        if (payload.rateLimits && typeof payload.rateLimits === 'object') {
          const rateLimit = payload.rateLimits as Record<string, unknown>;
          state.latestRateLimits.set(
            extractRateLimitKey(rateLimit),
            normalizeRateLimitPayload(rateLimit)
          );
        }
        return { type: method };
      }

      if (lowerMethod === 'thread/tokenusage/updated') {
        const usage = normalizeThreadTokenUsage(payload);
        if (Object.values(usage).some((value) => value != null)) {
          state.latestUsage = mergeUsage(state.latestUsage, usage);
        }
        return { type: method };
      }

      if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
        return { type: method };
      }

      if (method.includes('/delta')) {
        return { type: method };
      }

      if (method === 'thread/started') {
        state.threadId = extractThreadId(payload) ?? state.threadId;
        state.sessionId = extractSessionId(payload) ?? state.sessionId;
        return {
          type: method,
          threadId: state.threadId,
          sessionId: state.sessionId,
          structured: buildSessionStart(ts, 'codex', {
            threadId: state.threadId,
            sessionId: state.sessionId,
          }),
        };
      }

      if (method === 'turn/started') {
        return {
          type: method,
          structured: {
            type: 'agent_step_start',
            timestamp: ts,
            phase: 'turn',
            message: 'Turn started',
          },
        };
      }

      if (method === 'turn/completed') {
        const turn =
          payload.turn && typeof payload.turn === 'object'
            ? (payload.turn as Record<string, unknown>)
            : payload;
        const usage =
          turn.usage && typeof turn.usage === 'object'
            ? (turn.usage as Record<string, unknown>)
            : {};

        const status = typeof turn.status === 'string' ? turn.status : undefined;
        if (status === 'failed' && !state.failedAgentMessage) {
          state.failedAgentMessage = 'FAILED: turn failed';
        }
        const usageSummary = normalizeUsage(usage);
        state.latestUsage = mergeUsage(state.latestUsage, usageSummary);

        const structured: StructuredMessage = {
          type: 'token_usage',
          timestamp: ts,
          inputTokens: state.latestUsage?.inputTokens,
          cachedInputTokens: state.latestUsage?.cachedInputTokens,
          outputTokens: state.latestUsage?.outputTokens,
          reasoningTokens: state.latestUsage?.reasoningTokens,
          totalTokens: state.latestUsage?.totalTokens,
          rateLimits:
            state.latestRateLimits.size > 0
              ? Object.fromEntries(state.latestRateLimits.entries())
              : undefined,
        };

        return {
          type: method,
          structured,
        };
      }

      if (method === 'item/started' || method === 'item/completed') {
        const item =
          payload.item && typeof payload.item === 'object'
            ? (payload.item as Record<string, unknown>)
            : undefined;
        if (!item) {
          return {
            type: method,
            structured: buildUnknownStatus('codex', ts, JSON.stringify(payload), method),
          };
        }
        return handleItem(item, method, ts);
      }

      if (method === 'item/reasoning/summaryPartAdded') {
        return { type: method };
      }

      if (method === 'turn/diff/updated') {
        return { type: method };
      }

      if (method === 'turn/plan/updated' || method === 'codex/plan/updated') {
        return formatPlanUpdate(method, payload, ts);
      }

      return {
        type: method,
        structured: buildUnknownStatus(
          'codex',
          ts,
          JSON.stringify(payload),
          method.replaceAll('/', '.')
        ),
      };
    },
    getFinalAgentMessage(): string | undefined {
      return state.finalAgentMessage;
    },
    getFailedAgentMessage(): string | undefined {
      return state.failedAgentMessage;
    },
    getThreadId(): string | undefined {
      return state.threadId;
    },
    getSessionId(): string | undefined {
      return state.sessionId;
    },
  };
}
