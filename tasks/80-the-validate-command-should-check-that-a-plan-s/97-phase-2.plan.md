---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: The validate command should check that a plan's parent also depends on
  the child and automatically fix that if it doesn't. - Consistency Updates for
  Related Commands
goal: Update the set command and other related commands to maintain
  bidirectional parent-child relationships automatically
id: 97
status: pending
priority: medium
dependencies:
  - 96
parent: 80
planGeneratedAt: 2025-08-12T00:46:31.546Z
promptsGeneratedAt: 2025-08-12T01:22:51.307Z
createdAt: 2025-07-29T19:17:43.223Z
updatedAt: 2025-08-12T01:22:51.307Z
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
    files:
      - src/rmplan/commands/set.ts
    steps:
      - prompt: >
          Modify the "Set parent" section (lines 107-123) to also update the
          parent plan's dependencies array. Load the parent plan, add the
          current plan's ID to its dependencies if not already present, update
          its updatedAt timestamp, and save it back to disk.
        done: false
      - prompt: >
          Modify the "Remove parent" section (lines 125-134) to also update the
          old parent plan. Before deleting the parent field, store the old
          parent ID, then load that parent plan, remove the current plan's ID
          from its dependencies array, update its updatedAt timestamp, and save
          it.
        done: false
      - prompt: >
          Add logic to handle changing parents. In the "Set parent" section,
          first check if the plan already has a parent. If it does and it's
          different from the new parent, remove the child from the old parent's
          dependencies before adding it to the new parent's dependencies.
        done: false
      - prompt: >
          Add circular dependency prevention by importing and using the
          `wouldCreateCircularDependency` function from validate.ts. Before
          adding a child to a parent's dependencies, check if it would create a
          cycle and throw an error if it would.
        done: false
  - title: Add tests for set command updates
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
    files:
      - src/rmplan/commands/set.test.ts
    steps:
      - prompt: >
          Add a test "should update parent plan dependencies when setting
          parent" that creates two plans, sets one as the parent of the other,
          then verifies both the child has the parent field set AND the parent
          has the child in its dependencies array.
        done: false
      - prompt: >
          Add a test "should remove child from parent dependencies when removing
          parent" that creates a parent-child relationship, then uses
          --no-parent to remove it, and verifies the child is removed from the
          parent's dependencies array.
        done: false
      - prompt: >
          Add a test "should update both old and new parent when changing
          parent" that creates three plans (child, old parent, new parent),
          establishes initial relationship, changes the parent, then verifies
          old parent no longer has the child in dependencies and new parent
          does.
        done: false
      - prompt: >
          Add a test "should prevent circular dependencies when setting parent"
          that creates two plans where plan A depends on plan B, then attempts
          to set plan B's parent to plan A, and verifies this throws an
          appropriate error.
        done: false
      - prompt: >
          Add a test "should handle setting parent to same value without
          duplicating dependencies" that sets a parent, then sets the same
          parent again, and verifies the parent's dependencies array doesn't
          contain duplicate entries.
        done: false
  - title: Update documentation
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
    files:
      - README.md
      - CLAUDE.md
    steps:
      - prompt: >
          In README.md, add a new subsection under the rmplan section called
          "### Plan Validation" that documents the validate command. Explain
          that it validates plan file schemas and parent-child relationships,
          automatically fixing inconsistencies where child plans reference
          parents that don't include them in dependencies. Include a usage
          example.
        done: false
      - prompt: >
          In README.md, update the documentation for the set command to explain
          that when setting or changing a parent, it automatically updates the
          parent plan's dependencies to maintain bidirectional relationships.
          Add examples showing --parent and --no-parent usage.
        done: false
      - prompt: >
          In CLAUDE.md under the "## Repository Structure" section where rmplan
          is described, add a note about the automatic parent-child relationship
          maintenance feature. Explain that all commands (add, set, validate)
          work together to ensure consistency in the dependency graph.
        done: false
      - prompt: >
          Create a documentation file at docs/parent-child-relationships.md that
          provides a comprehensive guide to working with parent-child plan
          relationships, including examples of creating hierarchical plans, how
          the automatic maintenance works, and best practices for organizing
          multi-phase projects.
        done: false
  - title: Add integration tests
    description: >
      Create integration tests that verify the complete workflow: creating plans
      with parents using add command, modifying relationships with set command,
      and validating with the validate command. Ensure all commands work
      together to maintain consistency.


      The tests should simulate real-world usage patterns and verify that the
      parent-child relationships remain consistent across all operations. Place
      these in a new test file or add to cli_integration.test.ts if appropriate.
    files:
      - src/rmplan/commands/cli_integration.test.ts
    steps:
      - prompt: >
          Add an integration test "parent-child workflow with add and validate"
          that uses the add command to create a parent plan and child plan with
          --parent option, then runs validate to ensure no inconsistencies are
          found.
        done: false
      - prompt: >
          Add an integration test "parent-child workflow with set and validate"
          that creates two independent plans, uses set command to establish
          parent-child relationship, runs validate to ensure no inconsistencies,
          then uses set --no-parent to remove the relationship and validates
          again.
        done: false
      - prompt: >
          Add an integration test "complex hierarchy validation" that creates a
          multi-level hierarchy (grandparent -> parent -> child), modifies
          relationships using set command, and validates the entire structure
          remains consistent after each change.
        done: false
      - prompt: >
          Add an integration test "validate auto-fix integration" that manually
          creates an inconsistent state (child with parent field but parent
          missing dependency), runs validate command, then verifies the parent
          plan was automatically updated to include the child.
        done: false
---

Ensure that all commands that can modify parent-child relationships maintain bidirectional consistency. The set command should be updated to automatically update parent dependencies when setting or changing a parent field. Similarly, when removing a parent relationship, the child should be removed from the parent's dependencies. This phase ensures the codebase maintains consistency going forward, preventing the issues that the validate command fixes.

**Acceptance Criteria:**
- Set command updates parent dependencies when setting a parent
- Set command removes child from parent dependencies when removing parent relationship
- Changing a parent updates both old and new parent plans
- All modifications maintain file consistency
- Tests verify bidirectional updates work correctly
- Documentation updated to reflect new behavior
