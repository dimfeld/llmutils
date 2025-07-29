---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Use subagents in Claude Code executor - Implement Core Subagent Logic and
  Basic Cleanup
goal: To implement the core functionality of creating, using, and cleaning up
  subagents for a single, complete execution cycle.
id: 78
status: in_progress
priority: high
dependencies: []
parent: 77
planGeneratedAt: 2025-07-29T19:14:39.578Z
promptsGeneratedAt: 2025-07-29T19:24:27.635Z
createdAt: 2025-07-29T19:06:12.623Z
updatedAt: 2025-07-29T19:39:44.860Z
tasks:
  - title: Update Executor Function Signature to Accept Plan Information
    description: >
      The Claude Code executor function will be modified to accept additional
      arguments, specifically the `planId`. This ID is essential for creating
      the uniquely named agent files and will be passed down from the part of
      the application that invokes the executor. The Executor interface in
      types.ts needs to be updated to include plan information in the execute
      method signature. All executor implementations must be updated to match
      this new signature, even if they don't use the plan information.
    files:
      - src/rmplan/executors/types.ts
      - src/rmplan/executors/claude_code.ts
      - src/rmplan/executors/copy_only.ts
      - src/rmplan/executors/copy_paste.ts
      - src/rmplan/executors/one-call.ts
      - src/rmplan/commands/agent.ts
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Update the Executor interface in types.ts to modify the execute method
          signature to accept a second parameter containing plan information. 

          Add a new interface called ExecutePlanInfo that includes planId
          (string), planTitle (string), and planFilePath (string).
        done: true
      - prompt: >
          Update the ClaudeCodeExecutor class in claude_code.ts to match the new
          execute signature. 

          Store the plan information as instance variables for use in the agent
          file generation.
        done: true
      - prompt: >
          Update all other executor implementations (copy_only.ts,
          copy_paste.ts, one-call.ts) to match the new execute signature.

          They can ignore the plan parameter since they don't need it, but must
          accept it to maintain interface compatibility.
        done: true
      - prompt: >
          Create or update tests in claude_code.test.ts to verify the executor
          correctly receives and stores plan information.

          Test that the execute method is called with both contextContent and
          plan information parameters.
        done: true
      - prompt: >
          Update agent.ts to pass plan information when calling
          executor.execute(). 

          Extract planId from planData.id, planTitle from planData.title, and
          pass the currentPlanFile path.

          Update both the step execution branch and the simple task execution
          branch.
        done: true
  - title: Implement Dynamic Agent File Generation
    description: >
      A utility function will be created to dynamically generate the agent
      definition files. This function will take a `planId` and agent details,
      create the `.claude/agents` directory if it doesn't exist, and write the
      formatted Markdown files (`rmplan-${planId}-implementer.md`, etc.) to that
      directory. The function should handle errors gracefully and ensure the
      directory has proper permissions. Agent files follow a specific format
      with YAML frontmatter containing name and description fields, followed by
      the prompt content.
    files:
      - src/rmplan/executors/claude_code/agent_generator.ts
      - src/rmplan/executors/claude_code/agent_generator.test.ts
    steps:
      - prompt: >
          Create a new file agent_generator.ts in the claude_code directory.

          Define an interface AgentDefinition with fields: name (string),
          description (string), and prompt (string).
        done: true
      - prompt: >
          Implement a function generateAgentFiles that takes planId (string) and
          an array of AgentDefinition objects.

          The function should create the .claude/agents directory relative to
          the git root if it doesn't exist.
        done: true
      - prompt: >
          In generateAgentFiles, for each agent definition, create a markdown
          file with the filename pattern `rmplan-${planId}-${agent.name}.md`.

          Write YAML frontmatter with name and description, followed by the
          prompt content.
        done: true
      - prompt: >
          Implement a function removeAgentFiles that takes a planId and removes
          all agent files matching the pattern `rmplan-${planId}-*.md` from the
          .claude/agents directory.

          Handle cases where files might not exist gracefully.
        done: true
      - prompt: >
          Create comprehensive tests in agent_generator.test.ts that verify
          agent file creation, content format, and removal.

          Use a temporary directory for testing and verify file contents match
          expected format.
        done: true
  - title: Define Prompts for Implementer, Tester, and Reviewer Agents
    description: >
      The specific prompt content for each of the three agents will be defined.
      These prompts will contain their core instructions and will be used by the
      agent file generation utility to populate the body of the Markdown files.
      The implementer agent focuses on writing code to fulfill requirements, the
      tester agent creates and runs tests to verify the implementation, and the
      reviewer agent examines the code for quality, best practices, and
      potential improvements.
    files:
      - src/rmplan/executors/claude_code/agent_prompts.ts
    steps:
      - prompt: >
          Create a new file agent_prompts.ts that exports three functions:
          getImplementerPrompt, getTesterPrompt, and getReviewerPrompt.

          Each function should return an object matching the AgentDefinition
          interface.
        done: true
      - prompt: >
          Define getImplementerPrompt to return an agent that focuses on
          implementing the requested functionality.

          Include instructions to follow coding standards, use existing patterns
          in the codebase, and implement features incrementally.
        done: true
      - prompt: >
          Define getTesterPrompt to return an agent that creates comprehensive
          tests for the implemented code.

          Include instructions to write tests using Bun test, prefer integration
          tests over unit tests with mocks, and ensure edge cases are covered.
        done: true
      - prompt: >
          Define getReviewerPrompt to return an agent that reviews the
          implementation and tests for quality.

          Include instructions to check for code clarity, adherence to project
          patterns, security considerations, and suggest improvements without
          being overly critical.
        done: true
  - title: Update Main Executor Prompt to Orchestrate Subagents
    description: >
      The main prompt sent to the Claude Code executor will be revised. It will
      now include instructions for a primary agent to manage a workflow loop,
      explicitly calling the `rmplan-${planId}-implementer`,
      `rmplan-${planId}-tester`, and `rmplan-${planId}-reviewer` agents in
      sequence to complete the coding task. The orchestration instructions
      should be clear about when to use each agent and how to handle the
      iterative nature of the development process.
    files:
      - src/rmplan/executors/claude_code/orchestrator_prompt.ts
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          Create a new file orchestrator_prompt.ts that exports a function
          wrapWithOrchestration.

          This function takes the original contextContent and planId, and
          returns a modified prompt with orchestration instructions prepended.
        done: false
      - prompt: >
          In wrapWithOrchestration, add instructions that tell Claude to use the
          Task tool to invoke the subagents in sequence.

          Specify the exact agent names using the planId:
          rmplan-${planId}-implementer, rmplan-${planId}-tester,
          rmplan-${planId}-reviewer.
        done: false
      - prompt: >
          Include instructions for an iterative loop: implement with the
          implementer agent, test with the tester agent, and if tests fail or
          issues are found, use the reviewer agent before going back to the
          implementer.

          Emphasize that the main agent should coordinate but not implement
          directly.
        done: false
      - prompt: >
          Update claude_code.ts to use wrapWithOrchestration to modify the
          contextContent before execution.

          Only apply orchestration when subagents are being used (when plan
          information is provided).
        done: false
  - title: Integrate Agent Lifecycle Management into the Executor
    description: >
      The executor logic will be updated to manage the full lifecycle of the
      agent files. It will call the generation function before starting the main
      task and will use a `try...finally` block to ensure a new cleanup
      function, which deletes the agent files, is always called upon completion.
      This ensures that temporary agent files don't accumulate in the repository
      even if the execution fails or is interrupted.
    files:
      - src/rmplan/executors/claude_code.ts
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Import the agent generation functions and agent prompts in
          claude_code.ts.

          Modify the execute method to check if plan information is provided.
        done: false
      - prompt: >
          Before the main execution logic, if plan information exists, call
          generateAgentFiles with the planId and an array of agent definitions
          from the agent_prompts module.

          Log that agent files have been created.
        done: false
      - prompt: >
          Wrap the existing execution logic in a try block, and add a finally
          block that calls removeAgentFiles if plan information was provided.

          Ensure the finally block runs even if an error occurs during
          execution.
        done: false
      - prompt: >
          Update or create tests to verify that agent files are created before
          execution and cleaned up afterward.

          Test both successful execution and error scenarios to ensure cleanup
          always occurs.
        done: false
changedFiles:
  - src/rmplan/agent_runner.test.ts
  - src/rmplan/agent_runner.ts
  - src/rmplan/commands/agent.test.ts
  - src/rmplan/commands/agent.ts
  - src/rmplan/executors/claude_code/agent_generator.test.ts
  - src/rmplan/executors/claude_code/agent_generator.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/copy_only.ts
  - src/rmplan/executors/copy_paste.ts
  - src/rmplan/executors/one-call.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/prompt_builder.test.ts
  - src/rmpr/main.ts
rmfilter:
  - src/rmplan/executors/claude_code
  - --
  - src/rmplan/commands/agent.ts
  - --with-imports
---

This phase focuses on establishing the foundational mechanics of the subagent workflow. We will modify the executor to accept plan-specific information, generate the required agent definition files, and update the main prompt to orchestrate the implement-test-review loop. Cleanup will be handled within a `try...finally` block to ensure it runs after execution, providing a complete, working feature without the advanced interrupt handling.
