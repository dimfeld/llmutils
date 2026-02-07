---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: output run summary at end
goal: Add ability for tim run to display a summary of execution results,
  capturing important output from each step and presenting an aggregated report
  at completion.
id: 119
uuid: 347e6726-5e1d-4907-a4ce-a0d112763e5d
status: done
priority: medium
planGeneratedAt: 2025-09-14T09:17:46.197Z
promptsGeneratedAt: 2025-09-14T09:43:06.976Z
createdAt: 2025-09-14T07:54:56.352Z
updatedAt: 2025-10-27T08:39:04.219Z
tasks:
  - title: Define Summary Data Structures
    done: true
    description: >
      Create TypeScript interfaces and types for execution summaries that will
      be used throughout the summary system. This establishes the foundation
      data structures following patterns from the existing review system
      (ReviewResult, ReviewSummary interfaces). The interfaces should include
      ExecutionSummary for overall execution metadata, StepResult for individual
      step outcomes, and ExecutionMetadata for timing and error tracking. These
      types need to support both serial and batch execution modes, handle
      different executor types, and include file change tracking. The design
      should be memory-safe with appropriate limits and follow the established
      patterns from the review formatter system.
  - title: Create Summary Collection Module
    done: true
    description: >
      Implement the core summary collection functionality with a
      SummaryCollector class that accumulates execution results during plan
      execution. This module should integrate with the existing Git
      infrastructure for file change detection and provide memory-safe handling
      of large outputs with size limits. The collector needs to track step
      results, file modifications, execution metadata, and errors. It should
      work with both the trackedFiles mechanism from Claude Code executor and
      the Git-based change detection using getChangedFilesOnBranch(). The
      implementation should follow established patterns from the review system
      and include proper error handling for failed operations.
  - title: Modify Agent Execution for Summary Collection
    done: true
    description: >
      Update the main agent execution flow to integrate summary collection
      throughout the execution process. This involves modifying
      src/tim/commands/agent/agent.ts to initialize a SummaryCollector at the
      start of execution, configure executor calls to use captureOutput:
      'result' when summary is enabled, collect step results after each
      executor.execute() call, and track file changes after markStepDone() and
      markTaskDone() operations. The integration should work seamlessly with
      both serial and batch execution modes and handle execution errors by
      adding them to the summary. The changes should be backward compatible and
      not affect existing functionality when summary is disabled.
  - title: Update Batch Mode for Summary Aggregation
    done: true
    description: >
      Modify the batch mode execution to properly aggregate summary data across
      multiple batch iterations. This involves updating
      src/tim/commands/agent/batch_mode.ts to accept and use a SummaryCollector
      instance, aggregate step results across iterations, maintain cumulative
      file change tracking, and preserve summary state between batch iterations.
      The batch mode aggregation should handle the iterative nature of batch
      execution where multiple rounds of executor calls happen until all tasks
      are complete. This requires careful handling of step numbering, timing
      across iterations, and proper cleanup at the end of batch execution.
  - title: Implement Basic Summary Display
    done: true
    description: >
      Create the summary display functionality that formats and presents
      execution summaries in a user-friendly format. This should follow the
      established patterns from src/tim/formatters/review_formatter.ts, using
      consistent chalk colors, section dividers, and terminal formatting. The
      display should include sections for execution overview (plan name,
      execution mode, duration, success/failure status), step results summary,
      file changes list, and execution metadata. The implementation should use
      existing formatting utilities like boldMarkdownHeaders, table library for
      structured data, and the established color scheme from the review
      formatter system.
  - title: Add Summary Tests
    done: true
    description: >
      Create comprehensive unit tests for the summary collection functionality
      following the established testing patterns in the codebase. This includes
      testing the SummaryCollector class, integration with agent execution,
      batch mode aggregation, and error handling scenarios. The tests should use
      the ModuleMocker system for external dependencies, create temporary test
      directories with fs.mkdtemp(), and use real filesystem operations where
      possible to ensure integration confidence. Test scenarios should cover
      different executor outputs, file change detection, memory limits, and both
      serial and batch execution modes.
  - title: Add Executor-Specific Output Parsing
    done: true
    description: >
      Implement specialized parsing logic for extracting meaningful summary
      information from different executor types. This involves creating parser
      functions for Claude Code executor (extracting rawMessage from assistant
      responses), Codex CLI executor (extracting final agent messages), and
      fallback parsing for other executors. The parsers should handle the
      different output formats and structures used by each executor type,
      extract the most relevant information for summaries, and provide error
      handling for malformed or missing output. The implementation should be
      extensible for future executor types.
  - title: Update Executors for Summary Support
    done: true
    description: >
      Modify the existing executor implementations to ensure they provide the
      necessary data for summary collection. This involves verifying that the
      Claude Code executor properly extracts and returns rawMessage content when
      captureOutput is enabled, ensuring the Codex CLI executor captures final
      agent messages correctly, and adding any missing executor metadata (name,
      type) to summary results. The changes should maintain backward
      compatibility with existing execution modes and not affect performance
      when summary collection is disabled.
  - title: Enhance Summary Display Formatting
    done: true
    description: >
      Improve the summary display with enhanced formatting, better organization,
      and additional features like progress indicators, timestamps, duration
      formatting, and syntax highlighting for code snippets in step results.
      This involves extending the display.ts module with more sophisticated
      formatting capabilities, adding section headers with better visual
      hierarchy, implementing truncation for very long outputs with "show more"
      indicators, and including detailed statistics like completion percentages
      and performance metrics. The enhanced display should maintain consistency
      with existing formatting patterns while providing richer information
      presentation.
  - title: Add CLI Configuration Options
    done: true
    description: >
      Add user control options to the agent/run commands allowing users to
      enable/disable summary display and configure summary behavior. This
      involves adding --no-summary flag to disable summary display,
      --summary-file option to write summaries to a file instead of displaying
      them, and environment variable support for default summary behavior. The
      implementation should update the CLI argument parsing in both agent and
      run commands, modify the help text to document the new options, and ensure
      the options integrate properly with the existing command structure and
      configuration system.
  - title: Implement Error Handling and Edge Cases
    done: true
    description: >
      Add robust error handling throughout the summary system to ensure graceful
      degradation when summary collection fails, executor output capture fails,
      or other edge cases occur. This includes handling empty or malformed
      executor responses, implementing memory limits for very large execution
      outputs, adding timeout handling for slow summary generation, and
      providing clear error messages when summary generation fails. The error
      handling should ensure that summary collection failures don't interrupt or
      break the main execution flow, and users receive helpful feedback about
      any summary-related issues.
  - title: Add Integration Tests and Documentation
    done: false
    description: >
      Complete the testing coverage with integration tests that verify the
      summary functionality works correctly with real executor implementations
      and different plan types. This includes testing with actual Claude Code
      and Codx CLI executors, testing different execution scenarios (successful
      completion, partial failure, timeout), and performance testing with large
      plans and outputs. Additionally, update the CLI help text and project
      documentation to include examples of summary output and explain the new
      functionality. The integration tests should use real temporary
      environments and validate end-to-end functionality.
changedFiles:
  - src/common/git.ts
  - src/dependency_graph/__snapshots__/walk_imports.test.ts.snap
  - src/tim/commands/agent/agent.serial.capture_output.test.ts
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/agent/agent_batch_mode.test.ts
  - src/tim/commands/agent/agent_summary_options.test.ts
  - src/tim/commands/agent/batch_mode.capture_output.test.ts
  - src/tim/commands/agent/batch_mode.ts
  - src/tim/commands/agent/batch_tasks_unit.test.ts
  - src/tim/commands/agent/commander_negated_options.test.ts
  - src/tim/executors/claude_code_orchestrator.ts
  - src/tim/executors/codex_cli.capture_output.test.ts
  - src/tim/executors/codex_cli.fix_loop.test.ts
  - src/tim/executors/codex_cli.ts
  - src/tim/prompt.test.ts
  - src/tim/prompt.ts
  - src/tim/tim.ts
  - src/tim/summary/collector.test.ts
  - src/tim/summary/collector.ts
  - src/tim/summary/display.test.ts
  - src/tim/summary/display.ts
  - src/tim/summary/parsers.test.ts
  - src/tim/summary/parsers.ts
  - src/tim/summary/types.ts
rmfilter: []
---

# Original Plan Details

Add ability for tim run to give a summary of what happened from the executor. This should involve capturing the important output from every step and returning it. Loop then aggregates it and prints at the end

For Claude: this should just be the final messages from the orchestrator in each run.
For Codex: this should be the final output from every call that runs codex, combined together and labelled appropriately.

Other executors won't have access to relevant information, so don't need to return anything.

# Processed Plan Details

## Add execution summary display to tim run command

The tim system currently executes plans but provides limited visibility into what actually happened during execution. This feature will capture key outputs from executors (final messages from Claude Code orchestrator, final output from Codex CLI calls) and display a consolidated summary showing executed steps, key results, file changes, and execution metadata.

**Expected Behavior**: After `tim run` completes, users see a summary section with:
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
