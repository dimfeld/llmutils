import type {
  AgentLaunchCompletion,
  AgentLaunchHandle,
  AgentProviderLifecycleControls,
  AgentProviderLifecycleObserver,
} from '../../agent_messaging/agent_manager_types.js';
import {
  validateAgentInputAdapter,
  validateAgentProviderLifecycleControls,
} from '../../agent_messaging/agent_manager_types.js';

/** The only execution mode that can create a reusable Codex provider. */
export const CODEX_PERSISTENT_AGENT_MODE = 'persistent-agent' as const;
export type CodexPersistentAgentMode = typeof CODEX_PERSISTENT_AGENT_MODE;

export function isCodexPersistentAgentMode(value: unknown): value is CodexPersistentAgentMode {
  return value === CODEX_PERSISTENT_AGENT_MODE;
}

/**
 * Provider-only states used while the persistent Codex adapter is built out.
 * These are not public AgentManager lifecycle states.
 */
export const CODEX_PERSISTENT_AGENT_STATES = [
  'starting',
  'running-active-starting',
  'running-active',
  'running-idle',
  'finishing',
  'stopping-gracefully',
  'stopping-forced',
  'terminal',
] as const;
export type CodexPersistentAgentState = (typeof CODEX_PERSISTENT_AGENT_STATES)[number];

export function isCodexPersistentAgentState(value: unknown): value is CodexPersistentAgentState {
  return (
    typeof value === 'string' &&
    (CODEX_PERSISTENT_AGENT_STATES as readonly string[]).includes(value)
  );
}

/** Lifecycle callbacks supplied by the AgentManager boundary. */
export interface CodexPersistentAgentLifecycleCallbacks extends AgentProviderLifecycleObserver {}

export interface CodexPersistentAgentCompletion extends AgentLaunchCompletion {
  readonly lastCompletedAssistantMessage?: string;
}

/** Provider-neutral handle returned by the persistent Codex launcher. */
export interface CodexPersistentAgentLaunchHandle extends Omit<AgentLaunchHandle, 'executor'> {
  readonly mode: CodexPersistentAgentMode;
  readonly executor: 'codex-cli';
  readonly providerState: CodexPersistentAgentState;
  readonly completion: Promise<CodexPersistentAgentCompletion>;
  readonly lifecycle: AgentProviderLifecycleControls;
}

/** Validate a persistent Codex handle before AgentManager binds it. */
export function validateCodexPersistentAgentLaunchHandle(
  value: unknown
): asserts value is CodexPersistentAgentLaunchHandle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Codex persistent-agent launch handle must be an object');
  }

  const handle = value as Record<string, unknown>;
  if (handle.mode !== CODEX_PERSISTENT_AGENT_MODE) {
    throw new TypeError('Codex launch handle mode must be persistent-agent');
  }
  if (handle.executor !== 'codex-cli') {
    throw new TypeError('Codex persistent-agent launch handle executor must be codex-cli');
  }
  if (!isCodexPersistentAgentState(handle.providerState)) {
    throw new TypeError('Codex persistent-agent launch handle provider state is invalid');
  }
  if (typeof handle.processLabel !== 'string') {
    throw new TypeError('Codex persistent-agent launch handle process label must be a string');
  }
  if (!isPromiseLike(handle.ready)) {
    throw new TypeError('Codex persistent-agent launch handle ready must be a promise');
  }
  if (!isPromiseLike(handle.completion)) {
    throw new TypeError('Codex persistent-agent launch handle completion must be a promise');
  }

  validateAgentInputAdapter(handle.input);
  validateAgentProviderLifecycleControls(handle.lifecycle);
  if (handle.release !== undefined && typeof handle.release !== 'function') {
    throw new TypeError('Codex persistent-agent launch handle release must be a function');
  }
}

/** Validate the callbacks before a tunnel, temp directory, or process exists. */
export function validateCodexPersistentAgentLifecycleCallbacks(
  value: unknown
): asserts value is CodexPersistentAgentLifecycleCallbacks {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Codex persistent-agent lifecycle callbacks must be an object');
  }

  const callbacks = value as Record<string, unknown>;
  for (const method of ['outputActivity', 'completedAssistantMessage', 'turnComplete', 'exit']) {
    if (typeof callbacks[method] !== 'function') {
      throw new TypeError(`Codex persistent-agent lifecycle callback ${method} must be a function`);
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
