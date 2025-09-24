---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Catch when Codex implementer doesn't actually do anything
goal: ""
id: 122
status: pending
priority: medium
createdAt: 2025-09-24T02:30:42.162Z
updatedAt: 2025-09-24T02:30:42.162Z
tasks: []
---

Sometimes the Codex implementer step will plan some changes but not do anything. The tester step usually does a good job
of raising a FAIL when it finds the things it's supposed to test are not there, but we should try to catch this.

Something like this:
- Last message output contains a line matching /^ ?\S* ?Plan/
- No files have changed since the implementer was started.

For the file detection, we can check:
- Current git SHA has not changed
- `jj status` or `git status -s` has same output before and after the implementer  step runs

If this happens, we should run `codex resume <sessionId>` and give it a message saying something like "go ahead".
