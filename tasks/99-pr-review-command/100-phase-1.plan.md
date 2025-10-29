---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Core Review Command Implementation
goal: Implement the basic review command that can analyze a single plan against
  current branch changes
id: 100
uuid: e1866184-0459-4ba2-b92d-1d37dcaf8655
status: done
priority: high
dependencies:
  - 103
parent: 99
references:
  "99": b9ee92f5-e5b6-4035-9125-166c3b438180
  "103": be6ddfa8-5616-4026-8096-a2425cbace4f
planGeneratedAt: 2025-08-13T20:34:32.142Z
promptsGeneratedAt: 2025-08-13T20:40:39.944Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-10-27T08:39:04.296Z
project:
  title: Add PR review command to rmplan for comprehensive code review against
    plan requirements
  goal: Implement a new `rmplan review` command that analyzes code changes on the
    current branch against trunk, evaluates compliance with plan requirements,
    and provides comprehensive code quality feedback using the reviewer agent.
  details: >-
    The review command will compare the current branch to the trunk branch,
    gather all relevant plan context (including parent and completed children),
    and execute a thorough code review using the existing reviewer agent prompt.
    The command should support reviewing multiple plans simultaneously, handle
    parent-child relationships intelligently, and integrate seamlessly with the
    existing executor system. The review should focus on both general code
    quality (bugs, security, performance) and specific compliance with the
    plan's requirements and goals.


    Acceptance criteria:

    - Command can review single or multiple plans

    - Automatically includes parent context when reviewing child plans

    - Includes completed children when reviewing parent plans

    - Generates comprehensive diff against trunk branch

    - Works with both Git and jj version control systems

    - Supports all existing executors (Claude Code, copy-paste, etc.)

    - Provides clear feedback on code quality and requirement compliance
tasks:
  - title: Create review command handler
    done: true
    description: >
      Create /src/rmplan/commands/review.ts with the main command handler
      function that loads configuration, resolves the plan file, and
      orchestrates the review process. Follow the pattern established by other
      command handlers like show.ts and agent.ts, including proper error
      handling and option parsing. The handler should support resolving plans by
      both file path and plan ID, load the plan details, and prepare for diff
      generation and review execution.
  - title: Register review command in CLI
    done: true
    description: >
      Update /src/rmplan/rmplan.ts to register the new review command with
      appropriate options including plan argument, executor selection, model
      selection, and execution mode (direct vs clipboard). The command should
      follow the established pattern of other rmplan commands, using dynamic
      imports for the handler and supporting standard CLI options. Include help
      text that clearly explains the command's purpose and available options.
  - title: Implement diff generation logic
    done: true
    description: >
      Add functions to generate a comprehensive diff of the current branch
      against trunk, leveraging existing getChangedFilesOnBranch() and Git/jj
      utilities from /src/common/git.ts. The implementation should support both
      Git and jj version control systems, identify the trunk branch
      (main/master), generate both a list of changed files and the actual diff
      content, and format the output appropriately for inclusion in the review
      prompt.
  - title: Build review prompt generator
    done: true
    description: >
      Create a function to construct the review prompt combining plan details
      (goal, tasks, requirements) with the generated diff, formatting it
      appropriately for the reviewer agent prompt template. The prompt should
      provide clear context about what the plan intended to accomplish, what
      code changes were made, and instruct the reviewer to evaluate both code
      quality and requirement compliance. Use the existing reviewer agent prompt
      structure from agent_prompts.ts as the foundation.
  - title: Integrate with executor system
    done: true
    description: >
      Connect the review command to the existing executor infrastructure,
      ensuring it can use any configured executor (Claude Code, copy-paste,
      etc.) and properly passes the reviewer agent configuration. Use
      buildExecutorAndLog to create the executor instance with appropriate
      options, configure it for reviewer agent mode, and execute the review
      prompt. Support all standard executor options including model selection
      and execution mode.
---

Create the foundational review command that accepts a plan file/ID, generates a diff of the current branch against trunk, and executes a review using the reviewer agent. This phase establishes the core functionality and command structure that will be extended in later phases.

Acceptance criteria:
- `rmplan review <plan>` command works with single plan
- Correctly identifies and diffs against trunk branch (main/master)
- Generates review prompt with plan context and code changes
- Executes review using selected executor
- Supports standard CLI options (--executor, --model, --direct)
- Handles both file paths and plan IDs
