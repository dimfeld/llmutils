---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: output run summary at end
goal: Add ability for rmplan run to display a summary of execution results,
  capturing important output from each step and presenting an aggregated report
  at completion.
id: 119
status: pending
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-14T09:17:46.197Z
createdAt: 2025-09-14T07:54:56.352Z
updatedAt: 2025-09-14T09:17:46.197Z
tasks:
  - title: Define Summary Data Structures
    done: false
    description: >
      Create TypeScript interfaces and types for execution summaries in
      `src/rmplan/summary/types.ts`:

      - `ExecutionSummary` interface with plan metadata, step results, file
      changes, timing

      - `StepResult` interface for individual step outcomes and outputs

      - `ExecutionMetadata` interface for timing, iterations, error tracking

      - Export types for use across the codebase
    steps: []
  - title: Create Summary Collection Module
    done: false
    description: >
      Implement core summary collection functionality in
      `src/rmplan/summary/collector.ts`:

      - `SummaryCollector` class to accumulate execution results

      - Methods to add step results, track file changes, record errors

      - Integration with Git to detect file modifications

      - Memory-safe handling of large outputs with size limits
    steps: []
  - title: Modify Agent Execution for Summary Collection
    done: false
    description: >
      Update `src/rmplan/commands/agent/agent.ts` to collect summary data:

      - Initialize `SummaryCollector` at start of execution

      - Modify executor calls to use `captureOutput: 'result'` when summary
      enabled

      - Collect step results after each `executor.execute()` call

      - Track file changes after `markStepDone()` and `markTaskDone()`

      - Handle execution errors and add to summary
    steps: []
  - title: Update Batch Mode for Summary Aggregation
    done: false
    description: |
      Modify `src/rmplan/commands/agent/batch_mode.ts` to support summaries:
      - Aggregate step results across batch iterations
      - Track cumulative file changes and execution metadata
      - Maintain summary state between batch iterations
      - Ensure proper cleanup and final aggregation
    steps: []
  - title: Implement Basic Summary Display
    done: false
    description: >
      Create summary formatting and display in `src/rmplan/summary/display.ts`:

      - `displayExecutionSummary()` function using existing formatting utilities

      - Markdown-formatted output with consistent headers and colors

      - Section for execution overview, step results, file changes

      - Integration with existing logging infrastructure (`boldMarkdownHeaders`,
      chalk colors)
    steps: []
  - title: Add Summary Tests
    done: false
    description: |
      Create comprehensive tests in `src/rmplan/summary/`:
      - Unit tests for `SummaryCollector` class
      - Integration tests for agent execution with summary collection
      - Tests for batch mode summary aggregation
      - Tests for error handling and edge cases
      - Mock executor implementations for testing different output scenarios
    steps: []
  - title: Add Executor-Specific Output Parsing
    done: false
    description: >
      Enhance summary collection with executor-specific parsing in
      `src/rmplan/summary/parsers.ts`:

      - `parseClaudeOutput()` function to extract `rawMessage` from Claude Code
      responses

      - `parseCodexOutput()` function to extract final agent messages from Codex
      CLI

      - Fallback parsing for other executors that return generic output

      - Error handling for malformed or missing output
    steps: []
  - title: Update Executors for Summary Support
    done: false
    description: >
      Modify executor implementations to support summary capture:

      - Update Claude Code executor
      (`src/rmplan/executors/claude_code/claude_code.ts`) to ensure proper
      `rawMessage` extraction

      - Update Codex CLI executor
      (`src/rmplan/executors/codex_cli/codex_cli.ts`) to ensure final agent
      message capture

      - Add executor metadata (name, type) to summary results

      - Ensure backward compatibility with existing execution modes
    steps: []
  - title: Enhance Summary Display Formatting
    done: false
    description: >
      Improve the summary display with better formatting and organization:

      - Add section headers for Overview, Step Results, File Changes, Execution
      Metadata

      - Implement syntax highlighting for code snippets in step results

      - Add progress indicators and statistics (X/Y steps completed)

      - Truncate very long outputs with "show more" indicators

      - Add timestamps and duration formatting
    steps: []
  - title: Add CLI Configuration Options
    done: false
    description: |
      Add user control options to the agent/run commands:
      - `--no-summary` flag to disable summary display
      - `--summary-file` option to write summary to a file
      - Environment variable support for default summary behavior
      - Update help text and command documentation
    steps: []
  - title: Implement Error Handling and Edge Cases
    done: false
    description: |
      Add robust error handling throughout the summary system:
      - Graceful degradation when executor output capture fails
      - Handling of empty or malformed executor responses
      - Memory limits for very large execution outputs
      - Timeout handling for slow summary generation
      - Clear error messages for users when summary generation fails
    steps: []
  - title: Add Integration Tests and Documentation
    done: false
    description: |
      Complete testing and documentation for the summary feature:
      - Integration tests with real executor implementations
      - Tests for different plan types and execution scenarios
      - Performance tests for large plans and outputs
      - Update CLI help text and command documentation
      - Add examples to project documentation showing summary output
    steps: []
changedFiles: []
rmfilter: []
---

# Original Plan Details

Add ability for rmplan run to give a summary of what happened from the executor. This should involve capturing the important output from every step and returning it. Loop then aggregates it and prints at the end

For Claude: this should just be the final messages from the orchestrator in each run.
For Codex: this should be the final output from every call that runs codex, combined together and labelled appropriately.

Other executors won't have access to relevant information, so don't need to return anything.

# Processed Plan Details

## Add execution summary display to rmplan run command

The rmplan system currently executes plans but provides limited visibility into what actually happened during execution. This feature will capture key outputs from executors (final messages from Claude Code orchestrator, final output from Codex CLI calls) and display a consolidated summary showing executed steps, key results, file changes, and execution metadata.

**Expected Behavior**: After `rmplan run` completes, users see a summary section with:
- Execution overview (plan name, steps executed, success/failure status)
- Key output from each executed step (final LLM responses)
- List of files created, modified, or deleted
- Execution metadata (duration, iterations for batch mode, errors)

**Constraints**:
- Must work with both serial and batch execution modes
- Should handle executor output capture failures gracefully
- Memory usage must be reasonable for large execution runs
- Should follow existing logging patterns and formatting conventions

**Acceptance Criteria**:
- Summary displays after plan execution completes
- Captures final assistant messages from Claude Code executor
- Captures final agent messages from Codex CLI executor
- Shows all files modified during execution
- Aggregates summaries across batch iterations
- Shows failed steps and error messages
- Uses consistent markdown formatting and colors
- All functionality covered by tests

---

## Area 1: Summary Infrastructure and Collection

Tasks:
- Define Summary Data Structures
- Create Summary Collection Module
- Modify Agent Execution for Summary Collection
- Update Batch Mode for Summary Aggregation
- Implement Basic Summary Display
- Add Summary Tests

This phase establishes the foundation for execution summaries by creating the necessary data structures, modifying the main agent execution flow to collect summary information, and implementing basic summary display functionality.

The implementation will leverage the existing `captureOutput` infrastructure in executors and follow patterns established by the review command for structured output processing. Summary collection will be integrated into both serial and batch execution modes.

**Acceptance Criteria**:
- `ExecutionSummary` interface and supporting types defined
- Agent execution modified to collect summary data during step execution
- Basic summary display implemented with existing formatting patterns
- File change tracking integrated
- Works with both serial and batch execution modes
- Summary collection handles execution failures gracefully

---

## Area 2: Executor-Specific Integration and Polish

Tasks:
- Add Executor-Specific Output Parsing
- Update Executors for Summary Support
- Enhance Summary Display Formatting
- Add CLI Configuration Options
- Implement Error Handling and Edge Cases
- Add Integration Tests and Documentation

This phase adds sophisticated executor-specific output parsing to capture meaningful summaries from Claude Code and Codex CLI executors, polishes the summary display formatting, and adds CLI options for user control.

The implementation will add executor-specific parsing logic to extract final messages from Claude Code (rawMessage from assistant responses) and Codex CLI (final agent messages), enhance the display with better formatting and error reporting, and provide CLI options to enable/disable summaries.

**Acceptance Criteria**:
- Claude Code executor captures and parses final assistant messages
- Codex CLI executor captures and parses final agent messages
- Enhanced summary display with improved formatting and sections
- CLI option to enable/disable summary display
- Proper error handling for failed output capture
- Summary content is limited to prevent memory issues
- Integration tests cover all executor types
