---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Use subagents in Claude Code executor - Implement Robust Cleanup with a
  SIGINT Handler
goal: To make the agent file cleanup mechanism resilient to premature
  application termination by implementing a global SIGINT handler and a cleanup
  task registry.
id: 79
status: pending
priority: high
dependencies:
  - 78
parent: 77
planGeneratedAt: 2025-07-29T19:14:39.578Z
createdAt: 2025-07-29T19:06:12.623Z
updatedAt: 2025-07-29T19:14:39.578Z
tasks:
  - title: Create a Centralized Cleanup Handler Registry
    description: A module or class will be created to manage a list of cleanup
      functions. It will expose an interface to `register` a handler (which
      returns a corresponding `unregister` function) and a method to
      `executeAll` registered handlers.
    steps: []
  - title: Implement a Global SIGINT Handler
    description: At the application's main entry point, a process-level listener for
      the `SIGINT` signal will be established. When triggered, this handler will
      invoke the `executeAll` method from the cleanup registry to ensure all
      pending cleanup tasks are run before the process exits.
    steps: []
  - title: Integrate the Executor with the Cleanup Registry
    description: The Claude Code executor will be modified to interact with the new
      cleanup registry. On startup, it will register its agent-file cleanup
      function. The `unregister` function returned by the registry will be
      called in the `finally` block of the executor's `try...finally` structure,
      ensuring it's removed only on normal completion.
    steps: []
rmfilter:
  - src/rmplan/executors/claude_code
  - --
  - src/rmplan/commands/agent.ts
  - --with-imports
---

Building on the core functionality from Phase 1, this phase introduces a robust cleanup system. We will create a central registry for cleanup tasks. A global SIGINT handler will be added to the application's entry point, which will execute all registered tasks upon receiving an interrupt signal. The Claude Code executor will be updated to register its agent-file cleanup task at the start of its run and unregister it upon normal completion.
