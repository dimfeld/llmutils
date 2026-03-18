---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: loading straight to a session URL should work
goal: ""
id: 236
uuid: d5708664-ad99-4cea-9279-48594eb5e63a
simple: true
status: pending
priority: medium
createdAt: 2026-03-18T20:52:58.693Z
updatedAt: 2026-03-18T21:52:26.942Z
tasks: []
tags: []
---

When reloading the web app with a session ID in the url like `http://localhost:5174/projects/3/sessions/3a38c5ae-a407-4527-9df5-094550aec6f9` we are redirecting away from it because we haven't loaded the sessions yet. 

This should only happen if the session manager has actually loaded the session. I think this whole thing is designed to
make the dismiss button work properly; it would be better perhaps if dismiss would just `goto` a link away from the
session if dismissing the current session, instead of relying on the session detail page to handle it.
