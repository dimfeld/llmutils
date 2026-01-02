---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: clean up workspace switcher output
goal: ""
id: 155
uuid: bb7204f0-bb70-4856-bb41-20f639432125
status: pending
priority: medium
simple: true
createdAt: 2026-01-02T01:07:14.306Z
updatedAt: 2026-01-02T01:07:14.307Z
tasks: []
tags: []
---

Right now it does this TSV output but that doesn't look great. Instead lets do the full directory, a tab, and then a
nicely formatted name/description/branch/etc with deduplication of identical values.
