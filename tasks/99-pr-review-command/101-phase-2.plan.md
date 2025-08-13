---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR review command - Parent-Child Plan Integration
goal: Enhance the review command to intelligently handle plan hierarchies and
  multiple plan reviews
id: 101
status: in_progress
priority: medium
dependencies:
  - 100
parent: 99
planGeneratedAt: 2025-08-13T20:34:32.142Z
promptsGeneratedAt: 2025-08-13T21:14:17.043Z
createdAt: 2025-08-13T20:28:04.715Z
updatedAt: 2025-08-13T21:14:17.484Z
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
    description: >
      Add logic to detect when a plan has a parent and automatically include the
      parent's goal and high-level details in the review context, providing
      reviewers with understanding of the broader project scope. This involves
      modifying the handleReviewCommand to load parent plan data when
      planData.parent exists, and updating buildReviewPrompt to accept and
      format parent context appropriately. Follow the pattern used in
      src/rmplan/commands/agent/parent_plans.ts for loading parent plans.
    files:
      - src/rmplan/commands/review.ts
      - src/rmplan/commands/review.test.ts
    done: true
    steps:
      - prompt: >
          Add tests in review.test.ts for parent context inclusion. Create test
          cases that verify:

          1) When a plan has a parent, the parent's goal and details are
          included in the review prompt

          2) When a plan has no parent, the review prompt works as before

          3) When a parent plan reference is invalid/missing, the review
          continues without parent context
        done: true
      - prompt: >
          Modify handleReviewCommand in review.ts to check if planData.parent
          exists after loading the plan.

          If it does, use readPlanFile to load the parent plan and pass it to
          buildReviewPrompt as an optional parameter.

          Handle the case where the parent plan cannot be found by logging a
          warning and continuing without parent context.
        done: true
      - prompt: >
          Update the buildReviewPrompt function signature to accept an optional
          parentPlan parameter.

          When parentPlan is provided, add a new "Parent Plan Context" section
          before the main plan context that includes

          the parent's ID, title, goal, and a brief note that this review is for
          a child plan implementing part of the parent.
        done: true
  - title: Add completed children aggregation
    description: >
      Implement functionality to find all completed child plans when reviewing a
      parent, aggregating their requirements and changes to ensure the parent's
      goals are fully met. This follows the pattern from
      src/rmplan/commands/agent/parent_plans.ts and
      src/rmplan/plans/mark_done.ts where children are found using
      Array.from(plans.values()).filter(plan => plan.parent === parentId). The
      aggregated children information should include their titles, goals, and
      changed files to provide complete context for reviewing the parent plan's
      implementation.
    files:
      - src/rmplan/commands/review.ts
      - src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Add tests in review.test.ts for completed children aggregation:

          1) Test that when reviewing a parent plan, all completed children are
          included in the context

          2) Test that pending/in_progress children are excluded

          3) Test that the aggregated changed files from children are included

          4) Test that plans without children work normally
        done: true
      - prompt: >
          In handleReviewCommand, after loading the main plan, use readAllPlans
          to get all plans.

          Filter for children where plan.parent === planData.id and plan.status
          === 'done'.

          Pass the array of completed children to buildReviewPrompt as a new
          optional parameter.
        done: true
      - prompt: >
          Update buildReviewPrompt to accept an optional completedChildren
          parameter.

          When provided, add a "Completed Child Plans" section that lists each
          child's ID, title, goal,

          and changed files. This helps reviewers understand what parts of the
          parent have already been implemented.
        done: true
  - title: Support multiple plan arguments
    description: >
      Extend the command to accept multiple plan files/IDs as arguments,
      gathering context for all specified plans and their relationships while
      avoiding duplication. This follows the pattern from
      src/rmplan/commands/merge.ts which handles multiple child plans. The
      command signature needs to change from <planFile> to <planFiles...> and
      the implementation must deduplicate plans to avoid including the same plan
      multiple times when hierarchies overlap.
    files:
      - src/rmplan/rmplan.ts
      - src/rmplan/commands/review.ts
      - src/rmplan/commands/review.test.ts
    steps:
      - prompt: >
          Update the review command definition in rmplan.ts to change the
          argument from '<planFile>' to '<planFiles...>'.

          This allows the command to accept multiple plan arguments like: rmplan
          review plan1.yml plan2.yml 123
        done: true
      - prompt: |
          Add tests in review.test.ts for multiple plan handling:
          1) Test reviewing multiple independent plans
          2) Test deduplication when a plan and its parent are both specified
          3) Test that changed files are aggregated across all plans
          4) Test error handling when one of multiple plans cannot be found
        done: true
      - prompt: >
          Refactor handleReviewCommand to accept and process an array of plan
          files/IDs.

          Use a Set to track already-processed plan IDs to avoid duplication.

          For each plan, resolve it using resolvePlanFile, load it with
          readPlanFile, and collect all unique plans.

          Aggregate all plans' information and pass them to a modified
          buildReviewPrompt.
        done: true
      - prompt: >
          Update buildReviewPrompt to accept an array of plans instead of a
          single plan.

          Structure the output to clearly separate each plan's context while
          avoiding duplication of

          parent/child relationships already covered. Generate a single unified
          diff for all plans.
        done: true
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
    files:
      - src/rmplan/utils/hierarchy.ts
      - src/rmplan/utils/hierarchy.test.ts
    steps:
      - prompt: >
          Create src/rmplan/utils/hierarchy.ts with a getParentChain function
          that takes a plan and all plans map,

          returning an array of parent plans from immediate parent to root.
          Include cycle detection using a Set

          to track visited IDs and stop if a cycle is detected.
        done: true
      - prompt: >
          Add getAllChildren function that recursively finds all descendants of
          a plan.

          Use a Set for visited IDs to handle cycles and a queue/stack for
          traversal.

          Return results sorted by ID for consistent ordering.
        done: true
      - prompt: >
          Add getCompletedChildren function that wraps getAllChildren but
          filters for status === 'done'.

          Also add a getDirectChildren function that only returns immediate
          children (not recursive).
        done: true
      - prompt: |
          Create comprehensive tests in hierarchy.test.ts covering:
          1) Simple parent-child relationships
          2) Multi-level hierarchies (grandparents, great-grandparents)
          3) Cycle detection and handling
          4) Missing parent references
          5) Plans with multiple children
          6) Filtering by status
        done: true
      - prompt: >
          Update review.ts to use the new hierarchy utilities instead of inline
          filtering.

          Replace the manual parent loading with getParentChain and children
          filtering with getCompletedChildren.
        done: true
  - title: Optimize prompt structure for complex reviews
    description: >
      Design and implement an optimized prompt structure that clearly presents
      multi-plan reviews with hierarchical relationships without overwhelming
      the LLM or exceeding token limits. This includes structuring sections for
      clarity, implementing token counting to prevent exceeding limits, and
      organizing the prompt to avoid redundant information when reviewing
      related plans. The structure should make it clear which requirements apply
      to which code changes.
    files:
      - src/rmplan/commands/review.ts
      - src/rmplan/commands/review.test.ts
      - src/rmplan/utils/prompt_optimizer.ts
      - src/rmplan/utils/prompt_optimizer.test.ts
    steps:
      - prompt: >
          Create src/rmplan/utils/prompt_optimizer.ts with a function to
          estimate token count for a string.

          Use a simple heuristic (e.g., ~4 characters per token) or integrate a
          proper tokenizer if available.

          Add a function to truncate content intelligently when approaching
          token limits.
        done: true
      - prompt: >
          Add a structureHierarchicalContext function that takes plans with
          their relationships and

          organizes them into clear sections: "Primary Plans", "Parent Context",
          "Completed Sub-Plans".

          Ensure each plan's requirements are clearly associated with the code
          they should review.
        done: true
      - prompt: >
          Create tests in prompt_optimizer.test.ts for token counting, content
          truncation, and

          hierarchical structuring. Test with various sizes of content and
          deeply nested hierarchies.
        done: true
      - prompt: >
          Update buildReviewPrompt to use the prompt optimizer when dealing with
          multiple plans or

          complex hierarchies. Structure the prompt with clear headers and
          indentation to show relationships.

          Add a summary section at the top listing all plans being reviewed and
          their relationships.
        done: true
      - prompt: >
          Add tests in review.test.ts verifying that large reviews are properly
          truncated, that the

          prompt structure is clear and readable, and that all essential
          information is preserved even

          when content is truncated. Test with mock plans that would exceed
          token limits.
        done: true
---

Extend the review command to automatically include relevant context from parent plans and completed children. When reviewing a child plan, include the parent's goals for context. When reviewing a parent, include all completed children to ensure comprehensive requirement coverage. Support reviewing multiple plans in a single command.

Acceptance criteria:
- Automatically includes parent plan context when reviewing children
- Includes completed children when reviewing parent plans
- Supports multiple plan arguments: `rmplan review plan1 plan2 plan3`
- Handles deep hierarchies (grandparents, grandchildren)
- Maintains clear structure in review prompt despite complex relationships
- Properly aggregates requirements across all included plans
