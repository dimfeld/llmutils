# Dependency-Based Execution with --next-ready

The `--next-ready` feature in tim enables automated workflow management by allowing you to work with complex, multi-phase projects where tasks have interdependencies. Instead of manually tracking which plan is ready to work on next, tim can automatically find the next logical step in your dependency chain.

## Problem It Solves

When working with large software projects, you often break work into multiple phases or components with clear dependencies between them. For example:

- Phase 1: Set up database schema
- Phase 2: Create API endpoints (depends on Phase 1)
- Phase 3: Build frontend components (depends on Phase 2)
- Phase 4: Add authentication (depends on Phase 1)
- Phase 5: Integrate auth with frontend (depends on Phase 3 and Phase 4)

Without automated dependency management, you need to manually track:

- Which phases are complete
- Which phases are ready to start (all dependencies done)
- Which phase to work on next when multiple are ready

The `--next-ready` feature automates this process, allowing you to focus on implementation rather than project management overhead.

## How It Works

### Dependency Discovery Algorithm

When you run a command with `--next-ready <parentPlanId>`, tim:

1. **Loads the parent plan** and validates it exists
2. **Performs breadth-first search (BFS)** through the dependency graph to find all direct and indirect dependencies
3. **Filters candidates** to only include plans with actionable status (`pending` or `in_progress`)
4. **Checks readiness criteria** for each candidate:
   - Plans with `maybe` priority are excluded (considered optional)
   - Plans must have defined tasks (not just stubs)
   - For `pending` plans: all dependencies must be marked as `done`
   - For `in_progress` plans: immediately actionable (someone is already working on it)
5. **Sorts candidates** by priority: status (`in_progress` > `pending`), then priority level (`urgent` > `high` > `medium` > `low`), then by plan ID (ascending)
6. **Returns the first candidate** from the sorted list

### Readiness Criteria

A plan is considered "ready" when:

- **Status**: Must be `pending` (ready to start) or `in_progress` (actively being worked on)
- **Priority**: Must not be `maybe` (which indicates optional/deferred work)
- **Tasks**: Must have actual implementation tasks defined (not just a stub plan)
- **Dependencies**: All dependency plans must have `status: done`

### Error Handling and Feedback

The feature provides detailed feedback when no ready dependencies are found:

- **No dependencies**: "No dependencies found for this plan"
- **All complete**: "All dependencies are complete - ready to work on the parent plan"
- **Missing tasks**: "N dependencies have no actionable tasks → Try: Run `tim prepare` to add detailed steps"
- **Maybe priority**: "All pending dependencies have 'maybe' priority → Try: Review and update priorities"
- **Blocked dependencies**: "N dependencies are blocked by incomplete prerequisites → Try: Work on blocking dependencies first"

## Supported Commands

The `--next-ready` flag is supported by these commands:

### 1. `tim generate --next-ready <parentPlanId>`

Generates a planning prompt for the next ready dependency instead of the specified plan.

```bash
# Generate a plan for the next ready dependency of plan 100
tim generate --next-ready 100 -- src/**/*.ts

# Works with other generate options
tim generate --next-ready parent-plan --direct --commit
```

### 2. `tim prepare --next-ready <parentPlanId>`

Prepares detailed implementation steps for the next ready dependency.

```bash
# Prepare the next ready dependency with detailed steps
tim prepare --next-ready 100

# Use direct mode to call LLM automatically
tim prepare --next-ready parent-plan --direct
```

### 3. `tim agent --next-ready <parentPlanId>` / `tim run --next-ready <parentPlanId>`

Automatically executes the next ready dependency using the agent system.

```bash
# Execute the next ready dependency automatically
tim agent --next-ready 100

# Execute with specific options
tim run --next-ready parent-plan --steps 3 --dry-run

# Use Claude Code executor
tim agent --next-ready 100 --executor claude-code
```

### 4. `tim show --next-ready <parentPlanId>`

Displays information about the next ready dependency without executing it.

```bash
# Show details of the next ready dependency
tim show --next-ready 100

# Show full details without truncation
tim show --next-ready parent-plan --full
```

## Usage Examples

### Basic Workflow

```bash
# Start with a parent plan that has dependencies
tim show 100
# Output: Parent Plan: "Major Feature Rollout" (has 5 dependencies)

# Find and show the next ready dependency
tim show --next-ready 100
# Output: Found ready plan: Database Schema Setup (ID: 101)

# Generate detailed steps for that dependency
tim generate --next-ready 100 -- src/database/**/*.ts
# Works on plan 101 (Database Schema Setup)

# Execute the ready dependency
tim agent --next-ready 100
# Automatically works on plan 101

# After completion, find the next dependency
tim show --next-ready 100
# Output: Found ready plan: API Endpoints (ID: 102)
# (Now ready because Database Schema Setup is done)
```

### Integration with Existing Workflows

The `--next-ready` flag works seamlessly with all existing tim options:

```bash
# Generate with file context and auto-commit
tim generate --next-ready 100 --commit -- src/**/*.ts --grep auth

# Prepare with Claude Code
tim prepare --next-ready 100 --claude

# Execute with workspace isolation
tim agent --next-ready 100 --workspace feature-work

# Execute specific number of steps
tim run --next-ready 100 --steps 2 --dry-run
```

### Error Scenarios

```bash
# Parent plan doesn't exist
tim show --next-ready 999
# Output: Plan not found: 999
#         → Try: Run 'tim list' to see available plans

# No ready dependencies (all done)
tim show --next-ready 100
# Output: No ready dependencies found
#         All dependencies are complete - ready to work on the parent plan

# Dependencies blocked by prerequisites
tim show --next-ready 100
# Output: No ready dependencies found
#         3 dependencies are blocked by incomplete prerequisites
#         → Try: Work on the blocking dependencies first
```

## Tips for Organizing Plans

To get the most out of dependency-based execution:

### 1. Clear Dependency Chains

Structure your plans with explicit dependencies:

```yaml
# plan-101.yml - Database Schema
id: 101
title: "Set up database schema"
dependencies: []  # No dependencies, can start immediately

# plan-102.yml - API Layer
id: 102
title: "Create API endpoints"
dependencies: [101]  # Depends on database schema

# plan-103.yml - Frontend
id: 103
title: "Build user interface"
dependencies: [102]  # Depends on API layer
```

### 2. Use Priority Levels

Set appropriate priorities to guide execution order when multiple dependencies are ready:

```yaml
# High priority - critical path items
priority: high

# Medium priority - normal implementation
priority: medium

# Low priority - nice-to-have features
priority: low

# Maybe priority - excluded from --next-ready (optional work)
priority: maybe
```

### 3. Prepare Tasks in Advance

Ensure dependencies have actionable tasks, not just stubs:

```bash
# Prepare all dependencies with detailed steps
tim prepare 101  # Database schema plan
tim prepare 102  # API endpoints plan
tim prepare 103  # Frontend plan

# Now --next-ready can find and execute them automatically
tim agent --next-ready 100
```

### 4. Parent Plan Organization

Structure parent plans to represent complete features or milestones:

```yaml
# Parent plan coordinates multiple phases
id: 100
title: 'User Authentication System'
status: pending
dependencies: [] # Child plan IDs will be in here


# Child plans implement specific components
# Each child can have: parent: 100
# When children are added with parent: 100, they're automatically added to dependencies array above
```

## Debugging and Logging

Use the `--debug` flag to see detailed logging of the dependency discovery process:

```bash
tim show --next-ready 100 --debug
```

This shows:

- BFS traversal through the dependency graph
- Filtering decisions (why plans are included/excluded)
- Readiness checks for each candidate
- Sorting logic and final selection reasoning

## Integration with Development Workflows

### Continuous Integration

```bash
# In CI/CD pipeline, automatically find and validate next steps
tim show --next-ready $PARENT_PLAN_ID --debug
if [ $? -eq 0 ]; then
  echo "Next dependency is ready for development"
else
  echo "No dependencies ready, feature may be complete"
fi
```

### Team Coordination

```bash
# Team lead sets up parent plan with dependencies
tim generate --plan "Sprint 1 - User Profile Feature"

# Developers can independently find their next tasks
tim agent --next-ready sprint-1-plan --workspace $(whoami)

# Progress automatically enables downstream dependencies
```

### Multi-Repository Projects

```bash
# Parent plan coordinates work across repositories
# Each dependency can specify different rmfilter targets
tim generate --next-ready infra-plan -- infrastructure/**/*.tf
tim generate --next-ready app-plan -- src/**/*.ts
tim generate --next-ready docs-plan -- docs/**/*.md
```

This dependency-based approach transforms project management from manual coordination into automated workflow orchestration, allowing teams to focus on implementation while tim handles the coordination complexity.
