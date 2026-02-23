---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Better review rendering
goal: ""
id: 201
uuid: a2e13a19-4d9a-44da-ab4f-c6f566ecacc1
status: pending
priority: medium
createdAt: 2026-02-21T01:14:58.731Z
updatedAt: 2026-02-23T08:45:59.056Z
tasks: []
tags: []
---

We currently send a review result message and also render the review results on the terminal. Instead, we should just send the review result message and have the console formatter format it the same way that we currently do right now. The explicit call to console.log in the review in tunneling mode should remain unchanged.

It also seems like we have a separate review result and review verdict message. These should be combined into a single message. 

Also improve the formatting of the review result message in the GUI to look a bit more like the one in the terminal. Where the issues are grouped by severity. Perhaps it's best to just have the code sending the message do this, since we're it's already grouping it to display on the terminal anyway.
