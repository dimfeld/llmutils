---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: loading straight to a session URL should work
goal: ""
id: 236
uuid: d5708664-ad99-4cea-9279-48594eb5e63a
status: pending
priority: medium
createdAt: 2026-03-18T20:52:58.693Z
updatedAt: 2026-03-18T20:52:58.693Z
tasks: []
tags: []
---

When reloading the web app with a session ID in the url like `http://localhost:5174/projects/3/sessions/3a38c5ae-a407-4527-9df5-094550aec6f9` we are redirecting away from it because we haven't loaded the sessions yet. 

I think it would be useful to have the server layout load function return the list of sessions so that we know it right away. And that way, when we're loading directly into a session URL, we will already know if it's valid or not, even if the data hasn't been loaded on the client yet.
