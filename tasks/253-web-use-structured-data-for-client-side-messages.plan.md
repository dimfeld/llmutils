---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "web: use structured data for client-side messages"
goal: ""
id: 253
uuid: eaf60266-b11f-4524-bfd0-505ed40f8836
status: pending
priority: medium
createdAt: 2026-03-22T07:23:12.505Z
updatedAt: 2026-03-22T07:23:12.505Z
tasks: []
tags: []
---

Currently the server does the text formatting of messages, but this is not conducive to rich formatting on the client. 

Instead, we should just pass the structured message down to the client, which can store it, and then do better
formatting. 

The first example here should be to show much nicer output for review issues. The rest of the text formatting can stay
the same for now at least.
