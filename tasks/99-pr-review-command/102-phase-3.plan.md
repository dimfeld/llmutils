---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Enhanced Review Features and Configuration
goal: Add advanced review capabilities including custom review criteria,
  configuration options, and improved output formatting
id: 102
status: pending
priority: low
dependencies:
  - 101
parent: 99
planGeneratedAt: 2025-08-13T20:34:32.142Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-08-13T20:34:32.142Z
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
    description: Extend the rmplan configuration schema to include review-specific
      settings such as default review focus areas, custom instructions, and
      output preferences.
    steps: []
  - title: Implement custom review instructions
    description: Add support for providing custom review criteria through CLI
      options or configuration, allowing teams to enforce specific standards or
      focus areas.
    steps: []
  - title: Create structured output formatting
    description: Develop formatted output options for review results, including
      markdown reports, JSON for tooling integration, and human-readable
      summaries with clear action items.
    steps: []
  - title: Add review result persistence
    description: Implement functionality to save review results to files, track
      review history, and potentially integrate with Git commits or PR comments.
    steps: []
  - title: Build incremental review support
    description: Create logic to detect and review only changes made since the last
      review, reducing redundancy and focusing on new modifications.
    steps: []
---

Implement additional features to make the review command more powerful and customizable. Add configuration options for review behavior, support for custom review instructions, and enhanced output formatting. Include options to focus reviews on specific aspects (security, performance, etc.) and to save review results.

Acceptance criteria:
- Config file supports review-specific settings
- Custom review instructions can be provided via CLI or config
- Review output can be saved to file
- Option to focus on specific review aspects
- Integration with PR/issue tracking systems for posting reviews
- Support for incremental reviews (only new changes since last review)
