# tim CLI Commands Reference

Complete reference for tim command-line interface.

## Contents

- [Plan Lifecycle Commands](#plan-lifecycle-commands)
- [Viewing Commands](#viewing-commands)
- [Task Management Commands](#task-management-commands)
- [Prompt Commands](#prompt-commands)
- [Workspace Commands](#workspace-commands)
- [Assignment Commands](#assignment-commands)
- [PR Commands](#pr-commands)
- [Utility Commands](#utility-commands)
- [Common Workflows](#common-workflows)

## Plan Lifecycle Commands

### tim add

Create a plan stub for later generation.

```bash
tim add "Plan title"
tim add "Plan title" --priority high
tim add "Plan title" --parent 100
tim add "Plan title" --depends-on 101,102
tim add "Plan title" --discovered-from 99
tim add "Plan title" --tag frontend --tag urgent
tim add "Plan title" --simple  # Skip research phase
tim add "Plan title" --edit    # Open in editor after creation
tim add "Plan title" --output tasks/custom-name.yml
```

### tim generate

Generate detailed tasks for a plan interactively using Claude Code.

```bash
# From existing stub plan
tim generate 123

# From plan file
tim generate --plan tasks/description.md

# Simple mode (skip research)
tim generate 123 --simple

# Advanced
tim generate 123 --commit                       # Auto-commit result
tim generate --next-ready 100                   # Next child of plan 100
tim generate --latest                           # Latest plan

# Workspace integration
tim generate 123 --auto-workspace               # Auto-select/create workspace
tim generate 123 --workspace feature-xyz        # Manual workspace
tim generate 123 --new-workspace --workspace x  # Force new workspace
tim generate 123 --require-workspace            # Fail if workspace creation fails
tim generate 123 --no-terminal-input            # Disable interactive Q&A
tim generate 123 --non-interactive              # Skip interactive prompts
```

### tim agent / tim run

Execute a plan with automated agent.

```bash
tim agent 123
tim run 123                            # Alias

# Executor selection
tim agent 123 --executor claude-code
tim agent 123 --executor codex-cli
tim agent 123 --executor direct-call
tim agent 123 --executor copy-paste

# Execution modes
tim agent 123 --serial-tasks           # One task at a time
tim agent 123 --simple                 # Skip full review cycle
tim agent 123 --steps 3                # Limit to N steps

# Plan discovery
tim agent --next                       # Next ready plan
tim agent --next-ready 100             # Next ready child of 100

# Workspace
tim agent 123 --auto-workspace         # Find or create workspace
tim agent 123 --workspace feature-xyz  # Specific workspace

# Summary
tim agent 123 --no-summary             # Disable summary
tim agent 123 --summary-file report.txt
```

### tim done

Mark a plan as complete.

```bash
tim done 123
tim done 123 --commit                  # Commit changes
```

## Viewing Commands

### tim show

Display plan details.

```bash
tim show 123
tim show tasks/feature.yml

# Output modes
tim show 123 --short                   # Brief summary
tim show 123 --full                    # Full details

# Discovery
tim show --next                        # Next ready plan
tim show --next-ready 100              # Next ready child
```

### tim list

List all plans.

```bash
tim list
tim list --all                         # Include done/cancelled
tim list --status pending
tim list --status in_progress
tim list --tag frontend
tim list --sort priority               # Default
tim list --sort id
tim list --sort title
```

### tim ready

List plans ready to execute.

```bash
tim ready
tim ready --pending-only               # Exclude in_progress
tim ready --priority high
tim ready --priority urgent
tim ready --tag backend

# Output formats
tim ready --format list                # Default
tim ready --format table
tim ready --format json

# Sorting
tim ready --sort priority              # Default
tim ready --sort id
tim ready --sort title
tim ready --reverse
```

## Task Management Commands

### tim tools

Use `tim tools <tool-name>` for programmatic plan management with JSON stdin/stdout.

```bash
echo '{"plan": "123"}' | tim tools get-plan
echo '{"title": "New plan"}' | tim tools create-plan --json
echo '{"plan": "123", "details": "New details"}' | tim tools update-plan-details
echo '{"plan": "123", "tasks": [{"title": "Task", "description": "Details"}]}' | tim tools update-plan-tasks --json
echo '{"plan": "123", "action": "add", "title": "Task", "description": "Details"}' | tim tools manage-plan-task
echo '{}' | tim tools list-ready-plans --json
```

### tim add-task

Add a task to a plan.

```bash
tim add-task 123 --title "Task title" --description "Details"
tim add-task 123 --title "Task" --description "..." --files src/file.ts
```

### tim remove-task

Remove a task from a plan.

```bash
tim remove-task 123 --title "Task title"
tim remove-task 123 --index 2          # By index (1-based)
tim remove-task 123 --interactive      # Select interactively
```

### tim set

Update plan metadata. Supports adding and removing most plan properties.

```bash
# Status and priority
tim set 123 --status in_progress
tim set 123 --status done
tim set 123 --priority high
tim set 123 --status-description "Waiting on API review"
tim set 123 --no-status-description    # Remove status description

# Dependencies
tim set 123 --depends-on 101 102       # Add dependencies
tim set 123 --no-depends-on 101        # Remove a dependency

# Parent/child relationships
tim set 123 --parent 100
tim set 123 --no-parent                # Remove parent

# Discovery tracking
tim set 123 --discovered-from 99
tim set 123 --no-discovered-from       # Remove

# Tags
tim set 123 --tag backend
tim set 123 --no-tag frontend          # Remove tag

# Issues and docs
tim set 123 --issue https://github.com/org/repo/issues/456
tim set 123 --no-issue https://github.com/org/repo/issues/456
tim set 123 --doc docs/design.md
tim set 123 --no-doc docs/design.md

# Assignment
tim set 123 --assign username
tim set 123 --no-assign

# Plan type flags
tim set 123 --epic                     # Mark as epic
tim set 123 --no-epic
tim set 123 --simple                   # Mark as simple
tim set 123 --no-simple

# Rmfilter files
tim set 123 --rmfilter src/api.ts src/db.ts
```

## Prompt Commands

### tim prompts

Print prompt content to stdout.

```bash
# List available prompts
tim prompts

# Print specific prompt
tim prompts generate-plan 123
tim prompts generate-plan-simple --plan 123
tim prompts plan-questions 123
tim prompts load-plan 123
tim prompts compact-plan 123
```

## Workspace Commands

### tim workspace add

Create a workspace for plan execution. Use `--auto` or `--primary` to set the workspace type (mutually exclusive).

```bash
tim workspace add 123
tim workspace add 123 --id feature-oauth
tim workspace add --id scratch-work     # Without plan
tim workspace add 123 --auto            # Create as auto workspace
tim workspace add 123 --primary         # Create as primary workspace
```

### tim workspace list

List workspaces.

```bash
tim workspace list
tim workspace list --repo https://github.com/user/repo.git
```

### tim workspace push

Push the current branch (git) or bookmark (jj) to the primary workspace.

```bash
tim workspace push
tim workspace push task-123           # Push a specific tracked workspace
tim workspace push /path/to/workspace # Push by path
```

Requires a primary workspace to be configured via `tim workspace update /path --primary`.

### tim workspace update

Update workspace metadata including name, description, and type.

```bash
tim workspace update --name "Auth Feature"
tim workspace update --primary          # Mark as primary workspace
tim workspace update --no-primary       # Reset to standard type
tim workspace update --auto             # Mark as auto workspace (dedicated pool for --auto-workspace)
tim workspace update --no-auto          # Reset to standard type
```

Workspace types: `standard` (default), `primary` (push target, excluded from auto-selection), `auto` (dedicated pool for `--auto-workspace`). `--primary` and `--auto` are mutually exclusive.

## Assignment Commands

### tim claim

Claim a plan for the current workspace.

```bash
tim claim 123
```

### tim release

Release a plan assignment.

```bash
tim release 123
tim release 123 --reset-status         # Reset to pending
```

### tim assignments

Manage assignments across workspaces.

```bash
tim assignments list
tim assignments show-conflicts
tim assignments clean-stale
```

## PR Commands

### tim pr status

Fetch and display PR status for a plan (checks, reviews, merge readiness). Resolves the plan from a positional argument or the current workspace plan (walks parent directories to find the workspace root).

```bash
tim pr status 123
tim pr status                          # Auto-resolve from current workspace
```

### tim pr link

Link a PR to a plan. Validates the PR exists on GitHub and canonicalizes the URL before updating the plan file. Only accepts GitHub PR URLs (not issue URLs).

```bash
tim pr link 123 https://github.com/org/repo/pull/456
tim pr link 123 org/repo#456           # Shorthand notation
```

### tim pr unlink

Remove a PR link from a plan.

```bash
tim pr unlink 123 https://github.com/org/repo/pull/456
tim pr unlink 123 org/repo#456
```

### tim pr description

Generate a PR description from a plan (migrated from `tim pr-description`, which remains as a hidden alias).

```bash
tim pr description tasks/feature.yml
tim pr description tasks/feature.yml --dry-run
tim pr description tasks/feature.yml --create-pr
tim pr description tasks/feature.yml --copy
```

## Utility Commands

### tim validate

Validate plan files and relationships.

```bash
tim validate
tim validate 123 124
tim validate --no-fix
tim validate --verbose
```

### tim materialize

Materialize a DB-backed plan into `.tim/plans/` for editing. Related plans are also written as `.ref.md` context files.

```bash
tim materialize 123
```

### tim cleanup-materialized

Delete stale materialized plan files from `.tim/plans/`. Primary files are removed when their plan is missing, done, or cancelled. Reference files are removed when their plan no longer exists.

```bash
tim cleanup-materialized
```

### tim compact

Summarize completed plan for archival.

```bash
tim compact 144
tim compact 144 --dry-run
tim compact 144 --yes
tim compact 144 --age 14               # Minimum age in days
```

### tim cleanup

Clean up comments from files.

```bash
tim cleanup
tim cleanup src/file.ts
tim cleanup --diff-from main
```

### tim answer-pr

Respond to PR comments.

```bash
tim answer-pr
tim answer-pr 123
tim answer-pr --commit
tim answer-pr --comment
```

### tim update-docs

Update documentation based on plan changes.

```bash
tim update-docs 123
tim update-docs 123 --executor claude-code
```

### tim import

Import plans from issues.

```bash
tim import --issue 123
tim import                             # Interactive multi-select
```

### tim split

Split a plan into phases.

```bash
tim split 123 --output-dir tasks/phases/
```

### tim extract

Extract plan from text.

```bash
tim extract --input description.txt --output tasks/plan.yml
```

### tim sync

Sync plan files to the SQLite database. When given a plan ID, syncs a materialized `.tim/plans/<id>.plan.md` file back to the database. Without a plan ID, syncs all plan files from the tasks directory.

```bash
tim sync 123                           # Sync materialized plan back to DB
tim sync                               # Sync all plans to DB
tim sync --plan 123                    # Sync specific plan from tasks directory
tim sync --prune                       # Also remove DB entries for deleted plans
tim sync --dir tasks/                  # Sync from specific directory
```

### tim init

Initialize tim in a repository.

```bash
tim init                               # Interactive
tim init --yes                         # Use defaults
tim init --minimal                     # Minimal config
tim init --force                       # Overwrite existing
```

### tim mcp-server

Start the MCP server.

```bash
tim mcp-server --mode generate

# Transport options
tim mcp-server --mode generate --transport stdio    # Default
tim mcp-server --mode generate --transport http --port 3000

# Custom config
tim mcp-server --mode generate --config path/to/tim.yml
```

## Common Workflows

### Quick Plan Creation

```bash
tim add "Feature title" --issue https://github.com/org/repo/issues/123
tim generate 456 -- src/**/*.ts
tim agent 456
```

### Plan with Dependencies

```bash
tim add "Phase 1" --priority high
tim add "Phase 2" --depends-on 457
tim add "Phase 3" --depends-on 458 --parent 457
```

### Workspace Isolation

```bash
tim workspace add 123 --id feature-branch
tim agent 123 --workspace feature-branch
```

### Using CLI Prompts

```bash
# Generate plan using printed prompt with external tool
tim prompts generate-plan 123 | pbcopy  # Copy to clipboard
# Paste into external tool, get response, apply with tim
```
