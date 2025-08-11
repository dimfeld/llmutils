interface OrchestrationOptions {
  batchMode?: boolean;
  planFilePath?: string;
}

/**
 * Builds the batch mode processing instructions
 */
function buildBatchModeInstructions(options: OrchestrationOptions): string {
  if (!options.batchMode) return '';

  return `# Batch Task Processing Mode

You have been provided with multiple incomplete tasks from a project plan. Your responsibility is to:

1. **Analyze all provided tasks** to understand their scope, dependencies, and relationships
2. **Select a logical subset** of tasks that make sense to execute together in this batch
3. **Execute the selected tasks** using the specialized agents
4. **Update the plan file** to mark completed tasks as done

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

`;
}

/**
 * Builds the available agents section
 */
function buildAvailableAgents(planId: string): string {
  return `## Available Agents

You have access to three specialized agents that you MUST use for this task:
- **rmplan-${planId}-implementer**: Use this agent to implement new features and write code
- **rmplan-${planId}-tester**: Use this agent to write and run tests for the implementation
- **rmplan-${planId}-reviewer**: Use this agent to review code quality and suggest improvements`;
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
   - Use the Task tool to invoke the implementer agent with subagent_type="rmplan-${planId}-implementer"
   - Provide the implementer with the specific task requirements from the context below
   - Wait for the implementer to complete their work`;

  const testingPhase = `${options.batchMode ? '3' : '2'}. **Testing Phase**
   - After implementation is complete, use the Task tool to invoke the tester agent with subagent_type="rmplan-${planId}-tester"
   - Ask the tester to create comprehensive tests for the implemented functionality, if needed
   - Emphasize that tests must test actual implementation code. Testing a reproduction or simulation of the code is useless.
   - Have the tester run the tests and work on fixing any failures`;

  const reviewPhase = `${options.batchMode ? '4' : '3'}. **Review Phase**
   - Use the Task tool to invoke the reviewer agent with subagent_type="rmplan-${planId}-reviewer"
   - Tell the reviewer what was just implemented and what project requirements those changes fulfill.
   - Ask the reviewer to analyze the codebase and ensures its quality and adherence to the task requirements
   - The reviewer is instructed to only focus on problems; don't expect positive feedback even if the code is perfect.`;

  const finalPhase = options.batchMode
    ? `5. **Plan Update Phase**
   - After all selected tasks are successfully completed, tested, and reviewed, use the Edit tool to update the plan file
   - Mark each completed task with \`done: true\` in the YAML structure
   - Only mark tasks as done if they are fully complete and working
   - Make sure to commit after updating the plan file

6. **Iteration**`
    : `4. **Iteration**`;

  const iterationSteps = `
   - If the reviewer identifies issues or tests fail:
     - Return to step ${options.batchMode ? '2' : '1'} with the reviewer's feedback
     - Continue this loop until all tests pass and the implementation is satisfactory`;

  return `## Workflow Instructions

You MUST follow this iterative development process:

${taskSelectionPhase}${implementationSteps}

${testingPhase}

${reviewPhase}

${finalPhase}${iterationSteps}`;
}

/**
 * Builds the important guidelines section
 */
function buildImportantGuidelines(options: OrchestrationOptions): string {
  const baseGuidelines = `## Important Guidelines

- **DO NOT implement code directly**. Always delegate implementation tasks to the appropriate agents.
- **DO NOT write tests directly**. Always use the tester agent for test execution and updates.
- **DO NOT review code directly**. Always use the reviewer agent for code quality assessment.
- You are responsible only for coordination and ensuring the workflow is followed correctly.
- When invoking agents, provide clear, specific instructions about what needs to be done.
- The agents have access to the same task instructions below that you do, so you don't need to repeat them.
- Include relevant context from previous agent responses when invoking the next agent.`;

  const batchModeGuidelines = options.batchMode
    ? `
- Subagents will have access to the entire list of incomplete tasks from the plan file, so be sure to include which tasks to focus on in your subagent instructions.
- You must update the plan file to mark completed tasks as done before stopping.
- **Be selective**: Don't attempt all tasks at once - choose a reasonable subset that works well together.`
    : '';

  return baseGuidelines + batchModeGuidelines;
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
  const importantGuidelines = buildImportantGuidelines(options);

  const header = `# Multi-Agent Orchestration Instructions

You are the orchestrator for a multi-agent development workflow. Your role is to coordinate between specialized agents to complete the coding task${options.batchMode ? 's' : ''} described below.

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
