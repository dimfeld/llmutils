---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: config to customize PR created by review command - Implementation and
  Integration
goal: Implement PR creation functionality that uses the new configuration options
id: 112
uuid: af4a9d46-1e69-459c-b9b7-2b3057cf2f0b
status: done
priority: high
dependencies:
  - 111
parent: 110
references:
  "110": af507cc3-18ae-496b-8e46-952d382494f0
  "111": 1c6a10b5-605b-46d5-a1a9-d76e09960672
planGeneratedAt: 2025-08-16T00:25:44.550Z
promptsGeneratedAt: 2025-08-16T06:51:01.707Z
createdAt: 2025-08-16T00:21:10.187Z
updatedAt: 2025-10-27T08:39:04.298Z
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
  - title: Update createPullRequest function to use config
    done: true
    description: >
      Modify the `createPullRequest` function in
      `src/rmplan/commands/description.ts` to accept configuration options and
      use them when building the `gh pr create` command. Remove the hardcoded
      `--draft` flag and make it conditional based on config. The function
      should accept a new parameter for PR creation options that includes the
      draft setting and titlePrefix. When building the gh command arguments,
      only include the --draft flag if the config.draft is true. The title
      parameter should have the prefix prepended if configured.
  - title: Load and apply prCreation config in description command
    done: true
    description: >
      Update `handleDescriptionCommand` in `src/rmplan/commands/description.ts`
      to load the `prCreation` config from the effective configuration and pass
      it to the `createPullRequest` function. The config is already loaded via
      loadEffectiveConfig, so we need to extract the prCreation settings and
      apply them when creating PRs. Apply title prefix if configured, ensuring
      it's properly combined with the plan title. Default to draft:true if
      prCreation is not configured to maintain backward compatibility.
  - title: Add title prefix sanitization
    done: true
    description: >
      Implement a sanitization function for the title prefix to prevent command
      injection and ensure the prefix is safe to use in shell commands and PR
      titles. Include validation for maximum length and allowed characters. The
      function should be added to the file_validation utilities and used when
      applying the title prefix. Sanitization should remove control characters,
      limit length to 100 characters, and ensure no shell metacharacters that
      could break the gh command are present.
  - title: Update description command tests
    done: true
    description: >
      Modify existing tests in `src/rmplan/commands/description.test.ts` to
      account for the new configuration options. Add new test cases for
      draft/non-draft PR creation, title prefix application, and edge cases.
      Update mock configurations to include the prCreation field with
      appropriate test values. Ensure tests verify that the gh command is called
      with the correct arguments based on configuration.
  - title: Add integration tests for config-driven PR creation
    done: true
    description: >
      Create integration tests that verify the end-to-end flow of loading config
      and creating PRs with the specified settings, including scenarios with
      missing config, partial config, and various prefix formats. Tests should
      cover edge cases like very long prefixes, special characters in prefixes,
      and the interaction between CLI flags and config settings. These tests
      should verify the actual gh command construction rather than just mocking
      everything.
rmfilter:
  - src/rmplan/configSchema.ts
  - src/rmplan/commands/description.ts
  - --with-imports
---

Update the PR creation logic in the `description` command to read and apply the configuration values. The implementation must handle title prefix application, respect the draft setting, and maintain security through proper input sanitization.

Acceptance criteria:
- `createPullRequest` function uses config values instead of hardcoded draft flag
- Title prefix is correctly prepended to PR titles when configured
- Input sanitization prevents injection attacks
- Existing tests are updated to work with new functionality
- New tests cover config-driven PR creation scenarios
- Error handling covers configuration-related failures
