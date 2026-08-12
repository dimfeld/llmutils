import type { AgentManager } from './agent_manager.js';
import {
  AgentDirectory,
  validateAgentReservationRequest,
  type AgentReservation,
  type AgentReservationRequest,
} from './agent_directory.js';

/** Test-only access to directory reservations; StartTimAgent remains the facade API. */
export function reserveSubagentForTest(
  manager: AgentManager,
  request: AgentReservationRequest
): AgentReservation {
  const internal = manager as unknown as { readonly directory: AgentDirectory };
  return internal.directory.reserve(validateAgentReservationRequest(request));
}
