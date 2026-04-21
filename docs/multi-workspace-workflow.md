# Multi-Workspace Workflows with tim

Managing large features often requires multiple active workspaces, or even multiple developers working on the same repository. tim's shared assignments system keeps those workspaces coordinated without forcing everyone to edit the same materialized plan file. This guide explains how assignments work, how to claim plans for specific workspaces and users, and resolve conflicts when they appear.

## Quick Start

1. **Set your user identity** (recommended):

   ```bash
   export TIM_USER="alice"
   ```

   tim falls back to `USER`, `USERNAME`, or `LOGNAME`, but setting `TIM_USER` keeps names consistent across shells and machines.

2. **Clone the repository into multiple workspaces** as needed. Each workspace must be its own git checkout so tim can discover the correct workspace path.

3. **Claim a plan** from the workspace that will execute it:

   ```bash
   tim assignments claim 42
   ```

   The claim records:
   - The plan UUID and (if available) numeric ID
   - The workspace's absolute path (resolved through symlinks)
   - The active user identity
   - Timestamps for when the assignment was created and last updated

   Claims are stored in tim's SQLite database at `~/.config/tim/tim.db`.

4. **Run your normal commands** (`tim agent`, `tim generate`, etc.). When auto-claiming is enabled (the default in the CLI), those commands call the claim workflow automatically before they start work.

5. **Release the plan** when you leave the workspace or finish the task:

   ```bash
   tim assignments release 42
   ```

   Use `--reset-status` if you also want to move the plan back to `pending`.

## Viewing Assignments

The assignments database augments the existing plan metadata. Commands read both sources and merge them so workspaces always see the most relevant plans:

- `tim ready` loads plans from SQLite (matching `tim list` behavior) and shows the current workspace's claims plus any unassigned plans. Add `--all`, `--unassigned`, or `--user <name>` to broaden the view.
- `tim list --assigned` shows only claimed plans. Use `--unassigned` for the inverse.
- `tim show 42` prints the workspace path, user, and claim timestamps.
- `tim assignments list` provides a repository-wide overview of every assignment.

Each plan is assigned to a single workspace at a time. If another workspace claims an already-assigned plan, tim prints a warning about reassigning and updates the assignment to the new workspace.

## Working with Multiple Clones

Each clone has its own git root, so the assignment system distinguishes workspaces by their database record. Some tips:

- Always run tim commands from inside the workspace you want to associate with the plan. The CLI captures the current git root when claiming.
- Symlinks are resolved automatically, ensuring claims stay stable even if the workspace path contains symlinked directories.
- Claims survive git operations (branch switches, rebases, renames) because they are keyed by the plan UUID, not by filename.

### Example Workflow

```bash
# Workspace A – feature implementation
cd ~/dev/myapp-feature-a
tim ready          # shows plans assigned here or unclaimed
tim assignments claim 10       # mark plan 10 for this workspace
tim agent 10       # executes and auto-claims if not already claimed

# Workspace B – documentation plan
cd ~/dev/myapp-feature-b
tim ready --unassigned
tim assignments claim docs-uuid
tim generate --plan docs-uuid

# Later, release plans when the work is complete
tim assignments release 10
tim assignments release docs-uuid --reset-status
```

## Team Coordination

- Encourage everyone to set `TIM_USER` so claims identify the correct owner.
- Use `tim ready --user alice` to see all of Alice's active plans regardless of workspace.
- `tim assignments clean-stale` removes claims that have been idle longer than the configured timeout (defaults to 7 days). Pass `--yes` to skip confirmation.

## Troubleshooting

| Symptom                                     | Explanation                                                                                                                                            | Resolution                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `auto-claim` warnings in tests or scripts   | Auto-claim is disabled unless the CLI enables it.                                                                                                      | Import `enableAutoClaim()` from `src/tim/assignments/auto_claim.js` if you need it in custom tooling. |
| Claims point to stale workspaces            | The workspace was deleted or renamed.                                                                                                                  | Run `tim assignments clean-stale` or release the plan manually.                                       |
| Plan still appears claimed after completion | tim removes assignments when plan status transitions to `done` or `cancelled`. Plans in `needs_review` preserve their assignments and workspace locks. | Verify the plan reached the correct status; re-run `tim assignments release <plan>` if necessary.     |

## Workspace Types

Each workspace has a type that controls how it participates in auto-selection:

| Type       | DB Value | Description                                                                                                                  |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `standard` | 0        | Default type. Eligible for auto-selection only when no `auto` workspaces exist.                                              |
| `primary`  | 1        | The main checkout. Branches are pulled here from origin after execution. Never auto-selected.                                |
| `auto`     | 2        | Dedicated pool for `--auto-workspace`. When any auto workspace exists, only auto workspaces are eligible for auto-selection. |

### Auto-Selection Behavior

When `--auto-workspace` needs to pick a workspace:

1. If any workspace for the repository has type `auto`, restrict candidates to auto workspaces only.
2. Otherwise, all non-primary workspaces are candidates (preserving the original behavior).
3. If all eligible workspaces are locked, a new workspace is created and automatically tagged as `auto` so it remains in the pool for future runs.

This lets you carve out a dedicated set of workspaces for automated use while keeping other workspaces available for manual work.

## Workspace Switching

When working with multiple workspaces, quickly switching between them can be tedious. tim provides an interactive workspace switcher using `fzf`.

### Setup

Generate a shell function for your shell:

```bash
# For zsh (add to ~/.zshrc)
tim shell-integration --shell zsh >> ~/.zshrc

# For bash (add to ~/.bashrc)
tim shell-integration --shell bash >> ~/.bashrc

# Then reload your shell or source the file
source ~/.zshrc
```

### Usage

After setup, use the `tim_ws` function:

```bash
tim_ws          # Interactive fuzzy selection
tim_ws auth     # Pre-filter to workspaces matching "auth"
tim_ws 123      # Pre-filter to workspaces with "123" in name/description
```

The switcher displays workspace name, description, and branch. It also prints the full
`tim workspace list` output before launching the selector so you can always keep the list
in view.

Use Esc or Ctrl+C to cancel without changing directories.

### Workspace Metadata

Keep your workspace list informative with names and descriptions:

```bash
# Set name and description for current workspace
tim workspace update --name "Auth Feature" --description "Working on OAuth2"

# Seed description from a plan (uses issue number + plan title)
tim workspace update --from-plan 123
# Results in: "#123 Implement OAuth2 Authentication"
```

The `tim agent` command automatically updates workspace descriptions when running in a tracked workspace, so your workspace list stays current with what you're working on.

### List Formats

The workspace list command supports multiple output formats:

```bash
# Default table format (human-readable)
tim workspace list

# All workspaces across repositories
tim workspace list --all

# Machine-readable formats
tim workspace list --format tsv --no-header  # For scripts
tim workspace list --format json              # For programmatic use
```

## Workspace Creation Design Notes

When creating a new workspace (`tim workspace add`), branch setup uses a deferred approach — branches are created locally in the execution workspace and only pushed to origin after the command produces actual filesystem changes:

1. **Fetch and check**: The execution workspace fetches from origin to see if the branch already exists remotely.
2. **Existing branch**: If the branch exists on the remote, it is checked out in the execution workspace.
3. **New branch**: If the branch does not exist, a new local branch is created off the base branch directly in the execution workspace. No branch is created or pushed in the primary workspace during setup.
4. **Post-execution sync**: After the command finishes, the workspace round-trip sync compares repository state before and after execution. If there are actual changes, the branch is pushed to origin and pulled into the primary workspace. If no changes were made (e.g. `tim generate` which only updates the DB), the push is skipped entirely. If the branch was newly created during setup and no changes were made, the local branch is deleted to avoid accumulating unused branches.

All workspace sync uses origin as the intermediary — branches are always pushed to and pulled from origin rather than directly between workspaces.

### Stale Local-Only Branch Handling

When preparing an existing workspace, if the target branch exists locally but **not** on the remote, it is treated as stale — typically from a prior run that failed before pushing. Instead of reusing such a branch (which may contain broken work on an outdated base):

1. The stale local branch is deleted in the **execution workspace only** (never in the primary workspace).
2. A new branch is created from the current base branch, ensuring a clean starting point.
3. `reusedExistingBranch` is set to `false`, so `branchCreatedDuringSetup` is `true` — the workspace behaves identically to a fresh branch creation.

**Safety guards:**

- Stale-branch deletion is only performed when the fetch from origin succeeded (`fetchSucceeded`), ensuring offline mode or transient network failures don't cause valid branches to be mistakenly deleted.
- Only the execution workspace's branch is cleaned up — the primary workspace is not touched during branch setup.

Plans are not copied as files during workspace creation. Instead, when commands like `tim agent`, `tim generate`, or `tim chat` run in a workspace, they materialize the plan from the DB into the workspace at `.tim/plans/{planId}.plan.md` via `setupWorkspace()`. This approach keeps the DB as the source of truth and avoids stale file copies. After the executor finishes editing the materialized file, changes are synced back to the DB. The workspace roundtrip automatically wipes all materialized plan files from `.tim/plans/` (except `.gitignore`/`.gitkeep`) both at the start of pre-execution sync (to clean up leftovers from prior crashed runs) and at the end of post-execution sync (to prevent stale files from confusing subsequent runs on different plans).

When reusing an existing workspace that already contains a plan file, the reuse path syncs the existing file back to the DB before overwriting it with the new materialized version. This prevents data loss from unsynced local edits made during a previous session. If the sync fails, the file copy is skipped (setting the workspace plan file path to `undefined`) rather than silently discarding the edits.

## Workspace Push Design Notes

The `workspace push` command transfers branches between workspaces using different strategies for git and jj. You can set source, destination, and branch explicitly:

```bash
tim workspace push --from task-123 --to task-456 --branch feature/work
```

Defaults are source=current workspace, destination=primary workspace, and branch=current source branch/bookmark.

Implementation strategy:

- **Git mode** uses `git fetch` from the primary workspace side (rather than `git push` from the secondary). This avoids `receive.denyCurrentBranch` errors that occur when pushing to a non-bare repo where the target branch is checked out.
- **jj mode** adds a git remote pointing to the destination workspace and uses `jj git push --bookmark`.
- When an origin-backed round trip refreshes the primary workspace in **jj mode**, tim fetches and tracks the bookmark there without running `jj new`, so the primary workspace's working copy does not move to a fresh change.

## Related Commands

- `tim assignments claim <plan>` - manually claim a plan
- `tim assignments release <plan>` - remove the current workspace/user from a claim
- `tim workspace add` - create a new workspace (or reuse an existing one with `--reuse`)
- `tim workspace list` - list workspaces with status, name, and description
- `tim workspace update` - update workspace name and description
- `tim workspace push` - push a branch/bookmark between workspaces
- `tim shell-integration` - generate shell function for workspace switching
- `tim assignments list` - inspect all assignments for the repository
- `tim assignments clean-stale` - remove claims older than the configured timeout

Refer to the main README for detailed CLI usage and configuration examples.
