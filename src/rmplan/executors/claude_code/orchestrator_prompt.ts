interface OrchestrationOptions {
  batchMode?: boolean;
  planFilePath?: string;
  reviewExecutor?: string;
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
- Focus on what changed, why it changed, and what's next. These updates do NOT need to be about testing or review specifically.

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

/**
 * Builds the available agents section
 */
function buildAvailableAgents(planId: string): string {
  return `## Available Agents

You have access to two specialized agents that you MUST use for this task:
- **rmplan-implementer**: Use this agent to implement new features and write code
- **rmplan-tester**: Use this agent to write and run tests for the implementation

Code reviews are performed by running \`rmplan review\` (not a subagent).`;
}

/**
 * Builds the workflow instructions section
 */
function buildWorkflowInstructions(planId: string, options: OrchestrationOptions): string {
  const taskSelectionPhase = options.batchMode
    ? `1. **Task Selection Phase**
   - First, analyze all provided tasks and select a logical subset to work on
   - Document your selection and reasoning before proceeding
   - Focus on 2-5 related tasks that can be completed together efficiently

2. **Implementation Phase**`
    : `1. **Implementation Phase**`;

  const implementationSteps = `
   - Use the Task tool to invoke the implementer agent with subagent_type="rmplan-implementer"
   - Provide the implementer with the specific task requirements from the context below
   - Wait for the implementer to complete their work`;

  const testingPhase = `${options.batchMode ? '3' : '2'}. **Testing Phase**
   - After implementation is complete, use the Task tool to invoke the tester agent with subagent_type="rmplan-tester"
   - Ask the tester to create comprehensive tests for the implemented functionality, if needed
   - Emphasize that tests must test actual implementation code. Testing a reproduction or simulation of the code is useless.
   - Have the tester run the tests and work on fixing any failures`;

  const reviewCommand = buildReviewCommand(planId, options);
  const reviewExecutorGuidance = options.reviewExecutor
    ? `   - Use the review executor override provided: \`--executor ${options.reviewExecutor}\`.`
    : '   - If needed, pass `--executor <claude-code|codex-cli|both>` to select the review executor.';

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

When updating tasks after successful implementation, testing, and review, use the Bash command 'rmplan set-task-done ${planId} --title "<taskTitle>"'.
To set Task 2 done for plan 165, use 'rmplan set-task-done 165 --title "do it"'. To set multiple tasks done, run the command multiple times for each task.

`;
}

/**
 * Builds the important guidelines section
 */
function buildImportantGuidelines(planId: string, options: OrchestrationOptions): string {
  const reviewCommand = buildReviewCommand(planId, options);
  const baseGuidelines = `## Important Guidelines

- **DO NOT implement code directly**. Always delegate implementation tasks to the appropriate agents.
- **DO NOT write tests directly**. Always use the tester agent for test execution and updates.
- **DO NOT review code directly**. Always run \`${reviewCommand}\` for code quality assessment.
- You are responsible only for coordination and ensuring the workflow is followed correctly.
- The agents have access to the same task instructions below that you do, so you don't need to repeat them. You should reference which specific tasks titles are being worked on so the agents can focus on the right tasks.
- When invoking agents, provide clear, specific instructions about what needs to be done in addition to referencing the task titles.
- Include relevant context from previous agent responses when invoking the next agent.`;

  const failureProtocol = `
\n## Failure Protocol (Conflicting/Impossible Requirements)

- Monitor all subagent outputs (implementer, tester) and the \`rmplan review\` output for a line starting with "FAILED:".
- If any subagent or \`rmplan review\` emits a FAILED line, you MUST stop orchestration immediately.
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
  const baseCommand = `rmplan review ${planId} --print`;
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
  const availableAgents = buildAvailableAgents(planId);
  const workflowInstructions = buildWorkflowInstructions(planId, options);
  const importantGuidelines = buildImportantGuidelines(planId, options);

  const header = `# Multi-Agent Orchestration Instructions

You are the orchestrator for an rmplan multi-agent development workflow. rmplan is a tool for managing step-by-step project plans. Your role is to coordinate between specialized agents to complete the coding task${options.batchMode ? 's' : ''} described below.

${batchModeInstructions}`;

  const footer = `## Task Context

Below is the original task that needs to be completed through this multi-agent workflow:

---

${contextContent}`;

  return `${header}${availableAgents}

${workflowInstructions}

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

  const header = `# Two-Phase Orchestration Instructions

You are coordinating an rmplan streamlined two-phase workflow (implement → verify) for the tasks below. rmplan is a tool for managing step-by-step project plans.`;

  const availableAgents = `## Available Agents

You have two specialized agents:
- **rmplan-implementer**: Implements the requested functionality and updates code/tests as needed.
- **rmplan-verifier**: Runs verification commands (typecheck, lint, tests) and ensures the work meets requirements.`;

  const taskSelectionPhase = options.batchMode
    ? `1. **Task Selection Phase**
   - Review all provided tasks and select a focused subset for this run
   - Document which tasks you chose and why before proceeding
   - Keep the batch manageable so both phases can finish successfully

2. **Implementation Phase**`
    : `1. **Implementation Phase**`;

  const workflowInstructions = `## Workflow Instructions

You MUST follow this simplified loop:

${taskSelectionPhase}
   - Explore the repository and create a plan on how to implement the task.
   - Call the implementer agent via the Task tool with subagent_type="rmplan-implementer"
   - Provide precise task instructions and relevant context
   - Wait for the implementer to finish before moving on

${options.batchMode ? '3' : '2'}. **Verification Phase**
   - Invoke the verifier agent with subagent_type="rmplan-verifier"
   - Direct the verifier to:
     - Ensure tests exist for new or changed behavior (adding tests if gaps remain)
     - Run type checking (e.g. \`bun run check\`)
     - Run linting (e.g. \`bun run lint\`)
     - Run the project test suite (e.g. \`bun test\`)
     - Confirm all commands pass and summarize any failures
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

- Do NOT implement, verify, or edit files yourself—delegate all work to the agents.
- When invoking agents, give clear instructions referencing the specific task titles.
- Provide prior agent outputs to the next agent so they have full context.
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

${workflowInstructions}

${failureProtocol}

${guidance}

${footer}`;
}
