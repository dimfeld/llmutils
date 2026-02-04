# Adding New Plans

Use `tim add` to create a new plan stub for later task generation.

## Contents

- [Basic Usage](#basic-usage)
- [Common Options](#common-options)
- [From GitHub Issues](#from-github-issues)

## Basic Usage

```bash
tim add "Plan title"
```

After adding a plan, you may fill in the details of the plan in the Markdown section below the front matter.

In most cases, you do not want to fill in the structured tasks as those should be left to the generate process, which will do more research and generate the expected format for the plan document. But if the users asks you to, then use the `tim tools update-plan-tasks` command or make sure each entry in the `tasks` array should have a title and description field, and nothing else.

## Common Options

```bash
tim add "Plan title" --priority high          # Set priority (low/medium/high/urgent/maybe)
tim add "Plan title" --parent 100             # Create as child of plan 100
tim add "Plan title" --depends-on 101,102    # Block on other plans
tim add "Plan title" --discovered-from 99     # Link to source plan
tim add "Plan title" --tag frontend --tag urgent  # Add tags
tim add "Plan title" --simple                 # Skip research phase during generation
tim add "Plan title" --edit                   # Open in editor after creation
tim add "Plan title" --output tasks/custom.yml  # Custom file path
```

## From GitHub Issues

```bash
tim add "Plan title" --issue https://github.com/org/repo/issues/123
```
