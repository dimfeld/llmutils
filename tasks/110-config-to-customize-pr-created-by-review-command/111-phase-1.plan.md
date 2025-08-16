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
createdAt: 2025-08-16T00:21:10.187Z
updatedAt: 2025-08-16T00:25:44.550Z
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
    description: Add a new `prCreation` field to the `rmplanConfigSchema` in
      `src/rmplan/configSchema.ts` with Zod validation for `draft` (boolean,
      optional, default true) and `titlePrefix` (string, optional) fields. The
      schema should be placed alongside other feature-specific configs like
      `review` and `answerPr`.
    steps: []
  - title: Update getDefaultConfig function
    description: "Modify the `getDefaultConfig` function in
      `src/rmplan/configSchema.ts` to include default values for the new
      `prCreation` configuration, setting `draft: true` to maintain backward
      compatibility."
    steps: []
  - title: Add config schema tests
    description: Create comprehensive tests in `src/rmplan/configSchema.test.ts` for
      the new `prCreation` configuration, including validation of valid configs,
      rejection of invalid types, proper default values, and edge cases like
      empty strings or special characters in titlePrefix.
    steps: []
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
