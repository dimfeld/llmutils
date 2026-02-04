---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: The validate command should check that a plan's parent also depends on
  the child and automatically fix that if it doesn't. - Core Validation and
  Auto-Fix Implementation
goal: Implement the parent-child dependency validation logic in the validate
  command with automatic fixing capability
id: 96
uuid: 15d32fa0-5ff0-4bdc-9ac1-d7b982c50509
status: done
priority: high
dependencies: []
parent: 80
references:
  "80": 64642ea2-101e-48ce-a7bb-f69b8f961291
planGeneratedAt: 2025-08-12T00:46:31.546Z
promptsGeneratedAt: 2025-08-12T00:49:25.602Z
createdAt: 2025-07-29T19:17:43.223Z
updatedAt: 2025-10-27T08:39:04.320Z
project:
  title: Implement parent-child dependency validation and auto-fix in tim
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
      Modify `/src/tim/commands/validate.ts` to add a new validation phase
      after schema validation that checks parent-child relationships. Create a
      function that iterates through all plans, identifies those with parent
      fields, and verifies the parent includes them in dependencies. Track which
      relationships need fixing. Use the existing `readAllPlans` function to
      load all plans at once for cross-referencing. The validation should happen
      after the schema validation phase so we know all plans are structurally
      valid. Store validation results in a data structure that tracks which
      parent plans need updating and what child IDs should be added to their
      dependencies.
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
  - title: Add comprehensive tests for validation
    done: true
    description: >
      Create tests in `/src/tim/commands/validate.test.ts` covering: plans
      with correct parent-child relationships (should pass), plans with missing
      parent dependencies (should be fixed), multiple children with same parent,
      nested parent-child hierarchies, and edge cases like non-existent parent
      IDs. Follow the existing test patterns that use temporary directories and
      real file operations rather than mocks. Each test should create plan files
      in a temp directory, run the validation command, and verify both the
      console output and the actual file contents after fixing. Use the
      beforeEach/afterEach pattern to set up and tear down temp directories.
  - title: Add --no-fix flag option
    done: true
    description: >
      Add a command-line flag `--no-fix` to allow users to run validation
      without auto-fixing. When this flag is present, the command should report
      inconsistencies but not modify any files. Update the command description
      in tim.ts to document this new option. The flag should be a boolean
      option that defaults to false (auto-fix enabled by default). When --no-fix
      is used, the output should clearly indicate that issues were found but not
      fixed, suggesting the user run without the flag to fix them. This follows
      the pattern of other boolean flags in the codebase like --verbose.
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
