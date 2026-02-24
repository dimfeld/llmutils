# Task-Implementation-Machine (tim)

Tim is an AI-powered project planning and execution system for software development. Generate detailed plans from GitHub/Linear issues, execute them with automated agents, and track progress through complex multi-phase projects.

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
  - [run-prompt - One-Shot Prompts](#run-prompt---one-shot-prompts)
  - [chat - Interactive Sessions](#chat---interactive-sessions)
  - [subagent - Run Subagents](#subagent---run-subagents)
  - [add - Create Plan Stubs](#add---create-plan-stubs)
  - [show - View Plan Details](#show---view-plan-details)
  - [branch-name - Generate Branch Names](#branch-name---generate-branch-names)
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
  - [Progress Tracking](#progress-tracking)
  - [Plan Compaction](#plan-compaction)
- [Supporting Tools](#supporting-tools)
  - [rmfilter](#rmfilter)
  - [apply-llm-edits](#apply-llm-edits)
  - [rmfind](#rmfind)
  - [run-with-tunnel script](#run-with-tunnel-script)
  - [tim-gui (macOS)](#tim-gui-macos)
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
# 0. Initialize tim in your repository (first time only)
tim init
# Interactive setup: creates .rmfilter/config/tim.yml
# Choose tasks directory, executor, and other preferences
# Use --yes for defaults or --minimal for minimal config

# 1. Create a plan stub and generate tasks interactively
tim add "Implement user authentication" --priority high
# Creates tasks/123-implement-user-authentication.yml

tim generate 123
# Claude Code researches the codebase, collaborates with you, and generates tasks
# Research findings are saved to the plan's ## Research section

# 2. Review the generated plan
tim show 123
# Shows: title, goal, status, tasks, and a progress summary

# 3. Execute the plan automatically
tim agent 123 --orchestrator claude-code
# Creates isolated workspace
# Executes each task with LLM
# Runs tests and formatting
# Commits changes
# Updates the plan's Progress section

# 4. Track progress
tim show 123 --short
# Quick view of status and latest activity

# 5. List all ready plans
tim ready
# Shows plans with all dependencies satisfied
```

**Alternative workflow with MCP:**

If you're using Claude Code or another MCP-compatible client:

```bash
# Start the MCP server
tim mcp-server --mode generate

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
tdd: false                       # If true, use TDD mode in tim agent/run

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

---

<!-- Optional manual content -->

<!-- tim-generated-start -->
# Implementation Plan

## Overview
This plan implements user authentication using JWT tokens...

## Research
- Reviewed existing session management in src/sessions/
- Found passport.js already configured
- Need to integrate with existing user model

<!-- tim-generated-end -->

## Progress
### Current State
- Implementation in progress; auth middleware scaffolded and tests started.
### Completed (So Far)
- Drafted auth middleware wiring
### Remaining
- Finish login endpoint and integrate token refresh
### Next Iteration Guidance
- Start with src/auth/middleware.ts and related tests
### Decisions / Changes
- None
### Risks / Blockers
- None
```

**Key Concepts:**

- **Delimiters**: `<!-- tim-generated-start/end -->` preserve AI-generated content while allowing manual edits outside
- **UUID References**: Plans can reference each other by UUID for stable cross-references
- **Progress Tracking**: A structured `## Progress` section in the plan body, updated in place with a living summary (no timestamps)
- **Status Flow**: `pending` → `in_progress` → `done` (or `cancelled`/`deferred`)

---

## Core Commands

### generate - Create Plans

Generate detailed implementation plans interactively using Claude Code or Codex (app-server mode). The generate command uses the same interactive prompt as `tim prompts generate-plan`, enabling collaborative refinement during planning.

**Basic usage:**

```bash
# Generate plan for an existing stub
tim generate 123

# Generate by plan file path
tim generate --plan tasks/feature.yml

# Generate for next ready dependency of a parent plan
tim generate --next-ready 100

# Generate the latest plan
tim generate --latest
```

**Workspace integration:**

```bash
# Auto workspace (finds or creates)
tim generate 123 --auto-workspace

# Manual workspace selection
tim generate 123 --workspace feature-xyz

# Force new workspace
tim generate 123 --new-workspace --workspace feature-xyz

# Require workspace (fail if creation fails)
tim generate 123 --auto-workspace --require-workspace

# Use a specific base branch or revision (e.g. for stacked diffs)
tim generate 123 --auto-workspace --base feature-branch

# Disable automatic workspace round-trip sync
tim generate 123 --auto-workspace --no-workspace-sync
```

**Options:**

```bash
# Simple mode (skip research for quick fixes)
tim generate 123 --simple

# Auto-commit the generated plan
tim generate 123 --commit

# Disable terminal input (no interactive Q&A)
tim generate 123 --no-terminal-input

# Non-interactive mode (skip interactive prompts)
tim generate 123 --non-interactive
```

**How it works:**

1. Resolves plan from ID, path, `--next-ready`, or `--latest`
2. Optionally sets up a workspace (lock, plan file copy)
3. Runs the interactive planning prompt via the selected executor
4. The executor researches the codebase, collaborates with you to refine the plan, and generates structured tasks
5. In workspace mode, syncs the workspace branch/bookmark back to primary by default (disable with `--no-workspace-sync`)
6. Optionally commits changes

**Interactive planning:**

The generate command enables terminal input by default, allowing you to interact with Claude during the planning process. Claude will:

- Investigate the codebase structure
- Document findings in the plan's `## Research` section
- Ask questions to refine the approach
- Generate structured tasks based on the discussion

`tim generate` keeps stdin open while terminal input is enabled, so you can keep chatting after the model emits a `result` message and exit with `Ctrl+D`.

With `-x codex-cli`, generate uses a persistent Codex app-server thread by default, matching chat-style interaction until you close the session. Set `CODEX_USE_APP_SERVER=false` (or `0`) to force legacy `codex exec` behavior.

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
tim agent 123

# Execute using 'run' alias
tim run 123

# Execute next ready plan (all dependencies done)
tim agent --next

# Execute with specific orchestrator
tim agent 123 --orchestrator claude-code
```

**Execution modes:**

```bash
# Batch mode (default) - all tasks in parallel
tim agent 123

# Serial mode - one task at a time
tim agent 123 --serial-tasks

# Simple mode - skip full review cycle
tim agent 123 --simple
# Flow: implement → verify (type check, lint, test)
# Instead of: implement → test → review

# TDD mode - write tests first, then implement
tim agent 123 --tdd
# Flow: tdd-tests → implement → test → review

# TDD + simple mode
tim agent 123 --tdd --simple
# Flow: tdd-tests → implement → verify

# Limit execution to N steps
tim agent 123 --steps 3
```

**Subagent executor selection:**

The orchestrator delegates implementation, testing, and verification to subagents. You can control which executor runs these subagents:

```bash
# Use Codex CLI for all subagents
tim agent 123 -x codex-cli

# Use Claude Code for all subagents
tim agent 123 -x claude-code

# Let the orchestrator choose per-task (default)
tim agent 123 -x dynamic

# Provide guidance for dynamic selection
tim agent 123 -x dynamic --dynamic-instructions "Use codex for database migrations, claude for UI work"
```

In dynamic mode, the orchestrator decides between `claude-code` and `codex-cli` for each subagent invocation based on the task characteristics. Default guidance: "Prefer claude-code for frontend tasks, codex-cli for backend tasks." Override via `--dynamic-instructions` or the `dynamicSubagentInstructions` config field.

**Workspace integration:**

```bash
# Auto workspace (finds or creates)
tim agent 123 --auto-workspace

# Manual workspace selection
tim agent 123 --workspace feature-xyz

# Use a specific base branch or revision
tim agent 123 --auto-workspace --base feature-branch

# Disable automatic workspace round-trip sync
tim agent 123 --auto-workspace --no-workspace-sync

# Agent command handles:
# - Creating isolated git clone (or preparing existing workspace)
# - Checking out appropriate branch
# - Running post-clone commands (npm install, etc.)
# - Running workspace update commands on reused workspaces
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

**Terminal input:**

While the agent is executing, you can type a message and press Enter to send it as a follow-up instruction to the running Claude Code subprocess. This is useful for steering the agent mid-execution (e.g., "also add tests", "stop and fix the type error", "use the existing helper instead").

- Enabled by default when running in an interactive terminal (`stdin.isTTY`)
- Input is echoed visually as `→ You: <message>` in the output stream
- Automatically paused during permission prompts and resumed after
- Forwarded through the tunnel to nested subagents when running in workspace mode
- Custom permission prompts (including Bash prefix selection for "Always Allow"/session allow) are tunneled to the orchestrator
- Disable with `--no-terminal-input` or `terminalInput: false` in config

```bash
# Disable terminal input
tim agent 123 --no-terminal-input
```

**Execution summaries:**

Enabled by default, shows:

- Steps executed and status
- File changes
- Timing information
- Error details

```bash
# Disable summary
tim agent 123 --no-summary

# Write summary to file
tim agent 123 --summary-file report.txt
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

### run-prompt - One-Shot Prompts

Run a single prompt through Claude Code (default) or Codex without plan orchestration.
Executor aliases: `claude`/`claude-code` and `codex`/`codex-cli`.

Execution log output goes to stderr, and the final result goes to stdout for easy piping.

```bash
# Basic usage (Claude default)
tim run-prompt "What is 2 + 2?"

# Specify an explicit Claude model
tim run-prompt --model claude-sonnet-4-5-20250929 "What is 2 + 2?"

# Use Codex with explicit reasoning effort
tim run-prompt -x codex --reasoning-level high "Summarize this repository in 3 bullets"

# Structured JSON output (inline schema)
tim run-prompt --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' "Return JSON only"

# Structured JSON output (schema file)
tim run-prompt --json-schema @schema.json "Return JSON only"

# Read prompt from stdin
echo "Explain this function" | tim run-prompt

# Read prompt from a file
tim run-prompt --prompt-file task.md

# Pipe result to a file
tim run-prompt "summarize this" > result.txt

# Suppress execution log output on stderr
tim run-prompt -q "question" > answer.txt
```

---

### chat - Interactive Sessions

Start an interactive LLM session without a plan. This launches Claude Code (default) or Codex as a persistent session where you provide all input directly.

```bash
# Start interactive session (no initial prompt)
tim chat

# Start with an initial prompt
tim chat "Help me refactor the auth module"

# Read initial prompt from a file
tim chat --prompt-file context.md

# Pipe context as the initial prompt
echo "Explain this codebase" | tim chat

# Use a specific model
tim chat -m claude-sonnet-4-5-20250929 "Help me debug this"

# Use Codex
tim chat -x codex "Summarize this repository"

# Non-interactive mode (single prompt, then exit)
tim chat --non-interactive "What does this function do?"
```

The session stays open after each response, allowing multi-turn conversation. Press Ctrl+D or Ctrl+C to end. Works with Tim-GUI via the headless adapter for remote sessions.

By default, Codex uses app-server mode, so interactive input is supported via the JSON-RPC protocol. Set `CODEX_USE_APP_SERVER=false` (or `0`) to disable app-server mode and fall back to `codex exec` (single-prompt behavior).

---

### subagent - Run Subagents

Used by the orchestrator to delegate work to subagents. Each subagent loads the plan context, builds a role-specific prompt, and executes via the specified executor. Intermediate output is forwarded to the terminal via tunneling while the final result is printed to stdout.

```bash
# Run the implementer subagent with Claude Code
tim subagent implementer 123 -x claude-code --input "Implement tasks 1 and 2"

# Run the tester subagent with Codex CLI
tim subagent tester 123 -x codex-cli --input "Write tests for the auth module"

# Run the verifier subagent (used in simple mode)
tim subagent verifier 123 --input "Verify type checks, linting, and tests pass"

# Run the TDD tests subagent (used in TDD mode)
tim subagent tdd-tests 123 --input "Write failing tests for task 1 and validate failure reasons"

# Also save the final report to a file
tim subagent implementer 123 --input "Implement tasks 1 and 2" --output-file reports/implementer.txt
```

Available subagent types: `implementer`, `tester`, `tdd-tests`, `verifier`. The `-x` flag accepts `codex-cli` or `claude-code` (default: `claude-code`). Use `--output-file <path>` to write the final subagent message to a file.

With default Codex app-server mode, subagents run a single turn and exit after completion, but you can still steer that active turn with follow-up input.

---

### add - Create Plan Stubs

Quickly create plan stub files for future work.

**Basic usage:**

```bash
# Create basic stub
tim add "Implement OAuth authentication"
# Creates tasks/<id>-implement-oauth-authentication.yml

# Specify output location
tim add "Add logging system" --output tasks/logging.yml

# With priority
tim add "Fix security issue" --priority high

# Simple plan (skip research phase)
tim add "Quick refactor" --simple
```

**With relationships:**

```bash
# Set parent plan
tim add "Add user roles" --parent 100

# Set dependencies
tim add "Integration tests" --depends-on 101,102

# Mark as discovered from another plan
tim add "Refactor auth" --discovered-from 99
```

**Tag plans:**

```bash
# Add tags during creation (tags are normalized to lowercase)
tim add "UI refresh" --tag frontend --tag urgent

# Update tags later
tim set 123 --tag backend --no-tag frontend
```

Configure an allowlist via `tags.allowed` in `tim.yml` to restrict tags to a shared vocabulary across the team.

Filter tagged plans in listings:

```bash
tim list --tag frontend --tag urgent
tim list --epic 100
tim ready --tag backend
tim ready --epic 100
```

**Open in editor:**

```bash
# Create and immediately edit
tim add "Complex feature" --edit
```

**Use cases:**

- Capture ideas during review/planning
- Create placeholders for blocking issues
- Set up plan hierarchy before generating details
- Quick task creation for known work

**Next step:**

After creating stubs, use `tim generate <id>` to add detailed tasks.

---

### show - View Plan Details

Display plan information, status, and tasks.

**Basic usage:**

```bash
# Show specific plan
tim show 123

# Show by file path
tim show tasks/feature.yml

# Short summary (status + task titles)
tim show 123 --short
```

**Plan discovery:**

```bash
# Show next ready plan (status pending, all deps done)
tim show --next

# Show next ready dependency of parent plan
tim show --next-ready 100
```

**Full details:**

```bash
# Show full details
tim show 123 --full
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

### branch-name - Generate Branch Names

Generate a git/jj branch name from a plan.

**Basic usage:**

```bash
# Generate from specific plan
tim branch-name 123

# Generate from file path
tim branch-name tasks/feature.yml
```

**Plan discovery flags:**

```bash
# Use most recently updated plan
tim branch-name --latest

# Use next ready plan
tim branch-name --next

# Use current in-progress (or next ready) plan
tim branch-name --current

# Use next ready dependency from parent
tim branch-name --next-ready 100
```

Output is a single branch name string, for example:

```bash
task-123-implement-user-authentication
```

---

### ready - List Ready Plans

Show all plans ready to execute (dependencies satisfied).

**Basic usage:**

```bash
# List all ready plans
tim ready

# Pending only (exclude in_progress)
tim ready --pending-only

# Filter by priority
tim ready --priority high
tim ready --priority urgent
```

**Output formats:**

```bash
# List format (default, colorful and detailed)
tim ready

# Table format (compact)
tim ready --format table

# JSON (for scripting)
tim ready --format json
```

**Sorting:**

```bash
# Sort by priority (default)
tim ready

# Sort by ID
tim ready --sort id

# Sort by title
tim ready --sort title

# Reverse order
tim ready --reverse
```

**Readiness criteria:**

A plan is ready when:

1. Status is `pending` or `in_progress`
2. All dependencies have status `done`
3. Priority is not `maybe`

Note: Includes stub plans without tasks (ready for `tim generate`)

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
tim ready

# Execute next ready plan
tim agent --next

# Or execute specific ready plan
tim agent 123
```

---

### renumber - Manage Plan IDs

Automatically resolve ID conflicts and fix hierarchical ordering, or swap/renumber individual plans.

**Basic usage:**

```bash
# Auto-resolve conflicts and fix hierarchy
tim renumber

# Preview changes without applying
tim renumber --dry-run

# Only fix ID conflicts, skip hierarchy fixes
tim renumber --conflicts-only

# Preserve specific plans during conflict resolution
tim renumber --keep tasks/5-important.yml
```

**Swap or renumber individual plans:**

```bash
# Renumber plan 5 to ID 7 (if 7 doesn't exist)
tim renumber --from 5 --to 7

# Swap two plans (5 becomes 10, 10 becomes 5)
tim renumber --from 5 --to 10

# Preview swap operation
tim renumber --from 5 --to 10 --dry-run
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

The MCP (Model Context Protocol) server exposes tim functionality for AI agents like Claude Code, enabling interactive research, planning, and task management.

### Prompts

The server provides structured prompts that guide AI agents through tim workflows:

**1. `generate-plan`** - Full planning workflow with research

Loads a plan and guides through:

- Planning phase: Analyze task and draft approach
- Research phase: Investigate codebase and capture findings
- Generation phase: Create structured tasks

Research findings are automatically appended to the plan's `## Research` section.

For a plan with "simple: true", the research phase is skipped. Agents will still do some research on their own.

**4. `plan-questions`** - Collaborative refinement

Ask focused questions to improve plan quality before generation.

**5. `load-plan`** - Display plan and wait for guidance

Shows plan details and waits for human instructions.

**6. `compact-plan`** - Summarize completed plans

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
tim mcp-server --mode generate
```

**HTTP transport:**

```bash
tim mcp-server --mode generate --transport http --port 3000
```

**With custom config:**

```bash
tim mcp-server --mode generate --config path/to/tim.yml
```

**Prompts/resources only (no tools):**

```bash
tim mcp-server --no-tools
```

**MCP Client Configuration:**

Add to your MCP client settings (e.g., Claude Code):

```json
{
  "mcpServers": {
    "tim": {
      "command": "tim",
      "args": ["mcp-server", "--mode", "generate"]
    }
  }
}
```

**Example Workflow:**

1. Start server: `tim mcp-server --mode generate`
2. In Claude Code or other MCP client:
   - "Use the generate-plan prompt for plan 123"
   - Claude researches codebase
   - "Can you add a task for input validation?"
   - Use `manage-plan-task` tool to add
   - Review with `get-plan`
3. Execute: `tim agent 123`

If MCP tools are unavailable, you can call the equivalent CLI commands via `tim tools <tool-name>` and pipe JSON input on stdin (use `--json` for structured output).

**Claude Code Plugin:**

This repository includes a Claude Code plugin that automatically configures the tim MCP server and provides a usage skill. To use it, add this repository to your Claude Code plugins:

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
- A skill that loads when you mention "tim" or "generate plan"
- Documentation for MCP tools and CLI commands

**Sandbox mode note:**

If using Claude Code with sandbox mode enabled, you should add `tim:*`, or at least `tim review:*` to the sandbox `excludedCommands` list in your settings to allow the review command to run without permission prompts.

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

Configure in `.rmfilter/config/tim.yml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-config-schema.json

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

  # Commands to run when reusing an existing workspace
  # (e.g. reinstall dependencies after pulling latest changes)
  workspaceUpdateCommands:
    - npm install
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
tim workspace add 123

# Create with custom ID
tim workspace add 123 --id feature-oauth

# Create without plan (manual workspace)
tim workspace add --id scratch-work

# Reuse an existing clean, unlocked workspace (fails if none available)
tim workspace add 123 --reuse

# Try reuse first, otherwise create a new workspace
tim workspace add 123 --try-reuse

# Create (or reuse) using a specific base branch
tim workspace add 123 --from-branch develop
```

**Reuse flags:**

- `--reuse`: Reuse an existing clean, unlocked workspace for the current repo. Fails if no reusable workspace is found.
- `--try-reuse`: Attempt reuse first; if none are available, create a new workspace instead.
- `--from-branch`: Base branch to check out before creating or reusing a workspace branch.
- `--reuse` and `--try-reuse` are mutually exclusive.

**List workspaces:**

```bash
# All workspaces for current repository (default table format)
tim workspace list

# Specific repository
tim workspace list --repo https://github.com/user/repo.git

# List all workspaces across all repositories
tim workspace list --all

# Different output formats
tim workspace list --format table  # Default, human-readable
tim workspace list --format tsv    # Tab-separated for scripts
tim workspace list --format json   # JSON for programmatic use

# Machine-consumable TSV without header
tim workspace list --format tsv --no-header
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
tim workspace update --name "My Workspace" --description "Working on feature X"

# Update by workspace path or task ID
tim workspace update task-123 --description "Updated description"

# Seed description from a plan (extracts issue number and title)
tim workspace update --from-plan 456
# Sets description to "#456 Plan Title"

# Mark workspace as primary (excluded from auto-selection)
tim workspace update --primary

# Remove primary designation
tim workspace update --no-primary
```

**Primary workspaces:**

Mark a workspace as "primary" to prevent it from being auto-selected by `tim agent --auto-workspace`, workspace reuse (`--reuse`/`--try-reuse`), or `workspace lock --available`. This is useful for your main development workspace that you don't want agents to use:

```bash
tim workspace update /path/to/main-workspace --primary
```

Primary workspaces are shown with a "Primary" status in `tim workspace list`. They can still be used manually with `--workspace`.

**Push to primary workspace:**

Push a branch/bookmark between tracked workspaces. Defaults are source=current workspace and destination=primary workspace:

```bash
tim workspace push

# Push from a specific tracked workspace by task ID or path
tim workspace push task-123
tim workspace push /path/to/secondary-workspace

# Explicit source/destination/branch
tim workspace push --from task-123 --to task-456 --branch feature/my-work
```

If no primary workspace is configured, set one first:

```bash
tim workspace update /path/to/main-workspace --primary
```

**Interactive workspace switching:**

Set up a shell function for fast workspace navigation with `fzf`:

```bash
# Generate shell integration function (add to your .zshrc or .bashrc)
tim shell-integration --shell zsh >> ~/.zshrc
# or for bash:
tim shell-integration --shell bash >> ~/.bashrc

# After sourcing, use the tim_ws function:
tim_ws          # Interactive selection with fzf
tim_ws auth     # Pre-filter workspaces matching "auth"
```

The shell function:

- Uses `fzf` for fuzzy selection
- Shows workspace name, description, and branch
- Shows the full workspace list output before opening the selector so it stays visible
- Handles cancellation gracefully

**Using workspaces with agent and generate:**

Both `tim agent` and `tim generate` support workspace isolation with the same options:

```bash
# Auto workspace (finds unlocked or creates new)
tim agent 123 --auto-workspace
tim generate 123 --auto-workspace

# Manual workspace
tim agent 123 --workspace task-123
tim generate 123 --workspace task-123

# Auto workspace handles:
# 1. Search for existing workspaces
# 2. Prefer the workspace currently assigned to this plan (if unlocked)
# 3. Check lock status
# 4. Detect and clear stale locks (prompts for confirmation)
# 5. Create new workspace if all are locked
# For existing workspaces:
#   6. Acquire lock
#   7. Check for uncommitted changes (fails if dirty)
#   8. Pull latest and checkout base branch (or --base ref)
#   9. Copy plan file to workspace
# 10. Run workspaceUpdateCommands (e.g. npm install)
# 11. Execute
# 12. Release lock on completion
```

**Workspace tracking:**

Workspaces, assignments, permissions, and plan metadata are tracked in tim's SQLite database at `~/.config/tim/tim.db`. Plan data is automatically synced on every write, enabling centralized querying across workspaces.

**Lock management:**

Locks prevent concurrent execution in the same workspace:

- **Acquired**: When agent starts
- **Released**: When agent completes or is interrupted
- **Stale detection**: Checks if PID still exists
- **Auto cleanup**: Prompts to clear stale locks

---

## Configuration

### Initializing Configuration

The easiest way to set up tim is with the `init` command:

```bash
# Interactive setup (recommended for first-time users)
tim init

# Use defaults without prompting
tim init --yes

# Create minimal configuration
tim init --minimal

# Overwrite existing configuration
tim init --force
```

The `init` command will:

- Create `.rmfilter/config/tim.yml` with sample configuration
- Set up the tasks directory (default: `tasks/`)
- Guide you through choosing an executor and other preferences
- Configure common settings like code formatting commands

### Manual Configuration

You can also manually configure tim via `.rmfilter/config/tim.yml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-config-schema.json

# Paths
paths:
  tasks: ./tasks # Where plan files are stored
  docs: # Extra documentation search paths
    - ./docs
    - ./project-docs

# Default executor (used by generate, review, and other commands)
defaultExecutor: claude-code # or codex-cli, direct-call, copy-paste

# Default orchestrator for the agent command main loop
defaultOrchestrator: claude-code # Any executor name (claude-code, codex-cli, direct-call, copy-paste, copy-only)

# Default subagent executor for the agent command
defaultSubagentExecutor: dynamic # codex-cli, claude-code, or dynamic

# Instructions for dynamic subagent executor selection
dynamicSubagentInstructions: 'Use claude-code for UI components, codex-cli for data layer'

# Optional per-subagent model overrides by executor
subagents:
  implementer:
    model:
      claude: sonnet-4.6
      codex: gpt-5-codex
  tester:
    model:
      claude: sonnet-4.6
  tddTests:
    model:
      codex: gpt-5-codex
  verifier:
    model:
      claude: sonnet-4.6

# Allow typing messages to the agent during execution (default: true when TTY)
terminalInput: true

# Default executor for review command
review:
  defaultExecutor: claude-code # or codex-cli, both

# Workspace auto-creation (see Workspace Management section)
workspaceCreation:
  cloneMethod: cp
  cloneLocation: /path/to/workspaces
  sourceDirectory: /path/to/source
  # ... (see workspace section for full config)

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

### Headless Mode

`tim agent` and `tim review` automatically stream terminal output to a WebSocket endpoint when
tim is not running in tunnel mode (`TIM_OUTPUT_SOCKET` is unset).

- Default URL: `ws://localhost:8123/tim-agent`
- Env override (highest priority): `TIM_HEADLESS_URL`
- Config override: `headless.url`

```yaml
headless:
  url: ws://localhost:8123/tim-agent
```

Behavior:

- Output is still written locally (console and log files) as usual.
- Output is buffered from adapter startup and replayed to the WebSocket server after connect.
- The output buffer defaults to 10MB; oldest buffered output is dropped when the cap is reached.
- Reconnect attempts are rate-limited to once every 5 seconds while disconnected.
- Connection failures are silent no-ops, so commands continue normally if no server is listening.
- Note: headless streaming is not active in `tim review --print` mode, which installs a separate
  output adapter for executor capture.
- WebSocket messages use an envelope with `session_info`, `replay_start`, `output`, and
  `replay_end` message types. The `session_info` message includes optional `terminalPaneId` and
  `terminalType` fields (populated from `WEZTERM_PANE` env var) for terminal pane matching in tim-gui.
- The headless WebSocket also supports GUI→backend messages: `user_input` messages send free-form text from the GUI to the running agent's subprocess stdin, and `prompt_response` messages send structured answers to interactive prompts (confirm, select, input, checkbox, prefix_select). This enables interactive control from tim-gui.
- For `tim agent` and `tim review`, major lifecycle events are emitted as structured `output`
  payloads (for example: plan discovery, iteration/step lifecycle, failure reports, review
  start/result, and `input_required` before interactive prompts). Other commands continue
  emitting plain log output.
- Claude Code stream-json `system` events such as `task_started` and `task_notification` are
  normalized into `workflow_progress` structured output messages.

For local testing, run a simple listener that accepts `/tim-agent` and prints every received
message:

```bash
bun run tim-agent-listener
```

Optional port override:

```bash
bun run tim-agent-listener -- 9000
# or TIM_AGENT_PORT=9000 bun run tim-agent-listener
```

### Configuration Files and Precedence

tim merges configuration from multiple sources. Later entries override earlier ones:

1. Default configuration (built-in)
2. Global config: `~/.config/tim/config.yml`
3. Repository config: `.rmfilter/config/tim.yml` (or the path provided with `--config`)
4. Local override: `tim.local.yml` (in the same directory as the main config)

Use the global config for machine-wide defaults, and the local override for per-repo tweaks that
should not be committed. The global config uses the same schema and fields as the repository
config, so you can copy settings between them.

### Notifications

Configure an optional notification hook to run a command when agent/review completes or when review
needs input:

```yaml
notifications:
  command: /path/to/notify-script
  workingDirectory: . # Optional, defaults to repo root
  env:
    NOTIFY_LEVEL: info
  enabled: true
```

Fields:

- `command`: Shell command to execute. The notification payload is sent as JSON on stdin.
- `workingDirectory`: Optional working directory for the command (defaults to repository root).
- `env`: Optional environment variables to set for the command.
- `enabled`: Set to `false` to disable notifications.

Notification payload (JSON on stdin):

- `source`: Always `"tim"`.
- `command`: `"agent"` or `"review"`.
- `event`: `"agent_done"`, `"review_done"`, or `"review_input"`.
- `status`: `"success"`, `"error"`, or `"input"` to indicate outcome or prompt state.
- `cwd`: Working directory.
- `planId`: Plan ID (string).
- `planFile`: Path to the plan file.
- `planSummary`: Brief plan summary.
- `planDescription`: Plan description.
- `message`: Human-readable message describing the event.
- `errorMessage`: Error detail for `"error"` statuses (when available).

To suppress notifications for a single run, set `TIM_NOTIFY_SUPPRESS=1` in the environment.
`tim review --dry-run` prints the prompt and skips notifications, while `tim agent --dry-run`
still sends the completion notification.

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
  - Supports app-server mode (enabled by default) for persistent JSON-RPC connection with mid-turn input and interactive approval flows

- **`direct-call`**: Direct API calls
  - Calls any LLM via API
  - Applies edits automatically
  - No agent capabilities

- **`copy-paste`** (default): Manual workflow
  - Copies prompt to clipboard
  - Waits for you to paste LLM response
  - Good for web UIs

Codex app-server mode is enabled by default. To disable it and force legacy `codex exec`, set `CODEX_USE_APP_SERVER=false` (or `0`). App-server mode enables richer interaction, including sending input while a run is active.

**Configure executor:**

```yaml
# In tim.yml
defaultExecutor: claude-code

executors:
  claude-code:
    model: anthropic/claude-3.5-sonnet
    simpleMode: false # Use --simple mode by default
    permissionsMcp:
      enabled: false # Interactive permission system (also handles AskUserQuestion)
      autoApproveCreatedFileDeletion: false

  codex-cli:
    model: openai/gpt-4o
    simpleMode: false

  direct-call:
    model: google/gemini-2.5-flash
```

**Override via CLI:**

```bash
# Set the orchestrator (main agent loop)
tim agent 123 --orchestrator claude-code --model anthropic/claude-opus

# Set the subagent executor (for implementation/testing/verification subagents)
tim agent 123 -x codex-cli

# Combine both
tim agent 123 --orchestrator claude-code -x dynamic
```

Note: `defaultExecutor` is used by commands like `generate`, `review`, and `compact`. The `agent` command uses `defaultOrchestrator` for its main loop (defaulting to `claude-code`) and `defaultSubagentExecutor` for subagents (defaulting to `dynamic`).

Subagent model precedence:

1. `tim subagent ... --model <model>` CLI flag
2. `subagents.<type>.model.<claude|codex>` in config
3. Default executor model behavior

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

- **`never`** (default): Documentation updates are manual only via `tim update-docs ID`
- **`after-iteration`**: Automatically update docs after each agent loop iteration (before commit)
- **`after-completion`**: Automatically update docs only when the entire plan is complete

The `update-docs` command reads the plan's metadata and completed tasks, then asks the executor to find and update relevant documentation files (README.md, CLAUDE.md, docs/, etc.). The executor discovers which files need updating - no manual specification required.

**Manual usage:**

```bash
# Update docs for a completed plan
tim update-docs 123

# Use specific executor/model
tim update-docs 123 --executor claude-code --model anthropic/claude-opus
```

### Documentation Search Paths

Configure where tim searches for `.md` and `.mdc` documentation files:

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

Assignments stored in: `~/.config/tim/tim.db` (SQLite database)

**Commands:**

```bash
# Claim a plan for current workspace
tim claim 123

# Release plan (free it for others)
tim release 123

# Release and reset status to pending
tim release 123 --reset-status

# List assignments
tim assignments list

# Show conflict info (single-workspace model — conflicts no longer occur)
tim assignments show-conflicts

# Clean stale assignments (deleted workspaces, old claims)
tim assignments clean-stale
```

**Auto-claiming:**

The `agent`, `generate`, and `run` commands automatically claim plans for the current workspace.

**Filtering ready plans:**

```bash
# Current workspace + unassigned (default)
tim ready

# All assignments
tim ready --all

# Unassigned only
tim ready --unassigned

# Specific user
tim ready --user alice

# Filter by epic
tim ready --epic 100
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
tim validate

# Validate specific plans
tim validate 123 124

# Report only (no auto-fix)
tim validate --no-fix

# Verbose output
tim validate --verbose
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

- `tim add` with `--parent`
- `tim set` with relationship changes
- Plan file writes

### Progress Tracking

Track milestones, deviations, and discoveries in the plan file's `## Progress` section (outside the generated delimiters). This section is a living summary that is updated in place.

**Update the Progress section:**

- Create `## Progress` at the end of the file if it doesn't exist
- Edit or replace outdated text so it reflects the current reality while preserving meaningful history
- Do not include timestamps anywhere in the section
- Describe what progress was made, how, and why (not just testing/review status)

**Recommended template:**

```markdown
## Progress

### Current State

- ...

### Completed (So Far)

- ...

### Remaining

- ...

### Next Iteration Guidance

- ...

### Decisions / Changes

- ...

### Risks / Blockers

- None
```

**View progress in CLI:**

```bash
tim show 123
tim show 123 --short
tim show 123 --full
```

### Plan Compaction

Reduce completed plan footprint while preserving key decisions.

**Usage:**

```bash
# Compact a completed plan
tim compact 144

# Preview without writing
tim compact 144 --dry-run

# Skip confirmation
tim compact 144 --yes

# Custom executor and age threshold
tim compact 144 --executor direct-call --age 14
```

**What it does:**

1. Condenses generated details (between delimiters)
2. Summarizes research section
3. Preserves manual content outside delimiters

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

### run-with-tunnel script

Starts a local tunnel server, sets `TIM_OUTPUT_SOCKET` for a child process, runs the command,
and prints each received tunnel message as JSON (prefixed with `[tunnel]`).

**Usage:**

```bash
bun scripts/run-with-tunnel.ts -- tim chat
bun scripts/run-with-tunnel.ts -- bun test src/logging/tunnel_server.test.ts
```

---

## Complete Command Reference

### Plan Lifecycle

```bash
# Create stub
tim add "Feature name" [--output FILE] [--parent ID] [--priority LEVEL] [--tag TAG...]

# Generate detailed tasks (interactive planning with Claude Code)
tim generate ID [--plan FILE] [--latest] [--next-ready PARENT_ID] [--simple] [--commit]
tim generate ID [--workspace ID] [--auto-workspace] [--new-workspace] [--non-interactive]
tim generate ID [--no-terminal-input] [--require-workspace] [--base REF]

# Execute plan
tim agent ID [--orchestrator NAME] [-x codex-cli|claude-code|dynamic] [--dynamic-instructions TEXT] [--simple] [--tdd]
tim agent ID [--workspace ID] [--steps N] [--no-terminal-input] [--base REF]
tim run ID  # alias for agent
tim run-prompt [PROMPT] [-x claude|claude-code|codex|codex-cli] [--model MODEL] [--reasoning-level LEVEL]
tim run-prompt [PROMPT] [--json-schema JSON_OR_@FILE] [--prompt-file FILE] [-q]

# Interactive chat session
tim chat [PROMPT] [-x claude|claude-code|codex|codex-cli] [-m MODEL] [--prompt-file FILE]
tim chat [PROMPT] [--non-interactive] [--no-terminal-input]

# Run subagents (used by orchestrator, can also be run standalone)
tim subagent implementer PLAN [-x codex-cli|claude-code] [--input TEXT] [-m MODEL]
tim subagent tester PLAN [-x codex-cli|claude-code] [--input TEXT] [-m MODEL]
tim subagent tdd-tests PLAN [-x codex-cli|claude-code] [--input TEXT] [-m MODEL]
tim subagent verifier PLAN [-x codex-cli|claude-code] [--input TEXT] [-m MODEL]
tim subagent ... [--input-file FILE] [--output-file FILE]

# Track progress
tim show ID [--short | --full]
tim branch-name ID [--latest | --next | --current | --next-ready PARENT_ID]

# Mark complete
tim done ID [--commit]

# Update documentation
tim update-docs ID [--executor NAME] [--model MODEL]

# Compact for archival
tim compact ID [--dry-run] [--yes]
```

### Plan Discovery

```bash
# List all plans
tim list [--all] [--status STATUS] [--sort FIELD] [--tag TAG...] [--epic ID]

# List ready plans
tim ready [--pending-only] [--priority LEVEL] [--format FORMAT] [--tag TAG...] [--epic ID]

# Show next ready
tim show --next
tim show --next-ready PARENT_ID

# Execute next ready
tim agent --next
tim agent --next-ready PARENT_ID
```

Use `--tag` (repeatable) with `tim list` or `tim ready` to filter for plans that include any of the specified tags. Tag filters are case-insensitive and ignore plans without tags.
Use `--epic ID` with `tim list` or `tim ready` to show plans that live under a specific epic (or any parent plan in that hierarchy).

### Plan Management

```bash
# Set metadata
tim set ID --parent PARENT --priority LEVEL --status STATUS [--tag TAG...] [--no-tag TAG...]

# Add/remove tasks
tim add-task ID --title "Title" --description "Desc" [--files FILE]
tim remove-task ID --title "Title"

# Remove plans and clean references (use --force if dependents exist)
tim remove ID_OR_PATH [MORE_IDS_OR_PATHS...] [--force]

# Import from issues
tim import [--issue NUM] [--output FILE]
tim import  # interactive multi-select

# Validate
tim validate [PLANS...] [--no-fix] [--verbose]

# Renumber plans
tim renumber [--dry-run] [--conflicts-only] [--keep FILES...]
tim renumber --from ID --to ID [--dry-run]  # Swap or renumber single plan

# Split into phases
tim split PLAN --output-dir DIR
```

### Workspace Management

```bash
# Create workspace
tim workspace add [ID] [--id WORKSPACE_ID]

# List workspaces
tim workspace list [--repo URL] [--format table|tsv|json] [--all] [--no-header]

# Update workspace metadata
tim workspace update [WORKSPACE] --name NAME --description DESC
tim workspace update --from-plan PLAN_ID
tim workspace update [WORKSPACE] --primary    # Mark as primary (excluded from auto-selection)
tim workspace update [WORKSPACE] --no-primary # Remove primary designation

# Push branch/bookmark between workspaces
tim workspace push [WORKSPACE] [--from WORKSPACE] [--to WORKSPACE] [--branch BRANCH]

# Shell integration (interactive workspace switching with fzf)
tim shell-integration --shell bash|zsh

# Assignments
tim claim ID
tim release ID [--reset-status]
tim assignments list
tim assignments clean-stale
```

### MCP Server

```bash
# Start server
tim mcp-server --mode generate [--transport TRANSPORT] [--port PORT]

# Print MCP prompts from the CLI
tim prompts
tim prompts generate-plan 123
tim prompts generate-plan-simple --plan 123
tim prompts plan-questions 123
tim prompts load-plan 123
tim prompts compact-plan 123
```

### Database Maintenance

Plan metadata (including `details`), tasks, and dependencies are automatically synced to the SQLite database (`~/.config/tim/tim.db`) whenever a plan file is written. This enables centralized querying of plan data across workspaces without reading individual files from disk.

The `tim sync` command performs a bulk sync of all plan files, useful for initial setup or after external changes to plan files:

```bash
# Sync all plan files to SQLite database
tim sync

# Sync only one plan by ID (or file path)
tim sync --plan 123

# Force sync even when plan file updatedAt is older than DB updated_at
tim sync --force

# Show parse/read warnings during sync
tim sync --verbose

# Also remove DB entries for plans no longer on disk
tim sync --prune

# Sync from a specific directory
tim sync --dir /path/to/tasks
```

**Prune safety:** If any plan files fail to parse during sync, `--prune` is automatically skipped to avoid accidentally deleting DB entries for plans that still exist on disk but couldn't be read.
`--plan` and `--prune` are mutually exclusive. By default, sync skips updating a DB row when the plan file's `updatedAt` is older than the row's `updated_at`; use `--force` to override this.
When using `--plan`, referenced plans listed in that plan's `references` map are also synced if they are missing from the database.

Plan deletions via `tim remove` and `tim cleanup-temp` also remove the corresponding database entries.

### Utilities

```bash
# Cleanup comments
tim cleanup [FILES...] [--diff-from BRANCH]

# Review plan changes
tim review [PLAN] [--executor NAME] [--serial-both] [--task-index N...]
tim review [PLAN] --previous-response .rmfilter/reviews/last-review.md

# Answer PR comments
tim answer-pr [PR] [--mode MODE] [--commit] [--comment]

# Extract plan from text
tim extract [--input FILE] [--output FILE]
```

### tim-gui (macOS)

`tim-gui` is a macOS SwiftUI app for monitoring tim agent sessions and browsing project status.

**Features:**

- **Project tracking**: Browse projects, workspaces, and plan-level task status read from `tim.db`. Default filters show pending, in-progress, blocked (unresolved dependencies), and recently-done (last 7 days) plans. Data auto-refreshes while the Projects view is active.
- **Session monitoring**: Connects via WebSocket (`ws://localhost:8123/tim-agent`) to display live agent sessions with streaming output
- **Recent activity time**: Session rows show the time the most recent incoming message or notification was received (falling back to connection time when no messages have arrived yet)
- **Send messages to agents**: Active sessions show a text input field at the bottom of the session view for sending messages to the running agent's subprocess stdin via the headless WebSocket protocol. Press Enter to send, Shift+Enter to insert a newline. The input field auto-grows up to 5 lines and is hidden when the session is disconnected. Sent messages appear in the message list with distinct styling.
- **Interactive prompts**: When the backend sends a `prompt_request` (confirm, select, input, checkbox, or prefix_select), the GUI presents an interactive prompt UI. The user's response is sent back as a `prompt_response` message. Prompts auto-dismiss when answered from any source (GUI, terminal, or timeout).
- **Notification integration**: Incoming HTTP notifications are matched to existing sessions by terminal pane ID (WezTerm) or working directory. Unmatched notifications create standalone session entries.
- **Unread indicators**: Sessions with unread notifications show a blue dot; selecting the session clears it
- **Terminal pane activation**: Sessions with terminal info show a button to activate the associated WezTerm pane
- **macOS system notifications**: Fires native notifications for all incoming messages

```bash
# Open in Xcode
open tim-gui/TimGUI.xcodeproj

# Send a notification (matched to sessions by pane ID or workspace path)
curl -X POST http://127.0.0.1:8123/messages \\
  -H 'Content-Type: application/json' \\
  -d '{\"message\":\"Agent done\",\"workspacePath\":\"/path/to/repo\",\"terminal\":{\"type\":\"wezterm\",\"paneId\":\"42\"}}'
```

---

## Acknowledgements

- [repomix](https://github.com/yamadashy/repomix) and [ripgrep](https://github.com/BurntSushi/ripgrep) for context gathering
- [Aider](https://github.com/Aider-AI/aider) for edit application patterns
- Plan generation approach inspired by [harper.blog](https://harper.blog/2025/02/16/my-llm-codegen-workflow-atm/)
