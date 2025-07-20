---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add ability to rmplan config file to set "direct" mode in generate and
  prepare commands by default
goal: This phase will deliver the complete functionality by updating the
  configuration model, modifying the CLI commands to respect the new setting,
  adding comprehensive tests, and documenting the feature.
id: 70
status: done
priority: high
dependencies: []
planGeneratedAt: 2025-07-20T00:53:52.277Z
promptsGeneratedAt: 2025-07-20T00:59:04.282Z
createdAt: 2025-07-20T00:24:53.615Z
updatedAt: 2025-07-20T05:14:36.700Z
project:
  title: Add `direct_mode` Configuration Option
  goal: The project's goal is to introduce a new configuration option,
    `planning.direct_mode`, in the `rmplan` config file. This will allow users
    to set "direct" mode as the default behavior for the `generate` and
    `prepare` commands, improving user experience and workflow customization.
  details: >-
    This project involves updating the `rmplan` configuration system and the
    command-line interface for the `generate` and `prepare` commands.


    **Analysis of Work:**

    1.  **Configuration Model:** The configuration data structure needs to be
    extended to include a new boolean field, `direct_mode`. The system must
    handle cases where this field is missing from existing user configurations,
    defaulting to `false` to ensure backward compatibility.

    2.  **CLI Logic:** The `generate` and `prepare` commands must be updated.
    Their logic for determining whether to run in "direct" mode will be changed
    to a clear order of precedence:
        1.  A command-line flag (`--direct` or `--no-direct`) will always have the highest priority.
        2.  If no flag is provided, the value of `direct_mode` from the configuration file will be used.
        3.  If the setting is not in the configuration file, the system will default to non-direct mode (`false`).
    3.  **Testing:** Comprehensive tests are required to validate the new logic,
    ensuring that the command-line flags correctly override the configuration
    setting and that the default behaviors work as expected.

    4.  **Documentation:** User documentation, including the `README.md`, must
    be updated to explain the new configuration option and its behavior.


    **Acceptance Criteria:**

    - A new boolean option `planning.direct_mode` can be added to the `rmplan`
    config file.

    - When `direct_mode` is `true`, `rmplan generate` and `rmplan prepare`
    execute in "direct" mode by default.

    - The `--no-direct` command-line flag successfully overrides a configuration
    of `direct_mode: true`.

    - When `direct_mode` is `false` or absent, the commands execute in
    non-direct mode by default.

    - The `--direct` command-line flag successfully overrides a configuration of
    `direct_mode: false`.

    - The project's documentation is updated to reflect the new feature.
tasks:
  - title: Add `direct_mode` to Configuration Model
    description: Update the configuration data class to include the new optional
      boolean field `planning.direct_mode`. This change will ensure that the
      configuration loading mechanism recognizes the new setting and defaults it
      to `False` if it's not present in a user's config file, maintaining
      backward compatibility.
    files:
      - src/rmplan/configSchema.ts
    steps:
      - prompt: >
          In `src/rmplan/configSchema.ts`, add a new optional object named
          `planning` to the `rmplanConfigSchema`.
        done: true
      - prompt: >
          Within the new `planning` object in `rmplanConfigSchema`, add an
          optional boolean field named `direct_mode`. This field will control
          the default behavior for direct mode in the `generate` and `prepare`
          commands.
        done: true
  - title: Update `generate` and `prepare` Commands to Use New Config
    description: Modify the `generate` and `prepare` command functions to
      incorporate the new configuration setting. The implementation will
      prioritize the command-line flags (`--direct`/`--no-direct`) over the
      `direct_mode` setting from the config file, which in turn will be used as
      the default if no flag is specified.
    files:
      - src/rmplan/rmplan.ts
      - src/rmplan/commands/generate.ts
      - src/rmplan/commands/prepare.ts
    steps:
      - prompt: >
          In `src/rmplan/rmplan.ts`, update the `generate` and `prepare` command
          definitions to include a `--no-direct` flag. This will allow users to
          override a `direct_mode: true` setting from the configuration file.
          Commander will automatically handle the boolean logic for `--direct`
          and `--no-direct`.
        done: true
      - prompt: >
          In `src/rmplan/commands/generate.ts`, modify the
          `handleGenerateCommand` function to determine the effective `direct`
          mode setting. Implement a clear order of precedence:

          1. Use the value from the command-line flag (`--direct` or
          `--no-direct`) if provided.

          2. If no flag is present, use the value of
          `config.planning?.direct_mode`.

          3. If neither is set, default to `false`.

          Pass this calculated value to the relevant logic that handles direct
          execution.
        done: true
      - prompt: >
          In `src/rmplan/commands/prepare.ts`, apply the same precedence logic
          to the `handlePrepareCommand` function to determine the effective
          `direct` mode. This calculated boolean value should then be passed to
          the `preparePhase` function in its options object.
        done: true
  - title: Implement Tests for New Configuration Logic
    description: Add new unit and integration tests to verify the correct behavior
      of the `direct_mode` feature. The tests will cover scenarios where the
      configuration is set to true, false, or is absent, and confirm that
      command-line flags correctly override the configuration for both the
      `generate` and `prepare` commands.
    files:
      - src/rmplan/commands/prepare.test.ts
      - src/rmplan/commands/generate.test.ts
      - src/rmplan/configLoader.test.ts
    steps:
      - prompt: >
          Create a new test file `src/rmplan/commands/prepare.test.ts`. Set up
          the basic test structure with mocks for dependencies like
          `configLoader` and `preparePhase`, using `generate.test.ts` as a
          template.
        done: true
      - prompt: >
          In `src/rmplan/commands/prepare.test.ts`, add a test suite to verify
          the `direct_mode` logic. Write individual tests for each precedence
          scenario:

          - No flag, no config (`direct` should be `false`).

          - No flag, config `direct_mode: true` (`direct` should be `true`).

          - No flag, config `direct_mode: false` (`direct` should be `false`).

          - `--direct` flag overrides config `direct_mode: false`.

          - `--no-direct` flag overrides config `direct_mode: true`.

          Use `moduleMocker` to provide different mock configurations for each
          test.
        done: true
      - prompt: >
          In `src/rmplan/commands/generate.test.ts`, add a similar test suite to
          verify the `direct_mode` logic for the `handleGenerateCommand`
          function, covering the same set of precedence scenarios.
        done: true
      - prompt: >
          In `src/rmplan/configLoader.test.ts`, add a test to
          `loadEffectiveConfig` to ensure that a configuration containing
          `planning: { direct_mode: true }` is parsed and validated correctly.
        done: true
  - title: Update Project Documentation
    description: Update the `README.md` file and any other relevant user-facing
      documentation. The documentation will clearly explain the new
      `direct_mode` configuration setting, its purpose, how to use it, and how
      it interacts with the existing `--direct` and `--no-direct` command-line
      flags.
    files:
      - docs/direct_mode_feature.md
    steps:
      - prompt: >
          Create a new documentation file at `docs/direct_mode_feature.md`. In
          this file, explain the new `planning.direct_mode` configuration
          option. Describe its purpose for the `generate` and `prepare`
          commands, detail the precedence logic with the `--direct` and
          `--no-direct` flags, and provide a clear YAML snippet showing how to
          use it in the `rmplan.yml` config file.
        done: true
changedFiles:
  - docs/direct_mode_feature.md
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/prepare.test.ts
  - src/rmplan/commands/prepare.ts
  - src/rmplan/configLoader.test.ts
  - src/rmplan/configLoader.ts
rmfilter:
  - src/rmplan
---

# Original Plan Details

Update the rmplan config file with a flag that, if true, will set "direct" mode in the
generate and prepare commands by default.

# Processed Plan Details

This phase encompasses all the work required to implement the new feature. We will start by updating the data model for the configuration, then implement the core logic in the affected commands. Following that, we will write tests to ensure the new logic is correct and robust under all conditions. Finally, we will update the documentation so users can understand and use the new feature.
