# Generating Plan Details

After creating a plan stub, generate detailed tasks and implementation guidance. The tools here can be used to manage
the structured task data in the plan as well as .

## Contents

- [Creating a Plan Stub](#creating-a-plan-stub)
- [Tool Schema Discovery](#tool-schema-discovery)
- [Plan Management Tools](#plan-management-tools)

## Creating a Plan Stub

```bash
rmplan add "Plan title"
rmplan add "Plan title" --priority high --parent 100
rmplan add "Plan title" --issue https://github.com/org/repo/issues/123
```

See `adding-plans.md` for full options.

## Tool Schema Discovery

View the JSON schema for any tool:

```bash
rmplan tools get-plan --print-schema
rmplan tools create-plan --print-schema
```

## Plan Management Tools

Use `rmplan tools <tool-name>` with JSON on stdin to manage plans programmatically.

### get-plan

Retrieve full plan details.

```bash
echo '{"plan": "123"}' | rmplan tools get-plan
```

### create-plan

Create a new plan file. This is similar to `rmplan add` but takes JSON.

```bash
echo '{"title": "New plan", "priority": "high", "parent": 100}' | rmplan tools create-plan
```

Parameters: `title` (required), `goal`, `details`, `priority`, `parent`, `dependsOn`, `discoveredFrom`, `tags`, `issue`, `docs`

### update-plan-tasks

Update plan with generated tasks.

```bash
echo '{"plan": "123", "tasks": [{"title": "Task 1", "description": "Details"}]}' | rmplan tools update-plan-tasks
```

Parameters: `plan` (required), `tasks` (required), `title`, `goal`, `details`, `priority`

### update-plan-details

Update the generated section content (between `<!-- rmplan-generated-start -->` and `<!-- rmplan-generated-end -->`).

```bash
echo '{"plan": "123", "details": "New implementation notes", "append": true}' | rmplan tools update-plan-details
```

Parameters: `plan` (required), `details` (required), `append` (default: false)

### manage-plan-task

Add, update, or remove individual tasks.

```bash
# Add a task
echo '{"plan": "123", "action": "add", "title": "New task", "description": "Details"}' | rmplan tools manage-plan-task

# Mark task complete
echo '{"plan": "123", "action": "update", "taskTitle": "New task", "done": true}' | rmplan tools manage-plan-task

# Remove a task
echo '{"plan": "123", "action": "remove", "taskTitle": "New task"}' | rmplan tools manage-plan-task
```

### list-ready-plans

Find plans ready to execute (dependencies satisfied). You can also use `rmp ready` for a plain text output.

```bash
echo '{}' | rmplan tools list-ready-plans
echo '{"priority": "high", "limit": 5}' | rmplan tools list-ready-plans
```

