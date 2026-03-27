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

**Important: Do not populate the structured `tasks` array in the YAML frontmatter.** The structured tasks should be left to the `generate` process, which will do more research and produce the expected format. Instead, when you want to sketch out planned work items for a new plan, write them as a markdown list in the body section below the frontmatter (e.g., under a `## Planned Work` heading). This gives the generate process useful context about the intended scope while letting it produce properly structured tasks. If the user explicitly asks you to create structured tasks, then use the `tim tools update-plan-tasks` command or make sure each entry in the `tasks` array has a title and description field, and nothing else.

## Common Options

```bash
tim add "Plan title" --priority high          # Set priority (low/medium/high/urgent/maybe)
tim add "Plan title" --parent 100             # Create as child of plan 100
tim add "Plan title" --depends-on 101,102    # Block on other plans
tim add "Plan title" --discovered-from 99     # Link to source plan
tim add "Plan title" --tag frontend --tag urgent  # Add tags
tim add "Plan title" --simple                 # Skip research phase during generation
tim add "Plan title" --edit                   # Open in editor after creation
```

## From GitHub Issues

```bash
tim add "Plan title" --issue https://github.com/org/repo/issues/123
```

## Modifying Plans After Creation

Use `tim set` to update plan metadata after creation. This is the primary way to modify dependencies, parent relationships, tags, and other properties on existing plans.

```bash
# Add dependencies
tim set 123 --depends-on 101 102

# Remove a dependency
tim set 123 --no-depends-on 101

# Set parent relationship
tim set 123 --parent 100

# Change status/priority
tim set 123 --status in_progress
tim set 123 --priority high

# Add/remove tags
tim set 123 --tag frontend
tim set 123 --no-tag backend

# Link issues
tim set 123 --issue https://github.com/org/repo/issues/456
```

See the CLI reference for the full list of `tim set` options.
