# Batch Tasks Feature Documentation

## Overview

The `--batch-tasks` feature is a new execution mode for the `rmplan agent` command that allows the orchestrator agent to intelligently select and execute multiple related tasks in a single operation. This mode improves efficiency when working with plans containing many small or related tasks by reducing context switching and enabling better coordination between related work items.

## Usage

### Basic Command

```bash
rmplan agent --batch-tasks <plan_file>
```

### Examples

```bash
# Execute a plan in batch mode
rmplan agent --batch-tasks tasks/my-feature.yml

# Use batch mode with a different executor
rmplan agent --batch-tasks --executor claude-code tasks/refactor-plan.yml

# Run with verbose output to see batch selection decisions
rmplan agent --batch-tasks --verbose tasks/optimization-tasks.yml
```

## How It Works

### Orchestrator Intelligence

In batch mode, the rmplan agent operates differently from normal single-task execution:

1. **Task Analysis**: The orchestrator agent receives all incomplete tasks from the plan file and analyzes their relationships, dependencies, and complexity.

2. **Intelligent Batching**: Based on the analysis, the orchestrator selects a logical subset of tasks that can be worked on together effectively. This selection considers:
   - Task dependencies and ordering
   - Related functionality or components
   - Complementary work (e.g., implementation + tests)
   - Appropriate batch size for the current context

3. **Batch Execution**: The selected tasks are executed using the appropriate sub-agents (implementer, tester, reviewer) while maintaining shared context across the batch.

4. **Plan Updates**: After successful completion, the orchestrator uses file editing tools to update the plan YAML file, marking completed tasks with `done: true`.

5. **Loop Continuation**: The main agent loop re-reads the updated plan file and continues with remaining tasks until the entire plan is complete.

### Task Selection Logic

The orchestrator considers several factors when selecting tasks for a batch:
- **Functional Relationship**: Tasks that work on related components or features
- **Dependency Order**: Ensuring prerequisite tasks are completed before dependent tasks
- **Context Efficiency**: Tasks that benefit from shared understanding or setup
- **Reasonable Scope**: Limiting batch size to maintain quality and avoid overwhelming complexity

## Benefits

### Efficiency Improvements
- **Reduced Context Switching**: Working on related tasks together maintains better understanding of the codebase and requirements
- **Shared Setup**: Common initialization, imports, and understanding can be reused across tasks in the batch
- **Better Coordination**: Related changes can be implemented with better awareness of interdependencies

### Context Preservation
- **Maintained Understanding**: The agent retains knowledge about the codebase and recent changes throughout the batch
- **Consistent Approach**: Related tasks benefit from consistent implementation patterns and decisions
- **Reduced Redundancy**: Avoid re-analyzing the same code or requirements multiple times

### Quality Benefits
- **Holistic Implementation**: Related features can be implemented with better overall design coherence
- **Cross-Task Validation**: The agent can ensure consistency and compatibility across related changes
- **Efficient Testing**: Test suites can be run once for multiple related changes

## When to Use Batch Mode

### Ideal Scenarios

**Multiple Small Tasks**: Plans with many small, independent tasks that can be grouped logically:
```yaml
tasks:
  - id: "1"
    title: "Add validation to user input"
    done: false
  - id: "2" 
    title: "Add error handling for network requests"
    done: false
  - id: "3"
    title: "Update error messages for consistency"
    done: false
```

**Related Functionality**: Tasks that work on the same component or feature:
```yaml
tasks:
  - id: "1"
    title: "Implement user authentication API"
    done: false
  - id: "2"
    title: "Add authentication middleware"
    done: false
  - id: "3"
    title: "Create login/logout endpoints"
    done: false
```

**Implementation + Testing Pairs**: Tasks where implementation and testing can be done together:
```yaml
tasks:
  - id: "1"
    title: "Add new payment processing method"
    done: false
  - id: "2"
    title: "Write tests for payment processing"
    done: false
```

### When to Avoid Batch Mode

**Complex Independent Tasks**: Large, complex tasks that require deep focus and shouldn't be mixed:
```yaml
tasks:
  - id: "1"
    title: "Redesign entire database schema"
    done: false
  - id: "2"
    title: "Implement complete UI overhaul"
    done: false
```

**Sequential Dependencies**: Tasks that must be completed in strict order with validation between steps.

## Comparison with Normal Mode

| Aspect | Normal Mode | Batch Mode |
|--------|-------------|------------|
| **Task Selection** | Processes one task at a time | Intelligently selects multiple related tasks |
| **Context** | Fresh context for each task | Shared context across batch |
| **Plan Updates** | Manual or external updates | Automatic plan file updates |
| **Efficiency** | Lower for many small tasks | Higher for related task groups |
| **Control** | Precise control over each step | Delegated decision-making to orchestrator |
| **Best For** | Complex individual tasks | Many small or related tasks |

## Practical Example

### Before Batch Execution

```yaml
goal: "Improve user authentication system"
tasks:
  - id: "1"
    title: "Add password strength validation"
    done: false
  - id: "2"
    title: "Implement rate limiting for login attempts"
    done: false
  - id: "3"
    title: "Add session timeout configuration"
    done: false
  - id: "4"
    title: "Update login error messages"
    done: false
  - id: "5"
    title: "Write tests for authentication improvements"
    done: false
```

### After Batch Execution

```yaml
goal: "Improve user authentication system"
tasks:
  - id: "1"
    title: "Add password strength validation"
    done: true
  - id: "2"
    title: "Implement rate limiting for login attempts"
    done: true
  - id: "3"
    title: "Add session timeout configuration"
    done: false
  - id: "4"
    title: "Update login error messages"
    done: true
  - id: "5"
    title: "Write tests for authentication improvements"
    done: true
```

In this example, the orchestrator selected tasks 1, 2, 4, and 5 as a logical batch (password validation, rate limiting, error messages, and their tests), while leaving task 3 (session timeout) for a future iteration, possibly because it required different configuration or had different dependencies.

## Limitations and Best Practices

### Limitations

1. **Less Granular Control**: You cannot control exactly which tasks are selected for each batch
2. **Dependency on Orchestrator Intelligence**: Task selection quality depends on the orchestrator's understanding of the plan
3. **Potential for Larger Changes**: Batches may produce larger changesets that are harder to review
4. **Error Recovery Complexity**: If a batch partially fails, some tasks may be marked complete while others are not

### Best Practices

1. **Clear Task Descriptions**: Write clear, specific task titles and descriptions to help the orchestrator make good batching decisions

2. **Logical Task Granularity**: Break work into appropriately-sized tasks - not too large (hard to batch effectively) or too small (overhead dominates)

3. **Explicit Dependencies**: Use task dependencies in your plan to guide the orchestrator's selection logic

4. **Review Plan Structure**: Before using batch mode, review your plan to ensure tasks are well-organized and logically related

5. **Monitor Progress**: Use `--verbose` flag to understand how the orchestrator is making batching decisions

6. **Incremental Commits**: Ensure each batch results in a coherent, committable state

7. **Test After Batches**: Run comprehensive tests after batch completion to ensure all changes work together properly

## Getting Started

1. **Start Small**: Begin with plans that have clear, related tasks to get familiar with how the orchestrator makes batching decisions

2. **Compare Results**: Try running the same plan in both normal and batch modes to understand the differences

3. **Iterate on Plan Structure**: Adjust your planning approach based on how effectively the orchestrator batches your tasks

4. **Use Verbose Mode**: Include `--verbose` to see the orchestrator's reasoning and improve your plan structure over time

The batch tasks feature represents a significant step forward in automated project execution, enabling more efficient and intelligent task management while maintaining the quality and reliability of the rmplan system.