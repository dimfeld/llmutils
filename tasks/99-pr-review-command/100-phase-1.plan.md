---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Core Review Command Implementation
goal: Implement the basic review command that can analyze a single plan against
  current branch changes
id: 100
status: in_progress
priority: high
dependencies:
  - 103
parent: 99
planGeneratedAt: 2025-08-13T20:34:32.142Z
promptsGeneratedAt: 2025-08-13T20:40:39.944Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-08-13T23:54:11.755Z
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
    files:
      - /src/rmplan/commands/review.ts
      - /src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Create a test file review.test.ts that sets up basic test structure
          for the review command handler. Include tests for plan resolution by
          file path and by ID, and stub tests for diff generation and prompt
          building that will be filled in as those features are implemented.
        done: true
      - prompt: >
          Create review.ts with the handleReviewCommand function that accepts
          planFile, options, and command parameters. Implement configuration
          loading using loadEffectiveConfig, and plan file resolution using
          resolvePlanFile to support both file paths and numeric plan IDs.
        done: true
      - prompt: >
          Add plan loading logic to read the plan file and extract key
          information including title, goal, details, tasks, and requirements.
          Store this information in a structured format that will be used for
          prompt generation later.
        done: true
      - prompt: >
          Add validation to ensure the provided plan exists and has valid
          content. Include appropriate error messages for missing plans or
          invalid plan formats.
        done: true
  - title: Register review command in CLI
    done: true
    description: >
      Update /src/rmplan/rmplan.ts to register the new review command with
      appropriate options including plan argument, executor selection, model
      selection, and execution mode (direct vs clipboard). The command should
      follow the established pattern of other rmplan commands, using dynamic
      imports for the handler and supporting standard CLI options. Include help
      text that clearly explains the command's purpose and available options.
    files:
      - /src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add the review command registration after the other command
          definitions in rmplan.ts. Use program.command('review <planFile>')
          with a description explaining it analyzes code changes against plan
          requirements.
        done: true
      - prompt: >
          Add standard options to the review command including --executor for
          executor selection, --model for model override, --direct for direct
          execution mode, and --dry-run for testing without execution. Include
          appropriate help text for each option.
        done: true
      - prompt: >
          Implement the action handler that dynamically imports
          handleReviewCommand from './commands/review.js' and calls it with the
          provided arguments, following the error handling pattern used by other
          commands.
        done: true
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
    files:
      - /src/rmplan/commands/review.ts
      - /src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Create a generateDiffForReview function that uses getGitRoot and
          getTrunkBranch from git.ts to identify the repository root and trunk
          branch. The function should return both the list of changed files and
          the full diff content.
        done: true
      - prompt: >
          Implement diff generation using Bun's $ utility to execute either 'git
          diff' or 'jj diff' commands based on getUsingJj(). Generate a unified
          diff format comparing the current branch to trunk, excluding common
          lock files and temporary files.
        done: true
      - prompt: >
          Add error handling for cases where diff generation fails, such as when
          not in a git repository or when the trunk branch cannot be determined.
          Provide helpful error messages for troubleshooting.
        done: true
      - prompt: >
          Write tests for the diff generation logic that verify correct trunk
          branch detection, proper diff command execution for both Git and jj,
          and appropriate error handling for edge cases.
        done: true
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
    files:
      - /src/rmplan/commands/review.ts
      - /src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Create a buildReviewPrompt function that takes the plan data and diff
          content as parameters. Structure the prompt with clear sections for
          plan context, requirements, and code changes to review.
        done: true
      - prompt: >
          Import and use getReviewerPrompt from agent_prompts.ts to get the
          reviewer agent definition. Combine the plan's goal, details, and task
          descriptions into a context section that the reviewer agent prompt
          expects.
        done: true
      - prompt: >
          Format the diff content appropriately within the prompt, ensuring it's
          clearly marked as the code changes to review. Include both the file
          list and the actual diff, with proper markdown formatting for
          readability.
        done: true
      - prompt: >
          Add tests for prompt generation that verify the prompt includes all
          necessary plan context, properly formats the diff content, and follows
          the expected structure for the reviewer agent.
        done: true
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
    files:
      - /src/rmplan/commands/review.ts
      - /src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Import buildExecutorAndLog and DEFAULT_EXECUTOR from the executors
          module. Determine the executor to use from options, falling back to
          config.defaultExecutor or DEFAULT_EXECUTOR.
        done: true
      - prompt: >
          Create the executor instance using buildExecutorAndLog with
          appropriate shared options including model, direct mode, and dry-run
          settings. Configure the executor to use the reviewer agent type.
        done: true
      - prompt: >
          Call executor.execute() with the generated review prompt and metadata
          including plan ID and title. Handle the execution result and provide
          appropriate user feedback about the review completion.
        done: true
      - prompt: >
          Add integration tests that verify the executor is properly initialized
          with reviewer configuration, the review prompt is passed correctly to
          the executor, and different executor types are supported.
        done: true
---

Create the foundational review command that accepts a plan file/ID, generates a diff of the current branch against trunk, and executes a review using the reviewer agent. This phase establishes the core functionality and command structure that will be extended in later phases.

Acceptance criteria:
- `rmplan review <plan>` command works with single plan
- Correctly identifies and diffs against trunk branch (main/master)
- Generates review prompt with plan context and code changes
- Executes review using selected executor
- Supports standard CLI options (--executor, --model, --direct)
- Handles both file paths and plan IDs
