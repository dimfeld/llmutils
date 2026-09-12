/**
 * @fileoverview Resolution of the optional advisor subagent.
 *
 * The advisor is a consultation-only role: the orchestrator asks it about a
 * question or a problem that benefits from a stronger model with a broader view
 * of the system. It is off by default. It becomes available only when the
 * project configures both an executor and a model for that executor, so a
 * repository that has not opted in never sees the advisor in its orchestration
 * prompts and never has an advisor command suggested to it.
 */

import type { TimConfig } from '../configSchema.js';
import type { SubagentExecutor } from './types.js';

/** A fully configured advisor. Both fields are required for the role to exist. */
export interface AdvisorConfiguration {
  readonly executor: SubagentExecutor;
  readonly model: string;
}

/**
 * Returns the advisor configuration when the project configured both an
 * executor and a model for that executor, and `undefined` otherwise.
 *
 * Only the model matching the configured executor counts. Configuring a Codex
 * model while selecting `claude-code` leaves the advisor disabled rather than
 * silently running with the provider default model, because the whole point of
 * the role is the explicitly chosen model.
 */
export function resolveAdvisorConfiguration(
  config: TimConfig | undefined
): AdvisorConfiguration | undefined {
  const advisor = config?.subagents?.advisor;
  const executor = advisor?.executor;
  if (executor !== 'claude-code' && executor !== 'codex-cli') {
    return undefined;
  }

  const model = executor === 'codex-cli' ? advisor?.model?.codex : advisor?.model?.claude;
  if (!model?.trim()) {
    return undefined;
  }

  return { executor, model: model.trim() };
}
