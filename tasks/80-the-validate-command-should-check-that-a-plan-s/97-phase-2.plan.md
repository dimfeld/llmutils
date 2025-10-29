---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The validate command should check that a plan's parent also depends on
  the child and automatically fix that if it doesn't. - Consistency Updates for
  Related Commands
goal: Update the set command and other related commands to maintain
  bidirectional parent-child relationships automatically
id: 97
uuid: 81217254-4279-4c6d-a59d-878a6720c441
status: done
priority: medium
dependencies:
  - 96
parent: 80
planGeneratedAt: 2025-08-12T00:46:31.546Z
promptsGeneratedAt: 2025-08-12T01:22:51.307Z
createdAt: 2025-07-29T19:17:43.223Z
updatedAt: 2025-10-27T08:39:04.314Z
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
  - title: Update set command for parent field changes
    done: true
    description: >
      Modify `/src/rmplan/commands/set.ts` to handle parent field updates
      bidirectionally. When setting a parent, load the parent plan and add the
      child to its dependencies. When removing a parent (--no-parent), remove
      the child from the old parent's dependencies. Handle changing parents by
      updating both old and new parent plans.


      Follow the pattern established in `/src/rmplan/commands/add.ts` (lines
      95-121) where it updates the parent's dependencies when creating a child
      plan. Use the same approach from the validate command for loading and
      updating plans.


      Key scenarios to handle:

      - Setting a parent when none exists: Add child ID to parent's dependencies
      array

      - Removing a parent: Remove child ID from parent's dependencies array  

      - Changing from one parent to another: Remove from old parent's
      dependencies, add to new parent's dependencies

      - Prevent circular dependencies using the validation logic from
      validate.ts
  - title: Add tests for set command updates
    done: true
    description: >
      Create comprehensive tests in `/src/rmplan/commands/set.test.ts` for the
      new bidirectional behavior. The test file already exists and has good
      examples of testing patterns (creating test plans, checking updates,
      etc.).


      Test scenarios to cover:

      - Setting a parent updates parent's dependencies

      - Removing a parent updates parent's dependencies

      - Changing parents updates both old and new parents

      - Error handling for non-existent parents (already exists)

      - Preventing circular dependencies

      - Edge cases like setting parent to same value, removing non-existent
      parent relationship


      Follow the existing test patterns in the file, using temporary directories
      and the createTestPlan helper function.
  - title: Update documentation
    done: true
    description: >
      Update the README and CLAUDE.md files to document the new validation
      behavior and the automatic maintenance of bidirectional parent-child
      relationships. Include examples of how the validation works and when
      auto-fixing occurs.


      Key points to document:

      - The validate command now checks and auto-fixes parent-child
      relationships

      - The set command automatically maintains bidirectional relationships

      - The add command already maintains these relationships (existing
      behavior)

      - Examples of common workflows with parent-child plans

      - How circular dependency prevention works
  - title: Add integration tests
    done: true
    description: >
      Create integration tests that verify the complete workflow: creating plans
      with parents using add command, modifying relationships with set command,
      and validating with the validate command. Ensure all commands work
      together to maintain consistency.


      The tests should simulate real-world usage patterns and verify that the
      parent-child relationships remain consistent across all operations. Place
      these in a new test file or add to cli_integration.test.ts if appropriate.
---

Ensure that all commands that can modify parent-child relationships maintain bidirectional consistency. The set command should be updated to automatically update parent dependencies when setting or changing a parent field. Similarly, when removing a parent relationship, the child should be removed from the parent's dependencies. This phase ensures the codebase maintains consistency going forward, preventing the issues that the validate command fixes.

**Acceptance Criteria:**
- Set command updates parent dependencies when setting a parent
- Set command removes child from parent dependencies when removing parent relationship
- Changing a parent updates both old and new parent plans
- All modifications maintain file consistency
- Tests verify bidirectional updates work correctly
- Documentation updated to reflect new behavior
