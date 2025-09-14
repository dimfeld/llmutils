---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implementer should exit if it finds impossible or conflicting
  requirements it ca not resolve
goal: ""
id: 120
status: pending
priority: medium
createdAt: 2025-09-14T08:19:24.654Z
updatedAt: 2025-09-14T08:19:24.654Z
tasks: []
---

If implementer finds conflicting or impossible requirements and it is not confident to resolve on its own, tell it to exit with a line starting with "FAILED:" along with a detailed report including:
- the requirements it was trying to resolve
- the problems it encountered
- possible solutions

Then we look at that code and exit.

If it makes sense, create a single prompt template for this which can be included in all the relevant prompts.


## Executor Updates

Do this in the Claude and Codex executors. Update the executor run return value so that it can indicate failure along
with details.

### Claude Executor

Update the orchestrator agent prompt and the three subagent prompts with directions that if it (or for the orchestrator,
one of its subagents) encounters conflicting or
impossible requirements it should exit with the FAILED message.

Check the final message for FAILED and return a failure indication if so.

### Codex Executor

We can reuse the update to the Claude subagent prompts agent since we're sharing that file. Also update the fixer agent prompt with this FAILED message. Every time we run one of these agents, check for the FAILED line.

If that happens, we should return a failure indication. We should also skip the step in the "finally" block that marks the tasks as done.

## Main Agent Loop

If the executor returns a failure indication, we should break out of the main agent loop, printing the details about the
failure and exiting with a non-zero exit code.
