---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Renumber should account for parent/child relationships when only parent
  is being renumbered
goal: To update the `renumber` command to correctly order plan IDs based on
  parent-child hierarchies and sibling dependencies.
id: 113
status: pending
priority: medium
dependencies: []
planGeneratedAt: 2025-08-29T03:04:35.841Z
promptsGeneratedAt: 2025-08-29T03:08:33.186Z
createdAt: 2025-08-19T19:45:01.416Z
updatedAt: 2025-08-29T03:08:33.187Z
tasks:
  - title: Build a Representation of Plan Relationships
    done: false
    description: >
      Create data structures to model the hierarchy of all plans. After reading
      all plan files, iterate through them to build a graph or tree that links
      plans based on their `parent` and `dependencies` fields. This structure
      will be essential for traversing plan families and identifying ordering
      issues. The implementation should build on the existing plan loading logic
      in `readAllPlans` and create efficient data structures for parent-child
      and sibling relationship traversal.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create TypeScript interfaces to represent the plan relationship graph.
          Define interfaces for parent-child mappings, sibling groups, and plan
          hierarchy nodes that will be used throughout the renumbering process.
        done: false
      - prompt: >
          Implement a function `buildPlanRelationshipGraph` that takes the
          loaded plans map and constructs bidirectional parent-child mappings.
          Create a map from parent ID to children IDs and from child ID to
          parent ID for efficient traversal.
        done: false
      - prompt: >
          Add a function `getAllDescendants` that recursively collects all
          descendants (children, grandchildren, etc.) of a given plan ID. This
          will be essential for cascading renumbering operations.
        done: false
      - prompt: >
          Create a function `getSiblingGroup` that returns all sibling plans
          (plans with the same parent) for a given plan ID. Include plans with
          no parent as a special sibling group for root-level plans.
        done: false
  - title: Identify and Flag All Plans Requiring Renumbering
    done: false
    description: >
      Extend the logic for identifying plans to be renumbered. In addition to
      the existing ID conflict detection, implement a new check that iterates
      through all parent-child relationships and flags any plan where the
      parent's ID is greater than or equal to its child's ID. This should
      integrate with the existing `plansToRenumber` array and `PlanToRenumber`
      interface, adding a new reason type for hierarchy violations.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Extend the `PlanToRenumber` interface to include a new reason type
          'hierarchy_violation' in addition to the existing 'missing' and
          'conflict' reasons.
        done: false
      - prompt: >
          Implement a function `detectHierarchyViolations` that iterates through
          all parent-child relationships and identifies cases where `parent.id
          >= child.id`. Return an array of plans that need renumbering due to
          hierarchy violations.
        done: false
      - prompt: >
          Integrate the hierarchy violation detection into the main
          `handleRenumber` function after the existing conflict detection logic.
          Add violations to the `plansToRenumber` array, ensuring no duplicates
          are added for plans already marked for other reasons.
        done: false
  - title: Implement Cascading Renumbering for Descendants
    done: false
    description: >
      Modify the renumbering process so that when a parent plan is marked for
      renumbering (for any reason), all of its children, grandchildren, and
      other descendants are also automatically added to the set of plans to be
      renumbered. This ensures that entire sub-trees are updated cohesively and
      maintains proper parent-child ID ordering throughout the hierarchy.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a function `markDescendantsForRenumbering` that takes a plan ID
          and adds all its descendants to the renumbering set. Use the
          `getAllDescendants` function from Task 1 and ensure proper reason
          tracking.
        done: false
      - prompt: >
          Modify the conflict resolution logic to cascade renumbering when a
          parent is marked. After identifying all initial renumbering
          candidates, iterate through them and mark their descendants for
          renumbering as well.
        done: false
      - prompt: >
          Add logic to prevent duplicate entries in `plansToRenumber` when
          cascading renumbering. Ensure that plans already marked for
          renumbering maintain their original reason but are updated if they
          need renumbering for multiple reasons.
        done: false
  - title: Topologically Sort Sibling Plans by Dependency
    done: false
    description: >
      Implement a topological sort algorithm to order sibling plans (children of
      the same parent) based on their `dependencies`. This sorted order will be
      used to assign new IDs, ensuring that a plan's ID is always higher than
      the IDs of the siblings it depends on. Build on the existing
      `collectDependenciesInOrder` function pattern from `plans.ts` but adapt it
      for sibling group sorting.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a function `topologicallySortSiblings` that takes a group of
          sibling plans and sorts them based on their interdependencies. Use a
          topological sort algorithm similar to the existing
          `collectDependenciesInOrder` but adapted for sibling groups.
        done: false
      - prompt: >
          Implement cycle detection within sibling dependency graphs. If
          circular dependencies are found within a sibling group, throw a
          descriptive error indicating which plans are involved in the cycle.
        done: false
      - prompt: >
          Create a function `orderPlansForRenumbering` that groups plans to be
          renumbered by their parent and applies topological sorting to each
          sibling group. This will produce the final ordering for ID assignment.
        done: false
  - title: Refactor ID Assignment to Respect Hierarchy and Dependencies
    done: false
    description: >
      Update the ID assignment logic to process plans in a specific order. The
      new process should assign IDs to parents before their children and to
      sibling plans according to their topologically sorted order. This will
      guarantee that the final ID sequence is logical and correct. The
      implementation should integrate with the existing ID assignment logic
      while preserving all current functionality including reference updates.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Replace the existing simple sorting logic (lines 287-309) with a call
          to the new `orderPlansForRenumbering` function to ensure plans are
          processed in hierarchical and dependency-respecting order.
        done: false
      - prompt: >
          Modify the ID assignment loop (lines 314-327) to work with the new
          hierarchically-ordered plan list. Ensure that sequential ID assignment
          still works correctly while respecting the parent-before-child
          ordering.
        done: false
      - prompt: >
          Update the dependency and parent reference updating logic (lines
          335-409) to handle the more complex renumbering scenarios. Ensure that
          all references are correctly updated when entire hierarchies are
          renumbered.
        done: false
      - prompt: >
          Test the complete renumbering flow by adding debug logging to verify
          that parents receive lower IDs than children and that sibling
          dependencies are respected in the final ID assignments.
        done: false
  - title: Add Comprehensive Tests for New Renumbering Scenarios
    done: false
    description: >
      Create new unit tests to validate the enhanced renumbering logic. These
      tests should cover scenarios such as a parent with a higher ID than its
      child, a parent being renumbered due to a conflict, sibling plans with
      inter-dependencies, and complex multi-level hierarchies. Include tests for
      the `--dry-run` option as well. Follow the existing test patterns in the
      file, using temporary filesystem operations and the established mocking
      patterns.
    files:
      - src/rmplan/commands/renumber.test.ts
    steps:
      - prompt: >
          Add a test case for the basic parent-child hierarchy violation
          scenario where a parent has a higher ID than its child. Verify that
          both parent and child are renumbered to maintain proper ordering.
        done: false
      - prompt: >
          Create a test for cascading renumbering when a parent is involved in
          an ID conflict. Ensure that all descendants are renumbered even when
          they don't have conflicts themselves.
        done: false
      - prompt: >
          Add a test for sibling dependency ordering where multiple children of
          the same parent have interdependencies. Verify that the final ID
          assignment respects the dependency graph within the sibling group.
        done: false
      - prompt: >
          Create a complex multi-level hierarchy test with grandparents,
          parents, children, and various dependency relationships. Test both
          conflict-based and hierarchy-violation-based renumbering scenarios.
        done: false
      - prompt: >
          Add tests for the dry-run functionality with the new hierarchy
          scenarios. Verify that dry-run correctly reports all proposed changes
          without making any file modifications.
        done: false
      - prompt: >
          Create edge case tests including empty hierarchies, single-child
          families, and plans with complex dependency chains across different
          parent groups.
        done: false
rmfilter:
  - src/rmplan/commands/renumber.ts
  - --with-imports
---

# Original Plan Details

If we have a case where the parent plan conflicts but not all the children, the parent plan will end up with an ID
higher than the children. Ideally, we should detect this and renumber the parent's children as well to make sure that
the parent retains a smaller ID than its children. 

Overall, we want:
- A parent has a lower plan ID than any of its children
- The children plan IDs are sorted in dependency order

The renumber command should check for this and renumber even when there are no conflicts.

# Processed Plan Details

### Analysis
The current `renumber` command primarily focuses on resolving duplicate plan IDs. This project will extend its functionality to enforce structural integrity based on parent-child relationships defined in the plan files. The command will be updated to proactively check for and correct any instances where a parent plan has an ID that is greater than or equal to one of its children's IDs.

The implementation will involve building a graph or tree of all plans to understand their hierarchy and dependencies. When a parent plan is renumbered—either due to a conflict or an ordering violation—all of its descendants will also be renumbered to maintain a consistent and logical ID sequence. Furthermore, sibling plans will be sorted based on their dependencies before new IDs are assigned, ensuring that a plan's ID is always greater than the IDs of its dependencies within the same family.

### Acceptance Criteria
- Running `rmplan renumber` on a set of plans where a parent has a higher ID than a child will result in the parent and all its descendants being renumbered so that `parent.id < child.id`.
- If a parent plan is renumbered due to an ID conflict, all of its descendants (children, grandchildren, etc.) are also renumbered to ensure their new IDs are greater than the parent's new ID.
- When a group of sibling plans is renumbered, their new IDs are assigned in an order that respects their inter-dependencies (i.e., if plan B depends on plan A, `new_id(A) < new_id(B)`).
- The command functions correctly and enforces ordering even when there are no initial ID conflicts.
- All `parent` and `dependencies` fields in all affected plans are correctly updated to reflect the new IDs.
- The `--dry-run` option correctly reports all proposed changes without modifying any files.

### Technical Considerations and Approach
1.  **Graph Construction**: After loading all plans, construct an in-memory graph or tree that represents both parent-child relationships (from the `parent` field) and dependency relationships (from the `dependencies` field).
2.  **Identifying Renumber Candidates**: The set of plans to be renumbered will be determined by two conditions: (a) existing ID conflicts, and (b) parent-child ID ordering violations (`parent.id >= child.id`).
3.  **Cascading Renumber**: Once a plan is marked for renumbering, all of its descendants in the hierarchy must also be added to the renumbering set to ensure the entire sub-tree is updated correctly.
4.  **Topological Sorting**: Before assigning new IDs to a group of sibling plans, they must be topologically sorted based on their dependencies to determine the correct assignment order.
5.  **ID Assignment**: A new, ordered list of all plans to be renumbered will be created. New IDs will be assigned sequentially, starting from the current maximum plan ID, respecting the parent-before-child and dependency-sorted order.
6.  **Updating References**: After all new IDs are assigned, a final pass over all plans (including those not renumbered) is required to update any `parent` or `dependencies` fields that point to a renumbered plan.

### Constraints or Assumptions
- The project assumes that parent-child relationships and dependency graphs are acyclic. The logic will not handle circular references.
- Plan files are assumed to be well-formed and adhere to the `PlanSchema`.

This phase will deliver the complete functionality for the enhanced renumbering logic. We will modify the existing command to build a model of plan relationships, identify any ordering violations, and perform a comprehensive renumbering of affected plans and their descendants. The final implementation will ensure that all parent plans have lower IDs than their children and that sibling plans are ordered by their dependencies.
