import { createLineSplitter } from '../../../common/process.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import {
  createClaudeMessageFormatter,
  extractStructuredMessages,
  type FormattedClaudeMessage,
} from './format.js';

export interface ClaudeOutputStreamFormatterResult {
  readonly formattedResults: FormattedClaudeMessage[];
  readonly structuredMessages: StructuredMessage[];
}

/**
 * Formats one Claude output stream while keeping its splitter and formatter
 * state together for the lifetime of that stream.
 */
export class ClaudeOutputStreamFormatter {
  private readonly splitLines = createLineSplitter();
  private readonly formatter = createClaudeMessageFormatter();

  public constructor(private readonly model?: string) {}

  public formatChunk(output: string): ClaudeOutputStreamFormatterResult {
    const lines = this.splitLines(output);
    const formattedResults = lines.map((line) =>
      this.formatter.formatJsonMessage(line, this.model)
    );

    return {
      formattedResults,
      structuredMessages: extractStructuredMessages(formattedResults),
    };
  }
}

export function createClaudeOutputStreamFormatter(model?: string): ClaudeOutputStreamFormatter {
  return new ClaudeOutputStreamFormatter(model);
}
