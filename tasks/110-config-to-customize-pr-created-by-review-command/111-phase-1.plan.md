---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: config to customize PR created by review command - Configuration Schema
  and Infrastructure
goal: Add PR creation configuration to the rmplan config schema with proper
  validation
id: 111
status: pending
priority: high
dependencies: []
parent: 110
planGeneratedAt: 2025-08-16T00:25:44.550Z
promptsGeneratedAt: 2025-08-16T00:27:33.193Z
createdAt: 2025-08-16T00:21:10.187Z
updatedAt: 2025-08-16T00:27:33.193Z
project:
  title: Add configuration options for customizing auto-created PRs in rmplan
  goal: Enable users to configure default settings for PRs created by rmplan
    commands, including draft status and title prefix
  details: >-
    This feature adds configuration options to the project config file that
    control how PRs are created by the `description` command. Currently, PRs are
    always created as drafts with no title prefix customization. The new
    configuration will live under a `prCreation` section in the config schema
    and will apply to all PR creation operations triggered by rmplan commands.
    The implementation must maintain backward compatibility, defaulting to
    draft=true when not specified.


    Acceptance criteria:

    - Config schema includes new `prCreation` section with `draft` and
    `titlePrefix` options

    - The `description` command respects these config values when creating PRs

    - Backward compatibility is maintained (defaults to draft=true)

    - Configuration is properly validated using Zod schema

    - Tests cover all new functionality and edge cases

    - Title prefix is properly sanitized to prevent injection attacks
tasks:
  - title: Add prCreation schema to configSchema.ts
    description: >
      Add a new `prCreation` field to the `rmplanConfigSchema` in
      `src/rmplan/configSchema.ts` with Zod validation for `draft` (boolean,
      optional, default true) and `titlePrefix` (string, optional) fields. The
      schema should be placed alongside other feature-specific configs like
      `review` and `answerPr` (around line 119-236). 


      The schema should follow the established pattern:

      - Use z.object() with .strict() to reject unknown fields

      - Make the entire object optional with .optional()

      - Add .describe() for documentation

      - For the draft field, use .default(true) to maintain backward
      compatibility

      - The titlePrefix field should be a simple optional string (sanitization
      happens at usage time via sanitizeProcessInput)
    files:
      - src/rmplan/configSchema.ts
    steps:
      - prompt: >
          Add a new `prCreation` configuration section to the rmplanConfigSchema
          after the `answerPr` section (around line 135).

          Include two fields: `draft` (boolean, optional, default true with
          description about PR draft status) and 

          `titlePrefix` (string, optional with description about prefix added to
          PR titles).

          Follow the same pattern as the `answerPr` and `review` sections using
          .strict().optional() with proper descriptions.
        done: false
  - title: Update getDefaultConfig function
    description: >
      Modify the `getDefaultConfig` function in `src/rmplan/configSchema.ts` to
      include default values for the new `prCreation` configuration, setting
      `draft: true` to maintain backward compatibility. This ensures that
      existing code that doesn't specify PR creation settings will continue to
      create draft PRs as they do currently.
    files:
      - src/rmplan/configSchema.ts
    steps:
      - prompt: >
          Update the getDefaultConfig function to include a `prCreation` field
          with `{ draft: true }` as the default value.

          This maintains backward compatibility by ensuring PRs are created as
          drafts by default when config doesn't specify otherwise.
        done: false
  - title: Add config schema tests
    description: >
      Create comprehensive tests in `src/rmplan/configSchema.test.ts` for the
      new `prCreation` configuration. Tests should follow the established
      patterns from the existing `review` and `agents` test blocks and cover:

      - Valid configurations with both draft and titlePrefix fields

      - Partial configurations (only draft, only titlePrefix)

      - Default value verification (draft defaults to true when not specified)

      - Type validation (rejecting non-boolean for draft, non-string for
      titlePrefix)

      - Empty prCreation object handling

      - Unknown field rejection due to .strict()

      - Integration with other config fields

      - Edge cases like empty string for titlePrefix and special characters
    files:
      - src/rmplan/configSchema.test.ts
    steps:
      - prompt: >
          Add a new describe block for 'prCreation field' in
          configSchema.test.ts following the pattern of the existing 'review
          field' tests.

          Include tests for valid configurations with all fields, partial
          configs, and ensure the field is optional.
        done: false
      - prompt: >
          Add tests to verify draft field defaults to true when not specified in
          config and when prCreation object exists but draft is undefined.

          Also test that explicitly setting draft to false is preserved
          correctly.
        done: false
      - prompt: >
          Add validation tests that reject invalid types: non-boolean values for
          draft and non-string values for titlePrefix.

          Include tests for null and numeric values following the existing
          validation test patterns.
        done: false
      - prompt: >
          Add tests for edge cases including empty titlePrefix string (should be
          valid), special characters in titlePrefix,

          empty prCreation object, and rejection of unknown fields within
          prCreation due to .strict().
        done: false
      - prompt: >
          Add a test verifying prCreation works correctly alongside other
          configuration fields like issueTracker and review.

          Also update the getDefaultConfig test to verify it includes the new
          prCreation field with draft: true.
        done: false
rmfilter:
  - src/rmplan/configSchema.ts
  - src/rmplan/commands/description.ts
  - --with-imports
---

Create the configuration schema for PR creation options and ensure it integrates properly with the existing config loading system. This phase establishes the foundation for PR customization by defining the config structure, validation rules, and default values.

Acceptance criteria:
- New `prCreation` config section is added to `rmplanConfigSchema`
- Schema includes `draft` (boolean, optional, default true) and `titlePrefix` (string, optional) fields
- Default configuration maintains backward compatibility
- Schema validation properly handles invalid inputs
- Config loading correctly merges user config with defaults
