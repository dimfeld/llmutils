# rmplan CLI Commands Reference

Complete reference for rmplan command-line interface.

## Plan Lifecycle Commands

### rmplan add

Create a plan stub for later generation.

```bash
rmplan add "Plan title"
rmplan add "Plan title" --priority high
rmplan add "Plan title" --parent 100
rmplan add "Plan title" --depends-on 101,102
rmplan add "Plan title" --discovered-from 99
rmplan add "Plan title" --tag frontend --tag urgent
rmplan add "Plan title" --simple  # Skip research phase
rmplan add "Plan title" --edit    # Open in editor after creation
rmplan add "Plan title" --output tasks/custom-name.yml
```

### rmplan generate

Generate detailed tasks for a plan.

```bash
# From existing stub plan
rmplan generate 123 -- src/**/*.ts

# From GitHub issue
rmplan generate --issue 123 -- src/**/*.ts

# From text file
rmplan generate --plan tasks/description.md -- src/**/*.ts

# From editor
rmplan generate --plan-editor -- src/**/*.ts

# Generation modes
rmplan generate 123 --claude -- src/**/*.ts        # Claude Code (default)
rmplan generate 123 --simple -- src/**/*.ts        # Skip research
rmplan generate 123 --direct -- src/**/*.ts        # Direct API

# Advanced
rmplan generate 123 --with-blocking-subissues      # Discover prerequisites
rmplan generate 123 --commit                       # Auto-commit result
rmplan generate --next-ready 100 -- src/**/*.ts    # Next child of plan 100
```

### rmplan agent / rmplan run

Execute a plan with automated agent.

```bash
rmplan agent 123
rmplan run 123                            # Alias

# Executor selection
rmplan agent 123 --executor claude-code
rmplan agent 123 --executor codex-cli
rmplan agent 123 --executor direct-call
rmplan agent 123 --executor copy-paste

# Execution modes
rmplan agent 123 --serial-tasks           # One task at a time
rmplan agent 123 --simple                 # Skip full review cycle
rmplan agent 123 --steps 3                # Limit to N steps

# Plan discovery
rmplan agent --next                       # Next ready plan
rmplan agent --next-ready 100             # Next ready child of 100

# Workspace
rmplan agent 123 --auto-workspace         # Find or create workspace
rmplan agent 123 --workspace feature-xyz  # Specific workspace

# Summary
rmplan agent 123 --no-summary             # Disable summary
rmplan agent 123 --summary-file report.txt
```

### rmplan done

Mark a plan as complete.

```bash
rmplan done 123
rmplan done 123 --commit                  # Commit changes
```

## Viewing Commands

### rmplan show

Display plan details.

```bash
rmplan show 123
rmplan show tasks/feature.yml

# Output modes
rmplan show 123 --short                   # Brief summary
rmplan show 123 --full                    # All progress notes

# Discovery
rmplan show --next                        # Next ready plan
rmplan show --next-ready 100              # Next ready child
```

### rmplan list

List all plans.

```bash
rmplan list
rmplan list --all                         # Include done/cancelled
rmplan list --status pending
rmplan list --status in_progress
rmplan list --tag frontend
rmplan list --sort priority               # Default
rmplan list --sort id
rmplan list --sort title
```

### rmplan ready

List plans ready to execute.

```bash
rmplan ready
rmplan ready --pending-only               # Exclude in_progress
rmplan ready --priority high
rmplan ready --priority urgent
rmplan ready --tag backend

# Output formats
rmplan ready --format list                # Default
rmplan ready --format table
rmplan ready --format json

# Sorting
rmplan ready --sort priority              # Default
rmplan ready --sort id
rmplan ready --sort title
rmplan ready --reverse
```

## MCP Tool Equivalents

Use `rmplan tools <tool-name>` when you need MCP tool behavior via CLI (JSON stdin/stdout).

```bash
echo '{"plan": "123"}' | rmplan tools get-plan
echo '{"title": "New plan"}' | rmplan tools create-plan --json
echo '{"plan": "123", "details": "New details"}' | rmplan tools update-plan-details
echo '{"plan": "123", "tasks": [{"title": "Task", "description": "Details"}]}' | rmplan tools update-plan-tasks --json
echo '{"plan": "123", "action": "add", "title": "Task", "description": "Details"}' | rmplan tools manage-plan-task
echo '{}' | rmplan tools list-ready-plans --json
```

## Task Management Commands

### rmplan add-task

Add a task to a plan.

```bash
rmplan add-task 123 --title "Task title" --description "Details"
rmplan add-task 123 --title "Task" --description "..." --files src/file.ts
```

### rmplan remove-task

Remove a task from a plan.

```bash
rmplan remove-task 123 --title "Task title"
rmplan remove-task 123 --yes              # Skip confirmation
```

### rmplan set

Update plan metadata.

```bash
rmplan set 123 --status in_progress
rmplan set 123 --status done
rmplan set 123 --priority high
rmplan set 123 --parent 100
rmplan set 123 --tag backend
rmplan set 123 --no-tag frontend          # Remove tag
```

### rmplan add-progress-note

Record progress on a plan.

```bash
rmplan add-progress-note 123 --source "human: review" "Note text"
```

## Prompt Commands

### rmplan prompts

Print MCP prompt content to stdout.

```bash
# List available prompts
rmplan prompts

# Print specific prompt
rmplan prompts generate-plan 123
rmplan prompts generate-plan-simple --plan 123
rmplan prompts plan-questions 123
rmplan prompts load-plan 123
rmplan prompts compact-plan 123
```

Use this when you want to run a prompt outside of the MCP context.

## Workspace Commands

### rmplan workspace add

Create a workspace for plan execution.

```bash
rmplan workspace add 123
rmplan workspace add 123 --id feature-oauth
rmplan workspace add --id scratch-work     # Without plan
```

### rmplan workspace list

List workspaces.

```bash
rmplan workspace list
rmplan workspace list --repo https://github.com/user/repo.git
```

## Assignment Commands

### rmplan claim

Claim a plan for the current workspace.

```bash
rmplan claim 123
```

### rmplan release

Release a plan assignment.

```bash
rmplan release 123
rmplan release 123 --reset-status         # Reset to pending
```

### rmplan assignments

Manage assignments across workspaces.

```bash
rmplan assignments list
rmplan assignments show-conflicts
rmplan assignments clean-stale
```

## Utility Commands

### rmplan validate

Validate plan files and relationships.

```bash
rmplan validate
rmplan validate 123 124
rmplan validate --no-fix
rmplan validate --verbose
```

### rmplan compact

Summarize completed plan for archival.

```bash
rmplan compact 144
rmplan compact 144 --dry-run
rmplan compact 144 --yes
rmplan compact 144 --age 14               # Minimum age in days
```

### rmplan cleanup

Clean up comments from files.

```bash
rmplan cleanup
rmplan cleanup src/file.ts
rmplan cleanup --diff-from main
```

### rmplan answer-pr

Respond to PR comments.

```bash
rmplan answer-pr
rmplan answer-pr 123
rmplan answer-pr --commit
rmplan answer-pr --comment
```

### rmplan update-docs

Update documentation based on plan changes.

```bash
rmplan update-docs 123
rmplan update-docs 123 --executor claude-code
```

### rmplan import

Import plans from issues.

```bash
rmplan import --issue 123
rmplan import                             # Interactive multi-select
```

### rmplan split

Split a plan into phases.

```bash
rmplan split 123 --output-dir tasks/phases/
```

### rmplan extract

Extract plan from text.

```bash
rmplan extract --input description.txt --output tasks/plan.yml
```

### rmplan init

Initialize rmplan in a repository.

```bash
rmplan init                               # Interactive
rmplan init --yes                         # Use defaults
rmplan init --minimal                     # Minimal config
rmplan init --force                       # Overwrite existing
```

### rmplan mcp-server

Start the MCP server.

```bash
rmplan mcp-server --mode generate

# Transport options
rmplan mcp-server --mode generate --transport stdio    # Default
rmplan mcp-server --mode generate --transport http --port 3000

# Custom config
rmplan mcp-server --mode generate --config path/to/rmplan.yml
```

## Common Workflows

### Quick Plan Creation

```bash
rmplan add "Feature title" --issue https://github.com/org/repo/issues/123
rmplan generate 456 -- src/**/*.ts
rmplan agent 456
```

### Plan with Dependencies

```bash
rmplan add "Phase 1" --priority high
rmplan add "Phase 2" --depends-on 457
rmplan add "Phase 3" --depends-on 458 --parent 457
```

### Workspace Isolation

```bash
rmplan workspace add 123 --id feature-branch
rmplan agent 123 --workspace feature-branch
```

### Using CLI Prompts

```bash
# Generate plan using printed prompt with external tool
rmplan prompts generate-plan 123 | pbcopy  # Copy to clipboard
# Paste into external tool, get response, apply with rmplan
```
