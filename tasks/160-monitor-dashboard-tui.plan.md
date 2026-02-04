---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: monitor/dashboard GUI
goal: ""
id: 160
uuid: 514cedb9-6431-400a-a997-12d139376146
status: pending
priority: medium
epic: true
dependencies:
  - 158
  - 166
  - 167
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
createdAt: 2026-01-04T01:04:44.082Z
updatedAt: 2026-01-12T06:45:11.425Z
tasks: []
tags: []
---

## Manager UI

- Each "tab" (not necessarily actual tabs but the concept) corresponds to an active in_progress plan and its workspace.
- Make tim able to run headless. The current terminal IO is just a client to the headless server.
- Manager can run tim and forward input/output using the headless server protocol
- Manager can run Claude Code or Codex and forward input/output as a regular terminal
  - For Claude we can use streaming JSON input and output
  - Codex to start can use the `exec` command like we do in the executor, but they also support an "app server" mode - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Thinking about using Swift for the UI, can actually do macOS, and iOS versions then.
- We should also have some way to show when a session is waiting for input. 
  - Both of these have the ability to trigger notifications.

### Notifying Manager UI

First version:
- GUI starts a Unix socket, processes look for this socket and can ping it with a message including the terminal type and pane id. 
- When it receives a message the GUI adds it to the top of the list with a timestamp and action button to focus that terminal pane. This also replaces by message for the same workspace previously in the list. 


## Headless Mode

- 
- Communicate over websocket or maybe just regular TCP socket (simpler? probably is if we don't need to connect directly from browser).
- Protocol needs to support things like select or text prompts. Basically everywhere we use `inquirer` now needs to be
  supported in the protocol, where the terminal adapter will use inquirer and the other clients will do something similar
  but appropriate for their presentation.
- To start, only need to support the long running commands like `agent` and `review`. The rest can follow later since
they can also be run as regular CLI commands.

## Server Coordinator Agents

- Each machine running tim (my laptop, a linux server) should have a central server that allows discovery of active sessions and starting new sessions or claude/codex instances.
- When tim starts it should start a "session" (see below) that indicates that it is running, which workspace, etc., and the port it is listening on.
- The server can then scan these as needed, and tim can also notify the server that it has started or stopped for realtime updates.
- tim should see if this process is running when it starts, and if not, start it in daemonized mode.

### Session Tracking

- server coordinator can track sessions in SQLite
- Add a sessions table where we can track active sessions when an tim instance starts it will add an entry to the sessions table, noting the command that is being run and the workspace it is in and the PID.
- When a session exits, whether from an error or successfully, or a SIGINT, it should mark itself as exited with an accompanying status in the table. Server coordinator should also do some heartbeat monitoring.
- Server coordinator can clean up the Sessions table as Sessions exit or become stale. 


## General Capabilities

We want to be able to do these things:

- Create and tear down workspaces
- `tim run <plan>`
- `tim review <plan>`
- run claude or codex interactively with any arbitrary prompt but also the prompts from `tim prompts generate <planId>`
- quick add new plans (how does this work when the plans are all in git? Where do we add them? Maybe in primary
workspace or something. Maybe just don't worry about this for now)
