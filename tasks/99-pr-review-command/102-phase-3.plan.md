---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Enhanced Review Features and Configuration
goal: Add advanced review capabilities including custom review criteria,
  configuration options, and improved output formatting
id: 102
status: in_progress
priority: low
dependencies:
  - 101
parent: 99
planGeneratedAt: 2025-08-13T20:34:32.142Z
promptsGeneratedAt: 2025-08-13T21:48:21.383Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-08-13T21:48:21.857Z
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
    files:
      - src/rmplan/configSchema.test.ts
      - src/rmplan/configSchema.ts
      - src/rmplan/commands/review.ts
    steps:
      - prompt: >
          Create tests in configSchema.test.ts for the new review configuration
          section. Test validation of focus areas array, output format enum
          values, and file path resolution for custom instructions and save
          locations.
        done: false
      - prompt: >
          Extend rmplanConfigSchema in configSchema.ts with a new 'review'
          section containing: focusAreas (array of strings), outputFormat (enum:
          json/markdown/terminal), saveLocation (string path),
          customInstructionsPath (string path), incrementalReview (boolean), and
          excludePatterns (array of glob patterns).
        done: false
      - prompt: >
          Update the review command handler to load and use the review
          configuration settings, falling back to sensible defaults when not
          specified. Pass configuration values to the appropriate functions.
        done: false
  - title: Implement custom review instructions
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
    files:
      - src/rmplan/commands/review.test.ts
      - src/rmplan/commands/review.ts
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add tests for custom review instructions in review.test.ts, including
          loading from file, CLI override behavior, and focus area filtering.
        done: false
      - prompt: >
          Add CLI options to the review command in rmplan.ts: --instructions for
          inline text, --instructions-file for file path, and --focus for
          comma-separated focus areas.
        done: false
      - prompt: >
          Update handleReviewCommand to load custom instructions from config or
          CLI, merge them appropriately, and pass them to buildReviewPrompt
          which should then pass them to getReviewerPrompt.
        done: false
  - title: Create structured output formatting
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
    files:
      - src/rmplan/formatters/review_formatter.test.ts
      - src/rmplan/formatters/review_formatter.ts
      - src/rmplan/commands/review.ts
    steps:
      - prompt: >
          Create review_formatter.test.ts with tests for parsing reviewer output
          into structured ReviewResult objects and formatting them as JSON,
          Markdown, and terminal output.
        done: false
      - prompt: >
          Implement review_formatter.ts with a ReviewResult interface containing
          severity levels, issue categories, and file locations. Create
          formatter classes for each output format with a common interface.
        done: false
      - prompt: >
          Parse the executor output to extract review findings, categorize them
          by severity (critical/major/minor), and format using chalk for
          terminal output with clear visual hierarchy.
        done: false
      - prompt: >
          Update the review command to use the formatter based on config or CLI
          option, displaying formatted output and optionally saving to file.
        done: false
  - title: Add review result persistence
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
    files:
      - src/rmplan/review_persistence.test.ts
      - src/rmplan/review_persistence.ts
      - src/rmplan/commands/review.ts
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Create review_persistence.test.ts with tests for saving review
          results, managing review history, and handling file I/O errors
          gracefully.
        done: false
      - prompt: >
          Implement review_persistence.ts with functions to save review results
          with metadata, maintain a history index file, and optionally create
          Git notes using git commands.
        done: false
      - prompt: >
          Add --save and --output-file CLI options to the review command in
          rmplan.ts for controlling result persistence.
        done: false
      - prompt: >
          Update the review command to save results using the persistence
          module, creating the reviews directory if needed and handling the save
          location from config or CLI.
        done: false
  - title: Build incremental review support
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
    files:
      - src/rmplan/incremental_review.test.ts
      - src/rmplan/incremental_review.ts
      - src/rmplan/commands/review.ts
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Create incremental_review.test.ts with tests for tracking last review
          points, detecting changes since last review, and handling both Git and
          jj repositories.
        done: false
      - prompt: >
          Implement incremental_review.ts with functions to store/retrieve last
          review metadata, calculate diff ranges, and filter files based on
          modification time.
        done: false
      - prompt: >
          Add --incremental, --since-last-review, and --since CLI options to the
          review command for controlling incremental review behavior.
        done: false
      - prompt: >
          Update generateDiffForReview in review.ts to support incremental diffs
          using stored metadata, showing only changes since the specified point.
        done: false
      - prompt: >
          Integrate incremental review tracking into the main review flow,
          automatically storing review points and providing clear feedback about
          what's being reviewed.
        done: false
---

Implement additional features to make the review command more powerful and customizable. Add configuration options for review behavior, support for custom review instructions, and enhanced output formatting. Include options to focus reviews on specific aspects (security, performance, etc.) and to save review results.

Acceptance criteria:
- Config file supports review-specific settings
- Custom review instructions can be provided via CLI or config
- Review output can be saved to file
- Option to focus on specific review aspects
- Integration with PR/issue tracking systems for posting reviews
- Support for incremental reviews (only new changes since last review)
