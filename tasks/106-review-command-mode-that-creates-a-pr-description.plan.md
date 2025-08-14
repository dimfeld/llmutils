---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: PR description command
goal: ""
id: 106
status: pending
priority: medium
createdAt: 2025-08-14T00:55:08.903Z
updatedAt: 2025-08-14T00:55:08.903Z
tasks: []
---

This works a lot like the existing review command, but with a different prompt that asks it to generate a PR description.

The output should include details like:
- What was implemented
- A description of how the changes work with each other and how it integrates with the rest of the system
- optional diagrams if helpful

Unlike the review command, we don't need issue detection or a "fix" mode since it's just outputting the description. We
should copy the output to the clipboard when done and optionally create the PR using the Github CLI.
