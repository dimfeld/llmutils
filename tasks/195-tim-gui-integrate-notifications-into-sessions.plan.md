---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: integrate notifications into sessions"
goal: ""
id: 195
uuid: a2d40d96-fa91-4a18-a761-2c5ef235975b
status: pending
priority: medium
createdAt: 2026-02-15T04:05:01.637Z
updatedAt: 2026-02-15T04:05:01.637Z
tasks: []
tags: []
---

Get rid of the separate notifications tab and make everything a session now.

- Have the session start message include the WEZTERM_PANE environment variable and other terminal info that notifications currently
have so we can match up a session to a pane.
- Remove the "clear" button on defunct sessions and have that be a right-click action instead. Replace where the button
was with a button that will activate the wezterm pane if we have one.
- Keep the "clear all" button in the toolbar. 
- Add a blue dot for sessions like we have for notifications now, when there is an unhandled notification
- Match up notifications to existing sessions by WEZTERM_PANE value or working directory if there isn't one..
- For notifications not linked to an existing session, just create a new session for it.

