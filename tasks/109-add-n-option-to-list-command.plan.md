---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add -n option to list command
goal: To add the `-n` option to the `list` command, implement the
  result-limiting logic, and verify its correctness with unit tests.
id: 109
status: done
priority: medium
dependencies: []
planGeneratedAt: 2025-08-14T01:24:13.332Z
promptsGeneratedAt: 2025-08-14T01:27:08.412Z
createdAt: 2025-08-14T01:22:01.173Z
updatedAt: 2025-08-14T01:27:08.852Z
tasks:
  - title: Add the `-n` option to the `list` command definition
    done: true
    description: >
      Add a new option `-n, --number <count>` to the `list` command in
      `src/rmplan/rmplan.ts`. 

      This will involve using `commander`'s `.option()` method and providing a
      suitable description. 

      The existing `intArg` function (defined at line 44) will be used to
      convert the string argument 

      into an integer, following the same pattern used for other numeric options
      in the codebase 

      (see lines 149-150 for the `add` command as an example).
    files:
      - src/rmplan/rmplan.ts
    steps:
      - prompt: >
          Add a new option to the `list` command (around line 336) for limiting
          the number of results.

          Use `.option('-n, --number <count>', 'Limit the number of results
          shown', intArg)` to define the option.

          This follows the existing pattern where intArg is passed as the third
          argument to handle integer parsing.
        done: true
  - title: Implement the result limiting logic in the `handleListCommand` function
    done: true
    description: >
      Modify the `handleListCommand` function in `src/rmplan/commands/list.ts`
      to respect the new `number` option.

      After the `planArray` has been filtered and sorted (around line 136),
      check if the `number` option is present.

      If it is, use `Array.prototype.slice()` to truncate the array to the last
      N results before it is passed to 

      the table-rendering logic. The limiting should show the last N items
      (using negative slice index) to show 

      the most relevant results after sorting. The "Showing X of Y plan(s)"
      message at line 317 should accurately 

      reflect when limiting is applied.
    files:
      - src/rmplan/commands/list.ts
    steps:
      - prompt: >
          After the sorting logic (after line 136), add a check for the
          `options.number` parameter.

          If it's present and is a positive integer, limit the planArray to the
          last N items using 

          `planArray = planArray.slice(-options.number)`.
        done: true
      - prompt: >
          Update the final status message (around line 317) to indicate when
          results are limited.

          Store the original filtered count before limiting, then show a message
          like 

          "Showing 5 of 12 plan(s) (limited to 5)" when the limit is applied.
        done: true
  - title: Add unit tests for the new `-n` option
    done: true
    description: >
      Update the test file `src/rmplan/commands/list.test.ts` to include
      comprehensive tests for the new functionality.

      These tests will create a set of mock plan files, invoke
      `handleListCommand` with the `-n` option, and assert 

      that the number of rows in the output table is correctly limited. Tests
      should cover: basic limiting functionality,

      edge cases like requesting more items than exist, interaction with
      filtering and sorting, and ensuring the 

      "Showing X of Y" message is updated correctly. Follow the existing test
      patterns in the file, using the 

      ModuleMocker and temporary directories.
    files:
      - src/rmplan/commands/list.test.ts
    steps:
      - prompt: >
          Add a test case that creates 10 plan files and uses the `-n` option
          with value 5.

          Verify that the table output contains exactly 6 rows (1 header + 5
          data rows) and that

          the status message indicates "Showing 5 of 10 plan(s)".
        done: true
      - prompt: >
          Add a test for the edge case where `-n` is larger than the number of
          available plans.

          Create 3 plans and use `-n` with value 10. Verify all 3 plans are
          shown and the message

          correctly indicates "Showing 3 of 3 plan(s)".
        done: true
      - prompt: >
          Add a test that combines the `-n` option with status filtering.

          Create plans with different statuses, filter by status, and apply a
          limit.

          Verify the limit is applied after filtering and the correct plans are
          shown.
        done: true
      - prompt: >
          Add a test that verifies the `-n` option works correctly with sorting.

          Create plans with different IDs, sort by ID in reverse order, and
          limit to 3 results.

          Verify that the last 3 items after sorting are displayed (which should
          be the 3 highest IDs).
        done: true
rmfilter:
  - src/rmplan/commands/list.ts
  - src/rmplan/rmplan.ts
---

# Original Plan Details

Add a -n option to the list command that allows for specifying the number of
results to return.

# Processed Plan Details

This project will enhance the `rmplan list` command by introducing a feature to limit the number of results. The implementation will involve modifying the command's definition, updating the command handler to apply the limit, and adding comprehensive tests to ensure correctness.

### Acceptance Criteria
- The `rmplan list` command must accept a new option, `-n <count>` (or a long-form equivalent like `--number <count>`), where `<count>` is a positive integer.
- When `rmplan list -n 5` is executed, the output table should contain at most 5 plans (plus the header row).
- The limiting logic must be applied *after* all filtering (e.g., by status) and sorting has occurred, ensuring the last N results are shown.
- If the number of plans after filtering is less than the value specified by `-n`, all filtered plans should be displayed.
- If the `-n` option is not provided, the command's behavior should remain unchanged.
- The new option must be documented in the command's help text (`rmplan list --help`).
- Unit tests must be added to verify the functionality of the `-n` option, including edge cases.

### Technical Considerations
- The new option will be added to the `commander` definition in `src/rmplan/rmplan.ts`. A parser function should be used to ensure the option's value is treated as an integer.
- The core logic will be implemented in `src/rmplan/commands/list.ts` by slicing the `planArray` before it is used to generate the output table.
- New tests will be added to `src/rmplan/commands/list.test.ts` to cover the new functionality.

This phase encompasses all the work required to deliver the new feature. We will first define the new command-line option, then implement the logic to limit the results in the command handler, and finally, create tests to ensure the feature works as expected.
