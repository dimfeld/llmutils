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
- [Review Guide Commands](#review-guide-commands)
- [Artifact Commands](#artifact-commands)
- [Branch Commands](#branch-commands)
- [Utility Commands](#utility-commands)
- [Common Workflows](#common-workflows)

## Plan Lifecycle Commands

### tim add

Create a plan stub in the DB for later generation.

```bash
tim add "Plan title"
tim add "Plan title" --priority high
tim add "Plan title" --parent 100
tim add "Plan title" --depends-on 101,102
tim add "Plan title" --base-plan 122             # Stack branch on plan 122's branch
tim add "Plan title" --discovered-from 99
tim add "Plan title" --tag frontend --tag urgent
tim add "Plan title" --simple  # Skip research phase
tim add "Plan title" --edit    # Open in editor after creation
```

### tim generate

Generate detailed tasks for a plan interactively using Claude Code.

```bash
# From existing stub plan
tim generate 123

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

### tim edit

Open a plan in `$EDITOR`. Materializes the plan from DB to `.tim/plans/{planId}.plan.md`, opens the editor, syncs changes back to DB on close, then cleans up the temporary file.

If the edited file has invalid frontmatter (bad YAML syntax, missing required fields, or schema validation errors), the error is displayed and the user is prompted to re-edit the file. Declining preserves the file on disk for manual fixing later.

```bash
tim edit 123
```

## Viewing Commands

### tim show

Display plan details.

```bash
tim show 123

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
echo '{"plan": 123}' | tim tools get-plan
echo '{"title": "New plan"}' | tim tools create-plan --json
echo '{"plan": 123, "details": "New details"}' | tim tools update-plan-details
echo '{"plan": 123, "tasks": [{"title": "Task", "description": "Details"}]}' | tim tools update-plan-tasks --json
echo '{"plan": 123, "action": "add", "title": "Task", "description": "Details"}' | tim tools manage-plan-task
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
# Dependencies
tim set 123 --depends-on 101 102       # Add dependencies
tim set 123 --no-depends-on 101        # Remove a dependency

# Parent/child relationships
tim set 123 --parent 100
tim set 123 --no-parent                # Remove parent

# Branch stacking (PR stack on top of another plan's branch)
tim set 123 --base-plan 122            # Stack this plan's branch on plan 122's branch
tim set 123 --no-base-plan             # Clear the stacking pointer

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

### tim assignments claim

Claim a plan for the current workspace.

```bash
tim assignments claim 123
```

### tim assignments release

Release a plan assignment.

```bash
tim assignments release 123
tim assignments release 123 --reset-status         # Reset to pending
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

Link a PR to a plan. Validates the PR exists on GitHub and canonicalizes the URL before updating the plan. Only accepts GitHub PR URLs (not issue URLs).

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
tim pr description 123
tim pr description 123 --dry-run
tim pr description 123 --create-pr
tim pr description 123 --copy
```

### tim pr fix

Fix unresolved PR review threads by spawning an agent session. The agent receives review thread context (file paths, line numbers, diff hunks, comment bodies, and PRRT thread IDs). Agents should batch addressed review-thread replies with GitHub GraphQL by creating one pending review per PR, adding `addPullRequestReviewThreadReply` replies with `pullRequestReviewId`, and submitting the review with `submitPullRequestReview(event: COMMENT)`. Use `tim pr comment` only for feedback that is not represented as a review thread, and do not resolve review threads.

```bash
tim pr fix 123                                 # Interactive thread selection
tim pr fix 123 --all                           # Fix all unresolved threads
tim pr fix 123 --executor claude-code          # Specify executor
tim pr fix 123 --model claude-sonnet-4-5-20250514  # Model override
tim pr fix 123 --auto-workspace                # Auto-select workspace
tim pr fix 123 --all --no-terminal-input       # Non-interactive (web UI mode)
tim pr fix --pr 456 --auto-workspace           # No linked plan: fix a PR by URL/number
```

The numeric positional (`tim pr fix 123`) always means plan ID 123. Pass `--pr <pr-url-or-number>` to fix review threads on a PR that has no linked plan; the agent receives a Pull Request Context prompt (no plan context) and is told not to modify plan files, tasks, status, or assignments. No-plan PR fix always prepares a managed workspace on the PR head branch — it never switches your current checkout, never runs detached, and fails clearly for fork PRs whose head branch is not on `origin`. Because its source material is unresolved GitHub review threads, `pr fix` requires a PR target and rejects `--current`/`--branch` (those belong to `tim review`).

### tim pr resolve

Resolve a PR review thread via the GitHub API. This is a manual command; `tim pr fix` agents are instructed not to resolve threads.

```bash
tim pr resolve <threadId>
```

## Review Guide Commands

Use these commands when working with stored review guides and their extracted issues. Review guides may be plan-only (`tim review-guide generate`) or PR-based (`tim pr review-guide`), and issue management commands can resolve the current guide from a plan ID, branch name, or PR URL.

### tim review-guide generate

Generate a plan-only stored review guide.

```bash
tim review-guide generate 123
tim review-guide generate 123 --auto-workspace
tim review-guide generate 123 --executor codex-cli
```

### tim review-guide list-issues

List actionable issues from the latest stored review guide for a target. Targets can be a plan ID, a branch name, or a PR URL. When the target resolves to a plan linked to a PR, include review guides from both the plan and linked PR; when it resolves to a PR linked to a plan, include guides from both the PR and linked plan. By default, only unresolved non-note issues are shown.

```bash
tim review-guide list-issues 123
tim review-guide list-issues feature/my-branch
tim review-guide list-issues https://github.com/org/repo/pull/456
tim review-guide list-issues 123 --all          # Include resolved issues
```

When a user asks to work through review-guide issues, run `tim review-guide list-issues <target>` first to identify the latest issue IDs and scope. Prefer using the plan ID when available; use the branch name when the user gives branch context; use the PR URL when the user is explicitly asking about PR review-guide issues.

### tim review-guide resolve-issue

Mark a review-guide issue resolved after you have addressed or verified it. Pass the target when available so tim validates that the issue belongs to the latest guide for that plan, branch, or PR. Use `--unresolved` to reopen an issue.

```bash
tim review-guide resolve-issue 42 123
tim review-guide resolve-issue 42 feature/my-branch
tim review-guide resolve-issue 42 https://github.com/org/repo/pull/456
tim review-guide resolve-issue 42 --unresolved
```

Do not mark an issue resolved just because code was changed; verify the specific issue is handled. Notes from review-guide annotations are not actionable issues and cannot be resolved with this command.

## Artifact Commands

Use `tim artifact` to attach files to a plan. Artifacts are either **reference** artifacts (inputs the plan needs — specs, screenshots, sample data) or **proof** artifacts (outputs produced while working the plan — test results, screenshots of a working feature). Reference artifacts are materialized into the plan's workspace automatically before generation and execution, so code and executors can read them from disk; proof artifacts are not materialized and exist only for review/upload.

### tim artifact add

Attach one or more files to a plan.

```bash
tim artifact add 123 ./spec.pdf --reference -m "API spec to implement against"
tim artifact add 123 ./screenshot.png --proof -m "Feature working in browser"
tim artifact add 123 ./fixtures --reference --zip -m "Sample fixture data"   # zip a directory
tim artifact add 123 ./a.png ./b.png --proof --zip                          # zip multiple files
tim artifact add 123 ./spec.pdf --reference --json                          # structured output
```

Exactly one of `--reference` or `--proof` is required. Multiple files can only be attached together with `--zip`, which archives them (or a directory's contents) into a single ZIP artifact.

### tim artifact list

List artifacts attached to a plan.

```bash
tim artifact list 123
tim artifact list 123 --include-deleted
tim artifact list 123 --json
```

### tim artifact show

Show metadata for a single artifact by UUID.

```bash
tim artifact show <artifactUuid>
```

### tim artifact delete / restore

```bash
tim artifact delete <artifactUuid>          # Soft-delete
tim artifact delete <artifactUuid> --hard   # Remove the row and local file
tim artifact restore <artifactUuid>         # Restore a soft-deleted artifact
```

### tim artifact purge

Remove old artifact rows and orphaned artifact files (retention cleanup).

```bash
tim artifact purge
tim artifact purge --older-than 14        # Retention threshold in days (default: 30)
tim artifact purge --include-active       # Also consider active artifacts on non-terminal plans
tim artifact purge --dry-run
```

## Branch Commands

### tim rebase

Rebase a plan's branch onto the latest main/trunk branch. Supports both Git and Jujutsu repositories. If conflicts are detected, launches an LLM executor in bare mode with VCS-specific conflict resolution prompts.

```bash
# Rebase a specific plan's branch
tim rebase 123

# Plan discovery
tim rebase --current                          # Current plan
tim rebase --next                             # Next ready plan

# Executor options (only used if conflicts arise)
tim rebase 123 --executor claude-code
tim rebase 123 --model claude-sonnet-4-5-20250514

# Skip push after rebase
tim rebase 123 --no-push

# Workspace integration (used by web UI)
tim rebase 123 --auto-workspace
tim rebase 123 --workspace feature-xyz
tim rebase 123 --new-workspace
tim rebase 123 --no-terminal-input            # Disable interactive input
```

The branch is resolved from the plan's `branch` field, falling back to the calculated branch name via `generateBranchNameFromPlan()`. The trunk branch is auto-detected via `getTrunkBranch()`. After a successful rebase, the branch is force-pushed to origin (`--force-with-lease` for Git). For Git, if the executor fails mid-rebase, `git rebase --abort` is run to clean up.

## Utility Commands

### tim validate

Validate plans and relationships. Loads plans from the DB with a file overlay for YAML-specific validation. Checks parent-child consistency, circular dependencies, and dependency resolution.

```bash
tim validate
tim validate 123 124
tim validate --no-fix
tim validate --verbose
tim validate --dir /path/to/repo
```

### tim materialize

Materialize a DB-backed plan into `.tim/plans/` for editing. Related plans are also written as `.plan.md` files with `materializedAs: reference` in their frontmatter.

```bash
tim materialize 123
```

### tim cleanup-materialized

Delete stale materialized plan files from `.tim/plans/`. Primary files are removed when their plan is missing, done, or cancelled. Reference files are removed when their plan no longer exists.

```bash
tim cleanup-materialized
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

### tim simplify

Run a code-simplification pass over the changes introduced by a plan. Launches three parallel review agents (code reuse, code quality, efficiency) and applies the valid findings. Always runs when invoked directly, regardless of the `simplify.mode` config setting.

```bash
tim simplify 123
tim simplify 123 --executor claude-code --model opus
```

### tim import

Import plans from issues.

```bash
tim import --issue 123
tim import                             # Interactive multi-select
```

### tim sync

Sync materialized plan files back to the SQLite database. When given a plan ID, syncs a single `.tim/plans/<id>.plan.md` file. Without a plan ID, scans `.tim/plans/` for all `*.plan.md` files and syncs them all.

```bash
tim sync 123                           # Sync single materialized plan back to DB
tim sync                               # Sync all materialized plans from .tim/plans/
tim sync --verbose                     # Show detailed sync progress
```

### tim init

Initialize tim in a repository.

```bash
tim init                               # Interactive
tim init --yes                         # Use defaults
tim init --minimal                     # Minimal config
tim init --force                       # Overwrite existing
```

### tim shell

Open an interactive login shell (`zsh -l` by default) inside the workspace for a plan, branch, or PR. Sets up and/or switches to the correct workspace (honoring the standard workspace/branch/plan/PR options), then spawns the shell in a PTY whose working directory is the prepared workspace. The shell is exposed as a `pty` session over the embedded session server, so it is also reachable/streamable like other tim sessions.

```bash
tim shell 123                          # Workspace for plan 123
tim shell --plan 123                   # Equivalent
tim shell --branch feature/my-branch   # Workspace for a branch
tim shell --pr 456                     # Workspace for a PR head branch
tim shell 123 --auto-workspace         # Find or create workspace
tim shell 123 --workspace feature-xyz  # Specific workspace
tim shell --shell bash                 # Override the shell binary (falls back to $SHELL, then zsh)
tim shell 123 --cols 120 --rows 40     # Initial PTY size (defaults to the current terminal)
```

A plan ID may be given positionally or with `--plan`, but not both. `--pr` cannot be combined with a plan ID, `--plan`, or `--branch`; `--branch` cannot be combined with a plan ID or `--plan`.

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
