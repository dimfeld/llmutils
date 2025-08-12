---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The validate command should check that a plan's parent also depends on
  the child and automatically fix that if it doesn't. - Core Validation and
  Auto-Fix Implementation
goal: Implement the parent-child dependency validation logic in the validate
  command with automatic fixing capability
id: 96
status: pending
priority: high
dependencies: []
parent: 80
planGeneratedAt: 2025-08-12T00:46:31.546Z
createdAt: 2025-07-29T19:17:43.223Z
updatedAt: 2025-08-12T00:46:31.546Z
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
    description: Modify `/src/rmplan/commands/validate.ts` to add a new validation
      phase after schema validation that checks parent-child relationships.
      Create a function that iterates through all plans, identifies those with
      parent fields, and verifies the parent includes them in dependencies.
      Track which relationships need fixing.
    steps: []
  - title: Implement auto-fix functionality
    description: Add logic to automatically update parent plans when missing
      dependencies are detected. This includes reading the parent plan file,
      adding the child ID to the dependencies array if not present, updating the
      updatedAt timestamp, and writing the file back. Ensure proper error
      handling for file operations.
    steps: []
  - title: Add reporting for fixed relationships
    description: Enhance the console output to show which parent-child relationships
      were fixed. Use chalk for colored output consistent with existing
      validation messages. Include a summary section showing the total number of
      relationships fixed.
    steps: []
  - title: Add comprehensive tests for validation
    description: "Create tests in `/src/rmplan/commands/validate.test.ts` covering:
      plans with correct parent-child relationships (should pass), plans with
      missing parent dependencies (should be fixed), multiple children with same
      parent, nested parent-child hierarchies, and edge cases like non-existent
      parent IDs."
    steps: []
  - title: Add --no-fix flag option
    description: Add a command-line flag `--no-fix` to allow users to run validation
      without auto-fixing. When this flag is present, the command should report
      inconsistencies but not modify any files. Update the command description
      in rmplan.ts to document this new option.
    steps: []
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
