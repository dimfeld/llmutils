# Viewing Plans and Marking Tasks Done

Commands for viewing plan status and marking tasks/plans as complete.

## Contents

- [Viewing Plans](#viewing-plans)
- [Marking Tasks Done](#marking-tasks-done)
- [Marking Plans Done](#marking-plans-done)

## Viewing Plans

### Show Plan Details

```bash
rmplan show 123                    # Show plan by ID
rmplan show tasks/feature.yml      # Show plan by file path
rmplan show 123 --short            # Brief summary
rmplan show 123 --full             # Full details
rmplan show --next                 # Next ready plan
rmplan show --next-ready 100       # Next ready child of plan 100
```

### List All Plans

```bash
rmplan list                        # Active plans
rmplan list --all                  # Include done/cancelled
rmplan list --status pending
rmplan list --status in_progress
rmplan list --tag frontend
rmplan list --sort priority        # Default
rmplan list --sort id
rmplan list --sort title
```

### List Ready Plans

Plans ready to execute (all dependencies satisfied):

```bash
rmplan ready
rmplan ready --pending-only        # Exclude in_progress
rmplan ready --priority high
rmplan ready --tag backend
rmplan ready --format table        # Table format
rmplan ready --format json         # JSON output
```

## Marking Tasks Done

Use `rmplan set-task-done` to mark individual tasks as complete:

```bash
rmplan set-task-done 123 --title "Implement feature"
rmplan set-task-done 123 --index 2              # By index (1-based)
```

## Marking Plans Done

When all tasks are complete, mark the entire plan as done:

```bash
rmplan done 123                    # Mark plan complete
```

You can also use `rmplan set` to change plan status:

```bash
rmplan set 123 --status done
rmplan set 123 --status in_progress
rmplan set 123 --status pending
```
