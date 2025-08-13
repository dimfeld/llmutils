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
promptsGeneratedAt: 2025-08-13T00:58:12.552Z
createdAt: 2025-08-06T18:48:42.803Z
updatedAt: 2025-08-13T00:58:12.552Z
tasks:
  - title: Create a Git utility to find changed files on the current branch
    description: >
      Implement a new function in the `git.ts` module that identifies files
      created or modified on the current branch. This function should determine
      the common ancestor (merge-base) with a trunk branch (e.g., 'main' or
      'master') and then list all files that have changed since that point. This
      provides the necessary data for the renumbering logic to identify actively
      worked-on plans.


      The implementation should follow the pattern used in
      src/rmfilter/additional_docs.ts for getChangedFiles(), but be located in
      the common git utilities. It needs to:

      - Find the merge-base between current branch and trunk branch

      - Get the list of changed files since that merge-base

      - Handle both Git and Jujutsu repositories

      - Return an empty array if on a trunk branch or if there are no changes
    files:
      - src/common/git.ts
    steps:
      - prompt: >
          Add a new function called `getFilesChangedOnBranch()` to
          src/common/git.ts that returns the list of files changed on the
          current branch compared to the trunk branch (main/master).

          The function should detect the trunk branch, find the merge-base, and
          return changed files.
        done: false
      - prompt: >
          Implement the logic to detect if the current branch is a trunk branch
          (main or master).

          If on a trunk branch, return an empty array immediately.
        done: false
      - prompt: |
          Add support for both Git and Jujutsu by checking which VCS is in use.
          For Git, use `git merge-base` and `git diff --name-only`.
          For Jujutsu, use appropriate jj commands to get changed files.
        done: false
      - prompt: >
          Add proper error handling and debug logging using the debugLog
          function.

          Return an empty array if any Git commands fail or if the merge-base
          cannot be determined.
        done: false
  - title: Add tests for the new Git utility
    description: >
      Create comprehensive tests for the new "get changed files" utility. These
      tests should be in `git.test.ts` and will involve setting up a temporary
      Git repository, creating commits on different branches, and asserting that
      the function correctly identifies the files changed on a feature branch
      relative to the trunk.


      The tests should follow the existing patterns in git.test.ts:

      - Use temporary directories with fs.mkdtemp()

      - Create real Git repositories using Bun.spawn()

      - Test various scenarios including no changes, multiple changes, and edge
      cases

      - Clean up temporary directories after each test
    files:
      - src/common/git.test.ts
    steps:
      - prompt: >
          Add a new describe block for 'getFilesChangedOnBranch' in git.test.ts.

          Set up the basic test structure with beforeEach and afterEach hooks
          for temporary directory management.
        done: false
      - prompt: >
          Create a test that verifies the function returns an empty array when
          on the main branch.

          Initialize a Git repo, create some commits on main, and verify no
          files are reported as changed.
        done: false
      - prompt: >
          Create a test for detecting files changed on a feature branch.

          Create a main branch with initial files, then create a feature branch,
          modify/add files, and verify the function returns the correct changed
          files.
        done: false
      - prompt: >
          Add a test for when there are no changes on the feature branch.

          Create a feature branch but don't make any changes, verify the
          function returns an empty array.
        done: false
      - prompt: >
          Add edge case tests: detached HEAD state, branch with no common
          ancestor, and repository with no main/master branch.

          Ensure the function handles these gracefully.
        done: false
  - title: Integrate branch detection and changed file retrieval into the renumber
      command
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
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Import the new `getFilesChangedOnBranch` function and the existing
          `getCurrentBranchName` function from the git module at the top of
          renumber.ts.
        done: false
      - prompt: >
          After getting the gitRoot (around line 21), add code to detect the
          current branch using getCurrentBranchName().

          Store whether we're on a feature branch (not main/master) in a
          variable.
        done: false
      - prompt: >
          If on a feature branch, call getFilesChangedOnBranch() to get the list
          of changed files.

          Convert these to absolute paths and filter to only include plan files
          (.plan.md, .yml, .yaml).
        done: false
      - prompt: >
          Add debug logging to show the current branch and number of changed
          plan files found.

          This will help with troubleshooting the feature.
        done: false
  - title: Implement branch-based preference in conflict resolution
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
    files:
      - src/rmplan/commands/renumber.ts
    steps:
      - prompt: >
          Create a Set from the changed plan files (if any) for efficient
          lookup.

          This should be done before the conflict resolution loop starts.
        done: false
      - prompt: >
          In the conflict resolution loop (around line 93), after checking for
          preferred files, add a new branch-based preference check.

          This should only run if we're on a feature branch and no preferred
          file was found.
        done: false
      - prompt: >
          Implement the logic to find if any conflicting files are in the
          changed files set.

          If found, that file should be kept and others should be renumbered.
        done: false
      - prompt: >
          Add debug logging when a file is preferred due to being changed on the
          current branch.

          If no changed file is found among conflicts, fall back to the existing
          createdAt logic.
        done: false
      - prompt: >
          Ensure the branch-based preference respects the precedence order:
          --prefer flag > branch-based > createdAt timestamp.
        done: false
  - title: Add integration tests for the branch-aware renumber command
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
    files:
      - src/rmplan/commands/renumber.test.ts
    steps:
      - prompt: >
          Add a new test case "prefers plans changed on current feature branch
          when resolving conflicts".

          Mock getCurrentBranchName to return 'feature-branch' and
          getFilesChangedOnBranch to return specific plan files.
        done: false
      - prompt: >
          In the new test, create conflicting plans where the newer file (by
          timestamp) is the one changed on the branch.

          Verify that the changed file keeps its ID even though it's newer.
        done: false
      - prompt: >
          Add a test "uses timestamp logic when on trunk branch (main)".

          Mock getCurrentBranchName to return 'main' and verify the original
          timestamp-based logic is used.
        done: false
      - prompt: >
          Add a test "prefer flag overrides branch-based preference".

          Set up a scenario where a file would be preferred due to branch
          changes, but use --prefer to override it.
        done: false
      - prompt: >
          Add a test for the case where multiple files conflict but none were
          changed on the current branch.

          Verify it falls back to the timestamp-based logic correctly.
        done: false
      - prompt: >
          Add a test for handling errors when Git operations fail.

          Mock getFilesChangedOnBranch to throw an error and verify the command
          still works using the fallback logic.
        done: false
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
