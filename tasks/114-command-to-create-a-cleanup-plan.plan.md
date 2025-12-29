---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: --cleanup option for 'add' command to create a cleanup plan
goal: To implement the complete functionality for the `--cleanup` option,
  including plan creation, relationship linking, `rmfilter` population, and
  testing.
id: 114
uuid: 7398f6fa-abe4-467d-a516-6b47e8a3b259
status: done
priority: high
planGeneratedAt: 2025-08-24T22:39:10.663Z
promptsGeneratedAt: 2025-08-24T22:42:07.074Z
createdAt: 2025-08-24T22:31:39.657Z
updatedAt: 2025-10-27T08:39:04.311Z
tasks:
  - title: Update CLI definition for the 'add' command
    done: true
    description: >
      Modify the `rmplan add` command in `src/rmplan/rmplan.ts` to include the
      new `--cleanup <planId>` option. The existing `<title...>` argument should
      be made optional to allow for default title generation when using
      `--cleanup`. This involves changing the command definition from requiring
      a title to making it optional, and adding the cleanup option that accepts
      a plan ID parameter.
  - title: Implement cleanup plan creation and relationship linking
    done: true
    description: >
      In `src/rmplan/commands/add.ts`, add logic to handle the `--cleanup`
      option. This includes finding the referenced plan using existing utilities
      like `readAllPlans`, generating the new plan's title if one isn't provided
      using the pattern "<referenced plan title> cleanup", and setting the
      `parent` property on the new cleanup plan. The implementation should
      validate that the referenced plan exists and handle error cases
      appropriately.
  - title: Aggregate `changedFiles` into the new plan's `rmfilter`
    done: true
    description: >
      Extend the logic in `add.ts` to collect all file paths from the
      `changedFiles` property of both the referenced plan and any of its
      children that are marked as "done". These files will populate the
      `rmfilter` of the new cleanup plan, providing the necessary context files
      for the cleanup work. Use a Set for deduplication and sort the final array
      for consistency.
  - title: Update the referenced plan's dependencies
    done: true
    description: >
      Modify the referenced plan file to add the newly created cleanup plan's ID
      to its `dependencies` array. This establishes the reverse dependency link,
      ensuring the original work is not considered complete until the cleanup is
      done. Follow the existing pattern used for parent plan updates in the
      current add command implementation.
  - title: Add tests for the `--cleanup` option
    done: true
    description: >
      Create comprehensive tests in `src/rmplan/commands/add.test.ts` to
      validate the entire `--cleanup` workflow. Tests should cover default title
      generation, `rmfilter` aggregation from a parent and a "done" child,
      correct parent/dependency linking, and error handling for non-existent
      plan IDs. Follow the existing test patterns in the file using temporary
      directories and real filesystem operations.
changedFiles:
  - src/rmplan/commands/add.test.ts
  - src/rmplan/commands/add.ts
  - src/rmplan/rmplan.ts
rmfilter:
  - src/rmplan/commands/add.ts
  - src/rmplan/planSchema.ts
  - src/rmplan/rmplan.ts
  - --with-imports
---

# Original Plan Details

Add a new `--cleanup <planId>` option to rmplan that creates a "cleanup" plan to fix things that were not implemented right in another plan.

When specified, the new plan should:
- have the same title as the referenced one but with the word "cleanup" added to the title, if another title is not provided.
- have the referenced plan as a parent, and be a dependency of the referenced plan.
- have the referenced plan's changedFiles in its `rmfilter` array

We should also look at other "done" children of the referenced plan, and add the contents of those plans' changedFiles as well.

# Processed Plan Details

This project will introduce a new `--cleanup <planId>` option to the `rmplan add` command. This feature is designed to streamline the process of creating follow-up plans to correct or refactor work done in a previous plan.

### Analysis of Work
The implementation will involve modifying the `rmplan add` command to recognize and handle the new option. The core logic will:
1.  Locate the plan referenced by `<planId>`.
2.  Generate a default title for the new plan (e.g., "`<Referenced Plan Title>` cleanup") if a specific title isn't provided.
3.  Establish a bidirectional relationship: the new plan will be a child of the referenced plan, and the referenced plan will be updated to depend on the new plan.
4.  Aggregate the file context (`changedFiles`) from the referenced plan and all of its completed child plans into the `rmfilter` of the new cleanup plan. This ensures the cleanup plan has the correct context of all affected files.

Changes will primarily be in `src/rmplan/rmplan.ts` for the CLI definition and `src/rmplan/commands/add.ts` for the implementation logic. New tests will be added to `src/rmplan/commands/add.test.ts` to ensure correctness.

### Acceptance Criteria
- Running `rmplan add --cleanup <planId>` successfully creates a new plan file.
- If no title is provided, the new plan's title must be "<referenced plan title> cleanup".
- If a title is provided (e.g., `rmplan add "Custom Title" --cleanup <planId>`), the new plan uses the custom title.
- The new plan's `parent` property must be set to `<planId>`.
- The referenced plan's `dependencies` array must be updated to include the new cleanup plan's ID.
- The new plan's `rmfilter` array must contain a unique, sorted list of all file paths from the `changedFiles` property of the referenced plan AND all of its children with a `status` of "done".
- The command must fail with an informative error message if the plan specified by `<planId>` cannot be found.

### Technical Considerations
- The `title` argument for the `add` command will need to be made optional to support the default title generation.
- The implementation will use existing utility functions like `readAllPlans`, `readPlanFile`, and `writePlanFile` from `src/rmplan/plans.ts` to interact with the plan files.
- A `Set` should be used to efficiently collect and deduplicate file paths for the `rmfilter`.
- Tests will be crucial and should use a temporary filesystem to create a realistic scenario with a parent plan, a completed child plan, and their associated `changedFiles`.

This phase will deliver the entire feature in a single, integrated step. It begins by updating the CLI definition to accept the new option, then implements the core logic for creating the cleanup plan based on a referenced plan, and concludes by ensuring the new functionality is thoroughly tested and robust.
