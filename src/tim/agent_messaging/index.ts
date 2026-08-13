export { AgentManager, createAgentManager } from './agent_manager.js';
export { createAgentPreparation } from './agent_preparation.js';
export {
  buildGeneratedAgentName,
  createDefaultAgentId,
  createDefaultAgentSlug,
  DEFAULT_MAX_AGENT_ID_GENERATION_ATTEMPTS,
  DEFAULT_MAX_AGENT_NAME_GENERATION_ATTEMPTS,
  parseAgentAddress,
  parseAgentId,
  parseSubagentName,
} from './agent_names.js';
export { formatAgentProcessLabel } from './agent_process_labels.js';
export {
  FakeAgentInputAdapter,
  FakeAgentLaunchHandle,
  FakeAgentPreparer,
  FakeAgentLauncher,
} from './fake_provider.js';
export type { AgentId, AgentIdGenerator, AgentName, AgentSlugGenerator } from './agent_names.js';
export type { AgentProcessLabel } from './agent_process_labels.js';
export type {
  AgentPreparationOptions,
  CollaborativeReviewerPreparation,
} from './agent_preparation.js';
export type {
  AgentCallerIdentity,
  AgentPreparation,
  AgentPreparationRequest,
  AgentIdentity,
  AgentInputActivity,
  AgentInputAdapter,
  AgentInputDelivery,
  AgentInputMessage,
  AgentLaunchCompletion,
  AgentLaunchHandle,
  AgentLauncher,
  AgentLaunchRequest,
  AgentManagerOptions,
  AgentRecord,
  AgentRecordSnapshot,
  AgentReservation,
  AgentReservationRequest,
  AgentManagerSnapshot,
  OrchestratorAgentRecord,
  OrchestratorIdentity,
  PreparedAgentExecution,
  ProcessControlId,
  ProviderThreadId,
  SubagentAgentRecord,
  SubagentIdentity,
} from './agent_manager_types.js';
export { AgentManagerError } from './agent_manager_types.js';
export type { AgentManagerErrorCode } from './agent_manager_types.js';
