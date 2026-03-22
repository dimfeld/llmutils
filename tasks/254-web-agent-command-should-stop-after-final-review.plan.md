---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "web: agent command should stop after final review regardless of issues"
goal: ""
id: 254
uuid: 7cc5a9dc-8fc3-4199-89e2-4d81de23ab0e
status: pending
priority: medium
dependencies:
  - 190
references:
  "190": 822217b3-06f6-4200-b958-dae9bfd31ba0
createdAt: 2026-03-22T07:25:23.089Z
updatedAt: 2026-03-22T07:26:37.486Z
tasks: []
tags: []
---

When running agent from the web we should always just exit at the end of final review and add the review results, if any, to review issues.

When viewing a plan with review issues in PlanDetail, we should be able to edit them in the web interface, and also select which ones
should be turned into tasks. 

Then after that, the user can just run the agent command again to continue.
