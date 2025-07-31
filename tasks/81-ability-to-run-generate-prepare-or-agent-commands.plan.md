---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Ability to run, generate, prepare, or agent commands on the next ready
  dependency of a plan.
goal: ""
id: 81
status: pending
priority: medium
createdAt: 2025-07-29T19:19:03.441Z
updatedAt: 2025-07-29T19:19:03.441Z
tasks: []
---

So we want a new command line flag to be able to take any parent plan, and find the next plan that it depends on, either directly or indirectly, which is ready or pending.

The generate, prepare, or agent commands should be able to run on that plan.
