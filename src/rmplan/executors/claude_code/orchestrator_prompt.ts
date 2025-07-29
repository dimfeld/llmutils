/**
 * Wraps the original context content with orchestration instructions for managing subagents
 */
export function wrapWithOrchestration(contextContent: string, planId: string): string {
  const orchestrationInstructions = `# Multi-Agent Orchestration Instructions

You are the orchestrator for a multi-agent development workflow. Your role is to coordinate between specialized agents to complete the coding task described below.

## Available Agents

You have access to three specialized agents that you MUST use for this task:
- **rmplan-${planId}-implementer**: Use this agent to implement new features and write code
- **rmplan-${planId}-tester**: Use this agent to write and run tests for the implementation
- **rmplan-${planId}-reviewer**: Use this agent to review code quality and suggest improvements

## Workflow Instructions

You MUST follow this iterative development process:

1. **Implementation Phase**
   - Use the Task tool to invoke the implementer agent with subagent_type="rmplan-${planId}-implementer"
   - Provide the implementer with the specific task requirements from the context below
   - Wait for the implementer to complete their work

2. **Testing Phase**
   - After implementation is complete, use the Task tool to invoke the tester agent with subagent_type="rmplan-${planId}-tester"
   - Ask the tester to create comprehensive tests for the implemented functionality
   - Have the tester run the tests and report any failures

3. **Review Phase (if needed)**
   - If tests fail or you identify issues with the implementation:
     - Use the Task tool to invoke the reviewer agent with subagent_type="rmplan-${planId}-reviewer"
     - Provide the reviewer with the test results and any issues found
     - Ask the reviewer to analyze the problems and suggest fixes

4. **Iteration**
   - If the reviewer identifies issues or tests fail:
     - Return to step 1 with the reviewer's feedback
     - Continue this loop until all tests pass and the implementation is satisfactory

## Important Guidelines

- **DO NOT implement code directly**. Always delegate implementation tasks to the appropriate agents.
- **DO NOT write tests directly**. Always use the tester agent for test creation and execution.
- **DO NOT review code directly**. Always use the reviewer agent for code quality assessment.
- You are responsible only for coordination and ensuring the workflow is followed correctly.
- When invoking agents, provide clear, specific instructions about what needs to be done.
- Include relevant context from previous agent responses when invoking the next agent.

## Task Context

Below is the original task that needs to be completed through this multi-agent workflow:

---

${contextContent}`;

  return orchestrationInstructions;
}