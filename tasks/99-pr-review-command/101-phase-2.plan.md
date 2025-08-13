---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Parent-Child Plan Integration
goal: Enhance the review command to intelligently handle plan hierarchies and
  multiple plan reviews
id: 101
status: pending
priority: medium
dependencies:
  - 100
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
  - title: Implement parent plan context gathering
    description: Add logic to detect when a plan has a parent and automatically
      include the parent's goal and high-level details in the review context,
      providing reviewers with understanding of the broader project scope.
    steps: []
  - title: Add completed children aggregation
    description: Implement functionality to find all completed child plans when
      reviewing a parent, aggregating their requirements and changes to ensure
      the parent's goals are fully met.
    steps: []
  - title: Support multiple plan arguments
    description: Extend the command to accept multiple plan files/IDs as arguments,
      gathering context for all specified plans and their relationships while
      avoiding duplication.
    steps: []
  - title: Create hierarchy traversal utilities
    description: Build helper functions to traverse plan hierarchies efficiently,
      handling cycles, missing references, and deep nesting while maintaining
      performance with caching.
    steps: []
  - title: Optimize prompt structure for complex reviews
    description: Design and implement an optimized prompt structure that clearly
      presents multi-plan reviews with hierarchical relationships without
      overwhelming the LLM or exceeding token limits.
    steps: []
---

Extend the review command to automatically include relevant context from parent plans and completed children. When reviewing a child plan, include the parent's goals for context. When reviewing a parent, include all completed children to ensure comprehensive requirement coverage. Support reviewing multiple plans in a single command.

Acceptance criteria:
- Automatically includes parent plan context when reviewing children
- Includes completed children when reviewing parent plans
- Supports multiple plan arguments: `rmplan review plan1 plan2 plan3`
- Handles deep hierarchies (grandparents, grandchildren)
- Maintains clear structure in review prompt despite complex relationships
- Properly aggregates requirements across all included plans
