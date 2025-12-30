# rmplan

AI-powered project planning and execution system for software development. Generate detailed plans from GitHub/Linear issues, execute them with automated agents, and track progress through complex multi-phase projects.

**Core capabilities:**

- **Smart Planning**: Generate detailed implementation plans using LLMs with automatic research phases
- **Issue Tracking**: Track issues and their dependencies
- **Automated Execution**: Run plans step-by-step with workspace isolation and automatic progress tracking
- **MCP Integration**: Full Model Context Protocol server for AI agent access
- **Workspace Management**: Execute plans in isolated git clones with automatic dependency handling
- **Multi-Workspace Coordination**: Claim and track plans across multiple repository checkouts

**Older tools:**

These tools are deprecated as coding agents have largely replaced them, but sill exist in this codebase.

- `rmfilter`: Context gathering wrapper around repomix for LLM prompts
- `apply-llm-edits`: Apply LLM-generated code changes to your repository
- `rmfind`: AI-powered file search with interactive selection

---

# Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Plan Structure](#plan-structure)
- [Core Commands](#core-commands)
  - [generate - Create Plans](#generate---create-plans)
  - [agent/run - Execute Plans](#agentrun---execute-plans)
  - [add - Create Plan Stubs](#add---create-plan-stubs)
  - [show - View Plan Details](#show---view-plan-details)
  - [ready - List Ready Plans](#ready---list-ready-plans)
- [MCP Server](#mcp-server)
  - [Prompts](#prompts)
  - [Tools](#tools)
  - [Starting the Server](#starting-the-server)
- [Workspace Management](#workspace-management)
  - [Why Workspaces](#why-workspaces)
  - [Configuration](#workspace-configuration)
  - [Commands](#workspace-commands)
- [Configuration](#configuration)
  - [Workspace Auto-Creation](#workspace-auto-creation)
  - [Executors](#executors)
  - [Post-Apply Commands](#post-apply-commands)
  - [Documentation Search Paths](#documentation-search-paths)
  - [Model API Keys](#model-api-keys)
- [Advanced Features](#advanced-features)
  - [Multi-Workspace Assignments](#multi-workspace-assignments)
  - [Plan Validation](#plan-validation)
  - [Progress Notes](#progress-notes)
  - [Plan Compaction](#plan-compaction)
- [Supporting Tools](#supporting-tools)
  - [rmfilter](#rmfilter)
  - [apply-llm-edits](#apply-llm-edits)
  - [rmfind](#rmfind)
- [Complete Command Reference](#complete-command-reference)

---

## Installation

**Prerequisites:**

- [Bun](https://bun.sh/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [repomix](https://github.com/yamadashy/repomix)
- [fzf](https://github.com/junegunn/fzf) (for rmfind)
- [bat](https://github.com/sharkdp/bat) (for rmfind)
- [Claude Code](https://github.com/anthropics/claude-code)
- [OpenAI Codex](https://github.com/openai/codex) (optional)

**Install:**

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
pnpm add -g file://$(pwd)
```

---

## Quick Start

Here's a complete workflow from issue to implementation:

```bash
# 0. Initialize rmplan in your repository (first time only)
rmplan init
# Interactive setup: creates .rmfilter/config/rmplan.yml
# Choose tasks directory, executor, and other preferences
# Use --yes for defaults or --minimal for minimal config

# 1. Generate a plan from a GitHub issue
rmplan generate --issue 123 -- src/api/**/*.ts
# Claude Code analyzes the issue, researches the codebase, and creates a detailed plan
# Research findings are saved to the plan's ## Research section
# Plan saved to tasks/123-feature-name.yml

# 2. Review the generated plan
rmplan show 123
# Shows: title, goal, status, tasks, latest progress notes

# 3. Execute the plan automatically
rmplan agent 123 --executor claude-code
# Creates isolated workspace
# Executes each task with LLM
# Runs tests and formatting
# Commits changes
# Tracks progress notes

# 4. Track progress
rmplan show 123 --short
# Quick view of status and latest activity

# 5. List all ready plans
rmplan ready
# Shows plans with all dependencies satisfied
```

**Alternative workflow with MCP:**

If you're using Claude Code or another MCP-compatible client:

```bash
# Start the MCP server
rmplan mcp-server --mode generate

# In your MCP client (e.g., Claude Code):
# 1. Use "generate-plan" prompt with plan ID 123
# 2. Claude researches, generates tasks interactively, and updates the plan
```

---

## Plan Structure

Plans are stored as YAML files with Markdown content (`.plan.md` or `.yml`):

```yaml
---
# Core Metadata
title: Implement user authentication
goal: Add secure user login and session management
id: 123                          # Numeric ID for easy reference
uuid: abc-def-123                # Stable unique identifier
status: in_progress              # pending|in_progress|done|cancelled|deferred
priority: high                   # low|medium|high|urgent|maybe
simple: false                    # If true, skip research phase

# Relationships
parent: 100                      # Parent plan ID
dependencies: [101, 102]         # Must complete these first
discoveredFrom: 99               # Plan that discovered the need for this one

# Tasks
tasks:
  - title: Set up authentication middleware
    description: |
      Create Express middleware for JWT validation
      Include token refresh logic
    done: false

  - title: Add login endpoint
    description: |
      POST /api/login endpoint
      Return JWT token on successful auth
    done: false

# Metadata
issue:
  - https://github.com/user/repo/issues/123
assignedTo: alice
docs:
  - docs/security-policy.md

# Timestamps
createdAt: 2025-01-15T10:00:00Z
updatedAt: 2025-01-15T14:30:00Z
planGeneratedAt: 2025-01-15T10:15:00Z

# Progress Tracking
progressNotes:
  - timestamp: 2025-01-15T12:00:00Z
    source: "implementer: Set up auth middleware"
    text: "Completed middleware implementation, added tests"
---

<!-- Optional manual content -->

<!-- rmplan-generated-start -->
# Implementation Plan

## Overview
This plan implements user authentication using JWT tokens...

## Research
- Reviewed existing session management in src/sessions/
- Found passport.js already configured
- Need to integrate with existing user model

<!-- rmplan-generated-end -->
```

**Key Concepts:**

- **Delimiters**: `<!-- rmplan-generated-start/end -->` preserve AI-generated content while allowing manual edits outside
- **UUID References**: Plans can reference each other by UUID for stable cross-references
- **Progress Notes**: Timestamped notes from agents or manual updates, shown in CLI and included in prompts
- **Status Flow**: `pending` → `in_progress` → `done` (or `cancelled`/`deferred`)

---

## Core Commands

### generate - Create Plans

Generate detailed implementation plans from various sources.

**Basic usage:**

```bash
# From a GitHub issue (automatically fetches issue details)
rmplan generate --issue 123 -- src/**/*.ts

# From a text file describing the feature
rmplan generate --plan tasks/feature-description.md -- src/api/**/*.ts

# Using your editor to write the description
rmplan generate --plan-editor -- src/**/*.ts

# From a Linear issue (requires issueTracker: 'linear' in config)
rmplan generate --issue TEAM-456 -- src/**/*.ts

# Generate for existing stub plan
rmplan generate 123 -- src/**/*.ts
```

**Generation modes:**

```bash
# Claude Code mode (default - best results)
rmplan generate --issue 123 --claude -- src/**/*.ts
# Three-phase process:
# 1. Planning: Claude analyzes and drafts approach
# 2. Research: Captures findings to ## Research section
# 3. Generation: Produces structured tasks

# Simple mode (skip research for quick fixes)
rmplan generate --issue 123 --simple -- src/**/*.ts

# Direct API mode (uses configured LLM directly)
rmplan generate --issue 123 --direct -- src/**/*.ts
```

**Advanced features:**

```bash
# Discover and create blocking subissues first
rmplan generate 42 --claude --with-blocking-subissues
# Creates prerequisite plans automatically
# Sets up proper parent/dependency relationships
# Example output:
# ✓ Created 2 blocking plans: #143 Auth infrastructure, #144 Rate limiting

# Generate for next ready dependency
rmplan generate --next-ready 100 -- src/**/*.ts
# Finds next actionable child plan of plan 100

# Auto-commit the generated plan
rmplan generate --issue 123 --commit -- src/**/*.ts
```

**How it works:**

1. Loads issue/description and any existing plan stub
2. If needed, runs `rmfilter` with provided arguments to gather code context. Claude Code and Codex modes skip this
   step.
3. Calls LLM (via executor: Claude Code, Codex, direct API, or clipboard)
4. Extracts YAML plan from response
5. Writes plan file to configured tasks directory
6. Optionally commits changes

**Research Phase:**

In Claude Code mode (default), the research phase:

- Investigates the codebase structure
- Identifies relevant patterns and dependencies
- Documents findings in the plan's `## Research` section
- Provides context for task generation

Skip research with `--simple` when:

- Making trivial changes
- Plan already has extensive research
- Time is critical

---

### agent/run - Execute Plans

Automated execution of plans with LLM integration.

**Basic usage:**

```bash
# Execute a specific plan
rmplan agent 123

# Execute using 'run' alias
rmplan run 123

# Execute next ready plan (all dependencies done)
rmplan agent --next

# Execute with specific executor
rmplan agent 123 --executor claude-code
```

**Execution modes:**

```bash
# Batch mode (default) - all tasks in parallel
rmplan agent 123

# Serial mode - one task at a time
rmplan agent 123 --serial-tasks

# Simple mode - skip full review cycle
rmplan agent 123 --simple
# Flow: implement → verify (type check, lint, test)
# Instead of: implement → test → review

# Limit execution to N steps
rmplan agent 123 --steps 3
```

**Workspace integration:**

```bash
# Auto workspace (finds or creates)
rmplan agent 123 --auto-workspace

# Manual workspace selection
rmplan agent 123 --workspace feature-xyz

# Agent command handles:
# - Creating isolated git clone
# - Checking out appropriate branch
# - Running post-clone commands (npm install, etc.)
# - Locking workspace during execution
# - Releasing lock on completion
```

**Execution flow:**

For each task/step:

1. **Build prompt**: Runs `rmfilter` with configured context
2. **Execute**: Sends to LLM via executor (Claude Code, Codex CLI, etc.)
3. **Post-apply**: Runs formatting, linting, tests
4. **Mark done**: Updates task status
5. **Commit**: Commits changes with descriptive message
6. **Progress note**: Records completion with timestamp

Stops on:

- Executor failure
- Post-apply command failure (unless `allowFailure: true`)
- All tasks complete

**Execution summaries:**

Enabled by default, shows:

- Steps executed and status
- File changes
- Timing information
- Error details

```bash
# Disable summary
rmplan agent 123 --no-summary

# Write summary to file
rmplan agent 123 --summary-file report.txt
```

**Example output:**

```
Execution Summary: Implement authentication (3/3 • 100%)
┌───────────────┬────────────────┐
│ Plan ID       │ 123            │
│ Mode          │ serial         │
│ Steps Executed│ 3              │
│ Failed Steps  │ 0              │
│ Files Changed │ 5              │
│ Duration      │ 1m 12s         │
└───────────────┴────────────────┘

Step Results
✔ Set up middleware (claude-code) [#1] 24s
✔ Add login endpoint (claude-code) [#2] 31s
✔ Add tests (claude-code) [#3] 17s

File Changes
• tasks/123-implement-auth.plan.md
• src/middleware/auth.ts
• src/routes/auth.ts
• tests/auth.test.ts
```

---

### add - Create Plan Stubs

Quickly create plan stub files for future work.

**Basic usage:**

```bash
# Create basic stub
rmplan add "Implement OAuth authentication"
# Creates tasks/<id>-implement-oauth-authentication.yml

# Specify output location
rmplan add "Add logging system" --output tasks/logging.yml

# With priority
rmplan add "Fix security issue" --priority high

# Simple plan (skip research phase)
rmplan add "Quick refactor" --simple
```

**With relationships:**

```bash
# Set parent plan
rmplan add "Add user roles" --parent 100

# Set dependencies
rmplan add "Integration tests" --depends-on 101,102

# Mark as discovered from another plan
rmplan add "Refactor auth" --discovered-from 99
```

**Tag plans:**

```bash
# Add tags during creation (tags are normalized to lowercase)
rmplan add "UI refresh" --tag frontend --tag urgent

# Update tags later
rmplan set 123 --tag backend --no-tag frontend
```

Configure an allowlist via `tags.allowed` in `rmplan.yml` to restrict tags to a shared vocabulary across the team.

Filter tagged plans in listings:

```bash
rmplan list --tag frontend --tag urgent
rmplan list --epic 100
rmplan ready --tag backend
rmplan ready --epic 100
```

**Open in editor:**

```bash
# Create and immediately edit
rmplan add "Complex feature" --edit
```

**Use cases:**

- Capture ideas during review/planning
- Create placeholders for blocking issues
- Set up plan hierarchy before generating details
- Quick task creation for known work

**Next step:**

After creating stubs, use `rmplan generate <id>` to add detailed tasks.

---

### show - View Plan Details

Display plan information, status, and tasks.

**Basic usage:**

```bash
# Show specific plan
rmplan show 123

# Show by file path
rmplan show tasks/feature.yml

# Short summary (status + latest note + task titles only)
rmplan show 123 --short
```

**Plan discovery:**

```bash
# Show next ready plan (status pending, all deps done)
rmplan show --next

# Show next ready dependency of parent plan
rmplan show --next-ready 100
```

**Full details:**

```bash
# Show all progress notes (not just latest 10)
rmplan show 123 --full
```

**Example output:**

```
Plan #123: Implement user authentication
═══════════════════════════════════════

Status: in_progress  Priority: high  Simple: false
Parent: #100 (User management system)
Dependencies: #101 (Database schema) ✓ done
              #102 (Session storage) ✓ done

Goal:
Add secure user login and session management

Latest Progress Note (2025-01-15 12:00):
[implementer: Set up auth middleware] Completed middleware implementation, added tests

Tasks (2/3 done):
✓ 1. Set up authentication middleware
✓ 2. Add login endpoint
  3. Add integration tests

Files: src/middleware/auth.ts, src/routes/auth.ts
Docs: docs/security-policy.md

Created: 2025-01-15 10:00
Updated: 2025-01-15 14:30
```

---

### ready - List Ready Plans

Show all plans ready to execute (dependencies satisfied).

**Basic usage:**

```bash
# List all ready plans
rmplan ready

# Pending only (exclude in_progress)
rmplan ready --pending-only

# Filter by priority
rmplan ready --priority high
rmplan ready --priority urgent
```

**Output formats:**

```bash
# List format (default, colorful and detailed)
rmplan ready

# Table format (compact)
rmplan ready --format table

# JSON (for scripting)
rmplan ready --format json
```

**Sorting:**

```bash
# Sort by priority (default)
rmplan ready

# Sort by ID
rmplan ready --sort id

# Sort by title
rmplan ready --sort title

# Reverse order
rmplan ready --reverse
```

**Readiness criteria:**

A plan is ready when:

1. Status is `pending` or `in_progress`
2. All dependencies have status `done`
3. Priority is not `maybe`

Note: Includes stub plans without tasks (ready for `rmplan generate`)

**Example output:**

```
Ready Plans (4)
══════════════

[HIGH] #123 Implement authentication
  Status: pending • Tasks: 0/3 • Dependencies: 2 done
  Created: 2025-01-15

[HIGH] #125 Add authorization middleware
  Status: in_progress • Tasks: 1/2 • Dependencies: 1 done
  Created: 2025-01-16

[MEDIUM] #130 User profile endpoint
  Status: pending • Tasks: 0/0 • Dependencies: none
  Created: 2025-01-17

[LOW] #145 Improve error messages
  Status: pending • Tasks: 2/5 • Dependencies: 3 done
  Created: 2025-01-18
```

**Workflow integration:**

```bash
# See what's ready
rmplan ready

# Execute next ready plan
rmplan agent --next

# Or execute specific ready plan
rmplan agent 123
```

---

### renumber - Manage Plan IDs

Automatically resolve ID conflicts and fix hierarchical ordering, or swap/renumber individual plans.

**Basic usage:**

```bash
# Auto-resolve conflicts and fix hierarchy
rmplan renumber

# Preview changes without applying
rmplan renumber --dry-run

# Only fix ID conflicts, skip hierarchy fixes
rmplan renumber --conflicts-only

# Preserve specific plans during conflict resolution
rmplan renumber --keep tasks/5-important.yml
```

**Swap or renumber individual plans:**

```bash
# Renumber plan 5 to ID 7 (if 7 doesn't exist)
rmplan renumber --from 5 --to 7

# Swap two plans (5 becomes 10, 10 becomes 5)
rmplan renumber --from 5 --to 10

# Preview swap operation
rmplan renumber --from 5 --to 10 --dry-run
```

**How it works:**

1. **Conflict resolution**: Identifies plans with duplicate or missing IDs and assigns new unique IDs
2. **Hierarchy ordering**: Ensures parent plans always have lower IDs than their children
3. **Reference updates**: Automatically updates all parent, dependency, and discoveredFrom references using UUID tracking
4. **File renaming**: Renames files matching `{id}-{name}.yml` pattern to reflect new IDs

**When to use:**

- After manually editing plan files and creating ID conflicts
- When parent plans have higher IDs than children (violates hierarchy convention)
- To organize plan IDs numerically
- To swap plan IDs for better organization

**UUID tracking:**

The `references` field maintains UUID-to-ID mappings for referential integrity:

```yaml
id: 123
parent: 100
references:
  100: 'uuid-of-plan-100' # Survives renumbering
```

---

## MCP Server

The MCP (Model Context Protocol) server exposes rmplan functionality for AI agents like Claude Code, enabling interactive research, planning, and task management.

### Prompts

The server provides structured prompts that guide AI agents through rmplan workflows:

**1. `generate-plan`** - Full planning workflow with research

Loads a plan and guides through:

- Planning phase: Analyze task and draft approach
- Research phase: Investigate codebase and capture findings
- Generation phase: Create structured tasks

Research findings are automatically appended to the plan's `## Research` section.

**2. `generate-plan-simple`** - Skip research, generate tasks directly

Use when:

- Making simple changes
- Research already exists
- Time is critical

**3. `plan-questions`** - Collaborative refinement

Ask focused questions to improve plan quality before generation.

**4. `load-plan`** - Display plan and wait for guidance

Shows plan details and waits for human instructions.

**5. `compact-plan`** - Summarize completed plans

For plans with status `done`, `cancelled`, or `deferred`:

- Condenses generated sections
- Summarizes research
- Creates archival progress summary

### Tools

**Plan Management:**

**`create-plan`** - Create new plan with metadata

```typescript
{
  title: "Implement OAuth",
  priority: "high",
  parent: 100,
  dependsOn: [101, 102],
  simple: false
}
```

**`get-plan`** - Retrieve plan by ID or path

```typescript
{
  plan: '123';
} // or "tasks/feature.yml"
```

**`update-plan-tasks`** - Merge generated tasks into plan

```typescript
{
  plan: "123",
  title: "Updated title",
  goal: "Refined goal",
  details: "## Implementation notes\n...",
  tasks: [
    {
      title: "Task 1",
      description: "Details...",
      done: false,
    }
  ]
}
```

**`update-plan-details`** - Update generated section content

```typescript
{
  plan: "123",
  details: "## New analysis\n...",
  append: false  // true to append, false to replace
}
```

**Task Management:**

**`manage-plan-task`** - Add, update, or remove tasks

Add task:

```typescript
{
  plan: "123",
  action: "add",
  title: "Add validation",
  description: "Validate user input...",
}
```

Update task (by title - recommended):

```typescript
{
  plan: "123",
  action: "update",
  taskTitle: "Add validation",  // partial match, case-insensitive
  description: "Updated description...",
  done: true
}
```

Remove task:

```typescript
{
  plan: "123",
  action: "remove",
  taskTitle: "Add validation"  // prefer title over index
}
```

**Research:**

**`append-plan-research`** - Add findings to ## Research section

```typescript
{
  plan: "123",
  research: "## Authentication Flow\n\nFound existing passport.js setup...",
  timestamp: true  // optional, adds timestamp heading
}
```

**Discovery:**

**`list-ready-plans`** - Find executable plans

```typescript
{
  pendingOnly: false,  // exclude in_progress
  priority: "high",    // filter by priority
  sortBy: "priority",  // or "id", "title", "created", "updated"
  limit: 10
}
```

Returns:

```json
{
  "count": 3,
  "plans": [
    {
      "id": 123,
      "title": "Implement auth",
      "priority": "high",
      "status": "pending",
      "taskCount": 3,
      "completedTasks": 0,
      "dependencies": [101, 102],
      "filePath": "tasks/123-implement-auth.yml"
    }
  ]
}
```

### Starting the Server

**stdio transport (default):**

```bash
rmplan mcp-server --mode generate
```

**HTTP transport:**

```bash
rmplan mcp-server --mode generate --transport http --port 3000
```

**With custom config:**

```bash
rmplan mcp-server --mode generate --config path/to/rmplan.yml
```

**Prompts/resources only (no tools):**

```bash
rmplan mcp-server --no-tools
```

**MCP Client Configuration:**

Add to your MCP client settings (e.g., Claude Code):

```json
{
  "mcpServers": {
    "rmplan": {
      "command": "rmplan",
      "args": ["mcp-server", "--mode", "generate"]
    }
  }
}
```

**Example Workflow:**

1. Start server: `rmplan mcp-server --mode generate`
2. In Claude Code or other MCP client:
   - "Use the generate-plan prompt for plan 123"
   - Claude researches codebase
   - "Can you add a task for input validation?"
   - Use `manage-plan-task` tool to add
   - Review with `get-plan`
3. Execute: `rmplan agent 123`

If MCP tools are unavailable, you can call the equivalent CLI commands via `rmplan tools <tool-name>` and pipe JSON input on stdin (use `--json` for structured output).

**Claude Code Plugin:**

This repository includes a Claude Code plugin that automatically configures the rmplan MCP server and provides a usage skill. To use it, add this repository to your Claude Code plugins:

```bash
# Run Claude Code with the plugin
claude --plugin-dir /path/to/llmutils

# Or add to ~/.claude/settings.json
{
  "plugins": ["/path/to/llmutils"]
}
```

The plugin provides:

- Automatic MCP server configuration (no manual `.mcp.json` needed)
- A skill that loads when you mention "rmplan" or "generate plan"
- Documentation for MCP tools and CLI commands

---

## Workspace Management

### Why Workspaces

Workspaces isolate plan execution in dedicated git clones to avoid conflicts with your main development environment.

**Benefits:**

- **Safety**: No risk of breaking your working code
- **Parallelization**: Execute multiple plans simultaneously
- **Clean state**: Each plan starts with a fresh environment
- **Experimentation**: Try approaches without affecting main branch
- **Automatic setup**: Post-clone commands ensure dependencies are installed

**Without workspaces:**

```
main-repo/        ← You're editing files here
├── src/
│   └── auth.ts   ← Agent might conflict with your changes
└── tasks/
```

**With workspaces:**

```
main-repo/        ← You keep working here safely
└── tasks/

workspaces/
├── task-123/     ← Agent works here
│   ├── src/
│   └── tasks/
└── task-124/     ← Another agent works here
    ├── src/
    └── tasks/
```

### Workspace Configuration

Configure in `.rmfilter/config/rmplan.yml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

workspaceCreation:
  # How to create workspace copies
  cloneMethod: cp # cp | git | mac-cow

  # Source directory (required for cp/mac-cow)
  sourceDirectory: /home/user/projects/myapp

  # Repository URL (auto-detected if omitted)
  repositoryUrl: https://github.com/user/myapp.git

  # Where to create workspaces (REQUIRED)
  cloneLocation: /home/user/workspaces

  # Extra files to copy (beyond git-tracked files)
  copyAdditionalGlobs:
    - .env.local
    - .env.development
    - config/local.json

  # Commands to run after creating workspace
  postCloneCommands:
    - npm install
    - npm run build
    - cp ../.env.local .
```

**Clone methods:**

- **`cp`**: Fast copy of git-tracked files only
  - Pros: Very fast, uses minimal disk space
  - Cons: Requires source directory

- **`git`**: Git worktree (shares .git directory)
  - Pros: Efficient disk usage, shares git history
  - Cons: Some operations affect all worktrees

- **`mac-cow`**: macOS copy-on-write (APFS clones)
  - Pros: Faster, shares unchanged files
  - Cons: macOS only

### Workspace Commands

**Create workspace:**

```bash
# Create with plan association
rmplan workspace add 123

# Create with custom ID
rmplan workspace add 123 --id feature-oauth

# Create without plan (manual workspace)
rmplan workspace add --id scratch-work
```

**List workspaces:**

```bash
# All workspaces for current repository (default table format)
rmplan workspace list

# Specific repository
rmplan workspace list --repo https://github.com/user/repo.git

# List all workspaces across all repositories
rmplan workspace list --all

# Different output formats
rmplan workspace list --format table  # Default, human-readable
rmplan workspace list --format tsv    # Tab-separated for scripts
rmplan workspace list --format json   # JSON for programmatic use

# Machine-consumable TSV without header
rmplan workspace list --format tsv --no-header
```

Example table output:

```
+---------------------------+------------+---------------------+-------------+-----------+
| Path                      | Name       | Description         | Branch      | Status    |
+---------------------------+------------+---------------------+-------------+-----------+
| ~/workspaces/task-123     | Auth Work  | #123 Add OAuth      | task-123    | Locked    |
| ~/workspaces/task-124     | -          | API refactoring     | task-124    | Available |
+---------------------------+------------+---------------------+-------------+-----------+
```

**Update workspace metadata:**

```bash
# Set name and description
rmplan workspace update --name "My Workspace" --description "Working on feature X"

# Update by workspace path or task ID
rmplan workspace update task-123 --description "Updated description"

# Seed description from a plan (extracts issue number and title)
rmplan workspace update --from-plan 456
# Sets description to "#456 Plan Title"
```

**Interactive workspace switching:**

Set up a shell function for fast workspace navigation with `fzf`:

```bash
# Generate shell integration function (add to your .zshrc or .bashrc)
rmplan shell-integration --shell zsh >> ~/.zshrc
# or for bash:
rmplan shell-integration --shell bash >> ~/.bashrc

# After sourcing, use the rmplan_ws function:
rmplan_ws          # Interactive selection with fzf
rmplan_ws auth     # Pre-filter workspaces matching "auth"
```

The shell function:

- Uses `fzf` for fuzzy selection
- Shows workspace name, description, and branch
- Provides a preview window with full path and details
- Handles cancellation gracefully

**Using workspaces with agent:**

```bash
# Auto workspace (finds unlocked or creates new)
rmplan agent 123 --auto-workspace

# Manual workspace
rmplan agent 123 --workspace task-123

# Auto workspace handles:
# 1. Search for existing workspaces
# 2. Check lock status
# 3. Detect and clear stale locks (prompts for confirmation)
# 4. Create new workspace if all are locked
# 5. Acquire lock
# 6. Copy plan file to workspace
# 7. Execute
# 8. Release lock on completion
```

**Workspace tracking:**

Workspaces are tracked in `~/.config/rmplan/workspaces.json`:

```json
{
  "workspaces": [
    {
      "id": "task-123",
      "path": "/home/user/workspaces/task-123",
      "taskId": "123",
      "repositoryUrl": "https://github.com/user/repo.git",
      "createdAt": "2025-01-15T10:00:00Z",
      "branch": "task-123",
      "lock": {
        "pid": 12345,
        "hostname": "dev-machine",
        "startedAt": "2025-01-15T14:00:00Z"
      }
    }
  ]
}
```

**Lock management:**

Locks prevent concurrent execution in the same workspace:

- **Acquired**: When agent starts
- **Released**: When agent completes or is interrupted
- **Stale detection**: Checks if PID still exists
- **Auto cleanup**: Prompts to clear stale locks

---

## Configuration

### Initializing Configuration

The easiest way to set up rmplan is with the `init` command:

```bash
# Interactive setup (recommended for first-time users)
rmplan init

# Use defaults without prompting
rmplan init --yes

# Create minimal configuration
rmplan init --minimal

# Overwrite existing configuration
rmplan init --force
```

The `init` command will:

- Create `.rmfilter/config/rmplan.yml` with sample configuration
- Set up the tasks directory (default: `tasks/`)
- Guide you through choosing an executor and other preferences
- Configure common settings like code formatting commands

### Manual Configuration

You can also manually configure rmplan via `.rmfilter/config/rmplan.yml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

# Paths
paths:
  tasks: ./tasks # Where plan files are stored
  docs: # Extra documentation search paths
    - ./docs
    - ./project-docs

# Default executor for agent command
defaultExecutor: claude-code # or codex-cli, direct-call, copy-paste

# Workspace auto-creation (see Workspace Management section)
workspaceCreation:
  cloneMethod: cp
  cloneLocation: /path/to/workspaces
  sourceDirectory: /path/to/source
  # ... (see workspace section for full config)

# Planning configuration
planning:
  direct_mode: false # Use LLM API directly instead of clipboard
  claude_mode: true # Use Claude Code for generation (default)

# Post-apply commands (run after each step)
postApplyCommands:
  - title: Format Code
    command: bun run format
    allowFailure: true
    hideOutputOnSuccess: true

# Model API keys (custom env vars)
modelApiKeys:
  'anthropic/': 'MY_ANTHROPIC_KEY'
  'openai/': 'MY_OPENAI_KEY'

# Auto-examples (find patterns in prompts)
autoexamples:
  - PostgresTestEnvironment
  - find: Select
    example: <Select

# Issue tracker
issueTracker: github # or 'linear'
```

### Workspace Auto-Creation

See [Workspace Management](#workspace-management) section for details.

### Executors

Executors handle LLM interaction and code application:

**Available executors:**

- **`claude-code`** (recommended): Anthropic's Claude Code CLI
  - Agent-based workflow
  - Reads files, applies edits, runs commands
  - Supports implement/test/review cycle

- **`codex-cli`**: OpenAI Codex CLI
  - Implement/test/review loop
  - Auto-retry for planning-only responses

- **`direct-call`**: Direct API calls
  - Calls any LLM via API
  - Applies edits automatically
  - No agent capabilities

- **`copy-paste`** (default): Manual workflow
  - Copies prompt to clipboard
  - Waits for you to paste LLM response
  - Good for web UIs

**Configure executor:**

```yaml
# In rmplan.yml
defaultExecutor: claude-code

executors:
  claude-code:
    model: anthropic/claude-3.5-sonnet
    simpleMode: false # Use --simple mode by default
    permissionsMcp:
      enabled: false # Interactive permission system
      autoApproveCreatedFileDeletion: false

  codex-cli:
    model: openai/gpt-4o
    simpleMode: false

  direct-call:
    model: google/gemini-2.5-flash
```

**Override via CLI:**

```bash
rmplan agent 123 --executor claude-code --model anthropic/claude-opus
```

### Post-Apply Commands

Run commands after each step execution (before marking done):

```yaml
postApplyCommands:
  - title: Type Check
    command: bun run check
    allowFailure: false # Stop execution if this fails

  - title: Format Code
    command: bun run format
    allowFailure: true # Continue even if formatting fails
    hideOutputOnSuccess: true # Only show output on error

  - title: Run Tests
    command: bun test
    workingDirectory: apps/api # Run in subdirectory
    env: # Custom environment variables
      NODE_ENV: test
      CI: true
```

**Use cases:**

- Code formatting (prettier, biome)
- Linting (eslint, ruff)
- Type checking (tsc, mypy)
- Testing (jest, pytest, bun test)
- Custom validation scripts

### Automatic Documentation Updates

Automatically update documentation when completing work using the `update-docs` integration:

```yaml
updateDocs:
  mode: never # Options: never (default), after-iteration, after-completion
  executor: claude-code # Executor to use for doc updates (optional)
  model: anthropic/claude-3.5-sonnet # Model to use (optional)
```

**Modes:**

- **`never`** (default): Documentation updates are manual only via `rmplan update-docs ID`
- **`after-iteration`**: Automatically update docs after each agent loop iteration (before commit)
- **`after-completion`**: Automatically update docs only when the entire plan is complete

The `update-docs` command reads the plan's metadata and completed tasks, then asks the executor to find and update relevant documentation files (README.md, CLAUDE.md, docs/, etc.). The executor discovers which files need updating - no manual specification required.

**Manual usage:**

```bash
# Update docs for a completed plan
rmplan update-docs 123

# Use specific executor/model
rmplan update-docs 123 --executor claude-code --model anthropic/claude-opus
```

### Documentation Search Paths

Configure where rmplan searches for `.md` and `.mdc` documentation files:

```yaml
paths:
  docs:
    - ./docs
    - ./project-docs
    - ../shared-docs
```

Documentation files must have YAML frontmatter:

```markdown
---
description: Authentication patterns
type: docs # or 'rules'
globs: '*.ts, src/auth/**'
grep: auth, login # Match in instructions or source
---

Documentation content here...
```

Files are included in prompts when:

- Globs match source files
- Grep terms appear in instructions or source files
- `alwaysApply: true` in frontmatter

### Model API Keys

Use custom environment variables for API keys:

```yaml
modelApiKeys:
  # Provider-level (all models)
  'anthropic/': 'MY_ANTHROPIC_KEY'
  'openai/': 'MY_OPENAI_KEY'

  # Model-specific (overrides provider)
  'anthropic/claude-3.5-sonnet': 'SONNET_KEY'
  'google/gemini-2.5-flash': 'GEMINI_KEY'
```

Falls back to default env vars if custom not found:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

---

## Advanced Features

### Multi-Workspace Assignments

Track plan ownership across multiple repository checkouts.

**Configuration:**

Assignments stored in: `~/.config/rmplan/shared/<repo-id>/assignments.json`

**Commands:**

```bash
# Claim a plan for current workspace
rmplan claim 123

# Release plan (free it for others)
rmplan release 123

# Release and reset status to pending
rmplan release 123 --reset-status

# List assignments
rmplan assignments list

# Show conflicts (same plan claimed multiple times)
rmplan assignments show-conflicts

# Clean stale assignments (deleted workspaces, old claims)
rmplan assignments clean-stale
```

**Auto-claiming:**

The `agent`, `generate`, and `run` commands automatically claim plans for the current workspace.

**Filtering ready plans:**

```bash
# Current workspace + unassigned (default)
rmplan ready

# All assignments
rmplan ready --all

# Unassigned only
rmplan ready --unassigned

# Specific user
rmplan ready --user alice

# Filter by epic
rmplan ready --epic 100
```

**Use cases:**

- Team collaboration on same repository
- Multiple developers working on different plans
- CI/CD systems claiming plans for execution

See `docs/multi-workspace-workflow.md` for details.

### Plan Validation

Ensure plan file integrity and relationship consistency.

**Basic validation:**

```bash
# Validate all plans in tasks directory
rmplan validate

# Validate specific plans
rmplan validate 123 124

# Report only (no auto-fix)
rmplan validate --no-fix

# Verbose output
rmplan validate --verbose
```

**What it checks:**

1. **Schema compliance**: YAML structure matches expected format
2. **Parent-child consistency**: Bidirectional relationships are correct
3. **Circular dependencies**: Detects and prevents cycles
4. **File existence**: Plan files exist at expected paths

**Auto-fixing:**

When child plan references parent but parent doesn't include child in dependencies:

```
Found inconsistency:
  Plan #123 has parent #100
  But plan #100 dependencies don't include #123

Fixing: Adding #123 to plan #100 dependencies
```

Validation runs automatically during:

- `rmplan add` with `--parent`
- `rmplan set` with relationship changes
- Plan file writes

### Progress Notes

Record milestones, deviations, and discoveries during execution.

**Add notes:**

```bash
# Manual note
rmplan add-progress-note 123 --source "human: review" "Identified edge case in validation"

# Agents add automatically
# [implementer: Task 1] Completed refactor, updated tests
```

**View notes:**

```bash
# Show latest 10 notes (default)
rmplan show 123

# Show all notes
rmplan show 123 --full

# Short view (latest note only)
rmplan show 123 --short
```

**Notes in prompts:**

Agent prompts include up to 50 latest notes (timestamps omitted for clarity):

```
Progress Notes:
[implementer: Set up auth] Completed middleware implementation
[tester: Set up auth] All tests passing
[implementer: Add login] Endpoint functional, needs rate limiting
... and 12 more earlier note(s)
```

**Notes in lists:**

```bash
rmplan list
# Shows Notes column when plans have notes
```

### Plan Compaction

Reduce completed plan footprint while preserving key decisions.

**Usage:**

```bash
# Compact a completed plan
rmplan compact 144

# Preview without writing
rmplan compact 144 --dry-run

# Skip confirmation
rmplan compact 144 --yes

# Custom executor and age threshold
rmplan compact 144 --executor direct-call --age 14
```

**What it does:**

1. Condenses generated details (between delimiters)
2. Summarizes research section
3. Replaces progress notes with archival summary
4. Preserves manual content outside delimiters

**Requirements:**

- Status must be `done`, `cancelled`, or `deferred`
- Plan must be older than `minimumAgeDays` (default: 30)

**Configuration:**

```yaml
compaction:
  minimumAgeDays: 45
  defaultExecutor: claude-code
  defaultModel: anthropic/claude-3.5-sonnet
```

---

## Supporting Tools

### rmfilter

Context gathering wrapper around repomix for creating LLM prompts.

**Basic usage:**

```bash
# Gather files matching patterns
rmfilter src/**/*.ts tests/**/*.ts

# With instructions
rmfilter src/auth/**/*.ts --instructions "Add JWT validation" --copy

# Include import trees
rmfilter src/auth.ts --with-imports

# With grep filters
rmfilter src/**/*.ts --grep "auth" --grep "login"

# Add test files
rmfilter src/feature.ts --with-tests
```

**Presets:**

Create reusable configurations in `.rmfilter/`:

```yaml
# .rmfilter/auth.yml
edit-format: diff
copy: true
instructions: Update authentication logic
commands:
  - globs: ['src/auth/**/*.ts']
    with-imports: true
    with-tests: true
```

Use with:

```bash
rmfilter --preset auth
```

**MDC file support:**

Automatically includes `.mdc` documentation files from:

- `.cursor/rules/`
- `~/.config/rmfilter/rules/`
- Paths configured in `paths.docs`

Based on glob/grep frontmatter matching.

### apply-llm-edits

Apply LLM-generated code changes to your repository.

**Usage:**

```bash
# From clipboard (OSC52 support for SSH)
apply-llm-edits

# From stdin
cat changes.txt | apply-llm-edits --stdin

# Dry run (preview changes)
apply-llm-edits --dry-run

# With custom working directory
apply-llm-edits --cwd /path/to/project
```

**Workflow:**

1. Run `rmfilter` and copy output
2. Paste to LLM (web UI or API)
3. Copy LLM response
4. Run `apply-llm-edits`
5. Review and commit changes

### rmfind

AI-powered file search with interactive selection.

**Usage:**

```bash
# Basic glob search with fzf
rmfind src/**/*.ts

# With content grep
rmfind src/**/*.ts --grep auth --grep login

# Natural language query (requires LLM)
rmfind src/**/*.ts --query "files handling user authentication"

# Output as YAML array
rmfind src/**/*.ts --yaml

# Whole-word matching
rmfind src/**/*.ts --grep getUserData --whole-word
```

**Requirements:**

- `fzf` for interactive selection
- `bat` for syntax-highlighted previews
- `ripgrep` for content filtering
- LLM API access for `--query`

---

## Complete Command Reference

### Plan Lifecycle

```bash
# Create stub
rmplan add "Feature name" [--output FILE] [--parent ID] [--priority LEVEL] [--tag TAG...]

# Generate detailed tasks
rmplan generate [--issue NUM | --plan FILE | --plan-editor] -- [RMFILTER_ARGS]
rmplan generate ID -- [RMFILTER_ARGS]

# Execute plan
rmplan agent ID [--executor NAME] [--workspace ID] [--steps N]
rmplan run ID  # alias for agent

# Track progress
rmplan show ID [--short | --full]
rmplan add-progress-note ID --source "SOURCE" "NOTE"

# Mark complete
rmplan done ID [--commit]

# Update documentation
rmplan update-docs ID [--executor NAME] [--model MODEL]

# Compact for archival
rmplan compact ID [--dry-run] [--yes]
```

### Plan Discovery

```bash
# List all plans
rmplan list [--all] [--status STATUS] [--sort FIELD] [--tag TAG...] [--epic ID]

# List ready plans
rmplan ready [--pending-only] [--priority LEVEL] [--format FORMAT] [--tag TAG...] [--epic ID]

# Show next ready
rmplan show --next
rmplan show --next-ready PARENT_ID

# Execute next ready
rmplan agent --next
rmplan agent --next-ready PARENT_ID
```

Use `--tag` (repeatable) with `rmplan list` or `rmplan ready` to filter for plans that include any of the specified tags. Tag filters are case-insensitive and ignore plans without tags.
Use `--epic ID` with `rmplan list` or `rmplan ready` to show plans that live under a specific epic (or any parent plan in that hierarchy).

### Plan Management

```bash
# Set metadata
rmplan set ID --parent PARENT --priority LEVEL --status STATUS [--tag TAG...] [--no-tag TAG...]

# Add/remove tasks
rmplan add-task ID --title "Title" --description "Desc" [--files FILE]
rmplan remove-task ID --title "Title" [--yes]

# Import from issues
rmplan import [--issue NUM] [--output FILE]
rmplan import  # interactive multi-select

# Validate
rmplan validate [PLANS...] [--no-fix] [--verbose]

# Renumber plans
rmplan renumber [--dry-run] [--conflicts-only] [--keep FILES...]
rmplan renumber --from ID --to ID [--dry-run]  # Swap or renumber single plan

# Split into phases
rmplan split PLAN --output-dir DIR
```

### Workspace Management

```bash
# Create workspace
rmplan workspace add [ID] [--id WORKSPACE_ID]

# List workspaces
rmplan workspace list [--repo URL] [--format table|tsv|json] [--all] [--no-header]

# Update workspace metadata
rmplan workspace update [WORKSPACE] --name NAME --description DESC
rmplan workspace update --from-plan PLAN_ID

# Shell integration (interactive workspace switching with fzf)
rmplan shell-integration --shell bash|zsh

# Assignments
rmplan claim ID
rmplan release ID [--reset-status]
rmplan assignments list
rmplan assignments clean-stale
```

### MCP Server

```bash
# Start server
rmplan mcp-server --mode generate [--transport TRANSPORT] [--port PORT]

# Print MCP prompts from the CLI
rmplan prompts
rmplan prompts generate-plan 123
rmplan prompts generate-plan-simple --plan 123
rmplan prompts plan-questions 123
rmplan prompts load-plan 123
rmplan prompts compact-plan 123
```

### Utilities

```bash
# Cleanup comments
rmplan cleanup [FILES...] [--diff-from BRANCH]

# Answer PR comments
rmplan answer-pr [PR] [--mode MODE] [--commit] [--comment]

# Extract plan from text
rmplan extract [--input FILE] [--output FILE]
```

---

## Acknowledgements

- [repomix](https://github.com/yamadashy/repomix) and [ripgrep](https://github.com/BurntSushi/ripgrep) for context gathering
- [Aider](https://github.com/Aider-AI/aider) for edit application patterns
- Plan generation approach inspired by [harper.blog](https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/)
