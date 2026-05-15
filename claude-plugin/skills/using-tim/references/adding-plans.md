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
tim add "Plan title" --base-plan 122          # Stack branch on top of plan 122's branch
tim add "Plan title" --discovered-from 99     # Link to source plan
tim add "Plan title" --tag frontend --tag urgent  # Add tags
tim add "Plan title" --simple                 # Skip research phase during generation
tim add "Plan title" --edit                   # Open in editor after creation
```

## Followup Work Plans

When creating a plan for follow-on work, use `--depends-on <original-plan-id>` rather than setting the original as a parent or epic. See `generating-plans.md` for details.

## Stacking Sibling Plans

When the new plan should ship as a stacked PR on top of a sibling plan's branch (rather than branching from trunk), use `--base-plan` to declare the predecessor:

```bash
tim add "Followup" --base-plan 122             # New plan's branch stacks on plan 122's branch
tim set 123 --base-plan 122                    # Stack an existing plan on plan 122
tim set 123 --no-base-plan                     # Clear the stacking pointer
```

`--base-plan` and `--depends-on` solve different problems and can be combined:

- `--depends-on` orders the _work_ (the new plan is blocked until the predecessor is done).
- `--base-plan` stacks the _branch_ (workspace setup uses the predecessor's branch as the base instead of trunk).

If the referenced plan's branch no longer exists on the remote (typically after it merges), tim quietly falls back to trunk, so a `--base-plan` pointer stays safe across the predecessor's lifecycle. Explicit `--base-branch` always wins over `--base-plan` when both are set.

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

# Stack on another plan's branch
tim set 123 --base-plan 122
tim set 123 --no-base-plan             # Clear the stacking pointer

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
