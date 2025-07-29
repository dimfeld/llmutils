---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Use subagents in Claude Code executor
goal: The overall goal is to enhance the Claude Code executor to support a
  multi-agent workflow by dynamically creating, using, and cleaning up dedicated
  subagents for implementation, testing, and review tasks.
id: 77
status: in_progress
priority: medium
container: true
dependencies:
  - 78
  - 79
createdAt: 2025-07-29T19:06:12.623Z
updatedAt: 2025-07-29T19:24:27.972Z
tasks: []
rmfilter:
  - src/rmplan/executors/claude_code
  - --
  - src/rmplan/commands/agent.ts
  - --with-imports
---

# Original Plan Details

Claude Code now supports defining your own agents. We should set up the Claude Code executor to dynamically create a set of agent files and use them.

There should be three agents, an implementer, a tester, and a reviewer. Each of these agent files should include the main prompt and then additional directions on what to do.

These files should be placed in the repository's `.claude/agents` directory. Each one is a Markdown file that looks
like:

```markdown
---
name: agent-name
description: When to use this agent
---

The prompt for the agent goes here.
```

The agent names should look like `rmplan-${planId}-${agentName}` and the filenames should reflect that with an `.md`
extension too.

Then update the directions sent to the main prompt to include directions on a loop of implementing, testing, and then reviewing the code. It should explicitly reference the agent names.

## Considerations:

- Make sure to clean up the agent markdown files when done.
- You may need to pass additional information to the executor functions with more information about the plan. It is ok
to update the executor function prototypes to include that information.

## Additional work

Add a SIGINT handler to the application, and a system to register cleanup handlers in it. When the Claude Code executor
runs, it should register a cleanup handler to remove the agent files, and then remove the handler once it's done. Have
the handler registry return a function that can be called to remove the handler.

# Processed Plan Details

## Implement Subagent Workflow in Claude Code Executor

This project will introduce a more sophisticated execution model within the Claude Code executor. Instead of a single monolithic prompt, the executor will orchestrate a team of specialized AI agents. It will dynamically generate three Markdown files in the `.claude/agents/` directory, one for each subagent: an implementer, a tester, and a reviewer. The main prompt will be updated to direct a primary agent to manage a development loop, invoking these subagents by their unique names (`rmplan-${planId}-${agentName}`) to perform their specialized tasks. To ensure the system is robust, a global SIGINT handler will be implemented along with a cleanup registry. This will guarantee that the temporary agent files are removed even if the application is interrupted mid-execution.
