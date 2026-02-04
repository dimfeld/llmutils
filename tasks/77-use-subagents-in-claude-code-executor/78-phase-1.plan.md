---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Use subagents in Claude Code executor - Implement Core Subagent Logic and
  Basic Cleanup
goal: To implement the core functionality of creating, using, and cleaning up
  subagents for a single, complete execution cycle.
id: 78
uuid: e7a5e371-9586-4e94-8eca-c4f2e1b2a218
status: done
priority: high
dependencies: []
parent: 77
references:
  "77": 1e3610fe-6687-497c-b5d3-44696fa3d5ef
planGeneratedAt: 2025-07-29T19:14:39.578Z
promptsGeneratedAt: 2025-07-29T19:24:27.635Z
createdAt: 2025-07-29T19:06:12.623Z
updatedAt: 2025-10-27T08:39:04.319Z
tasks:
  - title: Update Executor Function Signature to Accept Plan Information
    done: true
    description: >
      The Claude Code executor function will be modified to accept additional
      arguments, specifically the `planId`. This ID is essential for creating
      the uniquely named agent files and will be passed down from the part of
      the application that invokes the executor. The Executor interface in
      types.ts needs to be updated to include plan information in the execute
      method signature. All executor implementations must be updated to match
      this new signature, even if they don't use the plan information.
  - title: Implement Dynamic Agent File Generation
    done: true
    description: >
      A utility function will be created to dynamically generate the agent
      definition files. This function will take a `planId` and agent details,
      create the `.claude/agents` directory if it doesn't exist, and write the
      formatted Markdown files (`tim-${planId}-implementer.md`, etc.) to that
      directory. The function should handle errors gracefully and ensure the
      directory has proper permissions. Agent files follow a specific format
      with YAML frontmatter containing name and description fields, followed by
      the prompt content.
  - title: Define Prompts for Implementer, Tester, and Reviewer Agents
    done: true
    description: >
      The specific prompt content for each of the three agents will be defined.
      These prompts will contain their core instructions and will be used by the
      agent file generation utility to populate the body of the Markdown files.
      The implementer agent focuses on writing code to fulfill requirements, the
      tester agent creates and runs tests to verify the implementation, and the
      reviewer agent examines the code for quality, best practices, and
      potential improvements.
  - title: Update Main Executor Prompt to Orchestrate Subagents
    done: true
    description: >
      The main prompt sent to the Claude Code executor will be revised. It will
      now include instructions for a primary agent to manage a workflow loop,
      explicitly calling the `tim-${planId}-implementer`,
      `tim-${planId}-tester`, and `tim-${planId}-reviewer` agents in
      sequence to complete the coding task. The orchestration instructions
      should be clear about when to use each agent and how to handle the
      iterative nature of the development process.
  - title: Integrate Agent Lifecycle Management into the Executor
    done: true
    description: >
      The executor logic will be updated to manage the full lifecycle of the
      agent files. It will call the generation function before starting the main
      task and will use a `try...finally` block to ensure a new cleanup
      function, which deletes the agent files, is always called upon completion.
      This ensures that temporary agent files don't accumulate in the repository
      even if the execution fails or is interrupted.
changedFiles:
  - src/tim/agent_runner.test.ts
  - src/tim/agent_runner.ts
  - src/tim/commands/agent.test.ts
  - src/tim/commands/agent.ts
  - src/tim/executors/claude_code/agent_generator.test.ts
  - src/tim/executors/claude_code/agent_generator.ts
  - src/tim/executors/claude_code/agent_prompts.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/copy_only.ts
  - src/tim/executors/copy_paste.ts
  - src/tim/executors/one-call.ts
  - src/tim/executors/types.ts
  - src/tim/prompt_builder.test.ts
  - src/rmpr/main.ts
rmfilter:
  - src/tim/executors/claude_code
  - --
  - src/tim/commands/agent.ts
  - --with-imports
---

This phase focuses on establishing the foundational mechanics of the subagent workflow. We will modify the executor to accept plan-specific information, generate the required agent definition files, and update the main prompt to orchestrate the implement-test-review loop. Cleanup will be handled within a `try...finally` block to ensure it runs after execution, providing a complete, working feature without the advanced interrupt handling.
