import type {
  AgentLaunchCompletion,
  AgentLaunchHandle,
  AgentProviderLifecycleControls,
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
