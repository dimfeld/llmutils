import { describe, expect, it } from 'vitest';
import type { AgentLaunchHandle } from '../../agent_messaging/agent_manager_types.js';
import {
  CLAUDE_PERSISTENT_AGENT_MODE,
  type ClaudePersistentAgentLaunchHandle,
  isClaudePersistentAgentMode,
  validateClaudePersistentAgentLaunchHandle,
} from './persistent_agent_contract.js';
import type {
  ClaudePersistentAgentRunOptions,
  RunClaudeSubprocessOptions,
} from './run_claude_subprocess.js';
import {
  FakeAgentInputAdapter,
  FakeAgentProviderLifecycleControls,
} from '../../agent_messaging/fake_provider.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';

type Assert<T extends true> = T;
type PersistentHandleImplementsNeutralHandle = Assert<
  ClaudePersistentAgentLaunchHandle extends AgentLaunchHandle ? true : false
>;
type OneShotModeExcludesPersistentMode = Assert<
  Extract<RunClaudeSubprocessOptions['mode'], 'persistent-agent'> extends never ? true : false
>;
const persistentHandleImplementsNeutralHandle: PersistentHandleImplementsNeutralHandle = true;
const oneShotModeExcludesPersistentMode: OneShotModeExcludesPersistentMode = true;

describe('Claude persistent-agent contract', () => {
  it('keeps persistent mode explicit and one-shot mode narrow', () => {
    const persistentMode: ClaudePersistentAgentRunOptions['mode'] = CLAUDE_PERSISTENT_AGENT_MODE;
    expect(persistentMode).toBe('persistent-agent');
    expect(isClaudePersistentAgentMode('persistent-agent')).toBe(true);
    expect(isClaudePersistentAgentMode('one-shot')).toBe(false);

    const oneShotMode: 'one-shot' | undefined = 'one-shot';
    expect(oneShotMode).toBe('one-shot');
    expect(persistentHandleImplementsNeutralHandle).toBe(true);
    expect(oneShotModeExcludesPersistentMode).toBe(true);
  });

  it('validates a Claude handle with provider-neutral input and lifecycle controls', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const handle = {
      mode: CLAUDE_PERSISTENT_AGENT_MODE,
      executor: 'claude-code',
      processLabel: formatAgentProcessLabel('claude-code', 'worker-a'),
      providerState: 'spawning' as const,
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({ lastCompletedAssistantMessage: 'done' }),
      lifecycle: new FakeAgentProviderLifecycleControls(),
    } satisfies ClaudePersistentAgentLaunchHandle;

    expect(() => validateClaudePersistentAgentLaunchHandle(handle)).not.toThrow();
  });

  it('rejects a wrong mode, provider state, or executor', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const lifecycle = new FakeAgentProviderLifecycleControls();
    const base = {
      mode: 'one-shot',
      executor: 'claude-code',
      processLabel: 'Claude worker-a',
      providerState: 'spawning',
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({}),
      lifecycle,
    };

    expect(() => validateClaudePersistentAgentLaunchHandle(base)).toThrow(
      'mode must be persistent-agent'
    );
    expect(() =>
      validateClaudePersistentAgentLaunchHandle({
        ...base,
        mode: CLAUDE_PERSISTENT_AGENT_MODE,
        providerState: 'running-idle',
      })
    ).toThrow('provider state is invalid');
    expect(() =>
      validateClaudePersistentAgentLaunchHandle({
        ...base,
        mode: CLAUDE_PERSISTENT_AGENT_MODE,
        executor: 'codex-cli',
      })
    ).toThrow('executor must be claude-code');
  });

  it('rejects a missing or malformed processLabel, ready, or completion', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const lifecycle = new FakeAgentProviderLifecycleControls();
    const base = {
      mode: CLAUDE_PERSISTENT_AGENT_MODE,
      executor: 'claude-code',
      processLabel: 'Claude worker-a',
      providerState: 'spawning',
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({}),
      lifecycle,
    };

    expect(() => validateClaudePersistentAgentLaunchHandle({ ...base, processLabel: 42 })).toThrow(
      'process label must be a string'
    );
    expect(() => validateClaudePersistentAgentLaunchHandle({ ...base, ready: undefined })).toThrow(
      'ready must be a promise'
    );
    expect(() =>
      validateClaudePersistentAgentLaunchHandle({ ...base, completion: 'not-a-promise' })
    ).toThrow('completion must be a promise');
  });

  it('rejects an invalid input adapter, lifecycle controls, or release', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const lifecycle = new FakeAgentProviderLifecycleControls();
    const base = {
      mode: CLAUDE_PERSISTENT_AGENT_MODE,
      executor: 'claude-code',
      processLabel: 'Claude worker-a',
      providerState: 'spawning',
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({}),
      lifecycle,
    };

    expect(() =>
      validateClaudePersistentAgentLaunchHandle({ ...base, input: { deliver: () => {} } })
    ).toThrow();
    expect(() => validateClaudePersistentAgentLaunchHandle({ ...base, lifecycle: {} })).toThrow();
    expect(() =>
      validateClaudePersistentAgentLaunchHandle({ ...base, release: 'not-a-function' })
    ).toThrow('release must be a function');
  });

  it('accepts a handle with a valid release function', () => {
    const input = new FakeAgentInputAdapter();
    input.markReady();
    const lifecycle = new FakeAgentProviderLifecycleControls();
    const handle = {
      mode: CLAUDE_PERSISTENT_AGENT_MODE,
      executor: 'claude-code',
      processLabel: formatAgentProcessLabel('claude-code', 'worker-a'),
      providerState: 'idle' as const,
      input,
      ready: Promise.resolve(),
      completion: Promise.resolve({}),
      lifecycle,
      release: async (): Promise<void> => {},
    } satisfies ClaudePersistentAgentLaunchHandle;

    expect(() => validateClaudePersistentAgentLaunchHandle(handle)).not.toThrow();
  });
});
