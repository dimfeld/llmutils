import type { NormalizedExecutorOutput } from './types.js';

export interface ParsedExecutorOutput {
  content: string;
  metadata?: Record<string, unknown>;
  success: boolean;
  error?: string;
}

/**
 * Generic parser that returns the input as content.
 */
export function parseGenericOutput(raw: unknown): ParsedExecutorOutput {
  try {
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return { content: content?.trim?.() ?? String(content), success: true };
  } catch (e) {
    return { content: String(raw ?? ''), success: false, error: String(e) };
  }
}

/**
 * Parse output from Claude Code executor.
 * In rmplan, when captureOutput is 'result', the Claude executor already extracts
 * the final assistant rawMessage and returns it as a plain string.
 * This parser therefore primarily trims and guards against malformed input.
 * If given a JSONL stream by mistake, it will attempt to pull the last assistant rawMessage.
 */
export function parseClaudeOutput(raw: unknown): ParsedExecutorOutput {
  try {
    if (typeof raw !== 'string') return parseGenericOutput(raw);

    const input = raw.trim();
    if (!input) return { content: '', success: true };

    // Heuristic: treat as JSONL only if some line starts with a JSON object and mentions "type"
    const lines = input.split(/\r?\n/);
    const looksJsonl = lines.some((l) => l.trimStart().startsWith('{') && l.includes('"type"'));
    if (looksJsonl) {
      let lastAssistantRaw: string | undefined;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj && obj.type === 'assistant') {
            // The formatter in executors/claude_code/format.ts uses 'rawMessage'
            if (typeof obj.rawMessage === 'string' && obj.rawMessage.trim()) {
              lastAssistantRaw = obj.rawMessage;
            }
          }
        } catch {
          // ignore parse error for non-JSON lines
        }
      }
      if (lastAssistantRaw != null) {
        return {
          content: lastAssistantRaw.trim(),
          success: true,
          metadata: { phase: 'orchestrator' },
        };
      }
    }

    // Default: treat entire string as final assistant message
    return { content: input, success: true, metadata: { phase: 'orchestrator' } };
  } catch (e) {
    return { content: String(raw ?? ''), success: false, error: String(e) };
  }
}

/**
 * Parse output from Codex CLI executor.
 * Codex returns a combined string with labeled sections when captureOutput is enabled.
 * Example labels:
 *   === Codex Implementer ===\n...
 *   === Codex Tester ===\n...
 *   === Codex Reviewer ===\n...
 * We extract these sections into metadata and provide a compact combined content.
 */
export function parseCodexOutput(raw: unknown): ParsedExecutorOutput {
  try {
    if (typeof raw !== 'string') return parseGenericOutput(raw);
    const text = raw.trim();
    if (!text) return { content: '', success: true };

    const headerRegex = /^===\s*Codex\s+(Implementer|Tester|Reviewer)\s*===\s*$/gim;
    const indices: Array<{ role: string; start: number; endHeader: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = headerRegex.exec(text)) !== null) {
      const role = match[1];
      const start = match.index;
      const endHeader = headerRegex.lastIndex;
      indices.push({ role, start, endHeader });
    }

    const metadata: Record<string, unknown> = {};
    const parts: string[] = [];

    for (let i = 0; i < indices.length; i++) {
      const cur = indices[i];
      const nextStart = i + 1 < indices.length ? indices[i + 1].start : text.length;
      const body = text.slice(cur.endHeader, nextStart).trim();
      metadata[cur.role.toLowerCase()] = body;
      parts.push(`${cur.role}:\n${body}`);
    }

    if (parts.length === 0) {
      return { content: text, success: true };
    }

    const content = parts.join('\n\n');
    return { content, success: true, metadata };
  } catch (e) {
    return { content: String(raw ?? ''), success: false, error: String(e) };
  }
}

/**
 * Dispatch to the appropriate parser based on executor name/type.
 * Returns a NormalizedExecutorOutput-ready object shape.
 */
export function parseExecutorOutput(
  executorName: string | undefined,
  raw: unknown
): ParsedExecutorOutput {
  try {
    const name = (executorName ?? '').toLowerCase();
    if (name === 'claude-code' || name === 'claude_code' || name === 'claude code') {
      return parseClaudeOutput(raw);
    }
    if (name === 'codex-cli' || name === 'codex_cli' || name === 'codex cli') {
      return parseCodexOutput(raw);
    }
    return parseGenericOutput(raw);
  } catch (e) {
    return { content: String(raw ?? ''), success: false, error: String(e) };
  }
}

/**
 * Helper to convert a ParsedExecutorOutput to NormalizedExecutorOutput used by SummaryCollector.
 */
export function toNormalizedOutput(parsed: ParsedExecutorOutput): NormalizedExecutorOutput {
  return { content: parsed.content, metadata: parsed.metadata };
}
