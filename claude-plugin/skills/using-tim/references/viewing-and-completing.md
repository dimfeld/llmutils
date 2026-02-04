# Viewing Plans and Marking Tasks Done

Commands for viewing plan status and marking tasks/plans as complete.

## Contents

- [Viewing Plans](#viewing-plans)
- [Marking Tasks Done](#marking-tasks-done)
- [Marking Plans Done](#marking-plans-done)

## Viewing Plans

### Show Plan Details

```bash
tim show 123                    # Show plan by ID
tim show tasks/feature.yml      # Show plan by file path
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

You can also use `tim set` to change plan status:

```bash
tim set 123 --status done
tim set 123 --status in_progress
tim set 123 --status pending
```
