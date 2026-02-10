import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { runWithLogger } from '../logging/adapter.ts';
import {
  createTunnelServer,
  type TunnelServer,
  type PromptRequestHandler,
} from '../logging/tunnel_server.ts';
import { createTunnelAdapter, TunnelAdapter } from '../logging/tunnel_client.ts';
import { createRecordingAdapter } from '../logging/test_helpers.ts';
import { ModuleMocker } from '../testing.js';

// Mock the @inquirer/prompts module so tests don't require a TTY.
// Uses ModuleMocker to preserve all original exports (e.g. `search`) and
// restore them after our tests complete, preventing cross-file mock leaks.
const moduleMocker = new ModuleMocker(import.meta);
const mockConfirm = mock(() => Promise.resolve(true));
const mockSelect = mock(() => Promise.resolve('selected'));
const mockInput = mock(() => Promise.resolve('typed'));
const mockCheckbox = mock(() => Promise.resolve(['a', 'b']));

await moduleMocker.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: mockSelect,
  input: mockInput,
  checkbox: mockCheckbox,
}));

// Import the wrapper AFTER mock setup.
const { promptConfirm, promptSelect, promptInput, promptCheckbox } = await import('./input.ts');

afterAll(() => {
  moduleMocker.clear();
});

/** Helper to get the nth call args from a mock, bypassing strict tuple types. */
function callArgs(fn: { mock: { calls: unknown[][] } }, callIndex: number): unknown[] {
  return fn.mock.calls[callIndex] ?? [];
}

const TEMP_BASE = '/tmp/claude';

describe('prompt wrappers', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockCheckbox.mockReset();

    mockConfirm.mockImplementation(() => Promise.resolve(true));
    mockSelect.mockImplementation(() => Promise.resolve('selected'));
    mockInput.mockImplementation(() => Promise.resolve('typed'));
    mockCheckbox.mockImplementation(() => Promise.resolve(['a', 'b']));
  });

  describe('non-tunneled path (direct inquirer calls)', () => {
    it('promptConfirm calls inquirer confirm and sends structured message', async () => {
      mockConfirm.mockImplementation(() => Promise.resolve(false));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () => promptConfirm({ message: 'Continue?' }));

      expect(result).toBe(false);
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const config = callArgs(mockConfirm, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'Continue?' });

      // Should have sent a structured prompt_request message for visibility
      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(1);
      const msg = structured[0].args[0] as Record<string, unknown>;
      expect(msg).toMatchObject({
        type: 'prompt_request',
        promptType: 'confirm',
      });
      expect(msg.requestId).toBeDefined();
    });

    it('promptConfirm passes default value', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => promptConfirm({ message: 'OK?', default: false }));

      const config = callArgs(mockConfirm, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'OK?', default: false });
    });

    it('promptSelect calls inquirer select with choices', async () => {
      mockSelect.mockImplementation(() => Promise.resolve('deny'));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () =>
        promptSelect({
          message: 'Choose:',
          choices: [
            { name: 'Allow', value: 'allow' },
            { name: 'Deny', value: 'deny', description: 'Block it' },
          ],
          default: 'allow',
          pageSize: 5,
        })
      );

      expect(result).toBe('deny');
      expect(mockSelect).toHaveBeenCalledTimes(1);
      const config = callArgs(mockSelect, 0)[0] as Record<string, unknown> & {
        choices: Array<Record<string, unknown>>;
      };
      expect(config).toMatchObject({ message: 'Choose:', default: 'allow', pageSize: 5 });
      expect(config.choices).toHaveLength(2);

      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(1);
      const msg = structured[0].args[0] as Record<string, unknown>;
      expect(msg).toMatchObject({ type: 'prompt_request', promptType: 'select' });
    });

    it('promptInput calls inquirer input', async () => {
      mockInput.mockImplementation(() => Promise.resolve('hello'));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () =>
        promptInput({ message: 'Name:', default: 'anon', validationHint: 'non-empty' })
      );

      expect(result).toBe('hello');
      expect(mockInput).toHaveBeenCalledTimes(1);
      const config = callArgs(mockInput, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'Name:', default: 'anon' });

      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(1);
      const msg = structured[0].args[0] as Record<string, unknown>;
      expect(msg).toMatchObject({ type: 'prompt_request', promptType: 'input' });
      expect((msg as Record<string, Record<string, unknown>>).promptConfig.validationHint).toBe(
        'non-empty'
      );
    });

    it('promptCheckbox calls inquirer checkbox', async () => {
      mockCheckbox.mockImplementation(() => Promise.resolve(['a', 'c']));

      const { adapter, calls } = createRecordingAdapter();

      const result = await runWithLogger(adapter, () =>
        promptCheckbox({
          message: 'Select:',
          choices: [
            { name: 'A', value: 'a', checked: true },
            { name: 'B', value: 'b' },
            { name: 'C', value: 'c', description: 'Third option' },
          ],
          pageSize: 10,
        })
      );

      expect(result).toEqual(['a', 'c']);
      expect(mockCheckbox).toHaveBeenCalledTimes(1);

      const structured = calls.filter((c) => c.method === 'sendStructured');
      expect(structured).toHaveLength(1);
      const msg = structured[0].args[0] as Record<string, unknown>;
      expect(msg).toMatchObject({ type: 'prompt_request', promptType: 'checkbox' });
    });

    it('promptConfirm with timeoutMs passes abort signal to inquirer', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => promptConfirm({ message: 'Quick?', timeoutMs: 5000 }));

      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockConfirm, 0)[1] as { signal?: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg).toHaveProperty('signal');
    });

    it('promptSelect with timeoutMs passes abort signal to inquirer', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () =>
        promptSelect({
          message: 'Pick:',
          choices: [{ name: 'A', value: 'a' }],
          timeoutMs: 5000,
        })
      );

      expect(mockSelect).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockSelect, 0)[1] as { signal?: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg).toHaveProperty('signal');
    });

    it('does not pass abort signal when timeoutMs is not set', async () => {
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => promptConfirm({ message: 'No timeout' }));

      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockConfirm, 0)[1];
      expect(secondArg).toBeUndefined();
    });
  });

  describe('tunneled path (via TunnelAdapter)', () => {
    let tunnelServer: TunnelServer | null = null;
    let clientAdapter: TunnelAdapter | null = null;
    let testDir: string;

    function uniqueSocketPath(): string {
      return path.join(testDir, 't.sock');
    }

    beforeEach(async () => {
      await mkdir(TEMP_BASE, { recursive: true });
      testDir = await mkdtemp(path.join(TEMP_BASE, 'prompt-'));
    });

    afterEach(async () => {
      await clientAdapter?.destroy();
      clientAdapter = null;
      tunnelServer?.close();
      tunnelServer = null;
      await rm(testDir, { recursive: true, force: true });
    });

    it('promptConfirm sends prompt through tunnel and returns response', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      // Server handler that auto-responds to confirm prompts
      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: true,
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        // Run the wrapper with the TunnelAdapter as the logger
        return runWithLogger(clientAdapter, () => promptConfirm({ message: 'Tunnel confirm?' }));
      });

      expect(result).toBe(true);
      // inquirer should NOT have been called - the tunnel handled it
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('promptSelect sends prompt through tunnel with choices', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        // Echo back the second choice value
        const choices = message.promptConfig.choices;
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: choices ? choices[1].value : 'unknown',
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        return runWithLogger(clientAdapter, () =>
          promptSelect({
            message: 'Pick one:',
            choices: [
              { name: 'A', value: 'first' },
              { name: 'B', value: 'second' },
            ],
          })
        );
      });

      expect(result).toBe('second');
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('promptInput sends prompt through tunnel', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: 'tunnel typed value',
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        return runWithLogger(clientAdapter, () => promptInput({ message: 'Enter:' }));
      });

      expect(result).toBe('tunnel typed value');
      expect(mockInput).not.toHaveBeenCalled();
    });

    it('promptCheckbox sends prompt through tunnel', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          value: ['opt1', 'opt3'],
        });
      };

      const result = await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        return runWithLogger(clientAdapter, () =>
          promptCheckbox({
            message: 'Select:',
            choices: [
              { name: 'Opt 1', value: 'opt1' },
              { name: 'Opt 2', value: 'opt2' },
              { name: 'Opt 3', value: 'opt3' },
            ],
          })
        );
      });

      expect(result).toEqual(['opt1', 'opt3']);
      expect(mockCheckbox).not.toHaveBeenCalled();
    });

    it('tunneled prompt with error from server rejects the promise', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      const onPromptRequest: PromptRequestHandler = (message, respond) => {
        respond({
          type: 'prompt_response',
          requestId: message.requestId,
          error: 'Server-side prompt failed',
        });
      };

      await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        await expect(
          runWithLogger(clientAdapter, () => promptConfirm({ message: 'Will fail' }))
        ).rejects.toThrow('Server-side prompt failed');
      });
    });

    it('tunneled prompt with timeoutMs times out when server does not respond', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      // Server handler that never responds
      const onPromptRequest: PromptRequestHandler = () => {
        // Intentionally do nothing
      };

      await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        await expect(
          runWithLogger(clientAdapter, () =>
            promptConfirm({ message: 'Will timeout', timeoutMs: 100 })
          )
        ).rejects.toThrow(/timed out/i);
      });
    });

    it('tunneled prompt rejects when connection is lost', async () => {
      const sp = uniqueSocketPath();
      const { adapter: serverAdapter } = createRecordingAdapter();

      // Handler that never responds
      const onPromptRequest: PromptRequestHandler = () => {
        // Intentionally do nothing
      };

      await runWithLogger(serverAdapter, async () => {
        tunnelServer = await createTunnelServer(sp, { onPromptRequest });
        clientAdapter = await createTunnelAdapter(sp);

        const promptPromise = runWithLogger(clientAdapter, () =>
          promptInput({ message: 'Will disconnect' })
        );

        // Wait briefly for the message to be sent, then destroy the client adapter
        // to simulate connection loss. This rejects pending prompts.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await clientAdapter!.destroy();

        // The promise should reject with an error about the connection/destroy
        const err = await promptPromise.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/destroyed|connection|closed/i);

        // Null out so afterEach doesn't double-destroy
        clientAdapter = null;
      });
    });
  });
});
