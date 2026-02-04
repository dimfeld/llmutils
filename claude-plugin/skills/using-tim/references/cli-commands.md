# tim CLI Commands Reference

Complete reference for tim command-line interface.

## Contents

- [Plan Lifecycle Commands](#plan-lifecycle-commands)
- [Viewing Commands](#viewing-commands)
- [Task Management Commands](#task-management-commands)
- [Prompt Commands](#prompt-commands)
- [Workspace Commands](#workspace-commands)
- [Assignment Commands](#assignment-commands)
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

Generate detailed tasks for a plan.

```bash
# From existing stub plan
tim generate 123 -- src/**/*.ts

# From GitHub issue
tim generate --issue 123 -- src/**/*.ts

# From text file
tim generate --plan tasks/description.md -- src/**/*.ts

# From editor
tim generate --plan-editor -- src/**/*.ts

# Generation modes
tim generate 123 --claude -- src/**/*.ts        # Claude Code (default)
tim generate 123 --simple -- src/**/*.ts        # Skip research
tim generate 123 --direct -- src/**/*.ts        # Direct API

# Advanced
tim generate 123 --with-blocking-subissues      # Discover prerequisites
tim generate 123 --commit                       # Auto-commit result
tim generate --next-ready 100 -- src/**/*.ts    # Next child of plan 100
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

Update plan metadata.

```bash
tim set 123 --status in_progress
tim set 123 --status done
tim set 123 --priority high
tim set 123 --parent 100
tim set 123 --tag backend
tim set 123 --no-tag frontend          # Remove tag
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

Create a workspace for plan execution.

```bash
tim workspace add 123
tim workspace add 123 --id feature-oauth
tim workspace add --id scratch-work     # Without plan
```

### tim workspace list

List workspaces.

```bash
tim workspace list
tim workspace list --repo https://github.com/user/repo.git
```

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

## Utility Commands

### tim validate

Validate plan files and relationships.

```bash
tim validate
tim validate 123 124
tim validate --no-fix
tim validate --verbose
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
