---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Add ability to tim config file to set "direct" mode in generate and
  prepare commands by default
goal: This phase will deliver the complete functionality by updating the
  configuration model, modifying the CLI commands to respect the new setting,
  adding comprehensive tests, and documenting the feature.
id: 70
uuid: 456cb603-04b5-4da6-8312-b60334d010bd
status: done
priority: high
planGeneratedAt: 2025-07-20T00:53:52.277Z
promptsGeneratedAt: 2025-07-20T00:59:04.282Z
createdAt: 2025-07-20T00:24:53.615Z
updatedAt: 2025-10-27T08:39:04.209Z
project:
  title: Add `direct_mode` Configuration Option
  goal: The project's goal is to introduce a new configuration option,
    `planning.direct_mode`, in the `tim` config file. This will allow users to
    set "direct" mode as the default behavior for the `generate` and `prepare`
    commands, improving user experience and workflow customization.
  details: >-
    This project involves updating the `tim` configuration system and the
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

    - A new boolean option `planning.direct_mode` can be added to the `tim`
    config file.

    - When `direct_mode` is `true`, `tim generate` and `tim prepare` execute in
    "direct" mode by default.

    - The `--no-direct` command-line flag successfully overrides a configuration
    of `direct_mode: true`.

    - When `direct_mode` is `false` or absent, the commands execute in
    non-direct mode by default.

    - The `--direct` command-line flag successfully overrides a configuration of
    `direct_mode: false`.

    - The project's documentation is updated to reflect the new feature.
tasks:
  - title: Add `direct_mode` to Configuration Model
    done: true
    description: Update the configuration data class to include the new optional
      boolean field `planning.direct_mode`. This change will ensure that the
      configuration loading mechanism recognizes the new setting and defaults it
      to `False` if it's not present in a user's config file, maintaining
      backward compatibility.
  - title: Update `generate` and `prepare` Commands to Use New Config
    done: true
    description: Modify the `generate` and `prepare` command functions to
      incorporate the new configuration setting. The implementation will
      prioritize the command-line flags (`--direct`/`--no-direct`) over the
      `direct_mode` setting from the config file, which in turn will be used as
      the default if no flag is specified.
  - title: Implement Tests for New Configuration Logic
    done: true
    description: Add new unit and integration tests to verify the correct behavior
      of the `direct_mode` feature. The tests will cover scenarios where the
      configuration is set to true, false, or is absent, and confirm that
      command-line flags correctly override the configuration for both the
      `generate` and `prepare` commands.
  - title: Update Project Documentation
    done: true
    description: Update the `README.md` file and any other relevant user-facing
      documentation. The documentation will clearly explain the new
      `direct_mode` configuration setting, its purpose, how to use it, and how
      it interacts with the existing `--direct` and `--no-direct` command-line
      flags.
changedFiles:
  - docs/direct_mode_feature.md
  - src/tim/commands/generate.test.ts
  - src/tim/commands/generate.ts
  - src/tim/commands/prepare.test.ts
  - src/tim/commands/prepare.ts
  - src/tim/configLoader.test.ts
  - src/tim/configLoader.ts
rmfilter:
  - src/tim
---

# Original Plan Details

Update the tim config file with a flag that, if true, will set "direct" mode in the
generate and prepare commands by default.

# Processed Plan Details

This phase encompasses all the work required to implement the new feature. We will start by updating the data model for the configuration, then implement the core logic in the affected commands. Following that, we will write tests to ensure the new logic is correct and robust under all conditions. Finally, we will update the documentation so users can understand and use the new feature.
