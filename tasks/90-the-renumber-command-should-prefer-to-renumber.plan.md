---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The renumber command should prefer to renumber files that were creaated
  or modified on the current branch.
goal: To implement and test the full functionality of the branch-aware
  renumbering preference, from the underlying Git utilities to the final command
  logic and integration tests.
id: 90
uuid: 8ecf1abd-e862-4fdd-b752-1c747d5b9368
status: done
priority: high
dependencies: []
planGeneratedAt: 2025-08-13T00:54:09.283Z
promptsGeneratedAt: 2025-08-13T00:58:12.552Z
createdAt: 2025-08-06T18:48:42.803Z
updatedAt: 2025-10-27T08:39:04.245Z
tasks:
  - title: Integrate branch detection and changed file retrieval into the renumber
      command
    done: true
    description: >
      Modify the `handleRenumber` function in `renumber.ts` to determine the
      current Git branch. Based on the branch name, it will decide whether to
      activate the new preference logic. If on a feature branch, it will call
      the new Git utility to get the list of changed plan files.


      The integration should:

      - Use the existing getCurrentBranchName() function from git.ts

      - Only activate the new logic when not on main/master branches

      - Store the list of changed files for use in conflict resolution

      - Add appropriate logging for debugging
  - title: Implement branch-based preference in conflict resolution
    done: true
    description: >
      Update the conflict resolution logic within `handleRenumber`. When an ID
      conflict is detected and the command is running on a feature branch, the
      logic will now check if any of the conflicting plan files were changed on
      the current branch. If so, that file will be preferred, and the other
      conflicting files will be marked for renumbering. This new preference
      should be applied after the explicit `--prefer` flag but before the
      existing `createdAt` timestamp fallback.


      The implementation should:

      - Add the branch-based check between lines 100 and 107 of the existing
      code

      - Create a Set of changed files for efficient lookup

      - Prefer files that were changed on the current branch

      - Fall back to the createdAt logic if no conflicting files were changed on
      the branch
  - title: Add integration tests for the branch-aware renumber command
    done: true
    description: >
      Add new tests to `renumber.test.ts` to validate the complete feature.
      These tests will need to create a temporary Git repository and simulate
      various scenarios, such as: running `renumber` on a feature branch with
      conflicting new/modified plans, running on a trunk branch to ensure the
      old logic is used, and verifying that the `--prefer` flag still overrides
      the new branch-based preference.


      The tests should:

      - Mock the git functions to simulate different branch scenarios

      - Create conflicting plan files with different timestamps

      - Verify correct preference order is applied

      - Test both feature branch and trunk branch behavior
rmfilter:
  - src/rmplan/commands/renumber*
  - --with-imports
---

# Original Plan Details

The idea is that we should be renumbering the plans that are being actively worked on, not that plans that are already done, regardless of when they were created or modified.

This logic should only run when we're on a feature branch. If the current branch is a trunk branch (main or master) then
we should skip this logic and use the existing preference logic.

# Processed Plan Details

This project aims to improve the developer experience of the `renumber` command by making it context-aware of the current Git branch. When resolving plan ID conflicts, the command should prefer to keep the ID for plans that are being actively developed on a feature branch, rather than renumbering them based on creation date.

### Analysis of Work
The implementation will involve two main parts:
1.  **Git Integration:** A new utility function will be created to determine the list of files that have been changed (created or modified) on the current branch compared to a trunk branch (main/master). This will likely involve using `git merge-base` and `git diff`.
2.  **Command Logic Update:** The `renumber` command's logic will be updated to use this new information. It will first check the current branch. If it's a feature branch, it will use the list of changed files to resolve ID conflicts. If it's a trunk branch, it will fall back to the existing behavior.

### Acceptance Criteria
- When `rmplan renumber` is run on a feature branch, if a plan file has a conflicting ID, the version of the file that was created or modified on the current branch will keep its ID.
- When `rmplan renumber` is run on a trunk branch (defined as `main` or `master`), the conflict resolution logic will remain unchanged, using the `createdAt` timestamp.
- The `--prefer` command-line option will continue to take highest precedence, overriding both the new branch-based logic and the timestamp logic.
- The new functionality is thoroughly tested, including tests that simulate Git repository states.

### Technical Considerations
- The new Git utility will be placed in `src/common/git.ts`.
- The core logic change will be in `src/rmplan/commands/renumber.ts`.
- Tests will require creating and manipulating temporary Git repositories to simulate different branch and commit scenarios.

### Assumptions
- The tool is being run within a Git repository.
- The primary development branches are named `main` or `master`.

This phase will deliver the complete feature. We will start by creating the necessary Git utility to find changed files on a branch. Then, we will integrate this utility into the `renumber` command, adding the conditional logic to prefer files changed on the current branch during conflict resolution. The phase will conclude with comprehensive testing to ensure the feature works as expected in all scenarios.
