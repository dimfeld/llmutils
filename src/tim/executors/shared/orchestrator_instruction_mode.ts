/**
 * Controls how prescriptive the orchestrator is when it hands work to subagents.
 *
 * - `detailed` assumes the orchestrator is the more capable model: it spells out files,
 *   behavior, constraints, and verification steps for subagents that may run a weaker model.
 * - `delegated` assumes the subagents are capable: the orchestrator points them at the plan
 *   tasks and the intended outcome, then trusts them to work out the specifics.
 *
 * This is deliberately independent of the model and executor settings elsewhere in the config.
 * It only changes the orchestration prompt wording.
 */
export type OrchestratorInstructionMode = 'detailed' | 'delegated';

export const DEFAULT_ORCHESTRATOR_INSTRUCTION_MODE: OrchestratorInstructionMode = 'detailed';

/** Options subset consumed by the instruction-mode builders. */
export interface OrchestratorInstructionModeOptions {
  orchestratorInstructionMode?: OrchestratorInstructionMode;
}

/**
 * Every builder below returns the historical `detailed` wording unchanged, so enabling
 * `delegated` is the only thing that alters an existing prompt.
 */
export function resolveOrchestratorInstructionMode(
  options?: OrchestratorInstructionModeOptions
): OrchestratorInstructionMode {
  return options?.orchestratorInstructionMode ?? DEFAULT_ORCHESTRATOR_INSTRUCTION_MODE;
}

export function isDelegatedInstructionMode(options?: OrchestratorInstructionModeOptions): boolean {
  return resolveOrchestratorInstructionMode(options) === 'delegated';
}

/** Sentence that sets expectations about subagent capability. */
export function buildSubagentCapabilityGuidance(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'Subagents are as capable as you are and can read the plan, the task details, and the codebase themselves. Point them at the tasks and the outcome you want, then trust them to work out which files to touch, how to implement the change, and how to verify it. Do not hand them a file-by-file recipe or re-derive their implementation for them.';
  }

  return 'Subagents may use a less capable model than you. Be specific when asking them to make changes: name the files, required behavior, constraints, and verification steps.';
}

/** Guidance for what to put in `--input` / `--input-file` when invoking a `tim subagent`. */
export function buildSubagentInvocationGuidance(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'When invoking subagents, name the task titles in scope and the outcome you expect, plus anything they cannot discover on their own: decisions already made, context from earlier phases, and accepted review findings. Leave the implementation specifics to them.';
  }

  return 'When invoking subagents, provide clear, specific instructions in `--input` (or `--input-file`) about what needs to be done in addition to referencing the task titles.';
}

/** Shorter variant used by the simple wrapper. */
export function buildSimpleSubagentInvocationGuidance(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'When invoking subagents, reference the specific task titles in scope and the outcome you expect in `--input` (or `--input-file`), and leave the implementation specifics to them.';
  }

  return 'When invoking subagents, give clear instructions in `--input` (or `--input-file`) referencing the specific task titles.';
}

/** Guidance for the initial assignment sent to a collaborative (messaging) agent. */
export function buildCollaborativeAssignmentGuidance(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'Scope every initial assignment without prescribing it: name the task and the expected handoff, add constraints the agent cannot discover on its own, and leave files, approach, and verification to the agent. Use SendTimAgentMessage for useful decisions, blockers, questions, and handoffs, not noisy status traffic.';
  }

  return 'Keep every initial assignment specific: task, files, constraints, verification, and expected handoff. Use SendTimAgentMessage for useful decisions, blockers, questions, and handoffs, not noisy status traffic.';
}

/** Contents of the StartTimAgent initial message, per instruction mode. */
export function buildStartAgentMessageContents(
  planId: string,
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return `an initial message containing plan \`${planId}\`, the task titles in scope, and the expected handoff. Let the agent determine the files, approach, and verification.`;
  }

  return `an initial message containing plan \`${planId}\`, the exact task and file scope, constraints, and expected handoff.`;
}

/** The StartTimAgent initial-message contract stated in the collaborative tool guidance. */
export function buildStartAgentInitialMessageContract(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'its initial message must state the task and the expected handoff, plus any constraint it could not discover on its own';
  }

  return 'its initial message must state the task, file scope, constraints, and expected handoff';
}

/** Opening of the collaborative "Agent Autonomy" section. */
export function buildAgentAutonomyGuidance(options?: OrchestratorInstructionModeOptions): string {
  if (isDelegatedInstructionMode(options)) {
    return 'Give each subagent a clear outcome and the expected handoff, plus any constraint it cannot discover on its own. Then let it choose the files, implementation steps, and verification, and work independently.';
  }

  return 'Give each subagent a clear outcome, file scope, constraints, verification steps, and expected handoff. Then let it choose its own implementation steps and work independently.';
}

/**
 * Prominent section describing the delegation posture. `detailed` mode returns an empty
 * string so the historical prompts are unchanged; only `delegated` adds a section.
 */
export function buildSubagentInstructionStyleSection(
  options?: OrchestratorInstructionModeOptions
): string {
  if (!isDelegatedInstructionMode(options)) {
    return '';
  }

  return `## Subagent Instruction Style

Your subagents are capable and can read the plan file, the task details, and the codebase for themselves. Instruct them by pointing at the work, not by specifying it:

- Name the plan tasks in scope and the outcome you expect, then let the subagent decide which files to change, how to implement the change, and how to verify it.
- Do not write a file-by-file implementation plan, a step-by-step recipe, or a diff sketch for them, and do not work out the solution yourself before delegating.
- Do pass along what they cannot discover on their own: decisions you already made, constraints from earlier phases, accepted review findings, and the handoff you expect back.
- When a result misses the mark, restate the outcome and what was wrong with the result rather than dictating the implementation.
- You still own task selection, sequencing, every review gate, plan updates, and the integrated result.

`;
}

/** Collaborative implementation phase: what the initial message to an implementer carries. */
export function buildCollaborativeInitialMessageLine(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'Put the task, the outcome you expect, any constraint the agent cannot discover on its own, and the expected handoff in each initial message. State file ownership only where concurrent agents could collide; leave the approach to the agent.';
  }

  return 'Put the task, exact files, constraints, verification, and expected handoff in each initial message.';
}

/** Collaborative simple workflow: how to start the single implementer. */
export function buildCollaborativeSimpleImplementerLine(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'Start an implementer with a clear task, the outcome you expect, any constraint it cannot discover on its own, and the expected handoff. Let it choose which files to change and how to verify the result.';
  }

  return 'Start an implementer with a clear task, exact file scope, constraints, verification steps, and expected handoff.';
}

/** Collaborative TDD workflow: how to start a tdd-tests agent. */
export function buildCollaborativeTddTestsLine(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return 'Start one tdd-tests agent per independent scope with the task and the behavior its tests must pin down, and let it choose the test files and cases. Require it to report the expected failure reason.';
  }

  return 'Start one tdd-tests agent per independent scope with the exact task, files, expected behavior, and expected failure reason.';
}

/** Collaborative TDD workflow: how to start the implementer after the red phase. */
export function buildCollaborativeTddImplementerLine(
  options?: OrchestratorInstructionModeOptions
): string {
  if (isDelegatedInstructionMode(options)) {
    return "After each scope's expected failure is verified, start its implementer with the TDD output, the outcome you expect, and the expected handoff. State file ownership only where concurrent scopes could collide. Keep that implementer active for later review fixes when useful.";
  }

  return "After each scope's expected failure is verified, start its implementer with the TDD output, exact file ownership, constraints, and expected handoff. Keep that implementer active for later review fixes when useful.";
}
