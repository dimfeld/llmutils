import { describe, expect, test, vi } from 'vitest';
import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';
import { runWithLogger } from '../../../logging/adapter.js';
import { ConsoleAdapter } from '../../../logging/console.js';
import { HeadlessAdapter } from '../../../logging/headless_adapter.js';
import { executeWithTerminalInput } from './terminal_input_lifecycle.ts';

function makeStreaming(): StreamingProcess {
  return {
    stdin: {
      write: vi.fn(() => 0),
      end: vi.fn(async () => {}),
    },
    result: new Promise<SpawnAndLogOutputResult>(() => {}),
    kill: vi.fn(() => {}),
  } as unknown as StreamingProcess;
}

interface HeadlessHandlerSlots {
  readonly userInputHandler?: (content: string) => void;
  readonly endSessionHandler?: () => void;
  readonly forceEndSessionHandler?: () => void;
}

function handlerSlots(adapter: HeadlessAdapter): HeadlessHandlerSlots {
  return adapter as unknown as HeadlessHandlerSlots;
}

describe('terminal_input_lifecycle with a real HeadlessAdapter', () => {
  test('persistent lifecycles preserve the orchestrator handlers through both cleanups', async () => {
    const adapter = new HeadlessAdapter({ command: 'agent' }, new ConsoleAdapter());
    const orchestratorUserInput = vi.fn();
    const orchestratorEndSession = vi.fn();
    const orchestratorForceEndSession = vi.fn();
    adapter.setUserInputHandler(orchestratorUserInput);
    adapter.setEndSessionHandler(orchestratorEndSession);
    adapter.setForceEndSessionHandler(orchestratorForceEndSession);

    try {
      await runWithLogger(adapter, async () => {
        const first = executeWithTerminalInput({
          streaming: makeStreaming(),
          prompt: 'first assignment',
          sendStructured: () => {},
          debugLog: () => {},
          errorLog: () => {},
          log: () => {},
          label: 'Claude first',
          terminalInputEnabled: false,
          tunnelForwardingEnabled: false,
          persistentAgent: {},
        });
        const second = executeWithTerminalInput({
          streaming: makeStreaming(),
          prompt: 'second assignment',
          sendStructured: () => {},
          debugLog: () => {},
          errorLog: () => {},
          log: () => {},
          label: 'Claude second',
          terminalInputEnabled: false,
          tunnelForwardingEnabled: false,
          persistentAgent: {},
        });

        expect(handlerSlots(adapter).userInputHandler).toBe(orchestratorUserInput);
        expect(handlerSlots(adapter).endSessionHandler).toBe(orchestratorEndSession);
        expect(handlerSlots(adapter).forceEndSessionHandler).toBe(orchestratorForceEndSession);

        first.cleanup();
        expect(handlerSlots(adapter).userInputHandler).toBe(orchestratorUserInput);
        expect(handlerSlots(adapter).endSessionHandler).toBe(orchestratorEndSession);
        expect(handlerSlots(adapter).forceEndSessionHandler).toBe(orchestratorForceEndSession);

        second.cleanup();
        expect(handlerSlots(adapter).userInputHandler).toBe(orchestratorUserInput);
        expect(handlerSlots(adapter).endSessionHandler).toBe(orchestratorEndSession);
        expect(handlerSlots(adapter).forceEndSessionHandler).toBe(orchestratorForceEndSession);
      });
    } finally {
      await adapter.destroy();
    }
  });
});
