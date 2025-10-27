---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: config to customize PR created by review command
goal: Enable users to configure default settings for PRs created by rmplan
  commands, including draft status and title prefix
id: 110
uuid: af507cc3-18ae-496b-8e46-952d382494f0
status: done
priority: medium
container: true
dependencies:
  - 111
  - 112
createdAt: 2025-08-16T00:21:10.187Z
updatedAt: 2025-10-27T08:39:04.238Z
tasks: []
rmfilter:
  - src/rmplan/configSchema.ts
  - src/rmplan/commands/description.ts
  - --with-imports
---

# Original Plan Details

We want to add options to the project config for defaults for the autocreated PRs. Currently this is just done by the
pr-description command.

- draft: boolean -- whether the PR should be created as a draft
- prefix: string -- a prefix for the PR title

# Processed Plan Details

## Add configuration options for customizing auto-created PRs in rmplan

This feature adds configuration options to the project config file that control how PRs are created by the `description` command. Currently, PRs are always created as drafts with no title prefix customization. The new configuration will live under a `prCreation` section in the config schema and will apply to all PR creation operations triggered by rmplan commands. The implementation must maintain backward compatibility, defaulting to draft=true when not specified.

Acceptance criteria:
- Config schema includes new `prCreation` section with `draft` and `titlePrefix` options
- The `description` command respects these config values when creating PRs
- Backward compatibility is maintained (defaults to draft=true)
- Configuration is properly validated using Zod schema
- Tests cover all new functionality and edge cases
- Title prefix is properly sanitized to prevent injection attacks
