---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: group sessions by workspace"
goal: ""
id: 203
uuid: 94d6de67-cc76-4721-ad3f-824eaafe9ed1
status: pending
priority: medium
createdAt: 2026-02-23T08:29:07.853Z
updatedAt: 2026-02-23T08:36:59.221Z
tasks: []
tags: []
---

In the sessions list on the left, we should group sessions by the project they're in. Allow collapsing a group so that
we show only its name. We should also be able to reorder workspace groups by dragging the session names.

Session group headers should show a count of the number of sessions in the group. 

When a session group is collapsed and any of its children have an active notification, that is, when we are showing the blue dot, we
should also show a dot next to the workspace name to indicate that there's something to click in for. 

Project names, when we have a Git remote, should be the last two parts of the remote. That is, in the standard GitHub
format, the username and repository name. If the username is the same as the current user, we should show just the
repository name.

As part of this project, we should also add a button in the toolbar, which will jump to the first session with an active
notification.
