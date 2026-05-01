# Generating Plan Details

After creating a plan stub, generate detailed tasks and implementation guidance. The tools here can be used to manage
the structured task data in the plan as well as .

## Contents

- [Creating a Plan Stub](#creating-a-plan-stub)
- [Tool Schema Discovery](#tool-schema-discovery)
- [Plan Management Tools](#plan-management-tools)
- [File-Based Plan Editing](#file-based-plan-editing)

## Creating a Plan Stub

```bash
tim add "Plan title"
tim add "Plan title" --priority high --parent 100
tim add "Plan title" --issue https://github.com/org/repo/issues/123
```

See `adding-plans.md` for full options.

## Followup Work Plans

When generating a plan reveals that additional follow-on work is needed (e.g. a second phase, a cleanup task, or a related feature), create a separate plan that depends on the current one:

```bash
echo '{"title": "Followup work title", "dependsOn": [<original-plan-id>]}' | tim tools create-plan
```

**Important guidelines for followup plans:**

- Do **not** mark the original plan as an epic
- Do **not** set the original plan as the parent of the new plan
- **Do** use `dependsOn` (or `--depends-on` with `tim add`) so the new plan is sequenced after the original

## Tool Schema Discovery

View the JSON schema for any tool:

```bash
tim tools get-plan --print-schema
tim tools create-plan --print-schema
```

## Plan Management Tools

Use `tim tools <tool-name>` with JSON on stdin to manage plans programmatically.

### get-plan

Retrieve full plan details.

```bash
echo '{"plan": "123"}' | tim tools get-plan
```

### create-plan

Create a new plan. This is similar to `tim add` but takes JSON.

```bash
echo '{"title": "New plan", "priority": "high", "parent": 100}' | tim tools create-plan
```

Parameters: `title` (required), `goal`, `details`, `priority`, `parent`, `dependsOn`, `discoveredFrom`, `tags`, `issue`, `docs`

### update-plan-tasks

Update plan with generated tasks.

```bash
echo '{"plan": "123", "tasks": [{"title": "Task 1", "description": "Details"}]}' | tim tools update-plan-tasks
```

Parameters: `plan` (required), `tasks` (required), `title`, `goal`, `details`, `priority`

### update-plan-details

Update the generated section content (between `<!-- tim-generated-start -->` and `<!-- tim-generated-end -->`).

```bash
echo '{"plan": "123", "details": "New implementation notes", "append": true}' | tim tools update-plan-details
```

Parameters: `plan` (required), `details` (required), `append` (default: false)

### manage-plan-task

Add, update, or remove individual tasks. Tasks can be identified by `taskTitle` (partial match) or `taskIndex` (1-based).

```bash
# Add a task
echo '{"plan": "123", "action": "add", "title": "New task", "description": "Details"}' | tim tools manage-plan-task

# Mark task complete by title
echo '{"plan": "123", "action": "update", "taskTitle": "New task", "done": true}' | tim tools manage-plan-task

# Mark task complete by index (1-based)
echo '{"plan": "123", "action": "update", "taskIndex": 2, "done": true}' | tim tools manage-plan-task

# Remove a task
echo '{"plan": "123", "action": "remove", "taskTitle": "New task"}' | tim tools manage-plan-task
```

## File-Based Plan Editing

For agents that prefer to edit plans using normal file-based tools (read/write/edit) instead of the JSON tool interface, use `tim materialize` and `tim sync`:

```bash
# Materialize a plan from the database to .tim/plans/<planId>.plan.md
tim materialize 123

# Edit the file with normal tools...
# Then sync changes back to the database
tim sync 123
```

`tim materialize` writes the plan to `.tim/plans/<planId>.plan.md` where it can be read and edited with standard file editing tools. After making changes, `tim sync` reads the file and writes the changes back to the database. Use `tim sync --force` if the file appears stale relative to the database.

If no plan ID is given, `tim sync` scans all `.plan.md` files in `.tim/plans/` and syncs any that have been modified.

### list-ready-plans

Find plans ready to execute (dependencies satisfied). You can also use `rmp ready` for a plain text output.

```bash
echo '{}' | tim tools list-ready-plans
echo '{"priority": "high", "limit": 5}' | tim tools list-ready-plans
```
