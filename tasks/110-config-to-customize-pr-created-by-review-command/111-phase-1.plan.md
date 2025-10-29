---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: config to customize PR created by review command - Configuration Schema
  and Infrastructure
goal: Add PR creation configuration to the rmplan config schema with proper
  validation
id: 111
uuid: 1c6a10b5-605b-46d5-a1a9-d76e09960672
status: done
priority: high
dependencies: []
parent: 110
references:
  "110": af507cc3-18ae-496b-8e46-952d382494f0
planGeneratedAt: 2025-08-16T00:25:44.550Z
promptsGeneratedAt: 2025-08-16T00:27:33.193Z
createdAt: 2025-08-16T00:21:10.187Z
updatedAt: 2025-10-27T08:39:04.302Z
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
    done: true
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
  - title: Update getDefaultConfig function
    done: true
    description: >
      Modify the `getDefaultConfig` function in `src/rmplan/configSchema.ts` to
      include default values for the new `prCreation` configuration, setting
      `draft: true` to maintain backward compatibility. This ensures that
      existing code that doesn't specify PR creation settings will continue to
      create draft PRs as they do currently.
  - title: Add config schema tests
    done: true
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
