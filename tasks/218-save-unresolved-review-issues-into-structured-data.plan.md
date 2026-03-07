---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: save unresolved review issues into structured data in the plan
goal: ""
id: 218
uuid: ba4a7ded-213e-4e02-9f05-c7c702c2aab5
status: pending
priority: medium
createdAt: 2026-03-07T07:34:29.000Z
updatedAt: 2026-03-07T07:34:29.001Z
tasks: []
tags: []
---

When we "exit" from the final review without addressing any issues, save the unresolved issues as structured data in the plan. Update the `review` command
with a new option that can just look at the existing unresolved issues for the plan and go straight to the select prompt
that asks what to do about it.
