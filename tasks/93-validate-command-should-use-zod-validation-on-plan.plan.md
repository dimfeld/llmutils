---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: validate command should use zod validation on plan files instead of custom code
goal: Convert plan schemas to strict mode and remove manual validation logic
id: 93
status: pending
priority: medium
dependencies: []
planGeneratedAt: 2025-08-09T23:13:19.739Z
createdAt: 2025-08-09T23:01:00.114Z
updatedAt: 2025-08-09T23:13:19.739Z
tasks:
  - title: Update plan schemas to use strict mode
    description: Modify `src/rmplan/planSchema.ts` to add `.strict()` to all object
      schemas including the main `phaseSchema` and nested schemas for tasks,
      steps, and project. Ensure that arrays and other non-object types are not
      affected. Test that the schemas still parse valid plans correctly.
    steps: []
  - title: Remove manual unknown key validation logic
    description: In `src/rmplan/commands/validate.ts`, remove the custom unknown key
      checking code (lines 61-111) that manually inspects parsed objects. The
      validation should now rely entirely on Zod's strict mode to detect unknown
      keys. Update the result handling to properly extract unknown key
      information from Zod errors.
    steps: []
  - title: Update error formatting and reporting
    description: Enhance the error handling in `validatePlanFile` to properly
      extract and format unknown key errors from Zod validation results. Ensure
      that the error messages clearly show the path to unknown keys (e.g.,
      "tasks[0].unknownField") and maintain the current console output format
      with colors.
    steps: []
  - title: Test validation with sample files
    description: |-
      Create test cases or manually verify that:
      - Valid plan files continue to pass validation
      - Plan files with unknown keys at root level are rejected
      - Plan files with unknown keys in tasks are rejected
      - Plan files with unknown keys in steps are rejected
      - Plan files with unknown keys in project are rejected
      - Frontmatter format files are handled correctly
      - Error messages are clear and actionable
    steps: []
  - title: Update existing tests if needed
    description: Review and update any existing tests for the validate command to
      ensure they work with the new strict validation. Add new test cases
      specifically for unknown key detection if they don't already exist. Verify
      that the command still exits with code 1 when invalid files are found.
    steps: []
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
