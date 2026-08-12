import { describe, expect, it } from 'vitest';
import type { AgentLaunchHandle } from '../../agent_messaging/agent_manager_types.js';
import type { CodexPersistentAgentLaunchHandle } from './persistent_agent_contract.js';
import {
  CODEX_PERSISTENT_AGENT_MODE,
  isCodexPersistentAgentMode,
} from './persistent_agent_contract.js';

type Assert<T extends true> = T;
type PersistentHandleImplementsNeutralHandle = Assert<
  CodexPersistentAgentLaunchHandle extends AgentLaunchHandle ? true : false
>;
const persistentHandleImplementsNeutralHandle: PersistentHandleImplementsNeutralHandle = true;

describe('Codex persistent-agent contract', () => {
  it('keeps persistent mode explicit and provider-neutral', () => {
    expect(CODEX_PERSISTENT_AGENT_MODE).toBe('persistent-agent');
    expect(isCodexPersistentAgentMode('persistent-agent')).toBe(true);
    expect(isCodexPersistentAgentMode('single-turn')).toBe(false);
    expect(persistentHandleImplementsNeutralHandle).toBe(true);
  });
});
