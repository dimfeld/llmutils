---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: validate command should use zod validation on plan files instead of custom code
goal: Convert plan schemas to strict mode and remove manual validation logic
id: 93
status: in_progress
priority: medium
dependencies: []
planGeneratedAt: 2025-08-09T23:13:19.739Z
promptsGeneratedAt: 2025-08-09T23:15:52.375Z
createdAt: 2025-08-09T23:01:00.114Z
updatedAt: 2025-08-09T23:18:34.328Z
tasks:
  - title: Update plan schemas to use strict mode
    description: >
      Modify `src/rmplan/planSchema.ts` to add `.strict()` to all object schemas
      including the main `phaseSchema` and nested schemas for tasks, steps, and
      project. This follows the pattern used successfully in
      `src/rmfilter/config.ts` where schemas use `.strict()` to automatically
      reject unknown properties. Ensure that arrays and other non-object types
      are not affected. The implementation should maintain backward
      compatibility - all existing valid plan files must continue to parse
      correctly. Test that the schemas still parse valid plans correctly after
      adding strict mode.
    files:
      - src/rmplan/planSchema.ts
    done: true
    steps:
      - prompt: >
          Add `.strict()` to the main phaseSchema object (after line 60, before
          the .describe() call).

          Follow the pattern from src/rmfilter/config.ts where .strict() is
          chained before .describe().
        done: true
      - prompt: >
          Add `.strict()` to the nested project object schema (after line 36,
          within the project field definition).

          Ensure the .optional() call remains at the end of the chain.
        done: true
      - prompt: >
          Add `.strict()` to the task object schema within the tasks array
          (after line 55, within the array definition).

          This should be added to the z.object() that defines each task's
          structure.
        done: true
      - prompt: >
          Add `.strict()` to the step object schema within the steps array
          (after line 52, within the nested array).

          Ensure this is added to the z.object() that defines each step's
          structure.
        done: true
      - prompt: >
          Verify that multiPhasePlanSchema also uses `.strict()` (after line
          76).

          This ensures consistency across all plan-related schemas.
        done: true
  - title: Remove manual unknown key validation logic
    description: >
      In `src/rmplan/commands/validate.ts`, remove the custom unknown key
      checking code (lines 61-111) that manually inspects parsed objects. The
      validation should now rely entirely on Zod's strict mode to detect unknown
      keys. The existing error handling already processes Zod's
      unrecognized_keys errors (line 127), so the result handling just needs
      minor adjustments to work with the automatic validation from strict mode.
      The removal should maintain the same ValidationResult interface structure
      to preserve compatibility with the rest of the command.
    files:
      - src/rmplan/commands/validate.ts
    done: true
    steps:
      - prompt: >
          Remove the entire manual unknown key checking block (lines 61-111).

          This includes all the manual checking for root keys, task keys, step
          keys, and project keys.
        done: true
      - prompt: >
          Update the success case handling to simply return { filename, isValid:
          true } when result.success is true.

          Remove the conditional logic that was checking for unknown keys after
          successful validation.
        done: true
      - prompt: >
          Ensure the error case handling (starting around line 122) remains
          intact as it already handles unrecognized_keys from Zod.

          The existing logic for extracting unknown keys from issue.code ===
          z.ZodIssueCode.unrecognized_keys should continue to work.
        done: true
  - title: Update error formatting and reporting
    description: >
      Enhance the error handling in `validatePlanFile` to properly extract and
      format unknown key errors from Zod validation results. With strict mode,
      Zod will provide the full path to unknown keys in its error issues. Ensure
      that the error messages clearly show the path to unknown keys (e.g.,
      "tasks[0].unknownField") and maintain the current console output format
      with colors. The existing handling of unrecognized_keys should be updated
      to extract the full path information from Zod's error issues.
    files:
      - src/rmplan/commands/validate.ts
    done: true
    steps:
      - prompt: >
          Update the unrecognized_keys handling to include the path information
          in the unknown keys array.

          When issue.code === z.ZodIssueCode.unrecognized_keys, combine the
          issue.path with issue.keys to create full paths like
          "tasks[0].unknownKey".
        done: true
      - prompt: >
          Ensure the error message formatting preserves the existing structure
          with proper indentation and chalk colors.

          The unknownKeys array should contain full paths to make it clear where
          the unknown keys are located.
        done: true
      - prompt: >
          Verify that the ValidationResult interface and return structure remain
          unchanged to maintain compatibility.

          The errors and unknownKeys arrays should continue to be populated as
          before.
        done: true
  - title: Test validation with sample files
    description: >
      Create test cases or manually verify that the strict validation works
      correctly for various scenarios. This includes testing valid plan files
      continue to pass, files with unknown keys at different levels are rejected
      with clear error messages, frontmatter format files are handled correctly,
      and the command exits with code 1 when invalid files are found. Create
      temporary test files in the test to verify each scenario, following the
      pattern used in other rmplan tests that create temporary directories with
      fs.mkdtemp().
    files:
      - src/rmplan/commands/validate.test.ts
    steps:
      - prompt: >
          Create a new test file for the validate command using Bun's test
          framework.

          Set up beforeEach and afterEach hooks to create and clean up temporary
          directories, following the pattern from plan_file_validation.test.ts.
        done: true
      - prompt: >
          Add a test case for valid plan files that verifies they pass
          validation without errors.

          Create a valid plan with all standard fields and ensure isValid is
          true.
        done: true
      - prompt: >
          Add test cases for unknown keys at the root level.

          Create a plan with an extra field like "unknownField" at the root and
          verify it's detected with the correct path.
        done: true
      - prompt: >
          Add test cases for unknown keys in tasks array.

          Create plans with unknown fields in task objects and verify the error
          messages show paths like "tasks[0].unknownField".
        done: true
      - prompt: >
          Add test cases for unknown keys in steps and project sections.

          Verify that nested unknown keys are properly detected with full paths
          like "tasks[0].steps[1].unknownField" and "project.unknownField".
        done: true
      - prompt: >
          Add a test for frontmatter format validation.

          Create a plan file with YAML frontmatter delimited by --- and verify
          it's parsed and validated correctly.
        done: true
      - prompt: >
          Add an integration test that runs the actual validate command and
          checks the exit code.

          Verify that invalid files cause process.exit(1) to be called.
        done: true
  - title: Update existing tests if needed
    description: >
      Review and update any existing tests for the validate command to ensure
      they work with the new strict validation. Add new test cases specifically
      for unknown key detection if they don't already exist. Check any tests
      that create plan objects programmatically to ensure they don't include
      extra fields that would now be rejected by strict validation. Verify that
      the command still exits with code 1 when invalid files are found. Run all
      rmplan tests to ensure no regressions were introduced.
    files:
      - src/rmplan/commands/import/plan_file_validation.test.ts
      - src/rmplan/process_markdown.test.ts
    steps:
      - prompt: >
          Review plan_file_validation.test.ts to ensure the plan objects created
          in tests don't have any unknown fields.

          Update any test data that might have extra fields that would now be
          rejected by strict validation.
        done: true
      - prompt: >
          Check process_markdown.test.ts for any tests that validate plan
          schemas.

          Ensure test data conforms to the strict schema requirements.
        done: true
      - prompt: >
          Run the full rmplan test suite with `bun test src/rmplan` to identify
          any failing tests.

          Fix any tests that fail due to the stricter validation by removing
          unknown fields from test data.
        done: true
      - prompt: >
          Add a specific test case to validate.test.ts that verifies the command
          returns exit code 1 for invalid files.

          Mock process.exit if needed to capture the exit code without actually
          terminating the test process.
        done: true
---

The validate command currently uses Zod for basic schema validation but then manually checks for unknown keys in a custom implementation spanning 50+ lines of code. By converting the plan schemas to use Zod's `.strict()` mode, we can eliminate this custom logic while maintaining the same validation behavior. This approach is already used successfully in other parts of the codebase (e.g., rmfilter config schemas).

The implementation must:
- Maintain backward compatibility with existing plan files
- Preserve the current error reporting format and user experience
- Handle both YAML and markdown frontmatter formats correctly
- Ensure all nested schemas (tasks, steps, project) properly validate unknown keys

Acceptance criteria:
- All existing valid plan files continue to pass validation
- Unknown keys at any level (root, tasks, steps, project) are detected and reported
- Error messages clearly indicate the path to unknown keys
- The validate command exits with error code 1 when invalid files are found
- Verbose mode continues to show valid files when requested

This phase will update the Zod schemas to use strict mode validation, which automatically rejects unknown properties. The implementation will modify the schema definitions and simplify the validation logic in the validate command. All existing functionality must be preserved, including support for frontmatter format and proper error reporting.

Acceptance criteria for this phase:
- All schemas use `.strict()` mode appropriately
- Manual unknown key checking code is completely removed
- Error messages maintain or improve clarity
- All existing tests pass
- New tests verify unknown key detection at all levels
