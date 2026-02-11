---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: monitor/dashboard GUI
goal: ""
id: 160
uuid: 514cedb9-6431-400a-a997-12d139376146
status: done
priority: medium
epic: true
dependencies:
  - 158
  - 166
  - 167
  - 168
  - 169
  - 170
  - 171
references:
  "158": e17331a4-1827-49ea-88e6-82de91f993df
  "166": 783bf184-9ec5-4919-bf30-8ae618785f0c
  "167": b0cf87ed-ba48-4d26-b028-476cf38e0cff
  "168": 59358b82-95c5-47a6-95a7-54adc501928f
  "169": 85aa17d2-7d55-4d91-afbb-09821893a59a
  "170": 7dbef580-dad0-4961-a66a-96c46839a354
  "171": d6b2c0b6-90fc-4f04-8e2b-feab3fd4f9d0
createdAt: 2026-01-04T01:04:44.082Z
updatedAt: 2026-02-11T21:46:49.350Z
tasks: []
changedFiles:
  - README.md
  - package.json
  - scripts/manual-headless-prompt-harness.ts
  - scripts/manual-tunnel-prompt-harness.ts
  - src/common/input.test.ts
  - src/common/input.ts
  - src/common/terminal.test.ts
  - src/logging/console_formatter.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/logging/headless_protocol.ts
  - src/logging/structured_messages.test.ts
  - src/logging/structured_messages.ts
  - src/logging/tunnel_client.test.ts
  - src/logging/tunnel_client.ts
  - src/logging/tunnel_integration.test.ts
  - src/logging/tunnel_prompt_handler.test.ts
  - src/logging/tunnel_prompt_handler.ts
  - src/logging/tunnel_protocol.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/testing.ts
  - src/tim/commands/agent/agent.integration.test.ts
  - src/tim/commands/agent/agent.summary_file.integration.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.timeout.integration.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/cleanup-temp.test.ts
  - src/tim/commands/find_next_dependency.test.ts
  - src/tim/commands/review.test.ts
  - src/tim/commands/subagent.test.ts
  - src/tim/commands/subagent.ts
  - src/tim/configSchema.test.ts
  - src/tim/configSchema.ts
  - src/tim/executors/claude_code/orchestrator_integration.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.test.ts
  - src/tim/executors/claude_code/permissions_mcp_setup.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
  - src/tim/executors/codex_cli/codex_runner.ts
  - src/tim/executors/types.ts
  - src/tim/issue_utils.ts
  - src/tim/planSchema.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_auto_selector.ts
  - src/common/prompt.test.ts
  - src/common/prompt.ts
  - tim-gui/TimGUI/ContentView.swift
  - tim-gui/TimGUI/LocalHTTPServer.swift
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUI/SessionState.swift
  - tim-gui/TimGUI/SessionsView.swift
  - tim-gui/TimGUI/TimGUIApp.swift
  - tim-gui/TimGUI/WebSocketConnection.swift
  - tim-gui/TimGUI.xcodeproj/project.pbxproj
  - tim-gui/TimGUITests/LocalHTTPServerTests.swift
  - tim-gui/TimGUITests/MessageFormatterTests.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
  - tim-gui/TimGUITests/SessionStateTests.swift
  - tim-gui/TimGUITests/WebSocketTests.swift
  - src/common/process.test.ts
  - src/common/process.ts
  - src/logging/adapter.ts
  - src/logging/console.ts
  - src/logging/console_formatter.test.ts
  - src/logging/send_structured.e2e.test.ts
  - src/logging/silent.ts
  - src/logging/test_helpers.ts
  - src/logging/tunnel_protocol.test.ts
  - src/logging.ts
  - src/tim/commands/agent/agent_helpers.ts
  - src/tim/commands/agent/batch_mode.soft_failure.test.ts
  - src/tim/commands/agent/parent_plans.ts
  - src/tim/commands/review.notifications.test.ts
  - src/tim/commands/review.ts
  - src/tim/commands/review.tunnel.test.ts
  - src/tim/commands/validate.ts
  - src/tim/executors/claude_code/format.test.ts
  - src/tim/executors/claude_code/format.ts
  - src/tim/executors/claude_code_orchestrator.ts
  - src/tim/executors/codex_cli/format.test.ts
  - src/tim/executors/codex_cli/format.ts
  - src/tim/executors/codex_cli/normal_mode.ts
  - src/tim/executors/codex_cli/review_mode.ts
  - src/tim/executors/codex_cli/simple_mode.ts
  - src/tim/executors/codex_cli.fix_loop.test.ts
  - src/tim/executors/codex_cli.simple_mode.test.ts
  - src/tim/executors/codex_cli.test.ts
  - src/tim/executors/shared/todo_format.ts
  - src/tim/headless.test.ts
  - src/tim/summary/display.test.ts
  - src/tim/summary/display.ts
  - src/tim/summary/format.ts
  - docs/direct_mode_feature.md
  - docs/next-ready-feature.md
  - schema/tim-config-schema.json
  - schema/tim-plan-schema.json
  - src/tim/assignments/auto_claim.test.ts
  - src/tim/commands/compact.test.ts
  - src/tim/commands/import/issue_tracker_integration.test.ts
  - src/tim/commands/renumber.test.ts
  - src/tim/headless.ts
  - test-plans/rmplan.yml
  - tim-gui/.swiftlint.yml
  - tim-gui/AGENTS.md
  - tim-gui/docs/index.md
  - tim-gui/docs/liquid-glass/appkit.md
  - tim-gui/docs/liquid-glass/overview.md
  - tim-gui/docs/liquid-glass/patterns.md
  - tim-gui/docs/liquid-glass/swiftui.md
  - tim-gui/docs/modern-swift.md
  - tim-gui/docs/swift-concurrency.md
  - tim-gui/docs/swift-testing-playbook.md
  - tim-gui/docs/toolbar/swiftui-features.md
  - src/tim/commands/run_prompt.test.ts
  - src/tim/commands/run_prompt.ts
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
