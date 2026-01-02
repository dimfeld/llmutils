---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: workspace switcher should run outside a project
goal: ""
id: 156
uuid: 6dc6b938-bac2-460e-8d69-58eb913b8acb
simple: true
status: pending
priority: medium
createdAt: 2026-01-02T01:08:14.981Z
updatedAt: 2026-01-02T01:08:14.981Z
tasks: []
tags: []
---

If we aren't in a git repository, just run as if the --all flag was passed. Also make sure to suppress the "Using
external rmplan storage" message.
