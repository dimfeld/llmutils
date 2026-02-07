---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add -n option to list command
goal: To add the `-n` option to the `list` command, implement the
  result-limiting logic, and verify its correctness with unit tests.
id: 109
uuid: d0aeaceb-82bf-4259-82e5-81945f253053
status: done
priority: medium
planGeneratedAt: 2025-08-14T01:24:13.332Z
promptsGeneratedAt: 2025-08-14T01:27:08.412Z
createdAt: 2025-08-14T01:22:01.173Z
updatedAt: 2025-10-27T08:39:04.256Z
tasks:
  - title: Add the `-n` option to the `list` command definition
    done: true
    description: >
      Add a new option `-n, --number <count>` to the `list` command in
      `src/tim/tim.ts`. 

      This will involve using `commander`'s `.option()` method and providing a
      suitable description. 

      The existing `intArg` function (defined at line 44) will be used to
      convert the string argument 

      into an integer, following the same pattern used for other numeric options
      in the codebase 

      (see lines 149-150 for the `add` command as an example).
  - title: Implement the result limiting logic in the `handleListCommand` function
    done: true
    description: >
      Modify the `handleListCommand` function in `src/tim/commands/list.ts` to
      respect the new `number` option.

      After the `planArray` has been filtered and sorted (around line 136),
      check if the `number` option is present.

      If it is, use `Array.prototype.slice()` to truncate the array to the last
      N results before it is passed to 

      the table-rendering logic. The limiting should show the last N items
      (using negative slice index) to show 

      the most relevant results after sorting. The "Showing X of Y plan(s)"
      message at line 317 should accurately 

      reflect when limiting is applied.
  - title: Add unit tests for the new `-n` option
    done: true
    description: >
      Update the test file `src/tim/commands/list.test.ts` to include
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
rmfilter:
  - src/tim/commands/list.ts
  - src/tim/tim.ts
---

# Original Plan Details

Add a -n option to the list command that allows for specifying the number of
results to return.

# Processed Plan Details

This project will enhance the `tim list` command by introducing a feature to limit the number of results. The implementation will involve modifying the command's definition, updating the command handler to apply the limit, and adding comprehensive tests to ensure correctness.

### Acceptance Criteria
- The `tim list` command must accept a new option, `-n <count>` (or a long-form equivalent like `--number <count>`), where `<count>` is a positive integer.
- When `tim list -n 5` is executed, the output table should contain at most 5 plans (plus the header row).
- The limiting logic must be applied *after* all filtering (e.g., by status) and sorting has occurred, ensuring the last N results are shown.
- If the number of plans after filtering is less than the value specified by `-n`, all filtered plans should be displayed.
- If the `-n` option is not provided, the command's behavior should remain unchanged.
- The new option must be documented in the command's help text (`tim list --help`).
- Unit tests must be added to verify the functionality of the `-n` option, including edge cases.

### Technical Considerations
- The new option will be added to the `commander` definition in `src/tim/tim.ts`. A parser function should be used to ensure the option's value is treated as an integer.
- The core logic will be implemented in `src/tim/commands/list.ts` by slicing the `planArray` before it is used to generate the output table.
- New tests will be added to `src/tim/commands/list.test.ts` to cover the new functionality.

This phase encompasses all the work required to deliver the new feature. We will first define the new command-line option, then implement the logic to limit the results in the command handler, and finally, create tests to ensure the feature works as expected.
