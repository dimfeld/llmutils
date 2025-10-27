---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Use subagents in Claude Code executor - Implement Robust Cleanup with a
  SIGINT Handler
goal: To make the agent file cleanup mechanism resilient to premature
  application termination by implementing a global SIGINT handler and a cleanup
  task registry.
id: 79
uuid: 458b10dc-2231-4344-a148-1f8f59b13e3f
status: done
priority: high
dependencies:
  - 78
parent: 77
planGeneratedAt: 2025-07-29T19:14:39.578Z
promptsGeneratedAt: 2025-07-29T20:38:48.963Z
createdAt: 2025-07-29T19:06:12.623Z
updatedAt: 2025-10-27T08:39:04.317Z
tasks:
  - title: Create a Centralized Cleanup Handler Registry
    done: false
    description: >
      A module will be created to manage a list of cleanup functions that need
      to run on process termination. 

      It will follow a singleton pattern and expose methods to
      register/unregister cleanup handlers and execute all registered handlers.

      The registry must use synchronous operations since it will be called from
      signal handlers.

      Following the pattern from workspace_lock.ts, the cleanup functions should
      handle errors gracefully.

      The module will use a Map to store cleanup functions with unique IDs
      generated using incrementing numbers.
    files:
      - src/common/cleanup_registry.ts
      - src/common/cleanup_registry.test.ts
    steps:
      - prompt: >
          Create src/common/cleanup_registry.test.ts with tests for the cleanup
          registry functionality.

          Include tests for registering handlers, unregistering handlers,
          executing all handlers,

          handling errors during cleanup execution, and ensuring cleanup
          functions run only once.
        done: true
      - prompt: >
          Create src/common/cleanup_registry.ts implementing a singleton
          CleanupRegistry class.

          Include a Map to store handlers by ID, a counter for generating unique
          IDs,

          a register() method that returns an unregister function, and an
          executeAll() method

          that runs all handlers synchronously and clears the registry
          afterwards.
        done: true
      - prompt: >
          Update the CleanupRegistry to handle errors gracefully during
          executeAll() by wrapping

          each handler call in a try-catch block. Add a debug log for any errors
          that occur

          during cleanup execution.
        done: true
  - title: Implement a Global SIGINT Handler
    done: false
    description: >
      At the application's main entry point in src/rmplan/rmplan.ts,
      process-level listeners for 

      termination signals will be established. Following the pattern from
      workspace_lock.ts,

      handlers will be added for 'exit', 'SIGINT', 'SIGTERM', and 'SIGHUP'
      signals.

      When triggered, these handlers will invoke the executeAll() method from
      the cleanup registry

      to ensure all pending cleanup tasks run before the process exits.

      The signal handlers should be registered early in the run() function
      before command parsing.
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Import the CleanupRegistry from '../common/cleanup_registry.ts' at the
          top of src/rmplan/rmplan.ts

          alongside other imports.
        done: true
      - prompt: >
          In the run() function of src/rmplan/rmplan.ts, right after loadEnv()
          is called,

          set up signal handlers for 'exit', 'SIGINT', 'SIGTERM', and 'SIGHUP'
          that call

          CleanupRegistry.getInstance().executeAll(). For SIGINT, also call
          process.exit(130)

          after cleanup to follow Unix convention.
        done: true
  - title: Integrate the Executor with the Cleanup Registry
    done: false
    description: >
      The Claude Code executor will be modified to register its agent file
      cleanup function with

      the new cleanup registry when agent files are created. The registration
      will happen right

      after generateAgentFiles() is called. The unregister function returned by
      the registry

      will be stored in a local variable and called in the finally block,
      ensuring the handler

      is removed only on normal completion. The cleanup function will use the
      synchronous

      fs.unlinkSync and fs.readdirSync operations since it may be called from
      signal handlers.

      Tests will be updated to verify the integration works correctly.
    files:
      - src/rmplan/executors/claude_code.ts
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Import CleanupRegistry from '../../common/cleanup_registry.ts' in
          src/rmplan/executors/claude_code.ts

          and import fs (not fs/promises) from 'node:fs' for synchronous
          operations.
        done: true
      - prompt: >
          In the execute() method of src/rmplan/executors/claude_code.ts, after
          calling generateAgentFiles(),

          register a cleanup function with CleanupRegistry that synchronously
          removes the agent files.

          Store the returned unregister function in a variable declared before
          the try block.
        done: true
      - prompt: >
          Update the cleanup function to use fs.readdirSync to find files
          matching the pattern

          rmplan-${planId}-*.md in the agents directory, then use fs.unlinkSync
          to remove each file.

          Wrap the operations in try-catch to handle errors gracefully.
        done: true
      - prompt: >
          In the finally block of execute(), call the stored unregister function
          if it exists

          to remove the cleanup handler from the registry, ensuring it only runs
          on abnormal termination.
        done: true
      - prompt: >
          Update src/rmplan/executors/claude_code.test.ts to add tests verifying
          that the cleanup

          handler is registered when agent files are created and unregistered in
          the finally block.

          Mock the CleanupRegistry to verify the register and unregister calls.
        done: true
changedFiles:
  - src/common/cleanup_registry.test.ts
  - src/common/cleanup_registry.ts
  - src/rmplan/agent_runner.test.ts
  - src/rmplan/agent_runner.ts
  - src/rmplan/commands/agent.test.ts
  - src/rmplan/commands/agent.ts
  - src/rmplan/executors/claude_code/agent_generator.test.ts
  - src/rmplan/executors/claude_code/agent_generator.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/copy_only.ts
  - src/rmplan/executors/copy_paste.ts
  - src/rmplan/executors/one-call.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/prompt_builder.test.ts
  - src/rmplan/rmplan.ts
  - src/rmpr/main.ts
rmfilter:
  - src/rmplan/executors/claude_code
  - --
  - src/rmplan/commands/agent.ts
  - --with-imports
---

Building on the core functionality from Phase 1, this phase introduces a robust cleanup system. We will create a central registry for cleanup tasks. A global SIGINT handler will be added to the application's entry point, which will execute all registered tasks upon receiving an interrupt signal. The Claude Code executor will be updated to register its agent-file cleanup task at the start of its run and unregister it upon normal completion.
