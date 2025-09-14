---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: output run summary at end
goal: Add ability for rmplan run to display a summary of execution results,
  capturing important output from each step and presenting an aggregated report
  at completion.
id: 119
status: in_progress
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-14T09:17:46.197Z
promptsGeneratedAt: 2025-09-14T09:43:06.976Z
createdAt: 2025-09-14T07:54:56.352Z
updatedAt: 2025-09-14T11:48:31.990Z
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
    files:
      - src/rmplan/summary/types.ts
    steps:
      - prompt: >
          Create src/rmplan/summary/types.ts with comprehensive TypeScript
          interfaces for execution summaries. Define ExecutionSummary interface
          with fields for plan metadata (planId, planTitle, planFilePath),
          execution timing (startTime, endTime, duration), step results array,
          file changes, execution mode (serial/batch), and error tracking.
          Create StepResult interface for individual step outcomes including
          step title, executor output, success status, timing, and any errors.
          Add ExecutionMetadata interface for batch iterations, total steps
          executed, and aggregate statistics. Follow patterns from
          src/rmplan/formatters/review_formatter.ts ReviewResult interface.
          Include proper JSDoc comments and export all types for use across the
          codebase.
        done: true
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
    files:
      - src/rmplan/summary/collector.ts
    steps:
      - prompt: >
          Create src/rmplan/summary/collector.ts with a SummaryCollector class
          that manages execution summary collection. Implement constructor that
          initializes with plan metadata (planId, title, filePath,
          executionMode). Add addStepResult method to collect individual step
          outcomes with memory limits (max 10MB per step output). Create
          trackFileChanges method that integrates with existing
          getChangedFilesOnBranch function from src/common/git.ts to detect
          modified files. Include addError method for collecting execution
          errors and recordExecutionStart/End methods for timing tracking. Add
          getExecutionSummary method that returns the final ExecutionSummary
          object. Implement memory safeguards following patterns from
          review_formatter.ts with MAX_OUTPUT_LENGTH limits and proper
          sanitization.
        done: true
  - title: Modify Agent Execution for Summary Collection
    done: true
    description: >
      Update the main agent execution flow to integrate summary collection
      throughout the execution process. This involves modifying
      src/rmplan/commands/agent/agent.ts to initialize a SummaryCollector at the
      start of execution, configure executor calls to use captureOutput:
      'result' when summary is enabled, collect step results after each
      executor.execute() call, and track file changes after markStepDone() and
      markTaskDone() operations. The integration should work seamlessly with
      both serial and batch execution modes and handle execution errors by
      adding them to the summary. The changes should be backward compatible and
      not affect existing functionality when summary is disabled.
    files:
      - src/rmplan/commands/agent/agent.ts
    steps:
      - prompt: >
          Modify src/rmplan/commands/agent/agent.ts to integrate summary
          collection. In the rmplanAgent function, initialize a SummaryCollector
          at the start using plan metadata. Update executor calls to include
          captureOutput: 'result' in planInfo when summary collection is enabled
          (default to enabled for now). After each executor.execute() call,
          collect the returned output using summaryCollector.addStepResult().
          Add file change tracking after markStepDone and markTaskDone calls
          using summaryCollector.trackFileChanges(). Handle execution errors by
          adding them to the summary via summaryCollector.addError(). Ensure the
          summary collection doesn't interfere with existing execution flow and
          maintains backward compatibility.
        done: true
      - prompt: >
          Add summary display at the end of rmplanAgent function execution.
          After the main execution loop completes (either in serial mode or
          after batch mode), call a displayExecutionSummary function with the
          collected summary data. Handle both successful completion and error
          scenarios. Ensure proper cleanup and final summary generation even
          when execution encounters errors or is interrupted.
        done: true
  - title: Update Batch Mode for Summary Aggregation
    done: true
    description: >
      Modify the batch mode execution to properly aggregate summary data across
      multiple batch iterations. This involves updating
      src/rmplan/commands/agent/batch_mode.ts to accept and use a
      SummaryCollector instance, aggregate step results across iterations,
      maintain cumulative file change tracking, and preserve summary state
      between batch iterations. The batch mode aggregation should handle the
      iterative nature of batch execution where multiple rounds of executor
      calls happen until all tasks are complete. This requires careful handling
      of step numbering, timing across iterations, and proper cleanup at the end
      of batch execution.
    files:
      - src/rmplan/commands/agent/batch_mode.ts
    steps:
      - prompt: >
          Modify src/rmplan/commands/agent/batch_mode.ts executeBatchMode
          function to accept an optional SummaryCollector parameter. Update all
          executor.execute() calls within the batch loop to use captureOutput:
          'result' when summaryCollector is provided. After each batch
          iteration, collect the executor output and add it to the summary as a
          step result. Track cumulative file changes across iterations and
          maintain proper iteration numbering in the summary data. Ensure the
          summary state persists correctly between batch iterations and that
          timing information reflects the total batch execution time.
        done: true
      - prompt: >
          Add final summary aggregation at the end of batch mode execution.
          Before the function returns, if a summaryCollector is provided,
          perform final file change detection and record the end of execution
          timing. Ensure proper cleanup and that the summaryCollector contains
          complete information about all batch iterations and their results.
        done: true
  - title: Implement Basic Summary Display
    done: true
    description: >
      Create the summary display functionality that formats and presents
      execution summaries in a user-friendly format. This should follow the
      established patterns from src/rmplan/formatters/review_formatter.ts, using
      consistent chalk colors, section dividers, and terminal formatting. The
      display should include sections for execution overview (plan name,
      execution mode, duration, success/failure status), step results summary,
      file changes list, and execution metadata. The implementation should use
      existing formatting utilities like boldMarkdownHeaders, table library for
      structured data, and the established color scheme from the review
      formatter system.
    files:
      - src/rmplan/summary/display.ts
    steps:
      - prompt: >
          Create src/rmplan/summary/display.ts with a displayExecutionSummary
          function that takes an ExecutionSummary and formats it for terminal
          output. Follow the TerminalFormatter pattern from review_formatter.ts.
          Create sections for execution overview with plan details, timing, and
          success status using chalk.bold for headers and appropriate colors
          (green for success, red for errors). Add a summary table showing total
          steps executed, files modified, and execution duration using the table
          library with the same border configuration as review formatter.
          Include proper spacing and dividers using '─'.repeat(60) pattern from
          existing code.
        done: true
      - prompt: >
          Add detailed sections to the summary display for step results and file
          changes. Create a step results section that lists each executed step
          with its status, timing, and key output excerpts (truncated for
          readability). Add a file changes section that lists all modified,
          created, and deleted files with appropriate color coding (green for
          created, yellow for modified, red for deleted). Include an execution
          metadata section with batch iteration count if applicable, total
          duration, and any errors encountered. Use consistent formatting with
          existing code patterns and ensure proper error handling for display
          operations.
        done: true
  - title: Add Summary Tests
    done: false
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
    files:
      - src/rmplan/summary/collector.test.ts
      - src/rmplan/summary/display.test.ts
    steps:
      - prompt: >
          Create src/rmplan/summary/collector.test.ts with comprehensive unit
          tests for the SummaryCollector class. Use ModuleMocker to mock logging
          and git functions following patterns from existing test files. Test
          collector initialization, addStepResult with various output sizes and
          content types, trackFileChanges integration with mocked git functions,
          error collection and handling, and memory limit enforcement. Create
          test scenarios with temporary directories using fs.mkdtemp() and
          realistic plan metadata. Test both successful operations and error
          conditions, ensuring proper cleanup in afterEach hooks.
        done: false
      - prompt: >
          Create src/rmplan/summary/display.test.ts to test the summary display
          functionality. Mock the chalk and table dependencies to capture
          formatting calls and verify output structure. Test
          displayExecutionSummary with various summary data scenarios including
          successful executions, failed executions, batch mode summaries, and
          empty summaries. Verify proper color usage, section formatting, table
          structure, and error handling. Test edge cases like very long output
          truncation, empty file changes lists, and missing metadata fields.
        done: false
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
    files:
      - src/rmplan/summary/parsers.ts
    steps:
      - prompt: >
          Create src/rmplan/summary/parsers.ts with executor-specific output
          parsing functions. Implement parseClaudeOutput function that extracts
          rawMessage content from Claude Code executor responses, handling the
          JSON stream format used by the Claude Code executor. Add
          parseCodexOutput function that extracts final agent messages from
          Codex CLI executor output, parsing the structured workflow results.
          Create parseGenericOutput function as a fallback for other executors
          that returns the output content directly. Each parser should handle
          malformed input gracefully and return standardized parsed result
          objects with content, metadata, and success indicators.
        done: true
      - prompt: >
          Add a main parseExecutorOutput function that dispatches to the
          appropriate parser based on executor type. This function should accept
          executor name/type and raw output, then route to the correct
          specialized parser. Include proper error handling that returns
          meaningful fallback results when parsing fails. Add TypeScript
          interfaces for parsed output results and ensure all parsers return
          consistent data structures for use by the SummaryCollector.
        done: true
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
    files:
      - src/rmplan/executors/claude_code/claude_code.ts
      - src/rmplan/executors/codx_cli/codx_cli.ts
    steps:
      - prompt: >
          Review and update src/rmplan/executors/claude_code/claude_code.ts to
          ensure proper rawMessage extraction for summary collection. Verify
          that when captureOutput: 'result' is used, the executor returns the
          clean rawMessage content from the final assistant response. Check that
          the existing formatJsonMessage and captureOutput logic properly
          extracts the meaningful content without formatting artifacts. Add
          executor metadata (name: 'claude_code', type: 'interactive') to the
          response data structure for summary collection identification. Ensure
          backward compatibility is maintained.
        done: true
      - prompt: >
          Review and update src/rmplan/executors/codx_cli/codx_cli.ts to ensure
          proper final agent message capture for summary collection. Verify that
          the executor returns the final agent messages from each workflow step
          (implementer, tester, reviewer) when captureOutput: 'result' is
          enabled. Check that the message extraction from the Codx CLI JSON
          output properly captures the meaningful agent responses. Add executor
          metadata (name: 'codx_cli', type: 'workflow') to the response for
          summary identification. Maintain existing functionality for all
          execution modes.
        done: true
  - title: Enhance Summary Display Formatting
    done: false
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
    files:
      - src/rmplan/summary/display.ts
    steps:
      - prompt: >
          Enhance the displayExecutionSummary function in
          src/rmplan/summary/display.ts with improved section organization and
          visual hierarchy. Add distinct section headers for Overview, Step
          Results, File Changes, and Execution Metadata using chalk.bold with
          different colors. Implement progress indicators showing X/Y steps
          completed with percentage. Add timestamp and duration formatting with
          human-readable time displays (e.g., "2m 34s"). Create helper functions
          for consistent spacing, section dividers, and hierarchical indentation
          following existing code patterns.
        done: false
      - prompt: >
          Add advanced formatting features including output truncation for long
          step results with "..." indicators and show-more hints. Implement
          basic syntax highlighting for code snippets in step outputs using
          simple keyword detection and chalk colors. Add statistics summary with
          completion rates, average step duration, and file change counts.
          Include error summary section with clear formatting for any execution
          errors encountered. Ensure all enhancements maintain backward
          compatibility and graceful degradation for missing data.
        done: false
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
    files:
      - src/rmplan/rmplan.ts
      - src/rmplan/commands/agent/agent.ts
    steps:
      - prompt: >
          Update src/rmplan/rmplan.ts to add new CLI options for summary
          control. In the createAgentCommand function, add --no-summary boolean
          flag to disable summary display and --summary-file string option to
          specify output file for summaries. Update the command help text to
          document these new options with clear descriptions. Ensure the options
          are available for both 'agent' and 'run' commands since they share the
          same option set through createAgentCommand. Follow existing patterns
          for option definition and help text formatting.
        done: true
      - prompt: >
          Modify src/rmplan/commands/agent/agent.ts to use the new CLI options.
          Update rmplanAgent function to check for the --no-summary flag and
          conditionally initialize summary collection. Add logic to handle
          --summary-file option by writing summary output to the specified file
          instead of displaying to console. Add environment variable support for
          RMPLAN_SUMMARY_ENABLED to set default summary behavior. Ensure proper
          error handling for file write operations and that summary collection
          is disabled when --no-summary is used.
        done: true
  - title: Implement Error Handling and Edge Cases
    done: false
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
    files:
      - src/rmplan/summary/collector.ts
      - src/rmplan/summary/display.ts
      - src/rmplan/summary/parsers.ts
    steps:
      - prompt: >
          Add comprehensive error handling to src/rmplan/summary/collector.ts.
          Wrap all external operations (git calls, file operations) in try-catch
          blocks with appropriate error logging. Implement memory limits for
          step results and executor output with graceful truncation when limits
          are exceeded. Add validation for input parameters and handle
          null/undefined values safely. Create fallback behaviors when file
          change tracking fails or git operations timeout. Ensure that any
          collector errors are logged but don't throw exceptions that could
          interrupt execution.
        done: false
      - prompt: >
          Enhance error handling in src/rmplan/summary/display.ts and
          parsers.ts. Add validation for summary data structure completeness and
          provide defaults for missing fields. Handle display formatting errors
          gracefully with fallback to plain text output. In parsers.ts, add
          robust error handling for malformed executor output with clear error
          messages and safe fallback parsing. Implement timeout protection for
          parsing operations and memory limits for output processing. Ensure all
          error conditions result in user-friendly messages rather than cryptic
          stack traces.
        done: false
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
    files:
      - src/rmplan/commands/agent/agent.integration.test.ts
      - CLAUDE.md
    steps:
      - prompt: >
          Create src/rmplan/commands/agent/agent.integration.test.ts with
          comprehensive integration tests for the summary functionality. Set up
          test environments with temporary directories and real plan files using
          fs.mkdtemp(). Test the complete agent execution flow with summary
          collection enabled using mock executors that return realistic output
          patterns. Test both serial and batch execution modes with summary
          aggregation. Verify file change tracking works correctly with actual
          file operations. Test error scenarios and edge cases with malformed
          plans and executor failures. Ensure tests clean up properly and don't
          leave artifacts.
        done: false
      - prompt: >
          Update CLAUDE.md to document the new summary functionality. Add a
          section explaining how execution summaries work, what information they
          provide, and how to use the CLI options (--no-summary,
          --summary-file). Include examples of typical summary output showing
          different execution scenarios. Document the environment variable
          configuration options and explain how summary collection integrates
          with different executor types. Add any relevant notes about
          performance considerations and memory usage for large executions.
        done: false
changedFiles:
  - src/common/git.ts
  - src/dependency_graph/__snapshots__/walk_imports.test.ts.snap
  - src/rmplan/commands/agent/agent.serial.capture_output.test.ts
  - src/rmplan/commands/agent/agent.test.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/agent/agent_batch_mode.test.ts
  - src/rmplan/commands/agent/agent_summary_options.test.ts
  - src/rmplan/commands/agent/batch_mode.capture_output.test.ts
  - src/rmplan/commands/agent/batch_mode.ts
  - src/rmplan/commands/agent/batch_tasks_unit.test.ts
  - src/rmplan/commands/agent/commander_negated_options.test.ts
  - src/rmplan/executors/claude_code_orchestrator.ts
  - src/rmplan/executors/codex_cli.capture_output.test.ts
  - src/rmplan/executors/codex_cli.fix_loop.test.ts
  - src/rmplan/executors/codex_cli.ts
  - src/rmplan/prompt.test.ts
  - src/rmplan/prompt.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/summary/collector.test.ts
  - src/rmplan/summary/collector.ts
  - src/rmplan/summary/display.test.ts
  - src/rmplan/summary/display.ts
  - src/rmplan/summary/parsers.test.ts
  - src/rmplan/summary/parsers.ts
  - src/rmplan/summary/types.ts
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
