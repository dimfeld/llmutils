---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: validate command should use zod validation on plan files instead of custom code
goal: Convert plan schemas to strict mode and remove manual validation logic
id: 93
uuid: 4db1972d-6a70-4226-baba-016a8d1284e0
status: done
priority: medium
planGeneratedAt: 2025-08-09T23:13:19.739Z
promptsGeneratedAt: 2025-08-09T23:15:52.375Z
createdAt: 2025-08-09T23:01:00.114Z
updatedAt: 2025-10-27T08:39:04.240Z
tasks:
  - title: Update plan schemas to use strict mode
    done: true
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
  - title: Remove manual unknown key validation logic
    done: true
    description: >
      In `src/rmplan/commands/validate.ts`, remove the custom unknown key
      checking code (lines 61-111) that manually inspects parsed objects. The
      validation should now rely entirely on Zod's strict mode to detect unknown
      keys. The existing error handling already processes Zod's
      unrecognized_keys errors (line 127), so the result handling just needs
      minor adjustments to work with the automatic validation from strict mode.
      The removal should maintain the same ValidationResult interface structure
      to preserve compatibility with the rest of the command.
  - title: Update error formatting and reporting
    done: true
    description: >
      Enhance the error handling in `validatePlanFile` to properly extract and
      format unknown key errors from Zod validation results. With strict mode,
      Zod will provide the full path to unknown keys in its error issues. Ensure
      that the error messages clearly show the path to unknown keys (e.g.,
      "tasks[0].unknownField") and maintain the current console output format
      with colors. The existing handling of unrecognized_keys should be updated
      to extract the full path information from Zod's error issues.
  - title: Test validation with sample files
    done: true
    description: >
      Create test cases or manually verify that the strict validation works
      correctly for various scenarios. This includes testing valid plan files
      continue to pass, files with unknown keys at different levels are rejected
      with clear error messages, frontmatter format files are handled correctly,
      and the command exits with code 1 when invalid files are found. Create
      temporary test files in the test to verify each scenario, following the
      pattern used in other rmplan tests that create temporary directories with
      fs.mkdtemp().
  - title: Update existing tests if needed
    done: true
    description: >
      Review and update any existing tests for the validate command to ensure
      they work with the new strict validation. Add new test cases specifically
      for unknown key detection if they don't already exist. Check any tests
      that create plan objects programmatically to ensure they don't include
      extra fields that would now be rejected by strict validation. Verify that
      the command still exits with code 1 when invalid files are found. Run all
      rmplan tests to ensure no regressions were introduced.
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
