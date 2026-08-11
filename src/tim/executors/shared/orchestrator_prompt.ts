import {
  buildBatchReviewRejectionGuidance,
  buildFinalBatchReviewGuidance,
  buildFullPlanReviewCommand,
  buildReviewCommand,
  buildReviewIterationGuidance,
  buildReviewRejectionGuidance,
  structuralPassApplies,
} from './review_guidance.js';
export type { OrchestrationOptions } from './orchestration_options.js';
import type { OrchestrationOptions } from './orchestration_options.js';

const INPUT_COMBINATION_GUIDANCE =
  '- You can use both `--input-file` and `--input` together. `--input-file` is read first and `--input` is appended afterward.';

function buildRejectedReviewIssueCleanupGuidance(planId: string): string {
  return `- If you later fix a finding that you previously rejected and recorded, remove that rejected entry after confirming the fix. Run \`tim review-issues list ${planId}\` to find its current index, then run \`tim review-issues resolve ${planId} <issue-index>\`. The resolve command removes the selected entry, including rejected entries; use the specific index and do not use \`--all\`.`;
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
 * Builds the -x flag portion of a tim subagent command based on executor selection mode.
 * For fixed mode, always includes -x <executor>.
 * For dynamic mode, returns empty string (orchestrator decides per invocation).
 */
function buildSubagentExecutorFlag(options: OrchestrationOptions): string {
  const executor = options.subagentExecutor;
  if (executor === 'codex-cli' || executor === 'claude-code') {
    return ` -x ${executor}`;
  }
  // dynamic or undefined: orchestrator decides per invocation
  return '';
}

/**
 * Builds the subagent executor selection guidance for dynamic mode.
 */
function buildDynamicExecutorGuidance(options: OrchestrationOptions): string {
  if (options.subagentExecutor && options.subagentExecutor !== 'dynamic') {
    return '';
  }

  const instructions = options.dynamicSubagentInstructions || DEFAULT_DYNAMIC_SUBAGENT_INSTRUCTIONS;

  return `## Subagent Executor Selection

You must choose which executor to use for each subagent invocation by passing \`-x codex-cli\` or \`-x claude-code\` to the \`tim subagent\` command.

Decision guidance: ${instructions}
`;
}

/**
 * Builds the available agents section
 */
function buildAvailableAgents(planId: string, options: OrchestrationOptions): string {
  const executorFlag = buildSubagentExecutorFlag(options);
  const reviewer = options.batchMode
    ? `- **Full-plan reviewer**: Only when the selected batch completes every remaining task, run \`${buildFullPlanReviewCommand(planId)}\` via the shell command tool, without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use \`tim subagent reviewer\` for selected-task batch reviews.`
    : `- **Reviewer**: Run \`tim subagent reviewer ${planId} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)`;
  return `## Available Agents

You have access to three specialized agents via the shell command tool:
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Tester**: Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)

${reviewer}

${REVIEW_FIX_TASK_INDEX_GUIDANCE}

Each subagent command may take a long time to complete because it may run multiple iterations of builds and test suites, and is expected to print no output until it finishes. Always use a long timeout when invoking them via the shell command tool.
`;
}

/**
 * Builds the workflow instructions section
 */
function buildWorkflowInstructions(planId: string, options: OrchestrationOptions): string {
  const executorFlag = buildSubagentExecutorFlag(options);

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
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output`;

  const testingPhase = `${options.batchMode ? '3' : '2'}. **Testing Phase**
   - After implementation is complete, run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a long timeout${dynamicNote}
   - When choosing an executor dynamically, prefer using the same executor that was used for the implementer to maintain consistency and leverage the same strengths.
   - In the input (\`--input\` or \`--input-file\`), ask the tester to create comprehensive tests for the implemented functionality, if needed
   - Emphasize that tests must test actual implementation code. Testing a reproduction or simulation of the code is useless.
   - In the input, instruct the tester to run tests and fix any failures
   - Include relevant context from the implementer's output in the input`;

  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId)
    : buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const reviewPhase = options.batchMode
    ? buildOrchestratorBatchReviewPhase(planId, options, '4')
    : `3. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass any relevant notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why. ${buildReviewRejectionGuidance(planId)}
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
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
- Continue this loop until all tests pass and a complete ordinary review produces no new blocking findings, or the bounded handoff procedure in the Review Iteration Policy has been completed. A review with only non-blocking findings is terminal.

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
  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId)
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
${buildRejectedReviewIssueCleanupGuidance(planId)}
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
  const batchModeInstructions = buildBatchModeInstructions(options);
  const progressSection = progressSectionGuidance(options.planFilePath, {
    useAtPrefix: options.useAtPrefix,
  });
  const executorFlag = buildSubagentExecutorFlag(options);
  const dynamicGuidance = buildDynamicExecutorGuidance(options);
  const reviewCommand = options.batchMode
    ? buildFullPlanReviewCommand(planId)
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
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
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
   - ${buildReviewRejectionGuidance(planId)}
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.
   - The review output focuses on problems; don't expect positive feedback even if the code is perfect.
   - If the review identifies accepted blocking issues, return to the implementer with the findings`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this simplified loop:

${taskSelectionPhase}
   - Explore the repository and create a plan on how to implement the task.
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output

${reviewPhase}

${options.batchMode ? '4' : '3'}. **Notes Phase**
${progressSection}

${options.batchMode ? '5' : '4'}. **Iteration**
- For straightforward fixes for accepted blocking review findings (for example focused refactors, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- After accepted blocking review fixes, run focused verification and repeat the same review mechanism according to the Review Iteration Policy.
- If the review repeats a blocking issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Repeat the implement → review loop until all tests pass and a complete ordinary review produces no new blocking findings, or the bounded handoff procedure in the Review Iteration Policy has been completed. A review with only non-blocking findings is terminal.

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
${buildRejectedReviewIssueCleanupGuidance(planId)}
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
  const batchModeInstructions = buildBatchModeInstructions(options);
  const progressSection = progressSectionGuidance(options.planFilePath, {
    useAtPrefix: options.useAtPrefix,
  });
  const executorFlag = buildSubagentExecutorFlag(options);
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
- **TDD Tests**: Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
${options.batchMode ? `- **Full-plan reviewer**: Only after every plan task is complete, run \`${buildFullPlanReviewCommand(planId)}\` without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use it for the selected-task batch review.` : `- **Reviewer**: Run \`${buildReviewCommand(planId, options)}\` via the shell command tool`}

${REVIEW_FIX_TASK_INDEX_GUIDANCE}

Each subagent command may take a long time to complete because it may run multiple iterations of builds and test suites. Always use a long timeout when invoking them via the shell command tool.
`
    : `## Available Agents

You have four specialized subagents available via the shell command tool:
- **TDD Tests**: Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Tester**: Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
${options.batchMode ? `- **Full-plan reviewer**: Only after every plan task is complete, run \`${buildFullPlanReviewCommand(planId)}\` without any \`--executor\` option so the review runs with all configured agents for full coverage. Do not use it for the selected-task batch review.` : `- **Reviewer**: Run \`tim subagent reviewer ${planId} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)`}

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
    ? buildFullPlanReviewCommand(planId)
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
   - ${buildReviewRejectionGuidance(planId)}
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`
    : `${verificationPhaseNumber}. **Testing Phase**
   - Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a long timeout${dynamicNote}
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
   - Pass any relevant notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why. ${buildReviewRejectionGuidance(planId)}
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`
}`;

  const reviewIterationGuidance = `
- For straightforward fixes for accepted blocking review findings (for example focused refactors, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- After accepted blocking review fixes, run relevant targeted checks and repeat the same review mechanism according to the Review Iteration Policy.`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this TDD process:

${taskSelectionPhase}
   - Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a long timeout${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify in-scope tasks and expected behavior to define
   - Explicitly instruct the TDD tests agent to:
     - Write tests first
     - Run tests
     - Verify failures are for expected behavioral reasons (not syntax/import/setup errors)
   - Capture and preserve this output for downstream phases

${implementationPhaseNumber}. **Implementation Phase**
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a long timeout${dynamicNote}
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
${buildRejectedReviewIssueCleanupGuidance(planId)}
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
