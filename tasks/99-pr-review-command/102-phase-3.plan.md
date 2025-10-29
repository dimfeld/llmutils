---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Enhanced Review Features and Configuration
goal: Add advanced review capabilities including custom review criteria,
  configuration options, and improved output formatting
id: 102
uuid: 275f1b0c-2bd6-4955-8d76-41503fa5a3ef
status: done
priority: low
dependencies:
  - 101
parent: 99
references:
  "99": b9ee92f5-e5b6-4035-9125-166c3b438180
  "101": d013e254-0f7c-47c4-b5e2-ed5fc613be1e
planGeneratedAt: 2025-08-13T20:34:32.142Z
promptsGeneratedAt: 2025-08-13T21:48:21.383Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-10-27T08:39:04.309Z
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
  - title: Add review configuration schema
    done: true
    description: >
      Extend the rmplan configuration schema to include review-specific settings
      such as default review focus areas, custom instructions, and output
      preferences. Following the existing pattern in configSchema.ts, add a new
      'review' section with Zod validation. The configuration should support:

      - Default focus areas (security, performance, testing, etc.)

      - Output format preferences (json, markdown, terminal)

      - Review result save location

      - Custom reviewer instructions path

      - Options for incremental review behavior

      Reference the existing 'agents' and 'planning' sections for patterns on
      how to structure nested configuration with file paths and boolean options.
  - title: Implement custom review instructions
    done: true
    description: >
      Add support for providing custom review criteria through CLI options or
      configuration, allowing teams to enforce specific standards or focus
      areas. Build on the existing customInstructions parameter in
      getReviewerPrompt. The implementation should:

      - Add --instructions and --instructions-file CLI options to the review
      command

      - Support loading instructions from the config file path

      - Merge CLI instructions with config instructions (CLI takes precedence)

      - Support focus area filtering (--focus security,performance)

      - Inject custom instructions into the reviewer agent prompt

      Use the existing pattern from agent_prompts.ts where custom instructions
      are inserted into the prompt template.
  - title: Create structured output formatting
    done: true
    description: >
      Develop formatted output options for review results, including markdown
      reports, JSON for tooling integration, and human-readable summaries with
      clear action items. Following patterns from display_utils.ts and the table
      formatting in list.ts:

      - Create a ReviewResult type to structure the review output

      - Implement formatters for JSON, Markdown, and terminal output

      - Parse reviewer agent output to extract issues by severity

      - Generate summary statistics and action items

      - Support configurable verbosity levels

      Use chalk for terminal colors and the table package for structured
      terminal output similar to list.ts.
  - title: Add review result persistence
    done: true
    description: >
      Implement functionality to save review results to files, track review
      history, and potentially integrate with Git commits or PR comments.
      Following the file I/O patterns from the codebase:

      - Save reviews to .rmfilter/reviews/ directory with timestamp-based naming

      - Store metadata including plan ID, commit hash, timestamp, and reviewer

      - Support appending reviews to a history file for tracking

      - Optionally create Git notes with review summaries

      - Add --save and --no-save CLI options

      Use the existing file writing patterns and consider integration with Git
      operations from git.ts.
  - title: Build incremental review support
    done: true
    description: >
      Create logic to detect and review only changes made since the last review,
      reducing redundancy and focusing on new modifications. Using the existing
      Git/jj integration from git.ts:

      - Track last review commit/timestamp in plan metadata or separate file

      - Generate diffs between last review point and current HEAD

      - Support --since-last-review and --since <commit> options

      - Filter unchanged files from the review scope

      - Show review delta summary (X new files, Y modified since last review)

      Build on getChangedFilesOnBranch and the diff generation logic already in
      review.ts.
---

Implement additional features to make the review command more powerful and customizable. Add configuration options for review behavior, support for custom review instructions, and enhanced output formatting. Include options to focus reviews on specific aspects (security, performance, etc.) and to save review results.

Acceptance criteria:
- Config file supports review-specific settings
- Custom review instructions can be provided via CLI or config
- Review output can be saved to file
- Option to focus on specific review aspects
- Integration with PR/issue tracking systems for posting reviews
- Support for incremental reviews (only new changes since last review)
