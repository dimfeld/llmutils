---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: manifest and sync should use a shadow original copy to compare to
goal: ""
id: 283
uuid: cdbe0368-2b53-45b3-bd8f-3fe4f8e373a8
status: pending
priority: medium
dependencies:
  - 280
parent: 278
createdAt: 2026-03-25T20:38:31.086Z
updatedAt: 2026-03-26T06:57:54.845Z
tasks: []
tags: []
references:
  "278": 8c8ba325-58ad-4033-b45a-a9a1efd654a6
  "280": 6de3727b-1e50-4cee-80ea-786d92db3a6c
---

When we manifest a plan, we should write the plan to disk like we do now, but also save a hidden copy alongside it,
which will not be modified. Then when we sync back, we can compare the current version against the hidden copy to see
what actually changed. This will help us in the future when building an ops log and if we need to resolve any conflicts. 

Conflict resolution can occur using last-write-wins on a per-field basis, assuming that any updated fields in the manifested file are the latest writes.
