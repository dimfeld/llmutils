import type {
  AgentInputAdapter,
  AgentLaunchCompletion,
  AgentLaunchHandle,
  AgentProviderLifecycleControls,
} from '../../agent_messaging/agent_manager_types.js';
import {
  validateAgentInputAdapter,
  validateAgentProviderLifecycleControls,
} from '../../agent_messaging/agent_manager_types.js';

/** The only execution mode that can create a reusable Claude provider. */
export const CLAUDE_PERSISTENT_AGENT_MODE = 'persistent-agent' as const;
export type ClaudePersistentAgentMode = typeof CLAUDE_PERSISTENT_AGENT_MODE;

export function isClaudePersistentAgentMode(value: unknown): value is ClaudePersistentAgentMode {
  return value === CLAUDE_PERSISTENT_AGENT_MODE;
}

/**
 * Claude's private provider state. These values are deliberately not the
 * public AgentManager lifecycle states. In particular, background result
 * handling and close-after-result are provider concerns.
 */
export const CLAUDE_PERSISTENT_AGENT_STATES = [
  'spawning',
  'active',
  'result-pending-background',
  'idle',
  'finish-after-result',
  'graceful-stop-active',
  'closing',
  'exited',
  'failed',
] as const;
export type ClaudePersistentAgentState = (typeof CLAUDE_PERSISTENT_AGENT_STATES)[number];

export function isClaudePersistentAgentState(value: unknown): value is ClaudePersistentAgentState {
  return (
    typeof value === 'string' &&
    (CLAUDE_PERSISTENT_AGENT_STATES as readonly string[]).includes(value)
  );
}

/**
 * Completion facts captured by the Claude adapter. Intermediate turn results
 * do not settle this value; it describes provider completion only.
 */
export interface ClaudePersistentAgentCompletion extends AgentLaunchCompletion {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals | null;
  readonly killedByInactivity?: boolean;
  readonly resultText?: string;
  readonly lastCompletedAssistantMessage?: string;
}

/**
 * Provider-neutral launch handle implemented by a persistent Claude session.
 * The inherited input and lifecycle members are the only manager-facing
 * controls; raw stdin and raw process handles are intentionally absent.
 */
export interface ClaudePersistentAgentLaunchHandle extends Omit<
  AgentLaunchHandle,
  'completion' | 'executor'
> {
  readonly mode: ClaudePersistentAgentMode;
  readonly executor: 'claude-code';
  readonly providerState: ClaudePersistentAgentState;
  readonly input: AgentInputAdapter;
  readonly lifecycle: AgentProviderLifecycleControls;
  readonly completion: Promise<ClaudePersistentAgentCompletion>;
}

/** Narrow runtime check used at the provider boundary before manager binding. */
export function validateClaudePersistentAgentLaunchHandle(
  value: unknown
): asserts value is ClaudePersistentAgentLaunchHandle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Claude persistent-agent launch handle must be an object');
  }

  const handle = value as Record<string, unknown>;
  if (handle.mode !== CLAUDE_PERSISTENT_AGENT_MODE) {
    throw new TypeError('Claude launch handle mode must be persistent-agent');
  }
  if (handle.executor !== 'claude-code') {
    throw new TypeError('Claude persistent-agent launch handle executor must be claude-code');
  }
  if (!isClaudePersistentAgentState(handle.providerState)) {
    throw new TypeError('Claude persistent-agent launch handle provider state is invalid');
  }
  if (typeof handle.processLabel !== 'string') {
    throw new TypeError('Claude persistent-agent launch handle process label must be a string');
  }
  if (!isPromiseLike(handle.ready)) {
    throw new TypeError('Claude persistent-agent launch handle ready must be a promise');
  }
  if (!isPromiseLike(handle.completion)) {
    throw new TypeError('Claude persistent-agent launch handle completion must be a promise');
  }

  validateAgentInputAdapter(handle.input);
  validateAgentProviderLifecycleControls(handle.lifecycle);
  if (handle.release !== undefined && typeof handle.release !== 'function') {
    throw new TypeError('Claude persistent-agent launch handle release must be a function');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
