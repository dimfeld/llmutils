---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
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
references:
  "77": 1e3610fe-6687-497c-b5d3-44696fa3d5ef
  "78": e7a5e371-9586-4e94-8eca-c4f2e1b2a218
planGeneratedAt: 2025-07-29T19:14:39.578Z
promptsGeneratedAt: 2025-07-29T20:38:48.963Z
createdAt: 2025-07-29T19:06:12.623Z
updatedAt: 2025-10-27T08:39:04.317Z
tasks:
  - title: Create a Centralized Cleanup Handler Registry
    done: true
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
  - title: Implement a Global SIGINT Handler
    done: true
    description: >
      At the application's main entry point in src/tim/tim.ts,
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
  - title: Integrate the Executor with the Cleanup Registry
    done: true
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
changedFiles:
  - src/common/cleanup_registry.test.ts
  - src/common/cleanup_registry.ts
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
  - src/tim/tim.ts
  - src/rmpr/main.ts
rmfilter:
  - src/tim/executors/claude_code
  - --
  - src/tim/commands/agent.ts
  - --with-imports
---

Building on the core functionality from Phase 1, this phase introduces a robust cleanup system. We will create a central registry for cleanup tasks. A global SIGINT handler will be added to the application's entry point, which will execute all registered tasks upon receiving an interrupt signal. The Claude Code executor will be updated to register its agent-file cleanup task at the start of its run and unregister it upon normal completion.
