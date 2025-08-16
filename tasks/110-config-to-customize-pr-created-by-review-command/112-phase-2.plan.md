---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: config to customize PR created by review command - Implementation and
  Integration
goal: Implement PR creation functionality that uses the new configuration options
id: 112
status: done
priority: high
dependencies:
  - 111
parent: 110
planGeneratedAt: 2025-08-16T00:25:44.550Z
promptsGeneratedAt: 2025-08-16T06:51:01.707Z
createdAt: 2025-08-16T00:21:10.187Z
updatedAt: 2025-08-16T07:08:26.510Z
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
    files:
      - src/rmplan/commands/description.ts
    steps:
      - prompt: >
          Add a new interface `PrCreationOptions` before the createPullRequest
          function that includes optional draft (boolean) and titlePrefix
          (string) fields.
        done: true
      - prompt: >
          Update the createPullRequest function signature to accept a third
          parameter of type PrCreationOptions with a default value of an empty
          object.
        done: true
      - prompt: >
          Modify the createPullRequest function implementation to build the gh
          command arguments conditionally. Only add '--draft' to the arguments
          array if options.draft is true. If options.titlePrefix is provided,
          prepend it to the title parameter.
        done: true
      - prompt: >
          Update the spawnAndLogOutput call to use the dynamically built
          arguments array instead of the hardcoded one.
        done: true
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
    files:
      - src/rmplan/commands/description.ts
    steps:
      - prompt: >
          In handleDescriptionCommand, after loading the config, extract the
          prCreation settings into a variable with a default fallback to {
          draft: true } if prCreation is undefined.
        done: true
      - prompt: >
          Update the call to createPullRequest in handleOutputActions to pass
          the prCreation config as the third parameter.
        done: true
      - prompt: >
          Update the interactive handleInteractiveOutput function's
          createPullRequest call to also pass the prCreation config, which will
          need to be passed as a parameter to this function.
        done: true
      - prompt: >
          Modify the handleOutputActions function signature to accept the
          prCreation config and pass it through to both createPullRequest and
          handleInteractiveOutput.
        done: true
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
    files:
      - src/rmplan/utils/file_validation.ts
      - src/rmplan/commands/description.ts
    steps:
      - prompt: >
          Add a new function `sanitizeTitlePrefix` to
          src/rmplan/utils/file_validation.ts that takes a string and returns a
          sanitized version. It should remove control characters, limit length
          to 100 characters, and remove shell metacharacters like backticks,
          dollar signs, and semicolons.
        done: true
      - prompt: >
          Export the sanitizeTitlePrefix function and add comprehensive JSDoc
          documentation explaining its purpose and the sanitization rules it
          applies.
        done: true
      - prompt: >
          Import sanitizeTitlePrefix in src/rmplan/commands/description.ts and
          use it in the createPullRequest function to sanitize the titlePrefix
          before applying it to the title.
        done: true
      - prompt: >
          Add validation in createPullRequest to ensure the combined title
          (prefix + original title) doesn't exceed GitHub's PR title length
          limit of 256 characters, truncating if necessary.
        done: true
  - title: Update description command tests
    done: true
    description: >
      Modify existing tests in `src/rmplan/commands/description.test.ts` to
      account for the new configuration options. Add new test cases for
      draft/non-draft PR creation, title prefix application, and edge cases.
      Update mock configurations to include the prCreation field with
      appropriate test values. Ensure tests verify that the gh command is called
      with the correct arguments based on configuration.
    files:
      - src/rmplan/commands/description.test.ts
    steps:
      - prompt: >
          Update the existing test mocks for loadEffectiveConfig to include
          prCreation configuration with test values like { draft: true } or {
          draft: false, titlePrefix: '[TEST] ' }.
        done: true
      - prompt: >
          Add a new test case that verifies createPullRequest is called without
          the --draft flag when prCreation.draft is false.
        done: true
      - prompt: >
          Add a test case that verifies the title prefix is correctly prepended
          to PR titles when prCreation.titlePrefix is configured.
        done: true
      - prompt: >
          Add a test case that verifies backward compatibility by ensuring draft
          defaults to true when prCreation is not configured.
        done: true
      - prompt: >
          Mock spawnAndLogOutput to capture the gh command arguments and verify
          they match the expected configuration.
        done: true
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
    files:
      - src/rmplan/commands/description.test.ts
    steps:
      - prompt: >
          Add a test suite "PR creation with configuration" that tests the full
          flow from config loading to gh command execution with different
          prCreation configurations.
        done: true
      - prompt: >
          Create a test that verifies sanitization works correctly by attempting
          to use a prefix with dangerous characters and ensuring they are
          properly sanitized.
        done: true
      - prompt: >
          Add a test for the edge case where titlePrefix is very long, verifying
          it gets truncated appropriately to fit within GitHub's title length
          limits.
        done: true
      - prompt: >
          Create a test that verifies the --create-pr CLI flag works correctly
          with both draft and non-draft configurations.
        done: true
      - prompt: >
          Add a test that simulates a real config file with prCreation settings
          and verifies the entire flow works as expected, including proper error
          handling.
        done: true
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
