/**
 * Options shared by the orchestration prompt wrappers and the review-guidance builders.
 *
 * This lives in its own module so `review_guidance.ts` and `orchestrator_prompt.ts` can both
 * depend on it without depending on each other. They previously formed a source-level cycle
 * that was harmless only because the back-edge happened to be type-only.
 */
import type { AdvisorConfiguration } from '../../subagents/advisor.js';
import type { OrchestratorInstructionMode } from './orchestrator_instruction_mode.js';

export interface OrchestrationOptions {
  batchMode?: boolean;
  /**
   * When true, the standalone `--structural-only` pass already ran for this plan, so the
   * final-batch review guidance omits it and the post-structural validation review.
   */
  structuralReviewCompleted?: boolean;
  planFilePath?: string;
  reviewExecutor?: string;
  /** Path to custom reviewer instructions configured in agents.reviewer.instructions. */
  reviewerInstructionsPath?: string;
  simpleMode?: boolean;
  /** Code-quality profile selected for this run. */
  quality?: 'hobby' | 'production';
  /**
   * Root-session snapshot of the experimental agent-messaging setting.
   * Collaborative prompt branches consume this immutable session value.
   */
  agentMessagingEnabled?: boolean;
  /**
   * Which executor to use for subagents: 'codex-cli', 'claude-code', or 'dynamic'.
   * When 'dynamic', the orchestrator decides per-task based on dynamicSubagentInstructions.
   * When undefined, defaults to 'dynamic' behavior.
   */
  subagentExecutor?: 'codex-cli' | 'claude-code' | 'dynamic';
  /**
   * Instructions for the orchestrator when choosing between claude-code and codex-cli
   * for subagent execution in dynamic mode.
   */
  dynamicSubagentInstructions?: string;
  /**
   * When true, the workspace uses Jujutsu (jj) for version control.
   * Instructs the orchestrator to use jj commands instead of git.
   */
  useJj?: boolean;
  /**
   * Whether plan file references should be prefixed with `@`. Claude Code uses the
   * `@` prefix to make a file accessible to its Edit tool; other providers (e.g. Codex)
   * do not use this semantic and should receive the raw path. Defaults to true.
   */
  useAtPrefix?: boolean;
  /**
   * How prescriptive the orchestrator should be when instructing subagents.
   * `detailed` (the default) keeps the historical prompts that spell out files, behavior,
   * and verification. `delegated` tells the orchestrator to point capable subagents at the
   * plan tasks and let them work out the specifics.
   */
  orchestratorInstructionMode?: OrchestratorInstructionMode;
  /**
   * The optional advisor subagent, resolved from config. Present only when the project
   * configured both an executor and a model for it; the orchestration prompts mention the
   * advisor only when this is set.
   */
  advisor?: AdvisorConfiguration;
}
