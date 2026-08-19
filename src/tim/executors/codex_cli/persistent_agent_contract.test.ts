import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchHandle } from '../../agent_messaging/agent_manager_types.js';
import {
  FakeAgentInputAdapter,
  FakeAgentProviderLifecycleControls,
} from '../../agent_messaging/fake_provider.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import {
  CODEX_PERSISTENT_AGENT_MODE,
  type CodexPersistentAgentLaunchHandle,
  type CodexPersistentAgentLifecycleCallbacks,
  isCodexPersistentAgentMode,
  validateCodexPersistentAgentLaunchHandle,
  validateCodexPersistentAgentLifecycleCallbacks,
} from './persistent_agent_contract.js';

type Assert<T extends true> = T;
type PersistentHandleImplementsNeutralHandle = Assert<
  CodexPersistentAgentLaunchHandle extends AgentLaunchHandle ? true : false
>;
const persistentHandleImplementsNeutralHandle: PersistentHandleImplementsNeutralHandle = true;

describe('Codex persistent-agent contract', () => {
  it('keeps persistent mode explicit', () => {
    expect(CODEX_PERSISTENT_AGENT_MODE).toBe('persistent-agent');
    expect(isCodexPersistentAgentMode('persistent-agent')).toBe(true);
    expect(isCodexPersistentAgentMode('single-turn')).toBe(false);
    expect(persistentHandleImplementsNeutralHandle).toBe(true);
  });

  it('validates a provider-neutral Codex handle', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const handle = {
      mode: CODEX_PERSISTENT_AGENT_MODE,
      executor: 'codex-cli',
      processLabel: formatAgentProcessLabel('codex-cli', 'worker-a'),
      providerState: 'running-active' as const,
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({ lastCompletedAssistantMessage: 'done' }),
      lifecycle: new FakeAgentProviderLifecycleControls(),
    } satisfies CodexPersistentAgentLaunchHandle;

    expect(() => validateCodexPersistentAgentLaunchHandle(handle)).not.toThrow();
  });

  it('rejects an invalid mode, state, executor, and callbacks object', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const lifecycle = new FakeAgentProviderLifecycleControls();
    const base = {
      mode: 'single-turn',
      executor: 'codex-cli',
      processLabel: 'Codex thread (worker-a)',
      providerState: 'running-active',
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({}),
      lifecycle,
    };

    expect(() => validateCodexPersistentAgentLaunchHandle(base)).toThrow(
      'mode must be persistent-agent'
    );
    expect(() =>
      validateCodexPersistentAgentLaunchHandle({
        ...base,
        mode: CODEX_PERSISTENT_AGENT_MODE,
        providerState: 'idle',
      })
    ).toThrow('provider state is invalid');
    expect(() =>
      validateCodexPersistentAgentLaunchHandle({
        ...base,
        mode: CODEX_PERSISTENT_AGENT_MODE,
        executor: 'claude-code',
      })
    ).toThrow('executor must be codex-cli');

    expect(() => validateCodexPersistentAgentLifecycleCallbacks(undefined)).toThrow(
      'callbacks must be an object'
    );
    expect(() =>
      validateCodexPersistentAgentLifecycleCallbacks({
        outputActivity: vi.fn(),
        completedAssistantMessage: vi.fn(),
        turnComplete: vi.fn(),
      })
    ).toThrow('callback exit must be a function');
  });

  it('rejects malformed handle members', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const lifecycle = new FakeAgentProviderLifecycleControls();
    const base = {
      mode: CODEX_PERSISTENT_AGENT_MODE,
      executor: 'codex-cli',
      processLabel: 'Codex thread (worker-a)',
      providerState: 'running-active',
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({}),
      lifecycle,
    };

    expect(() => validateCodexPersistentAgentLaunchHandle({ ...base, processLabel: 42 })).toThrow(
      'process label must be a string'
    );
    expect(() => validateCodexPersistentAgentLaunchHandle({ ...base, ready: undefined })).toThrow(
      'ready must be a promise'
    );
    expect(() =>
      validateCodexPersistentAgentLaunchHandle({ ...base, completion: 'not-a-promise' })
    ).toThrow('completion must be a promise');
    expect(() =>
      validateCodexPersistentAgentLaunchHandle({ ...base, release: 'not-a-function' })
    ).toThrow('release must be a function');
  });

  it('keeps the lifecycle callback shape provider-neutral', () => {
    const callbacks = {
      outputActivity: vi.fn(),
      completedAssistantMessage: vi.fn(),
      turnComplete: vi.fn(),
      exit: vi.fn(),
    } satisfies CodexPersistentAgentLifecycleCallbacks;

    expect(() => validateCodexPersistentAgentLifecycleCallbacks(callbacks)).not.toThrow();
  });
});
