---
name: rmplan Usage
description: This skill should be used when the user asks to "generate plan 123" (or any number), "work on plan 123", "run rmplan", mentions "rmplan" explicitly, asks about "rmplan commands", "rmplan tools", "rmplan prompts", or wants to create, manage, or execute project plans.
version: 1.0.0
---

# rmplan Usage Guide

rmplan is an AI-powered project planning and execution system. It generates detailed plans from issues, executes them with automated agents, and tracks progress through complex multi-phase projects.

## Core Concepts

**Plans** are YAML files with:

- Metadata (title, goal, priority, status, dependencies)
- Tasks with descriptions
- Research findings and implementation notes
- Progress tracking in a `## Progress` section within the plan body (living summary, no timestamps)

**Plan lifecycle**: `pending` → `in_progress` → `done` (or `cancelled`/`deferred`)

## MCP Integration

The rmplan MCP server provides tools and prompts for plan management. When the MCP server is available, use these capabilities:

### MCP Prompts

Use prompts to initiate plan workflows:

| Prompt                 | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `generate-plan`        | Full workflow: research → collaborate → generate tasks |
| `generate-plan-simple` | Skip research, go directly to task generation          |
| `plan-questions`       | Collaborate with user to refine a plan                 |
| `load-plan`            | Display plan and wait for user instructions            |
| `compact-plan`         | Summarize completed plan for archival                  |

**Using generate-plan prompt:**

1. Load the prompt with a plan ID
2. Research the codebase relevant to the plan goal
3. Add findings to the plan's `## Implementation Guide` section
4. Collaborate with the user by asking clarifying questions
5. Use `update-plan-tasks` tool to save generated tasks

### MCP Tools

| Tool                  | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `get-plan`            | Retrieve plan details by ID or path          |
| `create-plan`         | Create a new plan file                       |
| `update-plan-tasks`   | Update plan with generated tasks and details |
| `update-plan-details` | Update the generated section content         |
| `manage-plan-task`    | Add, update, or remove individual tasks      |
| `list-ready-plans`    | Find plans ready to execute                  |

### MCP Resources

Browse plan data via resources:

- `rmplan://plans/list` - All plans
- `rmplan://plans/{planId}` - Specific plan details
- `rmplan://plans/ready` - Ready-to-execute plans

### CLI Tool Equivalents (no MCP tools)

When MCP tools are not available, use `rmplan tools <tool-name>` with JSON on stdin.
These subcommands share the same schemas and behavior as the MCP tools and can return
structured JSON with `--json`.

```bash
# Text output (matches MCP tool output)
echo '{"plan": "123"}' | rmplan tools get-plan

# Structured JSON output
echo '{"plan": "123"}' | rmplan tools get-plan --json

# Create a plan
echo '{"title": "New Plan", "priority": "high"}' | rmplan tools create-plan --json
```

If you still want the MCP server for prompts/resources only, run:

```bash
rmplan mcp-server --no-tools
```

## CLI Commands

When MCP is not available, use the CLI:

### Viewing Plans

```bash
# Show plan details
rmplan show 123
rmplan show 123 --short      # Brief summary
rmplan show 123 --full       # Full details

# List ready plans (dependencies satisfied)
rmplan ready
rmplan ready --priority high
rmplan ready --format json
```

### Creating Plans

```bash
# Create stub for later generation
rmplan add "Feature title" --priority high

# Create with relationships
rmplan add "Subtask" --parent 100
rmplan add "Blocked task" --depends-on 101,102

# Create from GitHub issue
rmplan generate --issue 123 -- src/**/*.ts
```

### Generating Plan Content

```bash
# Generate with research (default)
rmplan generate 123 -- src/**/*.ts

# Simple mode (skip research)
rmplan generate 123 --simple -- src/**/*.ts

# Print prompt to stdout (for manual use)
rmplan prompts generate-plan 123
rmplan prompts generate-plan-simple 123
```

### Executing Plans

```bash
# Execute with automated agent
rmplan agent 123
rmplan agent 123 --executor claude-code

# Execute next ready plan
rmplan agent --next

# With workspace isolation
rmplan agent 123 --auto-workspace
```

### Managing Tasks

```bash
# Add task
rmplan add-task 123 --title "Task title" --description "Details"

# Mark complete
rmplan done 123 --commit

# Update metadata
rmplan set 123 --status in_progress --priority high
```

## Plan File Structure

Plans are stored in the configured tasks directory (default: `tasks/`):

```yaml
---
id: 123
title: Implement feature
goal: Add capability X
status: pending
priority: high
parent: 100           # Parent plan ID
dependencies: [101]   # Blocking plan IDs
tasks:
  - title: Task 1
    description: Details
    done: false
---

<!-- rmplan-generated-start -->
## Implementation Guide

Research findings and implementation notes...
<!-- rmplan-generated-end -->

## Progress
### Current State
- Initial stub created; implementation not started yet.
### Completed (So Far)
- None
### Remaining
- Generate tasks and implement feature X
### Next Iteration Guidance
- Start with src/feature.ts and associated tests
### Decisions / Changes
- None
### Risks / Blockers
- None
```

## Workflow Patterns

### Standard Plan Generation

1. Create stub: `rmplan add "Feature" --issue https://github.com/...`
2. Generate plan: Use `generate-plan` MCP prompt or `rmplan generate`
3. Research codebase and add findings
4. Collaborate on task breakdown
5. Save tasks with `update-plan-tasks`

### Breaking Down Large Plans

When a plan is too large, create child plans:

- Use `create-plan` with `parent` field set
- Split by feature areas, not architectural layers
- Each child plan should deliver complete, testable functionality

### Capturing Discovered Issues

When you uncover new, actionable work outside the current plan scope, create a new plan immediately:

```bash
rmplan add "Discovered issue title" --discovered-from 123 --priority medium --details "Why it matters and what to do next"
```

If the issue should live under an epic/parent, add `--parent <parent-plan-id>`. If it blocks current work, add `--depends-on`.

### CLI Prompts for External Tools

Print MCP prompt content to stdout for use with other tools:

```bash
# Print generate-plan prompt
rmplan prompts generate-plan 123

# Print simple generation prompt
rmplan prompts generate-plan-simple --plan 123

# Available prompts
rmplan prompts  # List all available prompts
```

## Additional Resources

For detailed information, consult:

- **`references/mcp-tools.md`** - Complete MCP tool parameters and examples
- **`references/cli-commands.md`** - Full CLI command reference

For configuration and advanced features, see the main rmplan README.
