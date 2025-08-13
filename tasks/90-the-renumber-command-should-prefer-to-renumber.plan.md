---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The renumber command should prefer to renumber files that were creaated
  or modified on the current branch.
goal: To implement and test the full functionality of the branch-aware
  renumbering preference, from the underlying Git utilities to the final command
  logic and integration tests.
id: 90
status: pending
priority: high
dependencies: []
planGeneratedAt: 2025-08-13T00:54:09.283Z
createdAt: 2025-08-06T18:48:42.803Z
updatedAt: 2025-08-13T00:54:09.283Z
tasks:
  - title: Create a Git utility to find changed files on the current branch
    description: Implement a new function in the `git.ts` module that identifies
      files created or modified on the current branch. This function should
      determine the common ancestor (merge-base) with a trunk branch (e.g.,
      'main' or 'master') and then list all files that have changed since that
      point. This provides the necessary data for the renumbering logic to
      identify actively worked-on plans.
    steps: []
  - title: Add tests for the new Git utility
    description: Create comprehensive tests for the new "get changed files" utility.
      These tests should be in `git.test.ts` and will involve setting up a
      temporary Git repository, creating commits on different branches, and
      asserting that the function correctly identifies the files changed on a
      feature branch relative to the trunk.
    steps: []
  - title: Integrate branch detection and changed file retrieval into the renumber
      command
    description: Modify the `handleRenumber` function in `renumber.ts` to determine
      the current Git branch. Based on the branch name, it will decide whether
      to activate the new preference logic. If on a feature branch, it will call
      the new Git utility to get the list of changed plan files.
    steps: []
  - title: Implement branch-based preference in conflict resolution
    description: Update the conflict resolution logic within `handleRenumber`. When
      an ID conflict is detected and the command is running on a feature branch,
      the logic will now check if any of the conflicting plan files were changed
      on the current branch. If so, that file will be preferred, and the other
      conflicting files will be marked for renumbering. This new preference
      should be applied after the explicit `--prefer` flag but before the
      existing `createdAt` timestamp fallback.
    steps: []
  - title: Add integration tests for the branch-aware renumber command
    description: "Add new tests to `renumber.test.ts` to validate the complete
      feature. These tests will need to create a temporary Git repository and
      simulate various scenarios, such as: running `renumber` on a feature
      branch with conflicting new/modified plans, running on a trunk branch to
      ensure the old logic is used, and verifying that the `--prefer` flag still
      overrides the new branch-based preference."
    steps: []
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
