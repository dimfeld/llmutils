---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: run generate command from web
goal: ""
id: 189
uuid: 9a812d63-4354-4355-ab9d-d254dcbef3b0
status: pending
priority: medium
dependencies:
  - 184
  - 180
  - 183
  - 188
references:
  "180": 4d9ccb0b-e988-479a-8f5a-4920747c72ec
  "183": 9c58c35e-6447-4ce3-af6b-3510719dc560
  "184": 05e31645-305d-4e59-8c49-a9fbc9ce0bd7
  "188": 2f287626-23b9-4d02-9e15-983f6ba6d5fd
createdAt: 2026-02-13T21:11:06.976Z
updatedAt: 2026-03-20T22:42:09.090Z
tasks: []
tags: []
---

This should work as if `tim generate <planId> --auto-workspace` was run from the command line in the primary workspace.

We'll want some kind of daemonization on the subprocess so that if the web server restarts or we're in the dev server,
we don't lose the process.
