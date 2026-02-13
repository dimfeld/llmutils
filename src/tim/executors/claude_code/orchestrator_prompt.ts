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
- In \`### Lessons Learned\`, capture surprises, gotchas, non-obvious fixes, and what was learned from review feedback or review-fix iterations.

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
- Especially note what you learned while fixing review feedback and why the issue occurred.
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

After successfully completing your selected tasks, you MUST use the Edit tool to update the plan file at: @${options.planFilePath || 'PLAN_FILE_PATH_NOT_PROVIDED'}

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
- Code review identified blocking issues

You don't need to mark the entire plan file as complete. We will handle that for you. But if you do, you must use 'status: done'

`;
}

const DEFAULT_DYNAMIC_SUBAGENT_INSTRUCTIONS =
  'Prefer claude-code for frontend tasks, codex-cli for backend tasks.';

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

You have access to two specialized agents that you MUST invoke via the Bash tool:
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)
- **Tester**: Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)

Code reviews are performed by running \`tim review\` (not a subagent).

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the Bash tool.`;
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
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output`;

  const testingPhase = `${options.batchMode ? '3' : '2'}. **Testing Phase**
   - After implementation is complete, run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), ask the tester to create comprehensive tests for the implemented functionality, if needed
   - Emphasize that tests must test actual implementation code. Testing a reproduction or simulation of the code is useless.
   - In the input, instruct the tester to run tests and fix any failures
   - Include relevant context from the implementer's output in the input`;

  const reviewCommand = buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '';

  const reviewPhase = `${options.batchMode ? '4' : '3'}. **Review Phase**
   - Run \`${reviewCommand}\` using the Bash tool.
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.
   - The review output focuses on problems; don't expect positive feedback even if the code is perfect.`;

  const finalPhases = `${options.batchMode ? '5' : '4'}. **Notes Phase**
   ${progressSectionGuidance(options.planFilePath)}

${options.batchMode ? '6' : '5'}. **Iteration**

- If the review output identifies issues or tests fail:
- Return to step ${options.batchMode ? '2' : '1'} with the review feedback
- Continue this loop until all tests pass and the implementation is satisfactory`;

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

When updating tasks after successful implementation, testing, and review, use the Bash command 'tim set-task-done ${planId} --title "<taskTitle>"'.
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
- **DO NOT review code directly**. Always run \`${reviewCommand}\` for code quality assessment.
- You are responsible only for coordination and ensuring the workflow is followed correctly.
- The subagents have access to the same task instructions below that you do, so you don't need to repeat them. You should reference which specific task titles are being worked on so the subagents can focus on the right tasks.
- When invoking subagents, provide clear, specific instructions in \`--input\` (or \`--input-file\`) about what needs to be done in addition to referencing the task titles.
- Include relevant context from previous subagent responses when invoking the next subagent.
- If input is large (roughly over 50KB), write it to a temporary file and pass \`--input-file <path>\` instead of \`--input\`.
- You can also pipe input to stdin and use \`--input-file -\`.`;

  const failureProtocol = `
\n## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs (implementer, tester) and the \`tim review\` output for a line starting with "FAILED:".
- If any subagent or \`tim review\` emits a FAILED line, you MUST stop orchestration immediately.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - Where <agent> is one of: implementer | tester | fixer | review
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
    baseGuidelines + failureProtocol + batchModeOnly + progressSectionGuidance(options.planFilePath)
  );
}

function buildReviewCommand(planId: string, options: OrchestrationOptions): string {
  const baseCommand = `tim review ${planId} --print`;
  if (options.reviewExecutor) {
    return `${baseCommand} --executor ${options.reviewExecutor}`;
  }
  return baseCommand;
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
 * Wraps context content with simplified orchestration instructions for implement → verify flow.
 */
export function wrapWithOrchestrationSimple(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions = {}
): string {
  const batchModeInstructions = buildBatchModeInstructions(options);
  const progressSection = progressSectionGuidance(options.planFilePath);
  const executorFlag = buildSubagentExecutorFlag(options);
  const dynamicGuidance = buildDynamicExecutorGuidance(options);

  const header = `# Two-Phase Orchestration Instructions

You are coordinating a tim streamlined two-phase workflow (implement → verify) for the tasks below. tim is a tool for managing step-by-step project plans.`;

  const availableAgents = `## Available Agents

You have two specialized subagents that you MUST invoke via the Bash tool:
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)
- **Verifier**: Run \`tim subagent verifier ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the Bash tool.`;

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
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify which tasks to work on and provide relevant context
   - Wait for the subagent to complete and review its output

${options.batchMode ? '3' : '2'}. **Verification Phase**
   - Run \`tim subagent verifier ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), direct the verifier to:
     - Ensure tests exist for new or changed behavior (adding tests if gaps remain)
     - Run type checking (e.g. \`bun run check\`)
     - Run linting (e.g. \`bun run lint\`)
     - Run the project test suite (e.g. \`bun test\`)
     - Confirm all commands pass and summarize any failures
   - Include relevant context from the implementer's output in the input
   - If verification fails, return to the implementer with the issues found

${options.batchMode ? '4' : '3'}. **Notes Phase**
${progressSection}

${options.batchMode ? '5' : '4'}. **Iteration**
- Repeat the implement → verify loop until verification succeeds without failures.`;

  const failureProtocol = `
## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs for a line starting with "FAILED:".
- If any subagent emits a FAILED line, stop immediately.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - <agent> must be one of: implementer | verifier | orchestrator
  - Then include the subagent's detailed report verbatim.
- Do NOT continue to other phases or mark tasks done when a failure occurs.
- You may add brief context (e.g. which tasks were active) if helpful.`;

  const guidance = `## Important Guidelines

- Do NOT implement, verify, or edit files yourself--delegate all work to the subagents via \`tim subagent\`.
- When invoking subagents, give clear instructions in \`--input\` (or \`--input-file\`) referencing the specific task titles.
- Provide prior subagent outputs to the next subagent so they have full context.
- If input is large (roughly over 50KB), write it to a temporary file and pass \`--input-file <path>\` instead of \`--input\`.
- You can also pipe input to stdin and use \`--input-file -\`.
- Keep the scope focused; if verification fails, loop back to implementation before moving forward.${
    options.batchMode
      ? `
- Subagents can read all pending tasks; explicitly tell them which ones are in scope for this batch.`
      : ''
  }

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
 * - TDD simple: tdd-tests -> implementer -> verifier
 */
export function wrapWithOrchestrationTdd(
  contextContent: string,
  planId: string,
  options: OrchestrationOptions = {}
): string {
  const batchModeInstructions = buildBatchModeInstructions(options);
  const progressSection = progressSectionGuidance(options.planFilePath);
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

You have three specialized subagents that you MUST invoke via the Bash tool:
- **TDD Tests**: Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)
- **Verifier**: Run \`tim subagent verifier ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the Bash tool.`
    : `## Available Agents

You have three specialized subagents that you MUST invoke via the Bash tool:
- **TDD Tests**: Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)
- **Implementer**: Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)
- **Tester**: Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool (or \`--input-file <path>\`)

Code reviews are performed by running \`tim review\` (not a subagent).

Each subagent command may take a long time to complete. Always use a timeout of at least 1800000 ms (30 minutes) when invoking them via the Bash tool.`;

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
    ? `${verificationPhaseNumber}. **Verification Phase**
   - Run \`tim subagent verifier ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), include:
     - TDD tests output and implementation summary
     - Which tasks are in scope
     - Required quality gates (\`bun run check\`, \`bun run lint\`, \`bun test\`)
   - Instruct verifier to confirm the implementation satisfies the previously written tests and report gaps`
    : `${verificationPhaseNumber}. **Testing Phase**
   - Run \`tim subagent tester ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), include:
     - TDD tests output and implementer output
     - Which tasks are in scope
     - Direction to ensure tests target real implementation code
   - Instruct tester to run tests and fix failures, then report remaining gaps

${options.batchMode ? '5' : '4'}. **Review Phase**
   - Run \`${reviewCommand}\` using the Bash tool.
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.
${reviewExecutorGuidance}
   - The review command may take up to 15 minutes; use a long timeout.`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this TDD process:

${taskSelectionPhase}
   - Run \`tim subagent tdd-tests ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input (\`--input\` or \`--input-file\`), specify in-scope tasks and expected behavior to define
   - Explicitly instruct the TDD tests agent to:
     - Write tests first
     - Run tests
     - Verify failures are for expected behavioral reasons (not syntax/import/setup errors)
   - Capture and preserve this output for downstream phases

${implementationPhaseNumber}. **Implementation Phase**
   - Run \`tim subagent implementer ${planId}${executorFlag} --input "<instructions>"\` via the Bash tool with a timeout of at least 1800000 ms (30 minutes)${dynamicNote}
   - In the input, include the TDD tests output and direct the implementer to make those tests pass
   - Emphasize that implementation should be driven by existing TDD tests, not by adding unrelated new behavior
   - Wait for the subagent to complete and review its output

${verificationPhase}

${notesPhaseNumber}. **Notes Phase**
${progressSection}

${iterationPhaseNumber}. **Iteration**
- If verification/review identifies issues or tests fail:
- Return to step ${options.batchMode ? '2' : '1'} and continue the loop
- Keep TDD order intact for each iteration`;

  const failureProtocol = `
## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs for a line starting with "FAILED:".
- If any subagent emits a FAILED line, stop immediately.
- Output a concise failure message and propagate details:
  - First line: FAILED: <agent> reported a failure — <1-sentence summary>
    - <agent> must be one of: tdd-tests | implementer | tester | verifier | review | orchestrator
  - Then include the subagent's detailed report verbatim.
- Do NOT continue to other phases or mark tasks done when a failure occurs.
- You may add brief context (e.g. which tasks were active) if helpful.`;

  const reviewCommandGuidance = isSimpleTdd
    ? ''
    : `- Do NOT review code directly. Always run \`${reviewCommand}\` for code quality assessment.`;
  const testingGuidance = isSimpleTdd
    ? '- Do NOT verify code directly. Always delegate verification to \`tim subagent verifier\`.'
    : '- Do NOT write or run tests directly. Always delegate testing to \`tim subagent tester\`.';

  const guidance = `## Important Guidelines

- Do NOT implement code directly. Always delegate implementation via \`tim subagent implementer\`.
${testingGuidance}
${reviewCommandGuidance}
- We are using Test-Driven Development. The \`tdd-tests\` subagent must run before implementation.
- Always pass the TDD tests output into the implementer invocation.
- Do not skip the TDD test phase, even if implementation seems straightforward.
- If input is large (roughly over 50KB), write it to a temporary file and pass \`--input-file <path>\` instead of \`--input\`.
- You can also pipe input to stdin and use \`--input-file -\`.
- When subagents can see all pending tasks, explicitly state which task titles are in scope for this run.${
    options.batchMode
      ? `
- Subagents can read all pending tasks; explicitly tell them which ones are in scope for this batch.`
      : ''
  }

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
