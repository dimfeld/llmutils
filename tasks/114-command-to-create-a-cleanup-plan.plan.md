---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: --cleanup option for 'add' command to create a cleanup plan
goal: To implement the complete functionality for the `--cleanup` option,
  including plan creation, relationship linking, `rmfilter` population, and
  testing.
id: 114
status: done
priority: high
container: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-08-24T22:39:10.663Z
promptsGeneratedAt: 2025-08-24T22:42:07.074Z
createdAt: 2025-08-24T22:31:39.657Z
updatedAt: 2025-08-24T23:12:31.454Z
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
    files:
      - src/rmplan/rmplan.ts
    docs: []
    steps:
      - prompt: >
          Update the `add` command definition in `src/rmplan/rmplan.ts` (around
          line 130) to make the `<title...>` argument optional by changing it to
          `[title...]`. This allows the command to work without a title when
          using the `--cleanup` option.
        done: true
      - prompt: >
          Add a new `--cleanup <planId>` option to the `add` command definition.
          This option should accept a plan ID parameter that will be used to
          reference the plan that needs cleanup. Use the existing pattern of
          other options in the command for consistency.
        done: true
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
    files:
      - src/rmplan/commands/add.ts
    docs: []
    steps:
      - prompt: >
          Update the `handleAddCommand` function signature and initial logic to
          handle the case where `title` array might be empty (when using
          `--cleanup` without a title). Add early validation to check if the
          `--cleanup` option is provided and if so, convert the planId to a
          number and validate it exists using `readAllPlans`.
        done: true
      - prompt: >
          Add logic to find the referenced plan when `--cleanup` option is used.
          Use the existing `readAllPlans` utility to get all plans, then find
          the plan with the matching ID. Throw an appropriate error if the
          referenced plan is not found, similar to the existing parent plan
          validation pattern.
        done: true
      - prompt: >
          Implement default title generation for cleanup plans. When no title is
          provided and `--cleanup` is used, generate a default title by
          appending " cleanup" to the referenced plan's title. If a custom title
          is provided, use it instead. Store the final title in the `planTitle`
          variable.
        done: true
      - prompt: >
          Set the `parent` property of the new cleanup plan to the referenced
          plan's ID when using `--cleanup`. This establishes the parent-child
          relationship where the cleanup plan is a child of the original plan
          that needs cleanup.
        done: true
  - title: Aggregate `changedFiles` into the new plan's `rmfilter`
    done: true
    description: >
      Extend the logic in `add.ts` to collect all file paths from the
      `changedFiles` property of both the referenced plan and any of its
      children that are marked as "done". These files will populate the
      `rmfilter` of the new cleanup plan, providing the necessary context files
      for the cleanup work. Use a Set for deduplication and sort the final array
      for consistency.
    files:
      - src/rmplan/commands/add.ts
    docs: []
    steps:
      - prompt: >
          When `--cleanup` is used, collect all file paths from the referenced
          plan's `changedFiles` property (if it exists). Use a Set to store the
          file paths for automatic deduplication.
        done: true
      - prompt: >
          Find all child plans of the referenced plan by filtering the plans
          where the `parent` property matches the referenced plan's ID. For each
          child plan that has a `status` of "done", add its `changedFiles` to
          the Set of collected files.
        done: true
      - prompt: >
          Convert the Set of collected file paths to a sorted array and assign
          it to the new plan's `rmfilter` property. This ensures the cleanup
          plan has access to all the files that were modified during the
          original work and any completed follow-up work.
        done: true
  - title: Update the referenced plan's dependencies
    done: true
    description: >
      Modify the referenced plan file to add the newly created cleanup plan's ID
      to its `dependencies` array. This establishes the reverse dependency link,
      ensuring the original work is not considered complete until the cleanup is
      done. Follow the existing pattern used for parent plan updates in the
      current add command implementation.
    files:
      - src/rmplan/commands/add.ts
    docs: []
    steps:
      - prompt: >
          After creating the new cleanup plan, update the referenced plan to
          include the cleanup plan's ID in its `dependencies` array. Follow the
          same pattern used for parent plan updates: check if dependencies array
          exists (create if not), add the new plan ID if not already present,
          and update the timestamp.
        done: true
      - prompt: >
          If the referenced plan's status is "done", change it to "in_progress"
          since it now has a new dependency (the cleanup plan) that needs to be
          completed. Log this status change to inform the user, similar to the
          existing parent plan status update messaging.
        done: true
      - prompt: >
          Write the updated referenced plan back to disk using `writePlanFile`
          and log the dependency update to provide user feedback about the
          relationship establishment.
        done: true
  - title: Add tests for the `--cleanup` option
    done: true
    description: >
      Create comprehensive tests in `src/rmplan/commands/add.test.ts` to
      validate the entire `--cleanup` workflow. Tests should cover default title
      generation, `rmfilter` aggregation from a parent and a "done" child,
      correct parent/dependency linking, and error handling for non-existent
      plan IDs. Follow the existing test patterns in the file using temporary
      directories and real filesystem operations.
    files:
      - src/rmplan/commands/add.test.ts
    docs: []
    steps:
      - prompt: >
          Add a test that verifies basic cleanup plan creation with default
          title generation. Create a parent plan, use the `--cleanup` option
          without providing a custom title, and verify that the new plan has the
          correct title format ("<parent title> cleanup"), parent relationship,
          and that the parent plan's dependencies are updated.
        done: true
      - prompt: >
          Add a test that verifies custom title handling with the `--cleanup`
          option. Create a parent plan, use `--cleanup` with a custom title, and
          verify that the custom title is used instead of the generated default
          title while all other relationships are established correctly.
        done: true
      - prompt: >
          Add a test that verifies `rmfilter` aggregation from multiple sources.
          Create a parent plan with `changedFiles`, create a child plan of that
          parent with status "done" and its own `changedFiles`, then create a
          cleanup plan and verify that its `rmfilter` contains all the files
          from both the parent and the completed child, properly deduplicated
          and sorted.
        done: true
      - prompt: >
          Add a test that verifies error handling when referencing a
          non-existent plan ID. Use the `--cleanup` option with a plan ID that
          doesn't exist and verify that an appropriate error message is thrown,
          similar to the existing parent plan error handling test.
        done: true
      - prompt: >
          Add a test that verifies the referenced plan's status change from
          "done" to "in_progress" when a cleanup dependency is added. Create a
          plan with status "done", create a cleanup plan for it, and verify that
          the original plan's status is changed and the dependency relationship
          is established correctly.
        done: true
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
