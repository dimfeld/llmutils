import type { StreamTextResult, ToolSet } from 'ai';
import { error, writeLogFile } from '../logging.ts';

/** Use `bat` to format Markdown text as it streams through. We use bat instead of a JS-native solution
 * since it works better for streaming markdown. */
class MarkdownBuffer {
  push: (text: string) => void;

  batProcess: Bun.PipedSubprocess;
  decoder = new TextDecoder();
  handleStreamPromise: Promise<void>;

  constructor(callback: (text: string) => void, language = 'md') {
    this.push = callback;
    this.batProcess = Bun.spawn(['bat', `--language=${language}`, '-pp', '--color=always'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.handleStreamPromise = this.handleStream(this.batProcess.stdout);
  }

  async handleStream(stdout: ReadableStream<Uint8Array>) {
    for await (const chunk of stdout) {
      let str = this.decoder.decode(chunk, { stream: true });
      this.push(str);
    }
  }

  add(chunk: string) {
    this.batProcess.stdin.write(chunk);
  }

  async flush() {
    await this.batProcess.stdin.flush();
  }

  async done() {
    await this.batProcess.stdin.end();
    await this.batProcess.exited;
    await this.handleStreamPromise;
  }
}

class PassthroughBuffer {
  push: (text: string) => void;
  constructor(callback: (text: string) => void) {
    this.push = callback;
  }
  add(chunk: string) {
    this.push(chunk);
  }

  async flush() {}
  async done() {}
}

export interface HandleStreamTextResultOptions {
  format?: boolean;
  showReasoning?: boolean;
  /** An additional callback to handle the text. This gets the raw text, not the formatted text */
  cb?: (text: string) => void;
}

/** Stream the text result to the console and the log file.
 *  If `format` is true, the console output is formatted as markdown.
 * */
export async function streamResultToConsole<T extends ToolSet, U>(
  result: StreamTextResult<T, U>,
  { format = true, showReasoning = true, cb }: HandleStreamTextResultOptions = {}
): Promise<StreamTextResult<T, U>> {
  const stderrWriter = (text: string) => process.stderr.write(text);
  const stdoutWriter = (text: string) => process.stdout.write(text);

  let reasoningRenderer: MarkdownBuffer | PassthroughBuffer | undefined =
    format && showReasoning
      ? new MarkdownBuffer(stderrWriter)
      : new PassthroughBuffer(stderrWriter);
  let textRenderer = format
    ? new MarkdownBuffer(stdoutWriter)
    : new PassthroughBuffer(stdoutWriter);

  try {
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'reasoning') {
        reasoningRenderer?.add(chunk.textDelta);
        writeLogFile(chunk.textDelta);
      } else if (chunk.type === 'text-delta') {
        if (reasoningRenderer) {
          // When we see the first text chunk, reasoning is over
          reasoningRenderer.add('\n');
          writeLogFile('\n');
          await reasoningRenderer.done();
          reasoningRenderer = undefined;
        }

        textRenderer.add(chunk.textDelta);
        // Log file gets the unformatted text
        writeLogFile(chunk.textDelta);
        cb?.(chunk.textDelta);
      } else if (chunk.type === 'error') {
        error(chunk.error);
        throw new Error((chunk.error as any).toString());
      }
    }
    textRenderer.add('\n');
  } finally {
    await reasoningRenderer?.done();
    await textRenderer.done();
  }

  return result;
}
