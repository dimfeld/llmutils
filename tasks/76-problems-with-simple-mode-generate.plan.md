---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Problems with simple mode generate
goal: ""
id: 76
status: deferred
priority: high
createdAt: 2025-07-28T19:26:36.115Z
updatedAt: 2025-10-26T22:55:51.014Z
tasks: []
---

I need to look into this, but it looks like it's trying to expect an entire plan to come back from the LLM with all the fields, instead of parsing it using the partial schema like the stuff in process_markdown does.
