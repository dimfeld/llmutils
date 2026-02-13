---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Enable app server mode for codex
goal: ""
id: 179
uuid: c3cc196c-52f8-4e4a-a640-0b973d23a5bd
status: pending
priority: medium
createdAt: 2026-02-13T06:45:35.045Z
updatedAt: 2026-02-13T06:45:35.045Z
tasks: []
tags: []
---

Codex has an app server mode described at https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md. We
should replace our existing codex runner with this because it allows sending input into the process.

To start, implement this in a new file and allow switching back to the old one via environment variable while we work
out all the kinks.
