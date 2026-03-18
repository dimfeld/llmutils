---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: agent command should be interactive session
goal: ""
id: 235
uuid: 040f82db-03d4-439b-9b74-673e4e4cb990
simple: true
status: in_progress
priority: medium
createdAt: 2026-03-18T20:52:21.108Z
updatedAt: 2026-03-18T20:55:36.118Z
tasks: []
tags: []
---

Agent command is not showing up as an "interactive" session when reported over the websocket, but it is from the perspective of us being able to write user input into it

## Current Progress
### Current State
- Complete. The fix has been implemented, tested, and committed.
### Completed (So Far)
- Changed `interactive: false` to a computed expression in `agentCommand()` at `src/tim/commands/agent/agent.ts` line 257
- The expression is: `options.nonInteractive !== true && options.terminalInput !== false && config.terminalInput !== false`
- Added test coverage for all three disabling conditions
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Excluded `process.stdin.isTTY` check from the interactive flag computation because when running headless (via websocket), stdin isn't a TTY but the session IS still interactive via the websocket input mechanism
### Lessons Learned
- None
### Risks / Blockers
- None
