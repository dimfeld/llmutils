import {
  buildBatchReviewRejectionGuidance,
  buildFinalBatchReviewGuidance,
  buildFormalReviewScopeGuidance,
  buildFullPlanReviewCommand,
  buildReviewCommand,
  buildReviewIterationGuidance,
  structuralPassApplies,
} from './review_guidance.js';
export type { OrchestrationOptions } from './orchestration_options.js';
import type { OrchestrationOptions } from './orchestration_options.js';
import { createOrchestrationDelegationRenderer } from './orchestration_delegation.js';
import {
  buildCollaborativeAvailableAgents,
  buildCollaborativeToolGuidance,
} from './collaboration_prompt.js';

const INPUT_COMBINATION_GUIDANCE =
  '- You can use both `--input-file` and `--input` together. `--input-file` is read first and `--input` is appended afterward.';

function buildReviewIssueCleanupGuidance(planId: string): string {
  return `- When the blocking review loop is terminal, run \`tim review-issues list ${planId}\`. For every saved \`Non-blocking\` finding that has a straightforward, contained fix, fix it before finishing. Run focused verification, then immediately delete that finding with \`tim review-issues resolve ${planId} <issue-index>\`. Re-list before each resolve because indexes can change. Do not resolve a finding until its fix is complete and verified. This also applies when you later fix a rejected finding.`;
}

/**
 * Points at the Review Iteration Policy rather than restating what
 * `--task-index` means. The agent list this is appended to varies by wrapper,
 * so any sentence here that describes which commands take the flag, or what it
 * does, goes stale as soon as a list changes. The policy owns the semantics.
 */
const REVIEW_FIX_TASK_INDEX_GUIDANCE =
  'The implementation subagents above also accept a `--task-index <indexes...>` option. See the Review Iteration Policy below for when to use it and what the indexes mean; do not infer its behavior from the reviewer option of the same name.';

const SUBAGENT_SPECIFICITY_GUIDANCE =
  'Subagents may use a less capable model than you. Be specific when asking them to make changes: name the files, required behavior, constraints, and verification steps.';

const BRANCH_SETUP_GUIDANCE =
  '- **The git branch for this task has already been set up.** Do not create, switch, or check out any branches. Do not use git worktrees. Work in the current directory as-is.';

const JJ_VCS_GUIDANCE = `- **This workspace uses Jujutsu (jj) for version control.** Use \`jj\` for all VCS operations instead of \`git\`. Do NOT run \`git\` commands that create or move commits, branches, or bookmarks; they do not reflect Jujutsu's working-copy model and can leave commits stranded above the base branch instead of on the active bookmark.
- When delegating to subagents, ensure they also use \`jj\` (never \`git\`) for all version control operations.`;

function buildJjGuidance(options: OrchestrationOptions): string {
  return options.useJj ? `\n${JJ_VCS_GUIDANCE}` : '';
}

function buildInputFileRandomizationGuidance(planId: string): string {
  return `- If input is large (roughly over 50KB), write it to a temporary file in a temp directory (for example, \`/tmp/claude\` or a \`mktemp\` path) and pass \`--input-file <paths...>\` instead of \`--input\`.
- When you create an input file for a subagent or reviewer, do not use shell commands or scripts to generate random numbers or timestamps for the filename.
- Prefer deterministic names such as \`/tmp/claude/tim-${planId}-<purpose>.md\`, \`/tmp/claude/tim-${planId}-<purpose>-task-1.md\`, or a stable counter-based filename.
- Recommended pattern: \`/tmp/claude/tim-${planId}-<purpose>-6170.md\`.
- It is also acceptable to reuse the same filename each time if that is simpler.
- Always explicitly pass the full path instead of using "$TMPDIR/filename".
- You can also pipe input to stdin and use \`--input-file -\`.`;
}

function buildBatchReviewerInstructionsGuidance(options: OrchestrationOptions): string {
  if (!options.batchMode || !options.reviewerInstructionsPath) {
    return '';
  }

  return `   - Before reviewing, read and follow the reviewer subagent instructions at \`${options.reviewerInstructionsPath}\`. Apply this review-specific guidance to your per-batch review.
`;
}

export function progressSectionGuidance(
  planFilePath?: string,
  options?: { useAtPrefix?: boolean }
) {
  const useAtPrefix = options?.useAtPrefix ?? true;
  const planLocation = planFilePath
    ? `Update the plan file at: ${useAtPrefix ? '@' : ''}${planFilePath}`
    : 'Update the plan file referenced in the task context.';

  return `
## Progress Updates (Plan File)

${planLocation}

If you edit the plan file instead of using \`tim add-task\`, run \`tim sync\` to save the changes to the plan database.

After each successful iteration (and again at the end of the run), update the plan file's \`## Current Progress\` section:
- Create the section at the end of the file if it does not exist (keep it outside any generated delimiters).
- Update in place: edit or replace outdated text so the section reflects current reality while preserving meaningful history.
- No timestamps anywhere in the section.
- Focus on what changed, why it changed, and what's next. Omit testing/review info, focus on what's useful to remember when starting the next task.
- Only remove information if it no longer applies. For example, decisions from previous tasks should remain unless they have been changed. 
- In \`### Lessons Learned\`, capture surprises, gotchas, non-obvious fixes, and what was learned from review feedback or review-fix iterations. Only include lessons that will actually be useful in the future, not things that are just specific only to the work just performed in this plan.

Use this structured template (fill every heading; use "None" when empty):

## Current Progress
### Current State
- ...
### Completed (So Far)
- ...
### Remaining
- ...
### Next Iteration Guidance
- ...
### Decisions / Changes
- ...
### Lessons Learned
- Record surprises, unexpected issues, non-obvious solutions, workarounds, or undocumented insights.
- Especially note what you learned while fixing review feedback and why the issue occurred, if the insights are applicable to future tasks and not just this one.
- Update this subsection in place. Keep ongoing lessons that still matter; remove only stale lessons.
- None
### Risks / Blockers
- None
`;
}

/**
 * Builds the batch mode processing instructions
 */
function buildBatchModeInstructions(options: OrchestrationOptions): string {
  if (!options.batchMode) return '';

  return `# Batch Task Processing Mode

You have been provided with multiple incomplete tasks from a project plan. Your responsibility is to:

1. **Analyze all provided tasks** to understand their scope, dependencies, and relationships
2. **Select a logical subset** of tasks that make sense to execute together in this batch.
   You are permitted to implement tasks from different Areas together.
3. **Execute the selected tasks** using the specialized agents
4. **Update the plan file** to document your work
5. Mark the tasks done.

If existing work has been done on the plan, you can find it described in the "# Implementation Notes" section of the plan file's details field.

## Task Selection Guidelines

When selecting which tasks to batch together, consider:
- **Related functionality**: Tasks that work on similar features or components
- **Shared files**: Tasks that modify the same files or modules
- **Logical dependencies**: Tasks where one naturally builds upon another
- **Efficiency**: Tasks that can reuse context or setup work
- **Reasonable scope**: Select a single task or 2-5 related tasks rather than attempting all tasks at once.

**IMPORTANT**: Do not attempt to complete all tasks in a single batch. Focus on a reasonable subset that can be completed thoroughly and tested properly.

## Plan File Updates

After successfully completing your selected tasks, you MUST edit the plan file at: ${options.planFilePath || 'PLAN_FILE_PATH_NOT_PROVIDED'}

For each completed task, update the YAML structure by setting \`done: true\`. Find each task item using the title. Here's an example:

\`\`\`yaml
tasks:
  - title: "Implement user authentication"
    done: true  # Already completed
    description: "Add login/logout functionality"
    
  - title: "Add password validation"
    # Add done: true here if this has been completed
    description: "Implement password strength checking"
\`\`\`


**CRITICAL**: Only mark tasks as \`done: true\` after they have been successfully implemented, tested, and reviewed. Do not mark tasks as done if:
- Implementation failed or is incomplete
- Tests are failing
- Review findings remain unhandled under the Review Iteration Policy

You don't need to mark the entire plan file as complete. We will handle that for you. But if you do, you must use 'status: done'

`;
}

const DEFAULT_DYNAMIC_SUBAGENT_INSTRUCTIONS =
  'Prefer claude-code for frontend tasks, codex-cli for backend tasks. When choosing executors for implementer and tester, prefer using the same executor for both to maintain consistency and leverage the same strengths.';

/**
 * Builds the subagent executor selection guidance for dynamic mode.
 */
function buildDynamicExecutorGuidance(options: OrchestrationOptions): string {
  if (options.agentMessagingEnabled === true) {
    const instructions =
      options.dynamicSubagentInstructions || DEFAULT_DYNAMIC_SUBAGENT_INSTRUCTIONS;
    const executorRule =
      options.subagentExecutor === 'codex-cli' || options.subagentExecutor === 'claude-code'
        ? `Use \`${options.subagentExecutor}\` as the executor value for every StartAgent call.`
        : 'Choose `codex-cli` or `claude-code` in the executor field of each StartAgent call.';

    return `## Subagent Executor Selection

${executorRule}
Both executors are supported for implementer, tester, tdd-tests, and reviewer agents. ${instructions}
`;
  }

  if (options.subagentExecutor && options.subagentExecutor !== 'dynamic') {
    return '';
  }

  const instructions = options.dynamicSubagentInstructions || DEFAULT_DYNAMIC_SUBAGENT_INSTRUCTIONS;

  return `## Subagent Executor Selection

You must choose which executor to use for each subagent invocation by passing \`-x codex-cli\` or \`-x claude-code\` to the \`tim subagent\` command.

Decision guidance: ${instructions}
`;
}

function buildCollaborativeReviewCommand(planId: string, options: OrchestrationOptions): string {
  return options.batchMode
    ? buildFullPlanReviewCommand(planId, options)
    : buildReviewCommand(planId, options);
}

function buildCollaborativeFormalReviewPhase(
  planId: string,
  options: OrchestrationOptions,
  phaseNumber: string,
  extraGuidance: string = ''
): string {
  const reviewCommand = buildCollaborativeReviewCommand(planId, options);
  const formalReviewerInputGuidance =
    '   - Pass relevant implementation and test notes to the formal reviewer with `--input <text>` or `--input-file <paths...>`.\n';
  return `${phaseNumber}. **Formal Review Phase**
   - Run \`${reviewCommand}\` as a separate one-shot formal gate with the shell command tool.
${formalReviewerInputGuidance}${extraGuidance}${buildFormalReviewScopeGuidance(planId)}
   - Do not replace this formal review with a StartAgent reviewer. The formal process has fresh context and no collaborative tools.
   - Apply the Review Iteration Policy for full scope, diff-scoped \`--since\` verification, closing full scope, severity, and bounded review handling.`;
}

function buildCollaborativeWorkflowInstructions(
  planId: string,
  options: OrchestrationOptions
): string {
  const implementationPhaseNumber = options.batchMode ? '2' : '1';
  const testingPhaseNumber = options.batchMode ? '3' : '2';
  const reviewPhaseNumber = options.batchMode ? '4' : '3';
  const reviewCommand = buildCollaborativeReviewCommand(planId, options);
  const batchSelection = options.batchMode
    ? `1. **Task Selection Phase**
   - Analyze all provided tasks, select a focused subset, and document the selection before starting agents.
   - Keep task selection and plan updates with the orchestrator.

`
    : '';
  const reviewPhase = options.batchMode
    ? buildOrchestratorBatchReviewPhase(planId, options, reviewPhaseNumber)
    : buildCollaborativeFormalReviewPhase(planId, options, reviewPhaseNumber);

  return `## Workflow Instructions

You MUST follow this collaborative development process:

${batchSelection}${implementationPhaseNumber}. **Implementation Phase**
   - Start one or more implementer agents only when each has a clear task and disjoint or explicitly coordinated file scope.
   - Put the task, exact files, constraints, verification, and expected handoff in each initial message.
   - Safe independent work may run concurrently, including multiple implementers of the same type. Coordinate before any shared-file edit.
   - Keep the implementer assignments active for follow-up context when useful; use SendAgentMessage acknowledgements as described above and do not duplicate queued messages.

${testingPhaseNumber}. **Testing Phase**
   - Start tester agents for completed or stable implementation scopes. Test analysis may run early, but final validation must run against the completed implementation.
   - Give each tester an explicit test or fixture file scope. A tester must claim that scope before editing it and must report the checks it ran and any remaining gaps.
   - Do not claim success until the required implementation and testing work is complete.

${reviewPhase}

${options.batchMode ? '5' : '4'}. **Notes and Completion Phase**
   - Update plan progress and task state only after the selected implementation, tests, and review gates are complete.
   - Continue until checks pass, all blocking review findings are fixed or handled by the Review Iteration Policy, and the final required full-scope review is complete.
   - Ask each finished subagent for its final handoff and FinishAgent call. The orchestrator remains responsible for the integrated workspace and completion decision.

${options.batchMode ? '6' : '5'}. **Iteration**
   - For a blocking fix, send the exact finding, owning task, and file scope to the existing implementer or start a new implementer with that scope.
   - Keep formal review iterations within the existing four ordinary-review bound and preserve the structural-pass and bounded-handoff rules.
   - Do not start a mutating agent for a scope that another mutating agent currently owns without an explicit handoff or edit order.

${buildReviewIterationGuidance(reviewCommand, options)}`;
}

function buildCollaborativeSimpleWorkflowInstructions(
  planId: string,
  options: OrchestrationOptions
): string {
  const reviewCommand = buildCollaborativeReviewCommand(planId, options);
  const reviewPhaseNumber = options.batchMode ? '3' : '2';
  const batchSelection = options.batchMode
    ? `1. **Task Selection Phase**
   - Select and document a focused task subset before starting agents. The orchestrator owns selection and plan updates.

`
    : '';
  const reviewPhase = options.batchMode
    ? buildOrchestratorBatchReviewPhase(planId, options, reviewPhaseNumber)
    : buildCollaborativeFormalReviewPhase(planId, options, reviewPhaseNumber);
  return `## Workflow Instructions

Use a small collaborative team while preserving all implementation, review, and completion gates:

${batchSelection}${options.batchMode ? '2' : '1'}. **Implementation Phase**
   - Start an implementer with a clear task, exact file scope, constraints, verification steps, and expected handoff.
   - You may keep one implementer alive for follow-up work or add a read-only reviewer. Do not overlap mutating file ownership without coordination.
   - Use SendAgentMessage for changed facts and handoffs; a queued acknowledgement is already successful.
   - Before formal review, require the implementer to run the required tests and checks and report their results. Start a tester for independent validation when the scope needs one.

${reviewPhase}

${options.batchMode ? '4' : '3'}. **Notes and Iteration**
   - Update progress and completion state only after implementation, checks, and formal review satisfy the existing policy.
   - Fix accepted blocking findings within their owning task and file scope, then repeat the same formal review mechanism.
   - Ask the implementer to make its final handoff and call FinishAgent. FinishAgent is self-only and is not a root-callable tool.

${buildReviewIterationGuidance(reviewCommand, options)}`;
}

function buildCollaborativeFailureProtocol(agentTypes: string): string {
  return `## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor ${agentTypes} responses for a line starting with FAILED:.
- A FAILED report is a signal to investigate, not an automatic reason to stop orchestration.
- Inspect the current work and decide whether the problem is a recoverable code, test, lint, type-check, build, or setup error before stopping.
- Treat the failure as genuine only when it cannot be resolved safely without a user decision or expected functionality is missing beyond this scope.
- If a failure is recoverable, send a precise fix assignment and continue the required testing and formal review gates.
`;
}

function buildCollaborativeImportantGuidelines(
  planId: string,
  options: OrchestrationOptions
): string {
  const reviewCommand = buildCollaborativeReviewCommand(planId, options);
  return `## Important Guidelines

- Use StartAgent for delegated implementation, testing, TDD test writing, and advisory review work. Do not implement or write tests directly when an assigned agent owns that scope.
- StartAgent-created reviewers are read-only and advisory. Always run the separate one-shot \`${reviewCommand}\` formal gate; it has fresh context and no messaging tools.
- Preserve implementation, testing, plan update, completion, severity, structural, and bounded review policy. Parallel scheduling does not remove any gate.
- Keep every initial assignment specific: task, files, constraints, verification, and expected handoff. Use SendAgentMessage for useful decisions, blockers, questions, and handoffs, not noisy status traffic.
- Coordinate shared-workspace file ownership before concurrent mutating edits. The orchestrator owns task selection, final integration, plan updates, and completion.
- Treat \`steered\`, \`queued\`, and \`started-idle-turn\` as successful delivery results. Never duplicate a message because it was queued.
- Ask agents to call self-only FinishAgent after their assignment and final handoff. The root cannot call FinishAgent and must use terminal notifications for final status.
${buildRejectedReviewIssueCleanupGuidance(planId)}
- ${SUBAGENT_SPECIFICITY_GUIDANCE}
- ${BRANCH_SETUP_GUIDANCE}${buildJjGuidance(options)}
${buildCollaborativeFailureProtocol('collaborative agent')}
${markTasksDoneGuidance(planId)}
${buildPlanDocumentationGuidance()}
${progressSectionGuidance(options.planFilePath, { useAtPrefix: options.useAtPrefix })}`;
}

function buildPlanDocumentationGuidance(): string {
  return `
## Plan Documentation During Implementation

If you or an agent discover that the plan needs to change during implementation, update the plan text so it reflects the current approach. Add a \`## Changes Made During Implementation\` section before \`## Current Progress\` and record what changed and why. Ask agents to report proposed plan changes rather than editing plan state on their own.`;
}

function buildCollaborativeSimplePrompt(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions
): string {
  const header = `# Two-Phase Collaborative Orchestration Instructions

You are coordinating a small tim team for the tasks below. Use persistent agents only for clear assignments and preserve the formal review policy.`;
  const footer = `## Task Context

Below is the original task context to execute with this collaborative workflow:

---

${contextContent}`;

  return `${header}

${buildBatchModeInstructions(options)}
${buildCollaborativeToolGuidance()}
${buildCollaborativeAvailableAgents(planId, ['implementer', 'reviewer'], options)}
${buildDynamicExecutorGuidance(options)}
${buildCollaborativeSimpleWorkflowInstructions(planId, options)}
${buildCollaborativeImportantGuidelines(planId, options)}
${footer}`;
}

function buildCollaborativeTddPrompt(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions
): string {
  const isSimpleTdd = options.simpleMode === true;
  const reviewCommand = buildCollaborativeReviewCommand(planId, options);
  const implementationPhaseNumber = options.batchMode ? '3' : '2';
  const verificationPhaseNumber = options.batchMode ? '4' : '3';
  const reviewPhaseNumber = isSimpleTdd
    ? options.batchMode
      ? '4'
      : '3'
    : options.batchMode
      ? '5'
      : '4';
  const notesPhaseNumber = isSimpleTdd
    ? options.batchMode
      ? '5'
      : '4'
    : options.batchMode
      ? '6'
      : '5';
  const iterationPhaseNumber = isSimpleTdd
    ? options.batchMode
      ? '6'
      : '5'
    : options.batchMode
      ? '7'
      : '6';
  const batchSelection = options.batchMode
    ? `1. **Task Selection Phase**
   - Select a focused task subset and record the selection before starting independent TDD pipelines.

`
    : '';
  const testingPhase = isSimpleTdd
    ? ''
    : `
${verificationPhaseNumber}. **Testing Phase**
   - Start a tester for the completed implementation scope. It may prepare non-mutating analysis early, but final validation must run against the completed implementation.
   - Give the tester an explicit test and fixture file scope, require it to coordinate before edits, and preserve its check output for review.
`;
  const reviewPhase = options.batchMode
    ? buildOrchestratorBatchReviewPhase(planId, options, reviewPhaseNumber)
    : buildCollaborativeFormalReviewPhase(
        planId,
        options,
        reviewPhaseNumber,
        '   - Run this gate after the implementation and final checks.\n'
      );
  const header = `# TDD Collaborative Orchestration Instructions

You are coordinating a tim Test-Driven Development workflow. Use persistent agents for separate scopes, but enforce red-before-green for every scope:
1. The tdd-tests agent writes and runs expected failing tests.
2. The implementer starts only after the orchestrator receives evidence that those tests fail for the expected behavioral reason.
3. Testing and formal review run against the completed implementation.`;
  const footer = `## Task Context

Below is the original task context to execute with this collaborative TDD workflow:

---

${contextContent}`;

  return `${header}

${buildBatchModeInstructions(options)}
${buildCollaborativeToolGuidance()}
${buildCollaborativeAvailableAgents(
  planId,
  isSimpleTdd
    ? ['tdd-tests', 'implementer', 'reviewer']
    : ['tdd-tests', 'implementer', 'tester', 'reviewer'],
  options
)}
${buildDynamicExecutorGuidance(options)}
## Workflow Instructions

You MUST keep TDD ordering per implementation scope while allowing independent scopes to run in parallel:

${batchSelection}${options.batchMode ? '2' : '1'}. **TDD Test Phase**
   - Start one tdd-tests agent per independent scope with the exact task, files, expected behavior, and expected failure reason.
   - Require each agent to write tests first, run them, and report evidence that the failure is behavioral rather than a syntax, import, setup, or environment failure.
   - Independent scopes may run their red phases concurrently. Do not start the implementer for a scope until that scope's red evidence is verified.

${implementationPhaseNumber}. **Implementation Phase**
   - After each scope's expected failure is verified, start its implementer with the TDD output, exact file ownership, constraints, and expected handoff.
   - Implementers for independent scopes may run concurrently. Coordinate before shared-file edits and do not let an implementer change a scope whose red phase is incomplete.
   - Send follow-up facts through SendAgentMessage and treat queued delivery as accepted.
${testingPhase}
${reviewPhase}

${notesPhaseNumber}. **Notes and Completion Phase**
   - Update plan progress only after the selected implementation, final checks, and required formal review gates are complete.
   - Ask each agent for a final handoff and self-only FinishAgent call. The orchestrator owns the integrated result.

${iterationPhaseNumber}. **Iteration**
   - Keep red-before-green intact for every new implementation scope and every substantial review-fix scope.
   - Send accepted blocking findings with their owning task and file scope, then repeat targeted checks and the same formal review policy.

${buildReviewIterationGuidance(reviewCommand, options)}

${buildCollaborativeImportantGuidelines(planId, options)}
${footer}`;
}

/**
 * Builds the available agents section
 */
function buildAvailableAgents(planId: string, options: OrchestrationOptions): string {
  if (options.agentMessagingEnabled === true) {
    return `${buildCollaborativeToolGuidance()}\n${buildCollaborativeAvailableAgents(
      planId,
      ['implementer', 'tester', 'reviewer'],
      options
    )}`;
  }

  const renderer = createOrchestrationDelegationRenderer(planId, options);
  const reviewer = options.batchMode
    ? `- **Full-plan reviewer**: Only when the selected batch completes every remaining task, run \`${buildFullPlanReviewCommand(planId, options)}\` via the shell command tool, without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use \`tim subagent reviewer\` for selected-task batch reviews.`
    : `- **Reviewer**: Run \`tim subagent reviewer ${planId} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)`;
  return `## Available Agents

You have access to three specialized agents via the shell command tool:
- **Implementer**: Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool (or \`--input-file <paths...>\`)
- **Tester**: Run \`${renderer.subagentCommand('tester')}\` via the shell command tool (or \`--input-file <paths...>\`)

${reviewer}

${REVIEW_FIX_TASK_INDEX_GUIDANCE}

Each subagent command may take a long time to complete because it may run multiple iterations of builds and test suites, and is expected to print no output until it finishes. Always use a long timeout when invoking them via the shell command tool.
`;
}

/**
 * Builds the workflow instructions section
 */
function buildWorkflowInstructions(planId: string, options: OrchestrationOptions): string {
  if (options.agentMessagingEnabled === true) {
    return buildCollaborativeWorkflowInstructions(planId, options);
  }

  const renderer = createOrchestrationDelegationRenderer(planId, options);

  const taskSelectionPhase = options.batchMode
    ? `1. **Task Selection Phase**
   - First, analyze all provided tasks and select a logical subset to work on
   - Document your selection and reasoning before proceeding
   - Focus on 2-5 related tasks that can be completed together efficiently

2. **Implementation Phase**`
    : `1. **Implementation Phase**`;

  const dynamicNote =
    !options.subagentExecutor || options.subagentExecutor === 'dynamic'
      ? `\n   - Choose the appropriate executor (\`-x claude-code\` or \`-x codex-cli\`) based on the executor selection guidance above.`
      : '';

  const implementationSteps = `
   - Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output`;

  const testingPhase = `${options.batchMode ? '3' : '2'}. **Testing Phase**
   - After implementation is complete, run \`${renderer.subagentCommand('tester')}\` via the shell command tool with a long timeout${dynamicNote}
   - When choosing an executor dynamically, prefer using the same executor that was used for the implementer to maintain consistency and leverage the same strengths.
   - In the input (\`--input\` or \`--input-file\`), ask the tester to create comprehensive tests for the implemented functionality, if needed
   - Emphasize that tests must test actual implementation code. Testing a reproduction or simulation of the code is useless.
   - In the input, instruct the tester to run tests and fix any failures
   - Include relevant context from the implementer's output in the input`;

  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId, options)
    : buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const reviewPhase = options.batchMode
    ? buildOrchestratorBatchReviewPhase(planId, options, '4')
    : `3. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass any relevant notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why.
${buildFormalReviewScopeGuidance(planId)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.
   - The review output focuses on problems; don't expect positive feedback even if the code is perfect.`;

  const finalPhases = `${options.batchMode ? '5' : '4'}. **Notes Phase**
   ${progressSectionGuidance(options.planFilePath, { useAtPrefix: options.useAtPrefix })}

${options.batchMode ? '6' : '5'}. **Iteration**

- If the review output identifies blocking issues or tests fail:
- For straightforward fixes for accepted blocking review findings (for example focused logic adjustments or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- Return to step ${options.batchMode ? '2' : '1'} when substantial code changes are required. If you are fixing review findings, scope the subagent command as the Review Iteration Policy directs; a run that only fixes failing tests is not a review-fix round and needs no scoping.
- After implementing blocking review fixes, run the relevant targeted checks and then repeat the same review mechanism according to the Review Iteration Policy.
- If the review repeats a blocking issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Continue this loop until all tests pass and a complete ordinary review produces no new findings that you decide are blocking, or the bounded handoff procedure in the Review Iteration Policy has been completed. A review with only findings you decide are non-blocking is terminal.

${buildReviewIterationGuidance(reviewCommand, options)}`;

  return `## Workflow Instructions

You MUST follow this iterative development process:

${taskSelectionPhase}${implementationSteps}

${testingPhase}

${reviewPhase}

${finalPhases}`;
}

function markTasksDoneGuidance(planId: string) {
  return `
## Marking Tasks Done

Only perform the following if no unresolved genuine subagent failure remains.
An agent's 'FAILED:' report is not automatically a terminal failure. Evaluate it
using the Failure Protocol, fix recoverable problems, and continue the workflow.
Do not mark tasks done while a genuine failure remains unresolved.

When updating tasks after successful implementation, testing, and review, use the shell command 'tim set-task-done ${planId} --title "<taskTitle>"'.
To set Task 2 done for plan 165, use 'tim set-task-done 165 --title "do it"'. To set multiple tasks done, run the command multiple times for each task.

After marking tasks done, commit your changes with a descriptive message about what tasks were completed. Do not include attribution comments in the commit message.

`;
}

/**
 * Builds the important guidelines section
 */
function buildImportantGuidelines(planId: string, options: OrchestrationOptions): string {
  if (options.agentMessagingEnabled === true) {
    return buildCollaborativeImportantGuidelines(planId, options);
  }

  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId, options)
    : buildReviewCommand(planId, options);
  const reviewGuidelines = options.batchMode
    ? `- **Review each selected task batch yourself.** Do not run \`tim subagent reviewer\` for per-batch review. You may start your own native review subagent if useful, but you must assess its findings and own the result.
- Reserve \`${reviewCommand}\` for the final full-plan review that runs only after all plan tasks are complete.
- After selected-batch review follow-ups for accepted blocking findings, run focused verification and repeat your orchestrator-owned review.`
    : `- **Do not substitute your own review for the formal reviewer quality gate.** Always run \`${reviewCommand}\` for the required code quality assessment.
- You may inspect code as needed to coordinate the work, evaluate reviewer findings, and perform the root-cause or structural analysis required by the Review Iteration Policy. This analysis does not replace a required reviewer pass.
- After blocking review follow-ups, run focused verification and repeat \`${reviewCommand}\` according to the Review Iteration Policy's scope tiers.`;
  const baseGuidelines = `## Important Guidelines

- **DO NOT implement code directly**. Always delegate implementation tasks to the appropriate subagent via \`tim subagent\`.
- **DO NOT write tests directly**. Always use the tester subagent via \`tim subagent tester\` for test execution and updates.
${buildReviewIssueCleanupGuidance(planId)}
${reviewGuidelines}
- Exception: if an accepted blocking review finding requires only straightforward, contained edits, you may apply those edits directly instead of spawning implementer again.
- You are responsible only for coordination and ensuring the workflow is followed correctly.
- The subagents have access to the same task instructions below that you do, so you don't need to repeat them. You should reference which specific task titles are being worked on so the subagents can focus on the right tasks.
- ${SUBAGENT_SPECIFICITY_GUIDANCE}
- When invoking subagents, provide clear, specific instructions in \`--input\` (or \`--input-file\`) about what needs to be done in addition to referencing the task titles.
- ${INPUT_COMBINATION_GUIDANCE}
- Include relevant context from previous subagent responses when invoking the next subagent.
- ${buildInputFileRandomizationGuidance(planId)}
- ${BRANCH_SETUP_GUIDANCE}${buildJjGuidance(options)}

## Plan Documentation During Implementation

If you or a subagent discover that the plan needs to change during implementation (e.g. the approach needs to differ from what was planned, a task needs to be split or reordered, new tasks are discovered, or requirements turn out to be different than expected):

1. **Update the plan text itself** to reflect the change. Modify the relevant task descriptions, details, or add new tasks as needed so the plan file always represents the current state of the work.
2. **Document the change** in a \`## Changes Made During Implementation\` section at the bottom of the plan file's markdown body (before any \`## Current Progress\` section). Each entry should briefly explain what changed and why. This prevents reviewers from getting confused by discrepancies between the plan and the actual implementation.

Instruct subagents to report any plan changes they believe are necessary in their output, so you can make the updates.`;

  const failureProtocol = `
\n## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs (implementer, tester, reviewer) for a line starting with "FAILED:".
- A FAILED report is a signal to investigate, not an automatic reason to stop orchestration.
- Read the detailed report, inspect the current work, and evaluate whether the problem is real.
- If the problem is fixable, including a pre-existing error or an ordinary code, test, lint, type-check, build, or setup error, fix it yourself or delegate the fix to the appropriate subagent. Rerun the relevant checks and continue the workflow.
- Treat the failure as real only when it cannot be resolved without a user decision, such as a conflicting design requirement, or when major expected functionality is missing and cannot be added safely within scope.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - Where <agent> is one of: implementer | tester | fixer | reviewer
  - Then include the subagent's detailed report verbatim (requirements, problems, possible solutions).
- Only after deciding that the failure is real should you stop further phases and output the FAILED message. Do not mark tasks done after a real failure.
- You may add brief additional context if necessary (e.g., which tasks were being processed).`;

  // Batch-mode specific guidance
  const batchModeOnly = options.batchMode
    ? `
- Subagents will have access to the entire list of incomplete tasks from the plan file, so be sure to include which tasks to focus on in your subagent instructions.
- **Be selective**: Don't attempt all tasks at once - choose a reasonable subset that works well together and prefer to choose smaller subsets.

${markTasksDoneGuidance(planId)}
`
    : '';

  return (
    baseGuidelines +
    failureProtocol +
    batchModeOnly +
    progressSectionGuidance(options.planFilePath, { useAtPrefix: options.useAtPrefix })
  );
}

/** Single source of truth for the batch review phase; add new guidance here, not in a wrapper. */
function buildOrchestratorBatchReviewPhase(
  planId: string,
  options: OrchestrationOptions,
  phaseNumber: string
): string {
  if (options.agentMessagingEnabled === true) {
    return `${phaseNumber}. **Review Phase**
   - Review the selected task batch yourself. Inspect the implementation, diff, tests, and relevant plan requirements for correctness, regressions, missing coverage, and maintainability.
${buildBatchReviewerInstructionsGuidance(options)}   - A StartAgent reviewer may provide read-only advisory findings, but the orchestrator owns this selected-task review and its result.
${buildBatchReviewRejectionGuidance(planId)}
${buildFinalBatchReviewGuidance(planId, options)}
   - If the selected batch completes every remaining task, use the final full-plan tim review sequence described above.`;
  }

  return `${phaseNumber}. **Review Phase**
   - Review the selected task batch yourself. Inspect the implementation, diff, tests, and relevant plan requirements for correctness, regressions, missing coverage, and maintainability.
${buildBatchReviewerInstructionsGuidance(options)}   - You may start your own native subagent to review all or part of the selected task batch if that would help, but you remain responsible for evaluating its findings and completing the review.
   - Do not run \`tim subagent reviewer\` for this selected-task batch review. That command is reserved for the final full-plan review after every task is complete.
${buildBatchReviewRejectionGuidance(planId)}
${buildFinalBatchReviewGuidance(planId, options)}
   - Your review should focus on problems; lack of findings means the batch review passed.`;
}

/**
 * Wraps the original context content with orchestration instructions for managing subagents
 */
export function wrapWithOrchestration(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions = {}
): string {
  const batchModeInstructions = buildBatchModeInstructions(options);
  const availableAgents = buildAvailableAgents(planId, options);
  const dynamicGuidance = buildDynamicExecutorGuidance(options);
  const workflowInstructions = buildWorkflowInstructions(planId, options);
  const importantGuidelines = buildImportantGuidelines(planId, options);

  const header = `# Multi-Agent Orchestration Instructions

You are the orchestrator for a tim multi-agent development workflow. tim is a tool for managing step-by-step project plans. Your role is to coordinate between specialized subagents to complete the coding task${options.batchMode ? 's' : ''} described below.

${batchModeInstructions}`;

  const footer = `## Task Context

Below is the original task that needs to be completed through this multi-agent workflow:

---

${contextContent}`;

  return `${header}${availableAgents}

${dynamicGuidance}${workflowInstructions}

${importantGuidelines}

${footer}`;
}

/**
 * Wraps context content with simplified orchestration instructions for implement → review flow.
 */
export function wrapWithOrchestrationSimple(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions = {}
): string {
  if (options.agentMessagingEnabled === true) {
    return buildCollaborativeSimplePrompt(contextContent, planId, options);
  }

  const batchModeInstructions = buildBatchModeInstructions(options);
  const progressSection = progressSectionGuidance(options.planFilePath, {
    useAtPrefix: options.useAtPrefix,
  });
  const renderer = createOrchestrationDelegationRenderer(planId, options);
  const dynamicGuidance = buildDynamicExecutorGuidance(options);
  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId, options)
    : buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const header = `# Two-Phase Orchestration Instructions

You are coordinating a tim streamlined two-phase workflow (implement → review) for the tasks below. tim is a tool for managing step-by-step project plans.`;

  const reviewerAgent = options.batchMode
    ? `- **Full-plan reviewer**: Only after every plan task is complete, run \`${reviewCommand}\` without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use it for the selected-task batch review.`
    : `- **Reviewer**: Run \`${reviewCommand}\` via the shell command tool`;
  const availableAgents = `## Available Agents

You have two specialized subagents available via the shell command tool:
- **Implementer**: Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool (or \`--input-file <paths...>\`)
${reviewerAgent}

${REVIEW_FIX_TASK_INDEX_GUIDANCE}

Each subagent command may take a long time to complete because it may run multiple iterations of builds and test suites. Always use a long timeout when invoking them via the shell command tool.
`;

  const taskSelectionPhase = options.batchMode
    ? `1. **Task Selection Phase**
   - Review all provided tasks and select a focused subset for this run
   - Document which tasks you chose and why before proceeding
   - Keep the batch manageable so both phases can finish successfully

2. **Implementation Phase**`
    : `1. **Implementation Phase**`;

  const dynamicNote =
    !options.subagentExecutor || options.subagentExecutor === 'dynamic'
      ? `\n   - Choose the appropriate executor (\`-x claude-code\` or \`-x codex-cli\`) based on the executor selection guidance above.`
      : '';

  const reviewPhase = options.batchMode
    ? buildOrchestratorBatchReviewPhase(planId, options, '3')
    : `2. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass relevant implementation notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why.
${buildFormalReviewScopeGuidance(planId)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.
   - The review output focuses on problems; don't expect positive feedback even if the code is perfect.
   - If the review identifies accepted blocking issues, return to the implementer with the findings`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this simplified loop:

${taskSelectionPhase}
   - Explore the repository and create a plan on how to implement the task.
   - Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output

${reviewPhase}

${options.batchMode ? '4' : '3'}. **Notes Phase**
${progressSection}

${options.batchMode ? '5' : '4'}. **Iteration**
- For straightforward fixes for accepted blocking review findings (for example focused refactors, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- After accepted blocking review fixes, run focused verification and repeat the same review mechanism according to the Review Iteration Policy.
- If the review repeats a blocking issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Repeat the implement → review loop until all tests pass and a complete ordinary review produces no new findings that you decide are blocking, or the bounded handoff procedure in the Review Iteration Policy has been completed. A review with only findings you decide are non-blocking is terminal.

${buildReviewIterationGuidance(reviewCommand, options)}`;

  const failureProtocol = `
## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs for a line starting with "FAILED:".
- A FAILED report is a signal to investigate, not an automatic reason to stop orchestration.
- Read the detailed report, inspect the current work, and evaluate whether the problem is real.
- If the problem is fixable, including a pre-existing error or an ordinary code, test, lint, type-check, build, or setup error, fix it yourself or delegate the fix to the appropriate subagent. Rerun the relevant checks and continue the workflow.
- Treat the failure as real only when it cannot be resolved without a user decision, such as a conflicting design requirement, or when major expected functionality is missing and cannot be added safely within scope.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - <agent> must be one of: implementer | reviewer | orchestrator
  - Then include the subagent's detailed report verbatim.
- Only after deciding that the failure is real should you stop further phases and output the FAILED message. Do not mark tasks done after a real failure.
- You may add brief context (e.g. which tasks were active) if helpful.`;

  const reviewGuidance = options.batchMode
    ? `- Review selected task batches yourself; do not run \`tim subagent reviewer\` for them. You may start a native review subagent if useful, but you own the review result.
- Run \`${reviewCommand}\` only for the final full-plan review after all tasks are complete.`
    : `- Do not substitute your own review for the formal reviewer quality gate. Always run \`${reviewCommand}\` for the required code quality assessment.
- You may inspect code as needed to coordinate the work, evaluate reviewer findings, and perform the root-cause or structural analysis required by the Review Iteration Policy. This analysis does not replace a required reviewer pass.`;
  const guidance = `## Important Guidelines

- Delegate implementation to \`tim subagent implementer\`.
${buildReviewIssueCleanupGuidance(planId)}
${reviewGuidance}
- ${SUBAGENT_SPECIFICITY_GUIDANCE}
- When invoking subagents, give clear instructions in \`--input\` (or \`--input-file\`) referencing the specific task titles.
- ${INPUT_COMBINATION_GUIDANCE}
- Provide prior subagent outputs to the next subagent so they have full context.
- ${buildInputFileRandomizationGuidance(planId)}
- ${BRANCH_SETUP_GUIDANCE}${buildJjGuidance(options)}
- Keep the scope focused; if the review identifies a new accepted blocking finding, loop back to implementation before moving forward according to the Review Iteration Policy.${
    options.batchMode
      ? `
- Subagents can read all pending tasks; explicitly tell them which ones are in scope for this batch.`
      : ''
  }

## Plan Documentation During Implementation

If you or a subagent discover that the plan needs to change during implementation (e.g. the approach needs to differ, tasks need to be split/reordered, or new tasks are discovered):

1. **Update the plan text itself** to reflect the change so the plan file always represents the current state of the work.
2. **Document the change** in a \`## Changes Made During Implementation\` section at the bottom of the plan file's markdown body (before any \`## Current Progress\` section). Each entry should briefly explain what changed and why.

Instruct subagents to report any plan changes they believe are necessary in their output, so you can make the updates.

${markTasksDoneGuidance(planId)}

${progressSection}`;

  const footer = `## Task Context

Below is the original task context to execute with this workflow:

---

${contextContent}`;

  return `${header}

${batchModeInstructions}${availableAgents}

${dynamicGuidance}${workflowInstructions}

${failureProtocol}

${guidance}

${footer}`;
}

/**
 * Wraps context content with TDD orchestration instructions.
 * - TDD normal: tdd-tests -> implementer -> tester -> review
 * - TDD simple: tdd-tests -> implementer -> reviewer
 */
export function wrapWithOrchestrationTdd(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions = {}
): string {
  if (options.agentMessagingEnabled === true) {
    return buildCollaborativeTddPrompt(contextContent, planId, options);
  }

  const batchModeInstructions = buildBatchModeInstructions(options);
  const progressSection = progressSectionGuidance(options.planFilePath, {
    useAtPrefix: options.useAtPrefix,
  });
  const renderer = createOrchestrationDelegationRenderer(planId, options);
  const dynamicGuidance = buildDynamicExecutorGuidance(options);
  const isSimpleTdd = options.simpleMode === true;

  const header = `# TDD Orchestration Instructions

You are coordinating a tim Test-Driven Development workflow for the tasks below. tim is a tool for managing step-by-step project plans.

You MUST enforce TDD order:
1. Write and run tests first (expecting failing tests for unimplemented behavior)
2. Implement to make those tests pass
3. Verify and review according to the selected workflow`;

  const availableAgents = isSimpleTdd
    ? `## Available Agents

You have three specialized subagents available via the shell command tool:
- **TDD Tests**: Run \`${renderer.subagentCommand('tdd-tests')}\` via the shell command tool (or \`--input-file <paths...>\`)
- **Implementer**: Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool (or \`--input-file <paths...>\`)
${options.batchMode ? `- **Full-plan reviewer**: Only after every plan task is complete, run \`${buildFullPlanReviewCommand(planId, options)}\` without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use it for the selected-task batch review.` : `- **Reviewer**: Run \`${buildReviewCommand(planId, options)}\` via the shell command tool`}

${REVIEW_FIX_TASK_INDEX_GUIDANCE}

Each subagent command may take a long time to complete because it may run multiple iterations of builds and test suites. Always use a long timeout when invoking them via the shell command tool.
`
    : `## Available Agents

You have four specialized subagents available via the shell command tool:
- **TDD Tests**: Run \`${renderer.subagentCommand('tdd-tests')}\` via the shell command tool (or \`--input-file <paths...>\`)
- **Implementer**: Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool (or \`--input-file <paths...>\`)
- **Tester**: Run \`${renderer.subagentCommand('tester')}\` via the shell command tool (or \`--input-file <paths...>\`)
${options.batchMode ? `- **Full-plan reviewer**: Only after every plan task is complete, run \`${buildFullPlanReviewCommand(planId, options)}\` without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use it for the selected-task batch review.` : `- **Reviewer**: Run \`tim subagent reviewer ${planId} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)`}

${REVIEW_FIX_TASK_INDEX_GUIDANCE}

Each subagent command may take a long time to complete because it may run multiple iterations of builds and test suites. Always use a long timeout when invoking them via the shell command tool.
`;

  const taskSelectionPhase = options.batchMode
    ? `1. **Task Selection Phase**
   - Review all provided tasks and select a focused subset for this run
   - Document which tasks you chose and why before proceeding
   - Keep the batch manageable for a full TDD cycle

2. **TDD Test Phase**`
    : `1. **TDD Test Phase**`;

  const dynamicNote =
    !options.subagentExecutor || options.subagentExecutor === 'dynamic'
      ? `\n   - Choose the appropriate executor (\`-x claude-code\` or \`-x codex-cli\`) based on the executor selection guidance above.`
      : '';

  const implementationPhaseNumber = options.batchMode ? '3' : '2';
  const verificationPhaseNumber = options.batchMode ? '4' : '3';
  const notesPhaseNumber = isSimpleTdd
    ? options.batchMode
      ? '5'
      : '4'
    : options.batchMode
      ? '6'
      : '5';
  const iterationPhaseNumber = isSimpleTdd
    ? options.batchMode
      ? '6'
      : '5'
    : options.batchMode
      ? '7'
      : '6';

  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId, options)
    : buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const orchestratorBatchReview = buildOrchestratorBatchReviewPhase(
    planId,
    options,
    isSimpleTdd ? verificationPhaseNumber : options.batchMode ? '5' : '4'
  );

  const verificationPhase = isSimpleTdd
    ? options.batchMode
      ? orchestratorBatchReview
      : `${verificationPhaseNumber}. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass relevant TDD test output and implementation notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why.
${buildFormalReviewScopeGuidance(planId)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`
    : `${verificationPhaseNumber}. **Testing Phase**
   - Run \`${renderer.subagentCommand('tester')}\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), include:
     - TDD tests output and implementer output
     - Which tasks are in scope
     - Direction to ensure tests target real implementation code
   - When choosing an executor dynamically, prefer using the same executor that was used for the implementer to maintain consistency and leverage the same strengths.
   - Instruct tester to run tests and fix failures, then report remaining gaps

${
  options.batchMode
    ? orchestratorBatchReview
    : `${options.batchMode ? '5' : '4'}. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass any relevant notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why.
${buildFormalReviewScopeGuidance(planId)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`
}`;

  const reviewIterationGuidance = `
- For straightforward fixes for accepted blocking review findings (for example focused refactors, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- After accepted blocking review fixes, run relevant targeted checks and repeat the same review mechanism according to the Review Iteration Policy.`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this TDD process:

${taskSelectionPhase}
   - Run \`${renderer.subagentCommand('tdd-tests')}\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify in-scope tasks and expected behavior to define
   - Explicitly instruct the TDD tests agent to:
     - Write tests first
     - Run tests
     - Verify failures are for expected behavioral reasons (not syntax/import/setup errors)
   - Capture and preserve this output for downstream phases

${implementationPhaseNumber}. **Implementation Phase**
   - Run \`${renderer.subagentCommand('implementer')}\` via the shell command tool with a long timeout${dynamicNote}
   - In the input, include the TDD tests output and direct the implementer to make those tests pass
   - Emphasize that implementation should be driven by existing TDD tests, not by adding unrelated new behavior
   - Wait for the subagent to complete and review its output

${verificationPhase}

${notesPhaseNumber}. **Notes Phase**
${progressSection}

${iterationPhaseNumber}. **Iteration**
- If verification fails, or the review identifies blocking issues:
- Return to step ${options.batchMode ? '2' : '1'} when substantial code changes are required. If you are fixing review findings, scope the subagent command as the Review Iteration Policy directs; a run that only fixes failing tests is not a review-fix round and needs no scoping.
- After each fix iteration, run relevant targeted checks before moving forward.${reviewIterationGuidance}
- If the review repeats a blocking issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Keep TDD order intact for each iteration, including the final full-plan review loop${structuralPassApplies(options) ? ' and the standalone `--structural-only` structural pass' : ''} before stopping.

${buildReviewIterationGuidance(reviewCommand, options)}`;

  const failureProtocol = `
## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs for a line starting with "FAILED:".
- A FAILED report is a signal to investigate, not an automatic reason to stop orchestration.
- Read the detailed report, inspect the current work, and evaluate whether the problem is real.
- If the problem is fixable, including a pre-existing error or an ordinary code, test, lint, type-check, build, or setup error, fix it yourself or delegate the fix to the appropriate subagent. Rerun the relevant checks and continue the workflow.
- Treat the failure as real only when it cannot be resolved without a user decision, such as a conflicting design requirement, or when major expected functionality is missing and cannot be added safely within scope.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - <agent> must be one of: tdd-tests | implementer | tester | reviewer | orchestrator
  - Then include the subagent's detailed report verbatim.
- Only after deciding that the failure is real should you stop further phases and output the FAILED message. Do not mark tasks done after a real failure.
- You may add brief context (e.g. which tasks were active) if helpful.`;

  const reviewCommandGuidance = options.batchMode
    ? `- Review selected task batches yourself; do not run \`tim subagent reviewer\` for them. You may start a native review subagent if useful, but you own the review result.
- Run \`${reviewCommand}\` only for the final full-plan review after all tasks are complete.`
    : `- Do not substitute your own review for the formal reviewer quality gate. Always run \`${reviewCommand}\` for the required code quality assessment.
- You may inspect code as needed to coordinate the work, evaluate reviewer findings, and perform the root-cause or structural analysis required by the Review Iteration Policy. This analysis does not replace a required reviewer pass.`;
  const testingGuidance = isSimpleTdd
    ? ''
    : '- Do NOT write or run tests directly. Always delegate testing to `tim subagent tester`.';
  const reviewFollowupGuidance = `
- Exception: if a blocking review finding requires only straightforward, contained edits, you may apply those edits directly instead of spawning implementer again.
- After blocking review fixes, run focused verification and repeat the same review mechanism according to the Review Iteration Policy.`;

  const guidance = `## Important Guidelines

- Do NOT implement code directly. Always delegate implementation via \`tim subagent implementer\`.
${testingGuidance}
${buildReviewIssueCleanupGuidance(planId)}
${reviewCommandGuidance}
${reviewFollowupGuidance}
- ${SUBAGENT_SPECIFICITY_GUIDANCE}
- ${INPUT_COMBINATION_GUIDANCE}
- We are using Test-Driven Development. The \`tdd-tests\` subagent must run before implementation.
- Always pass the TDD tests output into the implementer invocation.
- Do not skip the TDD test phase, even if implementation seems straightforward.
- ${buildInputFileRandomizationGuidance(planId)}
- ${BRANCH_SETUP_GUIDANCE}${buildJjGuidance(options)}
- When subagents can see all pending tasks, explicitly state which task titles are in scope for this run.${
    options.batchMode
      ? `
- Subagents can read all pending tasks; explicitly tell them which ones are in scope for this batch.`
      : ''
  }

## Plan Documentation During Implementation

If you or a subagent discover that the plan needs to change during implementation (e.g. the approach needs to differ, tasks need to be split/reordered, or new tasks are discovered):

1. **Update the plan text itself** to reflect the change so the plan file always represents the current state of the work.
2. **Document the change** in a \`## Changes Made During Implementation\` section at the bottom of the plan file's markdown body (before any \`## Current Progress\` section). Each entry should briefly explain what changed and why.

Instruct subagents to report any plan changes they believe are necessary in their output, so you can make the updates.

${markTasksDoneGuidance(planId)}

${progressSection}`;

  const footer = `## Task Context

Below is the original task context to execute with this TDD workflow:

---

${contextContent}`;

  return `${header}

${batchModeInstructions}${availableAgents}

${dynamicGuidance}${workflowInstructions}

${failureProtocol}

${guidance}

${footer}`;
}
