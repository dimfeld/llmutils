interface OrchestrationOptions {
  batchMode?: boolean;
  planFilePath?: string;
  reviewExecutor?: string;
  simpleMode?: boolean;
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
}

const INPUT_COMBINATION_GUIDANCE =
  '- You can use both `--input-file` and `--input` together. `--input-file` is read first and `--input` is appended afterward.';

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
  return `## Available Agents

You have access to three specialized agents that you MUST invoke via the shell command tool:
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Tester**: Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)

- **Reviewer**: Run \`tim subagent reviewer ${planId} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)

Each subagent command may take a long time to complete and is expected to print no output until it finishes. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the shell command tool.
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
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output`;

  const testingPhase = `${options.batchMode ? '3' : '2'}. **Testing Phase**
   - After implementation is complete, run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - When choosing an executor dynamically, prefer using the same executor that was used for the implementer to maintain consistency and leverage the same strengths.
   - In the input (\`--input\` or \`--input-file\`), ask the tester to create comprehensive tests for the implemented functionality, if needed
   - Emphasize that tests must test actual implementation code. Testing a reproduction or simulation of the code is useless.
   - In the input, instruct the tester to run tests and fix any failures
   - Include relevant context from the implementer's output in the input`;

  const reviewCommand = buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const reviewPhase = `${options.batchMode ? '4' : '3'}. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass any relevant notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why. On subsequent review runs, also include a list of any issues from prior review output that you determined were not relevant or acceptable to leave as-is, so the reviewer knows not to flag them again.
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${buildFinalBatchReviewGuidance(planId, options)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.
   - The review output focuses on problems; don't expect positive feedback even if the code is perfect.`;

  const finalPhases = `${options.batchMode ? '5' : '4'}. **Notes Phase**
   ${progressSectionGuidance(options.planFilePath, { useAtPrefix: options.useAtPrefix })}

${options.batchMode ? '6' : '5'}. **Iteration**

- If the review output identifies issues or tests fail:
- For straightforward review follow-ups that are easy to implement correctly (for example wording tweaks, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- Return to step ${options.batchMode ? '2' : '1'} when substantial code changes are required.
- After implementing review follow-up changes, run the relevant targeted checks and then rerun the same ordinary review over its complete declared scope.
- If the review repeats an issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Continue this loop until all tests pass and either the ordinary review is clean or the bounded handoff procedure in the Review Iteration Policy has been completed.

${buildReviewIterationGuidance(reviewCommand)}`;

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

Only perform the following if no subagent failure occurred during this run.
If any agent emitted a line beginning with 'FAILED:', do not run any of the following commands — stop immediately.

When updating tasks after successful implementation, testing, and review, use the shell command 'tim set-task-done ${planId} --title "<taskTitle>"'.
To set Task 2 done for plan 165, use 'tim set-task-done 165 --title "do it"'. To set multiple tasks done, run the command multiple times for each task.

After marking tasks done, commit your changes with a descriptive message about what tasks were completed. Do not include attribution comments in the commit message.

`;
}

/**
 * Builds the important guidelines section
 */
function buildImportantGuidelines(planId: string, options: OrchestrationOptions): string {
  const reviewCommand = buildReviewCommand(planId, options);
  const baseGuidelines = `## Important Guidelines

- **DO NOT implement code directly**. Always delegate implementation tasks to the appropriate subagent via \`tim subagent\`.
- **DO NOT write tests directly**. Always use the tester subagent via \`tim subagent tester\` for test execution and updates.
- **Do not substitute your own review for the formal reviewer quality gate.** Always run \`${reviewCommand}\` for the required code quality assessment.
- You may inspect code as needed to coordinate the work, evaluate reviewer findings, and perform the root-cause or structural analysis required by the Review Iteration Policy. This analysis does not replace a required reviewer pass.
- Exception: if review feedback requires only straightforward, contained edits, you may apply those edits directly instead of spawning implementer again.
- After review follow-ups, run focused verification and rerun \`${reviewCommand}\` over the same complete declared scope.
- You are responsible only for coordination and ensuring the workflow is followed correctly.
- The subagents have access to the same task instructions below that you do, so you don't need to repeat them. You should reference which specific task titles are being worked on so the subagents can focus on the right tasks.
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
- If any subagent emits a FAILED line, you MUST stop orchestration immediately.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - Where <agent> is one of: implementer | tester | fixer | reviewer
  - Then include the subagent's detailed report verbatim (requirements, problems, possible solutions).
- Do NOT proceed to further phases or mark tasks done after a failure.
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

function buildReviewCommand(planId: string, options: OrchestrationOptions): string {
  const baseCommand = `tim subagent reviewer ${planId} --print --output-file <output_path>`;
  if (options.reviewExecutor) {
    return `${baseCommand} --executor ${options.reviewExecutor}`;
  }
  return baseCommand;
}

function buildStructuralReviewCommand(planId: string): string {
  return `tim subagent reviewer ${planId} --print --output-file <output_path> --structural-only`;
}

function buildFinalBatchReviewGuidance(planId: string, options: OrchestrationOptions): string {
  if (!options.batchMode) {
    return '';
  }

  const reviewCommand = buildReviewCommand(planId, options);
  const structuralCommand = buildStructuralReviewCommand(planId);
  return `
   - If the selected batch finishes all remaining tasks in the plan, enter the final-plan review sequence by running \`${reviewCommand}\` without any \`--task-index\` arguments so the entire completed plan state is reviewed before you stop. This ordinary review must inspect the entire completed plan scope.
   - If that full-plan review reports issues, follow the Review Iteration Policy below. Every rerun intentionally reviews the entire plan scope, not only the latest fixes. Continue until the review is clean or the bounded handoff procedure has been completed.
   - Only after the ordinary full-plan review loop has reached one of those two stopping conditions, run exactly one standalone structural simplification pass with \`${structuralCommand}\`, again without \`--task-index\`. Use it to find code-layout, ownership, duplication, and structural smells.
   - Resolve the structural findings you accept and run relevant targeted checks. If you make structural changes, run exactly one complete ordinary review afterward to validate the resulting plan state, even if four ordinary reviews already ran before the structural pass. This post-structural validation review is an explicit exception to the ordinary review run limit.
   - Do not restart the ordinary review loop after the post-structural validation review. Reject incorrect findings from that review with evidence and capture each remaining finding worth fixing in a follow-up task using the bounded handoff procedure.
   - Do not rerun the structural pass automatically.
   - Any review findings related to previous tasks in this plan should still be considered, even if those tasks were not performed in this batch of work. The idea is a final quality pass on the entire plan.
`;
}

function buildReviewIterationGuidance(reviewCommand: string): string {
  return `## Review Iteration Policy

- Every ordinary invocation of \`${reviewCommand}\`, including every follow-up after fixes, reviews the complete declared task or plan scope. Do not narrow a follow-up review to only the files changed by the latest fix.
- Treat each full review as capable of finding issues earlier passes missed. After each review, fix every finding you accept and reject any incorrect finding with a concrete, evidence-based explanation. A finding that has been neither fixed nor explicitly rejected is unhandled.
- Compare each new review result with the actual substance and cause of prior findings; do not rely only on category labels or filenames. Decide whether it is the same underlying defect, a different issue exposed by the fix, or a regression introduced by the fix. Keep this recurrence judgment in your own working notes; the review command does not classify it for you.
- Watch for cascading findings: the same underlying defect recurring, a fix exposing another defect in the same responsibility boundary, or repeated fixes moving the problem between duplicated implementations.
- On the second occurrence in such a cascade, pause instance-by-instance patching. As the orchestrator, inspect the implementation and prior findings yourself, identify the failed invariant, duplicated responsibility, or ownership problem, and write a concrete restructuring proposal before delegating more implementation.
- This root-cause checkpoint is orchestrator analysis, not a separate review mode and not a request for the reviewer to solve a difficult bug. Prefer correcting the shared structure or consolidating responsibility when that addresses the cause. Pass the restructuring proposal and the relevant findings to the implementer.
- After restructuring, rerun \`${reviewCommand}\` over the same complete declared scope.
- After accepted fixes, run relevant targeted checks and repeat the complete ordinary review.
- Stop the ordinary review loop when either:
  1. targeted checks pass and a complete ordinary review reports no new unhandled findings; or
  2. the fourth ordinary review has completed and the bounded handoff procedure below has been completed.
- Allow at most 4 ordinary review runs per task batch during this iteration loop. The limit bounds iterative review execution; it does not mean that remaining feedback should be discarded. A single ordinary review used to validate changes from the standalone structural pass is allowed in addition to this limit.
- After the fourth ordinary review, do not run another ordinary review as part of this iteration loop. For every remaining finding, either reject it with a concrete, evidence-based explanation or create a specific follow-up task if it is worth fixing.
- A finding captured in a follow-up task is handled for purposes of completing this batch. Include the original finding, relevant files or locations, why it matters, and any structural analysis or proposed restructuring discovered during this review cycle.
- **Be careful where you file follow-up work:** adding it to the current plan means the harness may select it in a later iteration of this plan. If it depends on work scheduled for a later sibling plan, add it to that existing sibling plan instead. In rare cases, feedback that genuinely belongs at the end of the entire sibling-plan chain may require a new sibling plan.
- Once targeted checks pass and every finding from the fourth review and any post-structural validation review has been rejected or captured in a follow-up task, mark the original in-scope tasks done and complete the batch.
`;
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
  const reviewCommand = buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const header = `# Two-Phase Orchestration Instructions

You are coordinating a tim streamlined two-phase workflow (implement → review) for the tasks below. tim is a tool for managing step-by-step project plans.`;

  const availableAgents = `## Available Agents

You have two specialized subagents that you MUST invoke via the shell command tool:
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Reviewer**: Run \`${reviewCommand}\` via the shell command tool

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the shell command tool.
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

  const workflowInstructions = `## Workflow Instructions

You MUST follow this simplified loop:

${taskSelectionPhase}
   - Explore the repository and create a plan on how to implement the task.
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output

${options.batchMode ? '3' : '2'}. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass relevant implementation notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why.
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${buildFinalBatchReviewGuidance(planId, options)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.
   - The review output focuses on problems; don't expect positive feedback even if the code is perfect.
   - If review fails or identifies issues, return to the implementer with the issues found

${options.batchMode ? '4' : '3'}. **Notes Phase**
${progressSection}

${options.batchMode ? '5' : '4'}. **Iteration**
- For straightforward review follow-ups that are easy to implement correctly (for example wording tweaks, focused refactors, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- After review follow-ups, run focused verification and rerun \`${reviewCommand}\` over the same complete declared scope.
- If the review repeats an issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Repeat the implement → review loop until the ordinary review is clean or the bounded handoff procedure in the Review Iteration Policy has been completed.

${buildReviewIterationGuidance(reviewCommand)}`;

  const failureProtocol = `
## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs for a line starting with "FAILED:".
- If any subagent emits a FAILED line, stop immediately.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - <agent> must be one of: implementer | reviewer | orchestrator
  - Then include the subagent's detailed report verbatim.
- Do NOT continue to other phases or mark tasks done when a failure occurs.
- You may add brief context (e.g. which tasks were active) if helpful.`;

  const guidance = `## Important Guidelines

- Do not substitute your own review for the formal reviewer quality gate. Delegate implementation to \`tim subagent implementer\` and always run \`${reviewCommand}\` for the required code quality assessment.
- You may inspect code as needed to coordinate the work, evaluate reviewer findings, and perform the root-cause or structural analysis required by the Review Iteration Policy. This analysis does not replace a required reviewer pass.
- When invoking subagents, give clear instructions in \`--input\` (or \`--input-file\`) referencing the specific task titles.
- ${INPUT_COMBINATION_GUIDANCE}
- Provide prior subagent outputs to the next subagent so they have full context.
- ${buildInputFileRandomizationGuidance(planId)}
- ${BRANCH_SETUP_GUIDANCE}${buildJjGuidance(options)}
- Keep the scope focused; if review fails, loop back to implementation before moving forward.${
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

You have three specialized subagents that you MUST invoke via the shell command tool:
- **TDD Tests**: Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Reviewer**: Run \`${buildReviewCommand(planId, options)}\` via the shell command tool

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the shell command tool.
`
    : `## Available Agents

You have four specialized subagents that you MUST invoke via the shell command tool:
- **TDD Tests**: Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Tester**: Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)
- **Reviewer**: Run \`tim subagent reviewer ${planId} --input "<instructions>"\` via the shell command tool (or \`--input-file <paths...>\`)

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the shell command tool.
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

  const reviewCommand = buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const verificationPhase = isSimpleTdd
    ? `${verificationPhaseNumber}. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass relevant TDD test output and implementation notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why.
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${buildFinalBatchReviewGuidance(planId, options)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`
    : `${verificationPhaseNumber}. **Testing Phase**
   - Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), include:
     - TDD tests output and implementer output
     - Which tasks are in scope
     - Direction to ensure tests target real implementation code
   - When choosing an executor dynamically, prefer using the same executor that was used for the implementer to maintain consistency and leverage the same strengths.
   - Instruct tester to run tests and fix failures, then report remaining gaps

${options.batchMode ? '5' : '4'}. **Review Phase**
   - Run \`${reviewCommand}\` using the shell command tool.
   - Pass any relevant notes to the reviewer via \`--input-file <paths...>\` so it has the full picture of what was intended and why. On subsequent review runs, also include a list of any issues from prior review output that you determined were not relevant or acceptable to leave as-is, so the reviewer knows not to flag them again.
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${buildFinalBatchReviewGuidance(planId, options)}
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`;

  const reviewIterationGuidance = `
- For straightforward review follow-ups that are easy to implement correctly (for example wording tweaks, focused refactors, small logic adjustments, or similarly contained edits), you may apply the changes yourself without spawning the implementer subagent.
- After review follow-up changes, run relevant targeted checks and rerun \`${reviewCommand}\` over the same complete declared scope.`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this TDD process:

${taskSelectionPhase}
   - Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify in-scope tasks and expected behavior to define
   - Explicitly instruct the TDD tests agent to:
     - Write tests first
     - Run tests
     - Verify failures are for expected behavioral reasons (not syntax/import/setup errors)
   - Capture and preserve this output for downstream phases

${implementationPhaseNumber}. **Implementation Phase**
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the shell command tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input, include the TDD tests output and direct the implementer to make those tests pass
   - Emphasize that implementation should be driven by existing TDD tests, not by adding unrelated new behavior
   - Wait for the subagent to complete and review its output

${verificationPhase}

${notesPhaseNumber}. **Notes Phase**
${progressSection}

${iterationPhaseNumber}. **Iteration**
- If verification/review identifies issues or tests fail:
- Return to step ${options.batchMode ? '2' : '1'} when substantial code changes are required.
- After each fix iteration, run relevant targeted checks before moving forward.${reviewIterationGuidance}
- If the review repeats an issue that was supposedly fixed, re-examine the implementation and the evidence. Fix the underlying problem or reject the finding with a concrete explanation.
- Keep TDD order intact for each iteration, including the final full-plan review loop and structural pass before stopping.

${buildReviewIterationGuidance(reviewCommand)}`;

  const failureProtocol = `
## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs for a line starting with "FAILED:".
- If any subagent emits a FAILED line, stop immediately.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - <agent> must be one of: tdd-tests | implementer | tester | reviewer | orchestrator
  - Then include the subagent's detailed report verbatim.
- Do NOT continue to other phases or mark tasks done when a failure occurs.
- You may add brief context (e.g. which tasks were active) if helpful.`;

  const reviewCommandGuidance = `- Do not substitute your own review for the formal reviewer quality gate. Always run \`${reviewCommand}\` for the required code quality assessment.
- You may inspect code as needed to coordinate the work, evaluate reviewer findings, and perform the root-cause or structural analysis required by the Review Iteration Policy. This analysis does not replace a required reviewer pass.`;
  const testingGuidance = isSimpleTdd
    ? ''
    : '- Do NOT write or run tests directly. Always delegate testing to `tim subagent tester`.';
  const reviewFollowupGuidance = `
- Exception: if review feedback requires only straightforward, contained edits, you may apply those edits directly instead of spawning implementer again.
- After review follow-ups, run focused verification and rerun \`${reviewCommand}\` over the same complete declared scope.`;

  const guidance = `## Important Guidelines

- Do NOT implement code directly. Always delegate implementation via \`tim subagent implementer\`.
${testingGuidance}
${reviewCommandGuidance}
${reviewFollowupGuidance}
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
