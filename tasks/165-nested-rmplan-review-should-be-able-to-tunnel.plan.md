---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: nested rmplan review should be able to tunnel output to parent rmplan
goal: ""
id: 165
uuid: ad5bc044-81a4-4675-b1fa-4e3ca9038000
status: pending
priority: medium
createdAt: 2026-01-05T07:25:14.011Z
updatedAt: 2026-01-05T07:25:14.011Z
tasks: []
tags: []
---

When running the review from inside Claude, we don't print anything in order to not fill up Claude's context window, but it would still be useful to see the output on the console.

Implement a way  for the processes to write to the root rmplan process which can then re-emit on its
own stdout and stderr. Maybe named pipes whose paths are passed via environment variables? But maybe there's a better
solution.

Once we detect the pipes, we can install a logging adapter which will write to them.
