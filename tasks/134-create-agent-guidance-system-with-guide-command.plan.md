---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Create agent guidance system with guide command and help reorganization
goal: ""
id: 134
uuid: b03a07b6-27d4-44e0-9a3b-b798f50bfed2
status: pending
priority: medium
temp: false
parent: 128
createdAt: 2025-10-26T22:41:21.717Z
updatedAt: 2025-10-27T08:39:04.253Z
tasks: []
---

## Overview

Create an agent-friendly guidance system that helps autonomous agents understand rmplan commands and workflows. This includes:
1. A base `rmplan` command (no args) that displays guidance
2. Reorganized help output grouped by agent workflow
3. Best practices and examples for common agent tasks

## Components

### 1. Guide Command (base rmplan with no subcommand)

File: `src/rmplan/commands/guide.ts`

When user runs just `rmplan`, show:
- Overview of rmplan for agents
- Key concepts (dependencies, ready state, parent/child)
- Common workflows grouped by purpose
- Best practices for autonomous work
- Quick command reference

### 2. Help Reorganization

Update `src/rmplan/rmplan.ts` to group commands by workflow category:

**Categories:**
- **Discovery**: list, ready, show
- **Creation**: add, add-task, generate, import
- **Execution**: agent, run, next, done, prepare  
- **Modification**: set, remove-task, update, split, merge
- **Review**: review, pr-description, answer-pr
- **Workspace**: workspace subcommands
- **Maintenance**: validate, renumber, cleanup

Use Commander.js's `configureHelp()` to customize the help output format.

### 3. Agent Best Practices Section

Include guidance on:
- Creating discovered issues: `rmplan add "..." --discovered-from <id>`
- Managing dependencies and blockers
- Using `rmplan ready` to find work
- Using `rmplan show --full` for complete context
- Updating status as work progresses

## Example Guide Output

```
📋 rmplan - Autonomous Agent Guide
────────────────────────────────────────────────────────────────────────────────

🤖 For Autonomous Agents:
rmplan helps you manage complex projects through plan files that track
tasks, dependencies, and progress.

Key Concepts:
  • Plans have numeric IDs and can depend on other plans
  • Plans with status=pending become "ready" when all dependencies are done
  • Use parent/child relationships for hierarchical organization

📝 Creating and Managing Plans:
  rmplan add [title]              Create a new plan stub
    --parent <id>                 Set parent plan
    --depends-on <ids...>         Set dependencies
    --discovered-from <id>        Mark discovery source

🔍 Finding Work:
  rmplan list --status ready      Show ready-to-execute plans
  rmplan ready                    Detailed view of ready plans
  rmplan show <plan> --full       Show complete plan details

...
```

## Implementation Tasks

1. Create `src/rmplan/commands/guide.ts` with `handleGuideCommand()`
2. Update `src/rmplan/rmplan.ts` to call guide when no subcommand specified
3. Add `configureHelp()` to group commands by category
4. Add help text sections with best practices
5. Test that `rmplan` shows guide and `rmplan --help` shows standard help

## Testing

- Run `rmplan` with no args, verify guide displays
- Run `rmplan --help`, verify standard help displays
- Run `rmplan <command> --help`, verify command-specific help displays
- Verify categorization makes sense and all commands are included

## Dependencies

None - uses existing command structure and adds documentation.
