---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Renumber should account for parent/child relationships when only parent
  is being renumbered
goal: To update the `renumber` command to correctly order plan IDs based on
  parent-child hierarchies and sibling dependencies.
id: 113
status: in_progress
priority: high
dependencies: []
planGeneratedAt: 2025-08-29T05:11:32.894Z
promptsGeneratedAt: 2025-08-29T05:14:58.450Z
createdAt: 2025-08-19T19:45:01.416Z
updatedAt: 2025-08-29T05:14:58.866Z
tasks:
  - title: Build Plan Hierarchy Representation
    done: true
    description: >
      Create helper functions to process the full list of plans into a
      structured representation, such as a map of parent IDs to their child plan
      objects. This structure will facilitate efficient traversal of family
      trees. The functions should build maps that represent the parent-child
      relationships from the conflict-resolved plan data, similar to how the
      existing codebase handles dependencies in dependency_traversal.ts. These
      functions will be used by later tasks to identify and process plan
      families efficiently.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a helper function `buildParentChildHierarchy` that takes a Map
          of plans (the allPlans structure) and returns a Map where keys are
          parent plan IDs and values are arrays of child plan objects. This
          should iterate through all plans and group children under their parent
          IDs.
        done: true
      - prompt: >
          Create a helper function `findPlanFamily` that takes a plan ID and the
          parent-child hierarchy map and returns all plans in that family (the
          root parent and all its descendants). Use a breadth-first or
          depth-first traversal to collect the complete family tree starting
          from a given plan.
        done: true
      - prompt: >
          Create a helper function `findRootParent` that takes a plan ID and the
          allPlans map and traverses upward through parent relationships to find
          the topmost parent in the hierarchy. This will be used to identify
          family roots when processing disordered hierarchies.
        done: true
  - title: Identify Disordered Plan Families
    done: true
    description: >
      Implement logic to scan the complete plan hierarchy and identify any
      parent plan whose ID is greater than one of its children's IDs. This logic
      should collect the root parent of each disordered family to be processed.
      The function should work with the hierarchy representation built in the
      previous task and identify all families that need reordering, ensuring we
      process each family only once by working with root parents.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a function `findDisorderedFamilies` that scans all plans and
          identifies families where a parent has an ID greater than any of its
          children or descendants. The function should return a Set of root
          parent IDs representing families that need reordering.
        done: true
      - prompt: >
          Implement logic within `findDisorderedFamilies` to traverse each
          plan's complete family tree and check for ID ordering violations. When
          a violation is found, ensure we capture the root parent of the family
          rather than intermediate parents to avoid processing the same family
          multiple times.
        done: true
      - prompt: >
          Add validation to ensure that a plan isn't processed multiple times if
          it belongs to an already identified disordered family. This prevents
          duplicate processing when multiple branches of the same family tree
          have ordering issues.
        done: true
  - title: Implement Topological Sort for Plan Families
    done: true
    description: >
      Create a function that takes a family of plans (a parent and all its
      descendants) and returns a new list of those plans in a topologically
      sorted order. The sort must place the parent first, followed by the
      descendants ordered correctly based on their mutual dependencies. This
      should handle both the parent-child hierarchy constraint and any explicit
      dependencies between siblings within the family.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a function `topologicalSortFamily` that takes an array of
          family plans and returns them sorted in topological order. The
          function should ensure parents come before children and that sibling
          dependencies are respected using a topological sort algorithm.
        done: true
      - prompt: >
          Implement the core topological sort algorithm using Kahn's algorithm
          or similar approach. Build a dependency graph from both parent-child
          relationships and explicit dependency arrays, then perform the
          topological sort ensuring parents always precede their children.
        done: true
      - prompt: >
          Add cycle detection to the topological sort to handle any circular
          dependencies within a family. If a cycle is detected, throw a
          descriptive error message indicating which plans are involved in the
          circular dependency.
        done: true
      - prompt: >
          Ensure the sorting preserves the constraint that parent plans always
          have lower IDs than children, even when there are complex dependency
          relationships between siblings within the family.
        done: true
  - title: Implement ID Reassignment for a Sorted Family
    done: false
    description: >
      Develop the logic that takes a topologically sorted family of plans,
      gathers their current IDs into a pool, sorts the ID pool numerically, and
      reassigns these IDs to the plans according to their new sorted order. This
      function should return a mapping of old IDs to new IDs for the family,
      ensuring that the same set of IDs is reused but in the correct
      hierarchical order.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a function `reassignFamilyIds` that takes a topologically
          sorted array of family plans and returns a Map of old ID to new ID
          mappings. Extract all current IDs from the family, sort them
          numerically, and assign them to plans in their new topological order.
        done: false
      - prompt: >
          Implement logic to collect all existing IDs from the family plans into
          an array, sort this array numerically (lowest to highest), and then
          assign these sorted IDs to the plans in their topologically sorted
          order, ensuring parents get lower IDs than their children.
        done: false
      - prompt: >
          Create the return mapping structure that will be used by the main
          renumbering logic to update all plan references globally. The mapping
          should be clear about which old ID maps to which new ID for use in
          updating dependencies and parent references across all plans.
        done: false
  - title: Integrate Hierarchical Renumbering into the Main Command
    done: false
    description: >
      Modify the `handleRenumber` function to add a new phase that orchestrates
      the hierarchical reordering. This phase will use the previously developed
      functions to find all disordered families, sort them, reassign their IDs,
      and create a global mapping of all ID changes. It will then update all
      plan objects in memory with their new `id`, `parent`, and `dependencies`
      values. This phase should run after the existing conflict resolution logic
      but before the final file writing.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Add a new hierarchical reordering phase in the `handleRenumber`
          function after line 328 (after conflict resolution is complete).
          Create a clear section comment indicating the start of the
          hierarchical reordering phase and add logic to identify all disordered
          families using the helper functions.
        done: false
      - prompt: >
          For each disordered family identified, collect the complete family
          tree, perform topological sorting, and generate ID reassignment
          mappings. Accumulate all these mappings into a global ID change map
          that will be used to update all plan references.
        done: false
      - prompt: >
          Implement the global update logic that applies all ID changes to all
          plans in memory. Update the `id`, `parent`, and `dependencies` fields
          of all affected plans, and add these plans to the `plansToWrite` set
          so they get persisted to disk.
        done: false
      - prompt: >
          Add appropriate logging to track the hierarchical reordering process,
          similar to the existing logging patterns. Include information about
          how many families were reordered and which specific ID changes were
          made.
        done: false
      - prompt: >
          Ensure the hierarchical reordering phase respects the `--dry-run`
          option by only performing the analysis and logging what would be
          changed without actually modifying plan objects when in dry-run mode.
        done: false
  - title: Update File Writing and Renaming Logic
    done: false
    description: >
      Ensure the final step of writing plans to disk correctly handles the
      changes from the new hierarchical reordering phase. This includes renaming
      files and directories whose names are derived from the now-changed plan or
      parent IDs, ensuring the file system reflects the new structure. The
      existing file renaming logic should be extended to handle hierarchical ID
      changes in addition to the conflict resolution changes.
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Review the existing file writing and renaming logic (around lines
          415-453) to understand how it handles ID changes from conflict
          resolution. Identify where additional logic needs to be added to
          handle ID changes from hierarchical reordering.
        done: false
      - prompt: >
          Extend the file renaming logic to handle cases where both the plan ID
          and parent ID have changed due to hierarchical reordering. Ensure that
          directory names based on parent IDs are correctly updated when parents
          are renumbered.
        done: false
      - prompt: >
          Test the integration between the new hierarchical ID mappings and the
          existing file renaming logic. Ensure that all ID mappings (both from
          conflict resolution and hierarchical reordering) are properly applied
          to file paths and directory structures.
        done: false
      - prompt: >
          Add validation to ensure that file operations are performed in the
          correct order, particularly when both parent and child plans are being
          renamed, to avoid conflicts during the file system operations.
        done: false
  - title: Add Comprehensive Tests for Hierarchical Renumbering
    done: false
    description: >
      Write a suite of new tests in `renumber.test.ts` to validate the
      hierarchical reordering logic. The tests should cover various scenarios,
      including simple parent-child inversions, siblings with dependencies,
      multi-level hierarchies (grandparents), and cases where multiple
      independent families require reordering in a single command execution.
      Follow the existing testing patterns using real filesystem operations and
      temporary directories.
    files:
      - src/rmplan/commands/renumber.test.ts
    steps:
      - prompt: >
          Add a test case for simple parent-child inversion where a parent has
          ID 5 and child has ID 3, verifying that after renumbering the parent
          gets ID 3 and child gets ID 5, and that all file names and references
          are updated correctly.
        done: false
      - prompt: >
          Create a test for siblings with dependencies where parent ID 10 has
          children with IDs 5 and 7, where child 7 depends on child 5. Verify
          that after renumbering, parent gets ID 5, first child gets ID 7, and
          second child gets ID 10, preserving the dependency relationship.
        done: false
      - prompt: >
          Add a test for multi-level hierarchy (grandparent, parent, child)
          where IDs are out of order (grandparent: 15, parent: 10, child: 5).
          Verify the entire family gets reordered correctly with proper
          parent-child relationships maintained.
        done: false
      - prompt: >
          Create a test case where multiple independent families need reordering
          in the same command execution. Verify that each family is processed
          independently and that IDs from different families don't interfere
          with each other.
        done: false
      - prompt: >
          Add tests for edge cases including empty dependencies arrays, missing
          parent references, and plans that are part of hierarchies but don't
          need reordering themselves. Ensure the logic handles these cases
          gracefully without unnecessary changes.
        done: false
      - prompt: >
          Create a comprehensive test that combines hierarchical reordering with
          the existing conflict resolution logic. Set up a scenario where some
          plans have ID conflicts AND hierarchical ordering issues, verifying
          that both phases work together correctly.
        done: false
      - prompt: >
          Add tests for the `--dry-run` option specifically for hierarchical
          reordering, ensuring that the analysis is performed and reported
          correctly but no actual changes are made to files or plan objects.
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
- Plan IDs are reused (e.g. if plans 52, 53, 55, and 57 form a group of parent and children, the resulting plans have those IDs as well, just in a different arrangement)

The renumber command should check for this in a separate phase after its current conflict resolution phase. This ensures
that we're starting with a clean state and can focus solely on this task without worrying about conflicts.

# Processed Plan Details

The current `renumber` command effectively resolves ID conflicts but can result in a logically inconsistent state where a parent plan is assigned a higher ID than its children. This project will introduce a new phase to the renumbering process that specifically corrects these hierarchical inconsistencies.

The new logic will execute after the initial conflict resolution is complete. It will identify any "disordered" plan families (where a parent ID is greater than a child ID), collect the parent and all its descendants into a group, and re-assign their existing pool of IDs in a logical order. This order will be determined by a topological sort that respects both the parent-child structure and any dependencies between siblings.

### Acceptance Criteria
- After running `renumber`, any plan with a parent must have an ID greater than its parent's ID.
- The IDs of sibling plans must be sorted according to their mutual dependencies.
- A reordered family group must use the same set of IDs after renumbering as it did before, just in a different arrangement.
- All `parent` and `dependencies` fields across all plans in the project must be correctly updated to reflect the new numbering.
- File and directory names based on plan IDs must be correctly renamed.
- The `--dry-run` option must accurately report the proposed hierarchical changes without modifying any files.

### Technical Considerations and Approach
The implementation will be added to the `handleRenumber` function in `src/rmplan/commands/renumber.ts`. The core of the approach is to:
1.  Build a graph or map representation of the parent-child relationships from the conflict-resolved plan data.
2.  Identify all families where a parent's ID is greater than a descendant's ID.
3.  For each such family, perform a topological sort to establish the correct order.
4.  Re-assign the family's existing pool of IDs according to this new order.
5.  Apply all ID changes globally, updating `id`, `parent`, and `dependencies` fields.
6.  Write all modified plans back to disk, handling file and directory renames.

This phase will introduce a new step in the `renumber` command that runs after initial ID conflict resolution. This step will be responsible for ensuring that all plan hierarchies are logically ordered, with parent IDs being smaller than their children's IDs. The implementation will involve building a representation of the plan hierarchy, identifying disordered groups, sorting them logically, and re-assigning their existing IDs to restore order.
