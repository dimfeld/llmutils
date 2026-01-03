---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: monitor/dashboard TUI
goal: ""
id: 160
uuid: 514cedb9-6431-400a-a997-12d139376146
status: pending
priority: medium
dependencies:
  - 158
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
createdAt: 2026-01-04T01:04:44.082Z
updatedAt: 2026-01-04T01:04:44.082Z
tasks: []
tags: []
---

rmplan TUI for tracking open sessions and running new ones 

Make it in rust, use ratatui for the terminal and access through SQLite

Add a sessions table where we can track active sessions when an RM plan instant starts it will add an entry to the sessions table, noting the command that is being run and the workspace it is in and the PID.

When a session exits, whether from an error or successfully, or a SIGINT, it should mark itself as exited with an accompanying status in the table. 

The TUI can clean up the Sessions table as Sessions exit or become stale. 

We should also have some way to show when a session is waiting for input. I don't think we can do this reliably, but we can show how long it has been since the last message was printed, and if it's longer than a certain threshold, say 30 seconds or a minute, then we highlight that line. So then we just need the logging infrastructure to also update that. 

We can potentially do that with a named socket where the TUI can send a message on the named socket for a particular session and get back the last timestamp of the output. This allows us to do it without needing to continually track when the last output actually was or write it out to the database or file all the time. 

Can we use wezterm commands to start a new tab in a directory for a workspace?
