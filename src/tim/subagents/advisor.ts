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

/**
 * Renders the advisor section for the planning prompts.
 *
 * Returns an empty string unless the project configured an advisor, so a
 * repository that has not opted in is never told about a role it cannot run.
 * The planning agent usually has a plan ID, but the advisor also runs without
 * one, so the guidance names both forms.
 */
export function buildPlanningAdvisorGuidance(
  config: TimConfig | undefined,
  planId?: number | string
): string {
  const advisor = resolveAdvisorConfiguration(config);
  if (!advisor) {
    return '';
  }

  const planArgument = planId !== undefined ? `${planId} ` : '';
  const planlessNote =
    planId !== undefined
      ? '- The plan ID is optional. `tim subagent advisor --input "<question>"` consults the advisor about the local repository alone, which is what you want for a question that is not tied to this plan.'
      : '- The consultation is not tied to a plan. The advisor reads the local repository and answers the question you send it.';

  return `
# Advisor

A more capable advisor subagent is configured for this project. It runs \`${advisor.executor}\` with the \`${advisor.model}\` model and reads the codebase for itself, so it can answer questions that need a stronger model and a broader view of the system than your own exploration gives you.

- Run \`tim subagent advisor ${planArgument}--input "<question>"\` via the shell command tool (or \`--input-file <paths...>\`). Do not pass \`-x\` or \`-m\`; the advisor always runs with its own configured executor and model.
${planlessNote}
- Consult it while planning whenever a decision would be expensive to get wrong: which architecture or existing abstraction to build on, how the change interacts with subsystems and invariants elsewhere in the codebase, whether an approach fits the patterns already here, where the plan should be split, and which risks or migration concerns the plan must cover.
- Ask a specific question and include what you already found: the decision to make, the options you are weighing, the files and patterns you already read, and the constraints that apply. A vague question wastes the consultation.
- The advisor is read-only. It does not edit files and it does not write the plan. You own the plan and every decision in it: fold the parts of its answer you accept into the Research and Implementation Guide sections, and say what you rejected and why.
- Consulting the advisor is optional. Skip it for small or routine work whose approach is already clear.
`;
}
