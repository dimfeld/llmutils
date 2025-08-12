---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The validate command should check that a plan's parent also depends on
  the child and automatically fix that if it doesn't. - Core Validation and
  Auto-Fix Implementation
goal: Implement the parent-child dependency validation logic in the validate
  command with automatic fixing capability
id: 96
status: in_progress
priority: high
dependencies: []
parent: 80
planGeneratedAt: 2025-08-12T00:46:31.546Z
promptsGeneratedAt: 2025-08-12T00:49:25.602Z
createdAt: 2025-07-29T19:17:43.223Z
updatedAt: 2025-08-12T00:49:26.039Z
project:
  title: Implement parent-child dependency validation and auto-fix in rmplan
    validate command
  goal: Add validation to ensure bidirectional parent-child relationships in plan
    files, where child plans with a parent field are automatically included in
    their parent's dependencies array, with automatic fixing of inconsistencies.
  details: >-
    The validate command should detect when a plan specifies a parent but that
    parent doesn't include the child in its dependencies array. This ensures
    consistency in the dependency graph and prevents orphaned child plans. The
    implementation should automatically fix these inconsistencies by updating
    parent plans, provide clear reporting of what was fixed, and maintain
    backward compatibility with existing validation functionality.


    **Acceptance Criteria:**

    - Validate command detects missing parent-child dependency relationships

    - Automatic fixing updates parent plans to include child dependencies

    - Clear reporting shows which relationships were fixed

    - Existing validation functionality remains intact

    - No circular dependencies are created

    - Tests cover all edge cases including multiple children and nested
    hierarchies
tasks:
  - title: Add parent-child validation logic to validate.ts
    done: true
    description: >
      Modify `/src/rmplan/commands/validate.ts` to add a new validation phase
      after schema validation that checks parent-child relationships. Create a
      function that iterates through all plans, identifies those with parent
      fields, and verifies the parent includes them in dependencies. Track which
      relationships need fixing. Use the existing `readAllPlans` function to
      load all plans at once for cross-referencing. The validation should happen
      after the schema validation phase so we know all plans are structurally
      valid. Store validation results in a data structure that tracks which
      parent plans need updating and what child IDs should be added to their
      dependencies.
    files:
      - src/rmplan/commands/validate.ts
    steps:
      - prompt: >
          After the schema validation loop in handleValidateCommand, add a new
          section that uses readAllPlans to load all plans from the tasksDir.

          Create a Map to track parent-child inconsistencies where the key is
          the parent plan ID and the value is an array of child IDs that need to
          be added.
        done: true
      - prompt: >
          Iterate through all loaded plans and for each plan with a parent
          field, check if the parent plan exists and whether it includes this
          child in its dependencies array.

          If the parent exists but doesn't include the child, add this
          relationship to the inconsistencies Map.
        done: true
      - prompt: >
          Add validation to ensure that fixing a parent-child relationship won't
          create a circular dependency.

          Check if adding the child to the parent's dependencies would create a
          cycle in the dependency graph.
        done: true
  - title: Implement auto-fix functionality
    done: true
    description: >
      Add logic to automatically update parent plans when missing dependencies
      are detected. This includes reading the parent plan file using
      `readPlanFile`, adding the child ID to the dependencies array if not
      present, updating the updatedAt timestamp, and writing the file back using
      `writePlanFile`. Ensure proper error handling for file operations. The fix
      should maintain the existing order of dependencies and only append new
      ones. Handle the case where the dependencies array doesn't exist yet by
      creating it. Use the existing plan I/O functions from plans.ts to ensure
      consistency with how plans are read and written throughout the codebase.
    files:
      - src/rmplan/commands/validate.ts
    steps:
      - prompt: >
          Create a function called `fixParentChildRelationships` that takes the
          inconsistencies Map and the plans Map as parameters.

          For each parent ID in the inconsistencies Map, retrieve the parent
          plan and its filename from the plans Map.
        done: true
      - prompt: >
          For each parent plan that needs fixing, use readPlanFile to get the
          latest version, then add the missing child IDs to the dependencies
          array.

          Initialize the dependencies array as an empty array if it doesn't
          exist, and ensure no duplicate IDs are added.
        done: true
      - prompt: >
          Update the parent plan's updatedAt field to the current ISO timestamp
          and use writePlanFile to save the changes.

          Return a summary object indicating how many relationships were fixed
          and any errors encountered.
        done: true
  - title: Add reporting for fixed relationships
    done: true
    description: >
      Enhance the console output to show which parent-child relationships were
      fixed. Use chalk for colored output consistent with existing validation
      messages. Include a summary section showing the total number of
      relationships fixed. The reporting should clearly indicate which parent
      plans were updated and which child dependencies were added. Follow the
      existing output patterns in the validate command that use chalk.green for
      success, chalk.yellow for warnings, and chalk.red for errors. Group the
      output logically so users can easily understand what changes were made.
    files:
      - src/rmplan/commands/validate.ts
    steps:
      - prompt: >
          After the auto-fix process, add a new console output section that
          reports on fixed relationships.

          Use chalk.blue.bold for the section header "Parent-Child Relationships
          Fixed:" similar to existing headers.
        done: true
      - prompt: >
          For each fixed relationship, output a line showing the parent plan ID
          and filename, followed by the child IDs that were added.

          Use chalk.green checkmarks for successfully fixed relationships and
          proper indentation for readability.
        done: true
      - prompt: >
          Add the count of fixed relationships to the Summary section at the end
          of the command output.

          Include it as a separate line like "✓ X parent-child relationships
          fixed" using chalk.green when fixes were made.
        done: true
  - title: Add comprehensive tests for validation
    done: true
    description: >
      Create tests in `/src/rmplan/commands/validate.test.ts` covering: plans
      with correct parent-child relationships (should pass), plans with missing
      parent dependencies (should be fixed), multiple children with same parent,
      nested parent-child hierarchies, and edge cases like non-existent parent
      IDs. Follow the existing test patterns that use temporary directories and
      real file operations rather than mocks. Each test should create plan files
      in a temp directory, run the validation command, and verify both the
      console output and the actual file contents after fixing. Use the
      beforeEach/afterEach pattern to set up and tear down temp directories.
    files:
      - src/rmplan/commands/validate.test.ts
    steps:
      - prompt: >
          Add a new describe block for "parent-child validation" after the
          existing validation tests.

          Create a test for the happy path where a child has a parent and the
          parent already includes the child in dependencies - this should pass
          without fixes.
        done: true
      - prompt: >
          Create a test where a child specifies a parent but the parent doesn't
          include the child in dependencies.

          Verify that the validation detects this issue, fixes it by updating
          the parent file, and reports the fix in the output.
        done: true
      - prompt: >
          Add a test for multiple children with the same parent where some are
          missing from the parent's dependencies.

          Verify that all missing children are added to the parent in a single
          update operation.
        done: true
      - prompt: >
          Create a test for edge cases: non-existent parent ID (should report
          error), and a case that would create circular dependency (should not
          fix).

          Also test that the --no-fix flag prevents modifications while still
          reporting issues.
        done: true
  - title: Add --no-fix flag option
    done: true
    description: >
      Add a command-line flag `--no-fix` to allow users to run validation
      without auto-fixing. When this flag is present, the command should report
      inconsistencies but not modify any files. Update the command description
      in rmplan.ts to document this new option. The flag should be a boolean
      option that defaults to false (auto-fix enabled by default). When --no-fix
      is used, the output should clearly indicate that issues were found but not
      fixed, suggesting the user run without the flag to fix them. This follows
      the pattern of other boolean flags in the codebase like --verbose.
    files:
      - src/rmplan/rmplan.ts
      - src/rmplan/commands/validate.ts
    steps:
      - prompt: >
          In rmplan.ts, add a new option to the validate command definition:
          .option('--no-fix', 'Report validation issues without auto-fixing
          them').

          This should go after the existing --verbose option to maintain
          consistent ordering.
        done: true
      - prompt: >
          In validate.ts, modify handleValidateCommand to check for the
          options.noFix flag.

          When the flag is true, skip the auto-fix functionality but still
          report what issues were found.
        done: true
      - prompt: >
          Update the console output to indicate when --no-fix is active, showing
          a message like "Found X parent-child inconsistencies (run without
          --no-fix to auto-fix)".

          Use chalk.yellow for this informational message to distinguish it from
          errors.
        done: true
---

Enhance the existing validate command to check bidirectional parent-child relationships. When a plan has a parent field, verify that the parent plan includes this child in its dependencies array. If not, automatically update the parent plan to add the missing dependency. The implementation should handle multiple children for a single parent, prevent circular dependencies, and provide clear console output about what was fixed.

**Acceptance Criteria:**
- Validation detects all missing parent-child dependencies
- Auto-fix updates parent plans correctly
- Console output clearly reports fixed relationships
- Handles multiple children per parent
- Prevents circular dependency creation
- All existing validation tests still pass
- New tests cover parent-child validation scenarios
