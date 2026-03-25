---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: async chat with plan
goal: ""
id: 276
uuid: aaa01bbe-ec11-47f6-b77d-065c1da965ec
status: pending
priority: medium
dependencies:
  - 275
  - 265
references:
  "265": 428ed935-e91e-4d20-a4cb-46947ee8b2aa
  "275": 1b54394a-e12c-4f26-8a06-be5da8ab65a9
createdAt: 2026-03-24T21:50:31.074Z
updatedAt: 2026-03-25T00:25:41.998Z
tasks: []
tags: []
---

Still figuring this out, but basically it would be something where we can send single messages to a plan. And it would
run that one message in a workspace and return the resulting message. If they user wants to follow up then they can.
Each run would contain the previous context of messages. The messages and results, and any artifacts generated would be recorded in the database.

We should have a way to reference artifacts in the messages in a way that they show up in the web interface. A special
tag or markdown link or something.
