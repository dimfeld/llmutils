# Viewing Plans and Marking Tasks Done

Commands for viewing plan status and marking tasks/plans as complete.

## Contents

- [Viewing Plans](#viewing-plans)
- [Editing Plan Files](#editing-plan-files)
- [Marking Tasks Done](#marking-tasks-done)
- [Marking Plans Done](#marking-plans-done)

## Viewing Plans

### Show Plan Details

```bash
tim show 123                    # Show plan by ID
tim show 123 --short            # Brief summary
tim show 123 --full             # Full details
tim show --next                 # Next ready plan
tim show --next-ready 100       # Next ready child of plan 100
```

### List All Plans

```bash
tim list                        # Active plans
tim list --all                  # Include done/cancelled
tim list --status pending
tim list --status in_progress
tim list --tag frontend
tim list --sort priority        # Default
tim list --sort id
tim list --sort title
```

### List Ready Plans

Plans ready to execute (all dependencies satisfied):

```bash
tim ready
tim ready --pending-only        # Exclude in_progress
tim ready --priority high
tim ready --tag backend
tim ready --format table        # Table format
tim ready --format json         # JSON output
```

## Editing Plan Files

Plans are stored in the database. To check out a plan as a markdown file for direct editing, use `tim materialize`. To write changes back to the database, use `tim sync`.

```bash
# Materialize a plan to .tim/plans/{id}.plan.md (also writes related plans as .ref.md context files)
tim materialize 123

# After editing the file, sync it back to the database
tim sync 123

# Sync all materialized plans back to the database
tim sync
```

You can also use `tim edit 123` which materializes, opens in `$EDITOR`, syncs on close, and cleans up.

## Marking Tasks Done

Use `tim set-task-done` to mark individual tasks as complete:

```bash
tim set-task-done 123 --title "Implement feature"
tim set-task-done 123 --index 2              # By index (1-based)
```

## Marking Plans Done

When all tasks are complete, mark the entire plan as done:

```bash
tim done 123                    # Mark plan complete
```

You can also use `tim set` to change plan status and other metadata:

```bash
tim set 123 --status done
tim set 123 --status in_progress
tim set 123 --status pending
tim set 123 --depends-on 101 102       # Add dependencies
tim set 123 --no-depends-on 101        # Remove a dependency
tim set 123 --parent 100               # Set parent plan
```

See the CLI reference or `adding-plans.md` for the full list of `tim set` options.
