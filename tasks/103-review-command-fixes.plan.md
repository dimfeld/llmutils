---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command fixes
goal: ""
id: 103
status: pending
priority: medium
parent: 100
createdAt: 2025-08-13T23:54:11.755Z
updatedAt: 2025-08-13T23:54:11.755Z
tasks: []
rmfilter:
- src/rmplan/rmplan.ts
- src/rmplan/commands/review.ts
- src/rmplan/executors
---

The main problem right now with the review command is that this runs the executor normally, which for Claude Code is doing the full triple-agent implement/test/review sequence, so it doesn't just review but attempts to fix bugs as well.

This is actually potentially a good thing, but is really better for a separate option or command. The main intent was that it only runs the review. So we want to:

- have a mode in the executor for some kind of "simple" execution which changes nothing for most executors but for Claude Code will just run the provided prompt through Claude without wrapping in the orchestrator prompt or setting up the subagents.
- Add an --autofix option to the review command which will take the review results and run them through the executor as a plan to fix, if there are issues. This would use the normal mode, not the new "simple" mode.
- If --autofix is not passed, prompt the user to fix it or not


