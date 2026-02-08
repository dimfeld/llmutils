import type { LoggerAdapter } from './adapter.js';
import type { StructuredMessage } from './structured_messages.js';

export type RecordingAdapterCall = {
  method: 'log' | 'error' | 'warn' | 'writeStdout' | 'writeStderr' | 'debugLog' | 'sendStructured';
  args: unknown[];
};

export function createRecordingAdapter(): {
  adapter: LoggerAdapter;
  calls: RecordingAdapterCall[];
} {
  const calls: RecordingAdapterCall[] = [];
  const adapter: LoggerAdapter = {
    log(...args: unknown[]) {
      calls.push({ method: 'log', args });
    },
    error(...args: unknown[]) {
      calls.push({ method: 'error', args });
    },
    warn(...args: unknown[]) {
      calls.push({ method: 'warn', args });
    },
    writeStdout(data: string) {
      calls.push({ method: 'writeStdout', args: [data] });
    },
    writeStderr(data: string) {
      calls.push({ method: 'writeStderr', args: [data] });
    },
    debugLog(...args: unknown[]) {
      calls.push({ method: 'debugLog', args });
    },
    sendStructured(message: StructuredMessage) {
      calls.push({ method: 'sendStructured', args: [message] });
    },
  };

  return { adapter, calls };
}
