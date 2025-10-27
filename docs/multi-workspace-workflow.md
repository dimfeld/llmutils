# Multi-Workspace Workflows with rmplan

Managing large features often requires multiple active workspaces, or even multiple developers working on the same repository. rmplan's shared assignments system keeps those workspaces coordinated without forcing everyone to edit the same plan files. This guide explains how to configure the shared assignments file, claim plans for specific workspaces and users, and resolve conflicts when they appear.

## Quick Start

1. **Set your user identity** (recommended):

   ```bash
   export RMPLAN_USER="alice"
   ```

   rmplan falls back to `USER`, `USERNAME`, or `LOGNAME`, but setting `RMPLAN_USER` keeps names consistent across shells and machines.

2. **Clone the repository into multiple workspaces** as needed. Each workspace must be its own git checkout so rmplan can discover the correct workspace path.

3. **Claim a plan** from the workspace that will execute it:

   ```bash
   rmplan claim 42
   ```

   The claim records:

   - The plan UUID and (if available) numeric ID
   - The workspace's absolute path (resolved through symlinks)
   - The active user identity
   - Timestamps for when the assignment was created and last updated

   Claims are stored in `~/.config/rmplan/shared/<repository-id>/assignments.json` (or the platform equivalent). rmplan creates the directory on first use.

4. **Run your normal commands** (`rmplan agent`, `rmplan generate`, etc.). When auto-claiming is enabled (the default in the CLI), those commands call the claim workflow automatically before they start work.

5. **Release the plan** when you leave the workspace or finish the task:

   ```bash
   rmplan release 42
   ```

   Use `--reset-status` if you also want to move the plan back to `pending`.

## Viewing Assignments

The shared assignments file augments the existing plan metadata. Commands read both sources and merge them so workspaces always see the most relevant plans:

- `rmplan ready` defaults to the current workspace's claims plus any unassigned plans. Add `--all`, `--unassigned`, or `--user <name>` to broaden the view.
- `rmplan list --assigned` shows only claimed plans. Use `--unassigned` for the inverse.
- `rmplan show 42` prints the workspace path(s), user(s), claim timestamps, and highlights any conflicts.
- `rmplan assignments list` provides a repository-wide overview of every assignment.

If two workspaces claim the same plan, rmplan prints a warning and includes the conflicting paths in the command output. Use those signals to coordinate with your teammates before proceeding.

## Working with Multiple Clones

Each clone has its own git root, so the assignment tracker distinguishes workspaces by absolute path. Some tips:

- Always run rmplan commands from inside the workspace you want to associate with the plan. The CLI captures the current git root when claiming.
- Symlinks are resolved automatically, ensuring claims stay stable even if the workspace path contains symlinked directories.
- Claims survive git operations (branch switches, rebases, renames) because they are keyed by the plan UUID, not by filename.

### Example Workflow

```bash
# Workspace A – feature implementation
cd ~/dev/myapp-feature-a
rmplan ready          # shows plans assigned here or unclaimed
rmplan claim 10       # mark plan 10 for this workspace
rmplan agent 10       # executes and auto-claims if not already claimed

# Workspace B – documentation plan
cd ~/dev/myapp-feature-b
rmplan ready --unassigned
rmplan claim docs-uuid
rmplan generate --plan docs-uuid

# Later, release plans when the work is complete
rmplan release 10
rmplan release docs-uuid --reset-status
```

## Team Coordination

- Encourage everyone to set `RMPLAN_USER` so claims identify the correct owner.
- Use `rmplan ready --user alice` to see all of Alice's active plans regardless of workspace.
- `rmplan assignments show-conflicts` lists plans claimed by multiple workspaces and is helpful for daily stand-ups.
- `rmplan assignments clean-stale` removes claims that have been idle longer than the configured timeout (defaults to 7 days). Pass `--yes` to skip confirmation.

## Troubleshooting

| Symptom | Explanation | Resolution |
| --- | --- | --- |
| `auto-claim` warnings in tests or scripts | Auto-claim is disabled unless the CLI enables it. | Import `enableAutoClaim()` from `src/rmplan/assignments/auto_claim.js` if you need it in custom tooling. |
| Assignment file parse errors | The JSON file is incomplete or was edited manually. | Remove the file or fix the JSON; rmplan recreates it as needed. |
| Claims point to stale workspaces | The workspace was deleted or renamed. | Run `rmplan assignments clean-stale` or release the plan manually. |
| Plan still appears claimed after completion | rmplan removes assignments when plan status transitions to `done` or `cancelled`. | Verify the plan reached the correct status; re-run `rmplan release <plan>` if necessary. |

## Related Commands

- `rmplan claim <plan>` – manually claim a plan
- `rmplan release <plan>` – remove the current workspace/user from a claim
- `rmplan assignments list` – inspect all assignments for the repository
- `rmplan assignments clean-stale` – remove claims older than the configured timeout
- `rmplan assignments show-conflicts` – list plans claimed by multiple workspaces

Refer to the main README for detailed CLI usage and configuration examples.
