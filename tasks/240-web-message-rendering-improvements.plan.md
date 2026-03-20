---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: web message rendering improvements
goal: ""
id: 240
uuid: 1d8d0555-1325-4f53-82f2-3f9ff6d50d07
simple: true
status: done
priority: medium
createdAt: 2026-03-19T08:13:37.834Z
updatedAt: 2026-03-20T09:14:05.099Z
tasks: []
tags: []
---

- Dont truncate agent message items
- review summary items should show all the details about each review item
- higher truncation threshold for tool use inputs and outputs (that is, show more lines), use whatever threshold the console formatter uses

## Current Progress
### Current State
- All three tasks implemented and verified
### Completed (So Far)
- No truncation for llmOutput category messages (LLM responses/thinking)
- Review results now show full detail: verdict, fix instructions, issues grouped by severity with category/file:line/content/suggestion, recommendations, action items
- Tool use and command messages use 40-line truncation threshold (matching console formatter) instead of 10
- KV pair values for tool use messages also use 40-line truncation instead of 500-char truncation
- Review result messages skip truncation entirely (via rawType check)
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used `message.rawType === 'review_result'` to identify review messages for skip-truncation, since the category alone ('error' or 'lifecycle') is shared with other message types
- Tool use KV pairs use line-based truncation (40 lines) rather than character-based (500 chars) since tool inputs/outputs are typically structured multi-line content
### Lessons Learned
- The `getTextTruncationState` function already supported custom `lineLimit`/`charLimit` overrides, making the threshold change straightforward without refactoring
- KV pair truncation was a separate code path from text/monospaced truncation - needed its own handling via `getKeyValueTruncationState` helper
### Risks / Blockers
- None
