---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: PR review command - Parent-Child Plan Integration
goal: Enhance the review command to intelligently handle plan hierarchies and
  multiple plan reviews
id: 101
uuid: d013e254-0f7c-47c4-b5e2-ed5fc613be1e
status: done
priority: medium
dependencies:
  - 100
parent: 99
references:
  "99": b9ee92f5-e5b6-4035-9125-166c3b438180
  "100": e1866184-0459-4ba2-b92d-1d37dcaf8655
planGeneratedAt: 2025-08-13T20:34:32.142Z
promptsGeneratedAt: 2025-08-13T21:14:17.043Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-10-27T08:39:04.300Z
project:
  title: Add PR review command to tim for comprehensive code review against
    plan requirements
  goal: Implement a new `tim review` command that analyzes code changes on the
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
    done: true
    description: >
      Add logic to detect when a plan has a parent and automatically include the
      parent's goal and high-level details in the review context, providing
      reviewers with understanding of the broader project scope. This involves
      modifying the handleReviewCommand to load parent plan data when
      planData.parent exists, and updating buildReviewPrompt to accept and
      format parent context appropriately. Follow the pattern used in
      src/tim/commands/agent/parent_plans.ts for loading parent plans.
  - title: Add completed children aggregation
    done: true
    description: >
      Implement functionality to find all completed child plans when reviewing a
      parent, aggregating their requirements and changes to ensure the parent's
      goals are fully met. This follows the pattern from
      src/tim/commands/agent/parent_plans.ts and
      src/tim/plans/mark_done.ts where children are found using
      Array.from(plans.values()).filter(plan => plan.parent === parentId). The
      aggregated children information should include their titles, goals, and
      changed files to provide complete context for reviewing the parent plan's
      implementation.
  - title: Support multiple plan arguments
    done: true
    description: >
      Extend the command to accept multiple plan files/IDs as arguments,
      gathering context for all specified plans and their relationships while
      avoiding duplication. This follows the pattern from
      src/tim/commands/merge.ts which handles multiple child plans. The
      command signature needs to change from <planFile> to <planFiles...> and
      the implementation must deduplicate plans to avoid including the same plan
      multiple times when hierarchies overlap.
  - title: Create hierarchy traversal utilities
    done: true
    description: >
      Build helper functions to traverse plan hierarchies efficiently, handling
      cycles, missing references, and deep nesting while maintaining performance
      with caching. These utilities will be used across the review command and
      potentially other commands. The utilities should follow patterns from
      existing plan traversal code but provide a centralized, well-tested
      implementation. Include functions like getParentChain (gets all
      ancestors), getAllChildren (gets all descendants), and
      getCompletedChildren (filters for done status).
  - title: Optimize prompt structure for complex reviews
    done: true
    description: >
      Design and implement an optimized prompt structure that clearly presents
      multi-plan reviews with hierarchical relationships without overwhelming
      the LLM or exceeding token limits. This includes structuring sections for
      clarity, implementing token counting to prevent exceeding limits, and
      organizing the prompt to avoid redundant information when reviewing
      related plans. The structure should make it clear which requirements apply
      to which code changes.
---

Extend the review command to automatically include relevant context from parent plans and completed children. When reviewing a child plan, include the parent's goals for context. When reviewing a parent, include all completed children to ensure comprehensive requirement coverage. Support reviewing multiple plans in a single command.

Acceptance criteria:
- Automatically includes parent plan context when reviewing children
- Includes completed children when reviewing parent plans
- Supports multiple plan arguments: `tim review plan1 plan2 plan3`
- Handles deep hierarchies (grandparents, grandchildren)
- Maintains clear structure in review prompt despite complex relationships
- Properly aggregates requirements across all included plans
