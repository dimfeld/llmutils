---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: tdd mode
goal: ""
id: 175
uuid: 81bfa931-f9bc-4b5e-9ead-d7ab1a847137
status: pending
priority: medium
createdAt: 2026-02-12T22:51:53.004Z
updatedAt: 2026-02-12T22:51:53.004Z
tasks: []
tags: []
---

Add a new "tdd-tests" subagent. Tell the orchestrator that we are using TDD, and that it should run the TDD test sub-agent first before proceeding with the implementation. 

Add a `--tdd` argument to the agent command to enable this mode.
