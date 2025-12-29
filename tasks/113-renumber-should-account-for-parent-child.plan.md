---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Renumber should account for parent/child relationships when only parent
  is being renumbered
goal: To update the `renumber` command to correctly order plan IDs based on
  parent-child hierarchies and sibling dependencies.
id: 113
uuid: d6cc9495-6826-4d2d-b5d9-9f8597dd2e65
status: done
priority: high
planGeneratedAt: 2025-08-29T05:11:32.894Z
promptsGeneratedAt: 2025-08-29T05:14:58.450Z
createdAt: 2025-08-19T19:45:01.416Z
updatedAt: 2025-10-27T08:39:04.266Z
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
  - title: Identify Disordered Plan Families
    done: true
    description: >
      Implement logic to scan the complete plan hierarchy and identify any
      parent plan whose ID is greater than one of its children's IDs. This logic
      should collect the root parent of each disordered family to be processed.
      The function should work with the hierarchy representation built in the
      previous task and identify all families that need reordering, ensuring we
      process each family only once by working with root parents.
  - title: Implement Topological Sort for Plan Families
    done: true
    description: >
      Create a function that takes a family of plans (a parent and all its
      descendants) and returns a new list of those plans in a topologically
      sorted order. The sort must place the parent first, followed by the
      descendants ordered correctly based on their mutual dependencies. This
      should handle both the parent-child hierarchy constraint and any explicit
      dependencies between siblings within the family.
  - title: Implement ID Reassignment for a Sorted Family
    done: true
    description: >
      Develop the logic that takes a topologically sorted family of plans,
      gathers their current IDs into a pool, sorts the ID pool numerically, and
      reassigns these IDs to the plans according to their new sorted order. This
      function should return a mapping of old IDs to new IDs for the family,
      ensuring that the same set of IDs is reused but in the correct
      hierarchical order.
  - title: Integrate Hierarchical Renumbering into the Main Command
    done: true
    description: >
      Modify the `handleRenumber` function to add a new phase that orchestrates
      the hierarchical reordering. This phase will use the previously developed
      functions to find all disordered families, sort them, reassign their IDs,
      and create a global mapping of all ID changes. It will then update all
      plan objects in memory with their new `id`, `parent`, and `dependencies`
      values. This phase should run after the existing conflict resolution logic
      but before the final file writing.
  - title: Update File Writing and Renaming Logic
    done: true
    description: >
      Ensure the final step of writing plans to disk correctly handles the
      changes from the new hierarchical reordering phase. This includes renaming
      files and directories whose names are derived from the now-changed plan or
      parent IDs, ensuring the file system reflects the new structure. The
      existing file renaming logic should be extended to handle hierarchical ID
      changes in addition to the conflict resolution changes.
  - title: Add Comprehensive Tests for Hierarchical Renumbering
    done: true
    description: >
      Write a suite of new tests in `renumber.test.ts` to validate the
      hierarchical reordering logic. The tests should cover various scenarios,
      including simple parent-child inversions, siblings with dependencies,
      multi-level hierarchies (grandparents), and cases where multiple
      independent families require reordering in a single command execution.
      Follow the existing testing patterns using real filesystem operations and
      temporary directories.
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
