import { describe, it, expect, beforeEach, afterAll, afterEach, mock } from 'bun:test';
import type { PromptRequestMessage } from './structured_messages.ts';
import type { TunnelPromptResponseMessage } from './tunnel_protocol.ts';
import { ModuleMocker } from '../testing.js';
import { setActiveInputSource, type PausableInputSource } from '../common/input_pause_registry.js';

// Mock the @inquirer/prompts module so tests don't require a TTY.
// Uses ModuleMocker to preserve all original exports (e.g. `search`) and
// restore them after our tests complete, preventing cross-file mock leaks.
const moduleMocker = new ModuleMocker(import.meta);
const mockConfirm = mock(() => Promise.resolve(true));
const mockSelect = mock(() => Promise.resolve('selected'));
const mockInput = mock(() => Promise.resolve('typed'));
const mockCheckbox = mock(() => Promise.resolve(['a', 'b']));
const mockRunPrefixPrompt = mock(() => Promise.resolve({ exact: false, command: 'git status' }));

await moduleMocker.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: mockSelect,
  input: mockInput,
  checkbox: mockCheckbox,
}));
await moduleMocker.mock('../common/prefix_prompt.js', () => ({
  runPrefixPrompt: mockRunPrefixPrompt,
}));

// Import the handler AFTER the mock is set up so it picks up the mocked module.
const { createPromptRequestHandler } = await import('./tunnel_prompt_handler.ts');

afterAll(() => {
  moduleMocker.clear();
});

/** Helper to get the nth call args from a mock, bypassing strict tuple types. */
function callArgs(fn: { mock: { calls: unknown[][] } }, callIndex: number): unknown[] {
  return fn.mock.calls[callIndex] ?? [];
}

function makePromptRequest(
  overrides: Partial<PromptRequestMessage> & { promptType: PromptRequestMessage['promptType'] }
): PromptRequestMessage {
  return {
    type: 'prompt_request',
    timestamp: new Date().toISOString(),
    requestId: `test-${Math.random().toString(36).slice(2)}`,
    promptConfig: overrides.promptConfig ?? { message: 'Test prompt' },
    ...overrides,
  };
}

/** Collects the response from the handler via its respond callback. */
function collectResponse(): {
  promise: Promise<TunnelPromptResponseMessage>;
  respond: (response: TunnelPromptResponseMessage) => void;
} {
  let respond!: (response: TunnelPromptResponseMessage) => void;
  const promise = new Promise<TunnelPromptResponseMessage>((resolve) => {
    respond = resolve;
  });
  return { promise, respond };
}

describe('tunnel_prompt_handler', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockCheckbox.mockReset();
    mockRunPrefixPrompt.mockReset();

    // Restore default mock implementations
    mockConfirm.mockImplementation(() => Promise.resolve(true));
    mockSelect.mockImplementation(() => Promise.resolve('selected'));
    mockInput.mockImplementation(() => Promise.resolve('typed'));
    mockCheckbox.mockImplementation(() => Promise.resolve(['a', 'b']));
    mockRunPrefixPrompt.mockImplementation(() =>
      Promise.resolve({ exact: false, command: 'git status' })
    );

    // Clear registry between tests
    setActiveInputSource(undefined);
  });

  afterEach(() => {
    setActiveInputSource(undefined);
  });

  describe('prompt type mapping', () => {
    it('handles confirm prompts', async () => {
      mockConfirm.mockImplementation(() => Promise.resolve(false));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'confirm',
        promptConfig: { message: 'Continue?', default: true },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.type).toBe('prompt_response');
      expect(response.requestId).toBe(msg.requestId);
      expect(response.value).toBe(false);
      expect(response.error).toBeUndefined();

      // Verify inquirer was called with correct options
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const config = callArgs(mockConfirm, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'Continue?', default: true });
    });

    it('handles select prompts', async () => {
      mockSelect.mockImplementation(() => Promise.resolve('deny'));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'select',
        promptConfig: {
          message: 'Choose action:',
          choices: [
            { name: 'Allow', value: 'allow' },
            { name: 'Deny', value: 'deny', description: 'Block the action' },
          ],
          default: 'allow',
          pageSize: 10,
        },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toBe('deny');
      expect(response.error).toBeUndefined();

      expect(mockSelect).toHaveBeenCalledTimes(1);
      const config = callArgs(mockSelect, 0)[0] as Record<string, unknown> & {
        choices: Array<Record<string, unknown>>;
      };
      expect(config).toMatchObject({
        message: 'Choose action:',
        default: 'allow',
        pageSize: 10,
      });
      expect(config.choices).toHaveLength(2);
      expect(config.choices[1]).toMatchObject({
        name: 'Deny',
        value: 'deny',
        description: 'Block the action',
      });
    });

    it('handles input prompts', async () => {
      mockInput.mockImplementation(() => Promise.resolve('user typed this'));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'input',
        promptConfig: { message: 'Enter name:', default: 'anonymous' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toBe('user typed this');
      expect(response.error).toBeUndefined();

      expect(mockInput).toHaveBeenCalledTimes(1);
      const config = callArgs(mockInput, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({ message: 'Enter name:', default: 'anonymous' });
    });

    it('handles checkbox prompts', async () => {
      mockCheckbox.mockImplementation(() => Promise.resolve(['opt1', 'opt3']));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'checkbox',
        promptConfig: {
          message: 'Select items:',
          choices: [
            { name: 'Option 1', value: 'opt1', checked: true },
            { name: 'Option 2', value: 'opt2' },
            { name: 'Option 3', value: 'opt3', checked: false, description: 'The third option' },
          ],
          pageSize: 5,
        },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toEqual(['opt1', 'opt3']);
      expect(response.error).toBeUndefined();

      expect(mockCheckbox).toHaveBeenCalledTimes(1);
      const config = callArgs(mockCheckbox, 0)[0] as Record<string, unknown> & {
        choices: Array<Record<string, unknown>>;
      };
      expect(config).toMatchObject({ message: 'Select items:', pageSize: 5 });
      expect(config.choices).toHaveLength(3);
      expect(config.choices[0]).toMatchObject({
        name: 'Option 1',
        value: 'opt1',
        checked: true,
      });
      expect(config.choices[2]).toMatchObject({
        name: 'Option 3',
        value: 'opt3',
        checked: false,
        description: 'The third option',
      });
    });

    it('handles prefix_select prompts', async () => {
      mockRunPrefixPrompt.mockImplementation(() =>
        Promise.resolve({ exact: true, command: 'jj status --summary' })
      );

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'prefix_select',
        promptConfig: {
          message: 'Select command prefix',
          command: 'jj status --summary',
        },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toEqual({ exact: true, command: 'jj status --summary' });
      expect(response.error).toBeUndefined();
      expect(mockRunPrefixPrompt).toHaveBeenCalledTimes(1);
      const config = callArgs(mockRunPrefixPrompt, 0)[0] as Record<string, unknown>;
      expect(config).toMatchObject({
        message: 'Select command prefix',
        command: 'jj status --summary',
      });
    });
  });

  describe('timeout handling', () => {
    it('passes AbortController signal to inquirer when timeoutMs is set', async () => {
      // The mock resolves quickly, so the timeout won't fire, but we can verify
      // that the signal is passed through.
      mockConfirm.mockImplementation(() => Promise.resolve(true));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
        timeoutMs: 5000,
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toBe(true);
      expect(response.error).toBeUndefined();

      // Verify that a second argument with signal was passed
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockConfirm, 0)[1] as { signal?: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg).toHaveProperty('signal');
      expect(secondArg!.signal).toBeInstanceOf(AbortSignal);
    });

    it('does not pass signal when timeoutMs is not set', async () => {
      mockConfirm.mockImplementation(() => Promise.resolve(true));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
      });

      handler(msg, respond);
      await promise;

      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const secondArg = callArgs(mockConfirm, 0)[1];
      expect(secondArg).toBeUndefined();
    });

    it('responds with error when timeout fires before prompt completes', async () => {
      // Simulate a prompt that never resolves
      mockSelect.mockImplementation(
        // @ts-expect-error mock implementation with different signature
        (_config: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener('abort', () => {
                reject(new Error('Prompt was aborted'));
              });
            }
          })
      );

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'select',
        promptConfig: {
          message: 'Choose:',
          choices: [{ name: 'A', value: 'a' }],
        },
        timeoutMs: 50,
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toBeDefined();
      expect(response.error).toContain('aborted');
      expect(response.value).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('responds with error for unsupported prompt type', async () => {
      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'editor' as PromptRequestMessage['promptType'],
        promptConfig: { message: 'Edit:' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toBeDefined();
      expect(response.error).toContain('Unsupported prompt type');
      expect(response.error).toContain('editor');
      expect(response.value).toBeUndefined();
    });

    it('responds with error when inquirer throws', async () => {
      mockInput.mockImplementation(() => Promise.reject(new Error('TTY not available')));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'input',
        promptConfig: { message: 'Enter:' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toBeDefined();
      expect(response.error).toContain('TTY not available');
      expect(response.value).toBeUndefined();
    });

    it('responds with error when inquirer throws a non-Error value', async () => {
      mockConfirm.mockImplementation(() => Promise.reject('string error'));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'confirm',
        promptConfig: { message: 'OK?' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toBeDefined();
      expect(response.error).toContain('string error');
    });

    it('handles select with empty choices array', async () => {
      mockSelect.mockImplementation(() => Promise.reject(new Error('No choices')));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'select',
        promptConfig: {
          message: 'Choose:',
          choices: [],
        },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toBeDefined();
    });

    it('preserves requestId in error responses', async () => {
      mockInput.mockImplementation(() => Promise.reject(new Error('fail')));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'input',
        promptConfig: { message: 'Enter:' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.requestId).toBe(msg.requestId);
      expect(response.type).toBe('prompt_response');
    });
  });

  describe('input source pause/resume', () => {
    it('pauses the active input source before prompt and resumes after', async () => {
      const pauseSpy = mock(() => {});
      const resumeSpy = mock(() => {});
      const source: PausableInputSource = { pause: pauseSpy, resume: resumeSpy };
      setActiveInputSource(source);

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toBe(true);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });

    it('resumes the same input source instance after prompt completes', async () => {
      const pauseSpy = mock(() => {});
      const resumeSpy = mock(() => {});
      const source: PausableInputSource = { pause: pauseSpy, resume: resumeSpy };
      setActiveInputSource(source);

      // Register a different source after pause but before resume to verify
      // the handler resumes the original captured instance
      let promptCalled = false;
      mockInput.mockImplementation(() => {
        promptCalled = true;
        // Simulate the input source changing during the prompt
        const otherResume = mock(() => {});
        setActiveInputSource({ pause: mock(() => {}), resume: otherResume });
        return Promise.resolve('answer');
      });

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'input',
        promptConfig: { message: 'Enter:' },
      });

      handler(msg, respond);
      await promise;

      expect(promptCalled).toBe(true);
      // The original source's resume should be called, not the new one's
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });

    it('resumes the input source when the prompt throws', async () => {
      const pauseSpy = mock(() => {});
      const resumeSpy = mock(() => {});
      const source: PausableInputSource = { pause: pauseSpy, resume: resumeSpy };
      setActiveInputSource(source);

      mockSelect.mockImplementation(() => Promise.reject(new Error('prompt failed')));

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'select',
        promptConfig: {
          message: 'Choose:',
          choices: [{ name: 'A', value: 'a' }],
        },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toContain('prompt failed');
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });

    it('works normally when no active input source is registered', async () => {
      // No input source set — getActiveInputSource() returns undefined
      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'confirm',
        promptConfig: { message: 'Continue?' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.value).toBe(true);
      expect(response.error).toBeUndefined();
    });

    it('resumes the input source even for unsupported prompt types', async () => {
      const pauseSpy = mock(() => {});
      const resumeSpy = mock(() => {});
      const source: PausableInputSource = { pause: pauseSpy, resume: resumeSpy };
      setActiveInputSource(source);

      const handler = createPromptRequestHandler();
      const { promise, respond } = collectResponse();

      const msg = makePromptRequest({
        promptType: 'editor' as PromptRequestMessage['promptType'],
        promptConfig: { message: 'Edit:' },
      });

      handler(msg, respond);
      const response = await promise;

      expect(response.error).toContain('Unsupported prompt type');
      // The return is inside the try block, so finally still executes
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
