---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support streaming json input for Claude Code
goal: ""
id: 68
uuid: 0418238c-9680-4b96-bed3-be43e2b3419b
status: deferred
priority: medium
docs:
  - https://docs.anthropic.com/en/docs/claude-code/sdk#streaming-json-input
createdAt: 2025-07-03T00:16:02.256Z
updatedAt: 2025-10-27T08:39:04.220Z
tasks: []
---

This lets us type messages into Claude Code while running it to provide additional guidance. We should read stdin while Claude Code is running and send it to Claude Code a JSON-formatted message.

Ideally this should use a library like readline or something from @inquirer/prompts that allows input editing and
probably multiline input.

As part of this, we may also want to stop using the `--print` CLI argument and instead just send the initial prompt
directly to Claude Code as the first message.

Another thing that would be nice is if we can press Esc to abort the current Claude run without closing the session. Not
sure if the current SDK interface allows for that though.
