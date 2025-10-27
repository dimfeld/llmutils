---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: review command fixes
goal: The goal of this project is to modify the `review` command to perform a
  review-only action by default and introduce an explicit `--autofix` option to
  trigger a subsequent fix-up process, providing a more predictable and
  user-controlled workflow.
id: 103
uuid: be6ddfa8-5616-4026-8096-a2425cbace4f
status: done
priority: medium
container: true
dependencies:
  - 104
  - 105
parent: 100
createdAt: 2025-08-13T23:54:11.755Z
updatedAt: 2025-10-27T08:39:04.279Z
tasks: []
rmfilter:
  - src/rmplan/rmplan.ts
  - src/rmplan/commands/review.ts
  - src/rmplan/executors
---

# Original Plan Details

The main problem right now with the review command is that this runs the executor normally, which for Claude Code is doing the full triple-agent implement/test/review sequence, so it doesn't just review but attempts to fix bugs as well.

This is actually potentially a good thing, but is really better for a separate option or command. The main intent was that it only runs the review. So we want to:

- have a mode in the executor for some kind of "simple" execution which changes nothing for most executors but for Claude Code will just run the provided prompt through Claude without wrapping in the orchestrator prompt or setting up the subagents.
- Add an --autofix option to the review command which will take the review results and run them through the executor as a plan to fix, if there are issues. This would use the normal mode, not the new "simple" mode.
- If --autofix is not passed, prompt the user to fix it or not

# Processed Plan Details

## Refactor the review command to separate review and autofix functionality

The current implementation of the `rmplan review` command uses the standard executor, which for `claude-code` initiates a full implement/test/review cycle. This means it not only reviews the code but also attempts to fix any identified issues, which is not the intended default behavior. This project will introduce a "simple" execution mode for executors. For the `claude-code` executor, this mode will run a prompt directly without the multi-agent orchestration, effectively performing a review-only task. The `review` command will use this simple mode by default. Additionally, an `--autofix` flag will be added to the `review` command. When this flag is used, or when the user interactively consents, the system will take the output from the initial review and feed it back into the executor using the standard (non-simple) execution mode to automatically fix the identified problems.
