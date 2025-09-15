---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Implementer should exit if it finds impossible or conflicting
  requirements it can not resolve
goal: Enable rmplan executors to gracefully exit when they encounter conflicting
  or impossible requirements, providing detailed failure reports and preventing
  incorrect implementations from proceeding.
id: 120
generatedBy: agent
status: in_progress
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-15T03:12:44.945Z
promptsGeneratedAt: 2025-09-15T03:52:50.945Z
createdAt: 2025-09-14T08:19:24.654Z
updatedAt: 2025-09-15T05:38:48.775Z
tasks:
  - title: Create Standardized Failure Detection Template
    done: true
    description: >
      Create a reusable prompt template in
      `src/rmplan/executors/claude_code/agent_prompts.ts` that instructs agents
      how to handle conflicting or impossible requirements. The template should
      specify the "FAILED:" prefix format and required report structure
      (requirements, problems, solutions).


      The template will be a constant that can be imported and included in all
      agent prompts. It should provide clear instructions that when an agent
      encounters requirements it cannot resolve due to conflicts or
      impossibility, it should exit with a line starting with "FAILED:" followed
      by a structured report.
    files:
      - src/rmplan/executors/claude_code/agent_prompts.ts
    steps: []
  - title: Update Shared Agent Prompts
    done: true
    description: >
      Integrate the failure detection template into `getImplementerPrompt()`,
      `getTesterPrompt()`, and `getReviewerPrompt()` functions in
      `src/rmplan/executors/claude_code/agent_prompts.ts`. Place the
      instructions prominently in the error handling or guidelines sections.


      Each agent prompt should include the failure detection template in a
      location that makes sense for that agent's role. For implementers, it goes
      in the error handling section. For testers, it goes after the test failure
      handling. For reviewers, it goes in the verdict section.
    files:
      - src/rmplan/executors/claude_code/agent_prompts.ts
    steps: []
  - title: Update Claude Orchestrator Prompt
    done: true
    description: >
      Add failure detection instructions to the orchestrator prompt in
      `src/rmplan/executors/claude_code/orchestrator_prompt.ts`. Include
      instructions for detecting subagent failures and propagating them with the
      "FAILED:" prefix.


      The orchestrator needs special handling because it manages multiple
      agents. It should check each agent's output for failure indicators and if
      any agent fails, the orchestrator should propagate that failure with
      additional context about which agent failed and why.
    files:
      - src/rmplan/executors/claude_code/orchestrator_prompt.ts
    steps: []
  - title: Update Codex Fixer Prompt
    done: true
    description: >
      Modify the `getFixerPrompt()` method in
      `src/rmplan/executors/codex_cli.ts` to include the failure detection
      template, ensuring consistency with other agents.


      The fixer agent is unique to Codex and runs when the reviewer finds
      issues. It also needs to be able to report when fixes are impossible due
      to conflicting requirements or fundamental issues that can't be resolved.
    files:
      - src/rmplan/executors/codex_cli.ts
    steps: []
  - title: Enhance ExecutorOutput Interface
    done: true
    description: >
      Update `src/rmplan/executors/types.ts` to add optional `success: boolean`
      and `failureDetails?: { requirements: string; problems: string;
      solutions?: string }` fields to the ExecutorOutput interface.


      These new fields will allow executors to indicate structured failure
      information while maintaining backward compatibility through optional
      fields. The success field defaults to true when not specified, preserving
      existing behavior.
    files:
      - src/rmplan/executors/types.ts
    steps: []
  - title: Create Failure Detection Utilities
    done: true
    description: >
      Create utility functions in a new file
      `src/rmplan/executors/failure_detection.ts` for detecting "FAILED:"
      prefixes in text and extracting failure details. These will be shared by
      both executors.


      The utilities should handle various formats of failure messages, extract
      structured information when possible, and provide a consistent interface
      for checking if content contains a failure indicator.
    files:
      - src/rmplan/executors/failure_detection.ts
      - src/rmplan/executors/failure_detection.test.ts
    steps: []
  - title: Add Failure Detection to Claude Executor
    done: true
    description: >
      Modify `src/rmplan/executors/claude_code.ts` to check for "FAILED:" in the
      final assistant message. Update the `execute()` method to return failure
      indication in ExecutorOutput when detected.


      The Claude executor needs to check the captured output for failure
      indicators and return structured failure information. This should work
      with different capture modes (all, result, none).
    files:
      - src/rmplan/executors/claude_code.ts
    steps: []
  - title: Update Claude Output Processing
    done: true
    description: >
      Enhance the output processing in
      `src/rmplan/executors/claude_code/format.ts` to identify and extract
      failure messages from the JSON stream, making them available for the
      executor to process.


      The formatter processes JSON messages from the Claude CLI. It needs to
      identify assistant messages that contain failure indicators and flag them
      appropriately.
    files:
      - src/rmplan/executors/claude_code/format.ts
    steps: []
  - title: Handle Orchestrator Subagent Failures
    done: true
    description: >
      Update the orchestrator handling in
      `src/rmplan/executors/claude_code_orchestrator.ts` to detect when
      subagents report failures and propagate them appropriately.


      Since this file doesn't exist based on the codebase analysis, this
      handling will be done in the main claude_code.ts file where orchestration
      output is processed.
    files:
      - src/rmplan/executors/claude_code.ts
    steps: []
  - title: Add Failure Detection to Codex Executor
    done: true
    description: >
      Modify `src/rmplan/executors/codex_cli.ts` to check each agent's output
      for "FAILED:" messages. Update the `execute()` method to track failure
      state and return appropriate ExecutorOutput.


      The Codex executor runs multiple agents sequentially and needs to check
      each one's output. It should stop processing when a failure is detected
      and return the failure information.
    files:
      - src/rmplan/executors/codex_cli.ts
    steps: []
  - title: Make Task Completion Conditional
    done: true
    description: >
      Update the finally block in `execute()` method to check for failure state
      before calling `markCompletedTasksFromImplementer()`. Add a flag to track
      whether any agent failed during execution.


      Currently the finally block unconditionally marks tasks as done. This
      needs to become conditional based on whether a failure was detected during
      execution.
    files:
      - src/rmplan/executors/codex_cli.ts
    steps: []
  - title: Update Codex Output Processing
    done: true
    description: >
      Enhance `src/rmplan/executors/codex_cli/format.ts` to identify failure
      messages in the JSON stream and make them available for detection.


      The Codex formatter needs similar failure detection capabilities as the
      Claude formatter to identify when agents report failures.
    files:
      - src/rmplan/executors/codex_cli/format.ts
    steps: []
  - title: Update Serial Mode Agent Loop
    done: true
    description: >
      Modify `src/rmplan/commands/agent/agent.ts` to check executor output for
      failure indication. Update error handling to display detailed failure
      information and exit with appropriate code.


      The agent loop needs to check the ExecutorOutput for the success field and
      handle failures appropriately. This includes displaying the failure
      details to the user and exiting with a non-zero code.
    files:
      - src/rmplan/commands/agent/agent.ts
    steps: []
  - title: Update Batch Mode Handler
    done: true
    description: >
      Modify `src/rmplan/commands/agent/batch_mode.ts` to handle executor
      failures in batch execution. Implement strategy for partial failures when
      multiple tasks are involved.


      Batch mode needs similar failure handling as serial mode but should break
      out of the batch loop when a failure is detected rather than continuing to
      process more tasks.
    files:
      - src/rmplan/commands/agent/batch_mode.ts
    steps: []
  - title: Enhance Summary Collection
    done: true
    description: >
      Update the summary collector integration to capture and display failure
      details when executors return failure information, ensuring visibility in
      execution summaries.


      The summary collector already captures executor output but needs to
      specially handle failure cases to ensure they're prominently displayed in
      the summary.
    files:
      - src/rmplan/summary/collector.ts
      - src/rmplan/summary/display.ts
    steps: []
  - title: Create Failure Detection Tests
    done: false
    description: >
      Write comprehensive tests in
      `src/rmplan/executors/failure_detection.test.ts` for the utility
      functions. Create test fixtures with various failure message formats.


      Tests should cover detection accuracy, parsing of structured failure
      messages, edge cases, and ensure the utilities work correctly with
      real-world failure message formats.
    files:
      - src/rmplan/executors/failure_detection.test.ts
    steps: []
  - title: Test Executor Failure Scenarios
    done: false
    description: >
      Add tests to `src/rmplan/executors/claude_code.test.ts` and
      `src/rmplan/executors/codex_cli.test.ts` for failure detection scenarios,
      including subagent failures and orchestrator failures.


      Tests should verify that executors correctly detect failures, return
      appropriate ExecutorOutput with failure information, and handle various
      failure scenarios.
    files:
      - src/rmplan/executors/claude_code.test.ts
      - src/rmplan/executors/codex_cli.test.ts
    steps: []
  - title: Test Agent Loop Failure Handling
    done: false
    description: >
      Create tests for the main agent loop's handling of executor failures in
      both serial and batch modes, verifying exit codes and error messages.


      These integration tests ensure the agent command properly handles executor
      failures, exits with correct codes, and displays appropriate error
      messages to users.
    files:
      - src/rmplan/commands/agent/agent.test.ts
      - src/rmplan/commands/agent/batch_mode.test.ts
    steps: []
  - title: Update Documentation
    done: true
    description: >
      Update README.md and CLAUDE.md to document the new failure handling
      behavior, including examples of when failures occur and how to resolve
      them.


      Documentation should explain the new failure detection feature, when it
      triggers, what the failure messages look like, and how users can resolve
      common failure scenarios.
    files:
      - README.md
      - CLAUDE.md
    steps: []
changedFiles:
  - CLAUDE.md
  - README.md
  - src/rmplan/commands/agent/agent.failure_handling.test.ts
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/agent/batch_mode.soft_failure.test.ts
  - src/rmplan/commands/agent/batch_mode.ts
  - src/rmplan/executors/claude_code/agent_prompts.test.ts
  - src/rmplan/executors/claude_code/agent_prompts.ts
  - src/rmplan/executors/claude_code/format.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/codex_cli/format.ts
  - src/rmplan/executors/codex_cli.fixer_prompt.test.ts
  - src/rmplan/executors/codex_cli.test.ts
  - src/rmplan/executors/codex_cli.ts
  - src/rmplan/executors/failure_detection.test.ts
  - src/rmplan/executors/failure_detection.ts
  - src/rmplan/executors/types.ts
  - src/rmplan/prompt_builder.ts
  - src/rmplan/summary/collector.ts
  - src/rmplan/summary/display.test.ts
  - src/rmplan/summary/display.ts
  - src/rmplan/summary/parsers.ts
  - src/rmplan/summary/types.ts
rmfilter: []
---

# Original Plan Details

If implementer finds conflicting or impossible requirements and it is not confident to resolve on its own, tell it to exit with a line starting with "FAILED:" along with a detailed report including:
- the requirements it was trying to resolve
- the problems it encountered
- possible solutions

Then we look at that code and exit.

If it makes sense, create a single prompt template for this which can be included in all the relevant prompts.


## Executor Updates

Do this in the Claude and Codex executors. Update the executor run return value so that it can indicate failure along
with details.

### Claude Executor

Update the orchestrator agent prompt and the three subagent prompts with directions that if it (or for the orchestrator,
one of its subagents) encounters conflicting or
impossible requirements it should exit with the FAILED message.

Check the final message for FAILED and return a failure indication if so.

### Codex Executor

We can reuse the update to the Claude subagent prompts agent since we're sharing that file. Also update the fixer agent prompt with this FAILED message. Every time we run one of these agents, check for the FAILED line.

If that happens, we should return a failure indication. We should also skip the step in the "finally" block that marks the tasks as done.

## Main Agent Loop

If the executor returns a failure indication, we should break out of the main agent loop, printing the details about the
failure and exiting with a non-zero exit code.

# Processed Plan Details

## Add Executor Failure Detection for Impossible or Conflicting Requirements

### Expected Behavior/Outcome
- When an executor agent (implementer, tester, reviewer, or fixer) encounters conflicting or impossible requirements, it exits with a line starting with "FAILED:" followed by a detailed report
- The failure report includes: the requirements being resolved, problems encountered, and potential solutions
- The orchestrator agent detects subagent failures and propagates them
- The main agent loop detects executor failures and exits with a non-zero exit code
- Tasks are not marked as done when an executor fails
- Clear error reporting helps users understand and resolve conflicts

### Key Findings

**Product & User Story**
- Users need executors to fail fast when requirements are impossible or conflicting rather than attempting incorrect implementations
- Current behavior attempts to continue even with conflicting requirements, potentially causing cascading errors
- Users want detailed context about why the failure occurred and potential resolutions

**Design & UX Approach**
- Standardized "FAILED:" prefix protocol across all executor agents for consistent detection
- Detailed failure reports with structured information (requirements, problems, solutions)
- Graceful degradation with backward compatibility for existing error handling
- Clear console output showing the failure reason and suggestions

**Technical Plan & Risks**
- Create reusable failure detection prompt template
- Update all agent prompts (orchestrator, implementer, tester, reviewer, fixer)
- Enhance ExecutorOutput interface with optional failure fields
- Implement failure detection in Claude and Codex executors
- Update main agent loop to handle structured failures
- Risks: Breaking changes to executor interface, coordination across shared files, testing complexity

**Pragmatic Effort Estimate**
- Small to medium effort (2-3 days)
- Most changes are straightforward prompt additions and string checking
- Main complexity in comprehensive testing of failure scenarios

### Acceptance Criteria
- [ ] All agent prompts include standardized failure detection instructions
- [ ] Executors detect "FAILED:" messages and return structured failure indication
- [ ] Main agent loop exits with non-zero code on executor failure
- [ ] Tasks are not marked as done when executor fails
- [ ] Failure messages include requirements, problems, and potential solutions
- [ ] Backward compatibility maintained with existing error handling
- [ ] Claude orchestrator propagates subagent failures correctly
- [ ] Codex executor skips task completion on failure
- [ ] All failure scenarios covered by comprehensive tests
- [ ] Summary collection captures failure details when enabled

### Dependencies & Constraints
- **Dependencies**: Shared agent prompts file (claude_code/agent_prompts.ts), executor interface (types.ts), main agent loop (agent.ts, batch_mode.ts)
- **Technical Constraints**: Must maintain backward compatibility, cannot break existing error patterns, preserve summary collection functionality

### Implementation Notes

**Recommended Approach**
- Start with shared prompt template for consistency across all agents
- Make ExecutorOutput changes backward compatible with optional fields
- Implement detection in executors incrementally with thorough testing
- Use environment variable for gradual rollout if needed

**Potential Gotchas**
- Orchestrator manages multiple agents - must check each agent's output separately
- Codex executor's finally block unconditionally marks tasks done - must make conditional
- Batch mode handles multiple tasks - need strategy for partial failures
- Different output capture modes affect failure detection ability
- Must handle both "FAILED:" in content and structured failure in ExecutorOutput

---

## Area 1: Create Failure Detection Template and Update Prompts

Tasks:
- Create Standardized Failure Detection Template
- Update Shared Agent Prompts
- Update Claude Orchestrator Prompt
- Update Codex Fixer Prompt

This phase establishes the foundation for failure detection by creating a reusable prompt template and integrating it into all agent prompts. The template will provide clear instructions for agents to exit with "FAILED:" when they encounter requirements they cannot resolve. This ensures consistency across all agents and executors.

**Acceptance Criteria for Phase 1:**
- [ ] Failure detection template created with clear instructions
- [ ] Template integrated into implementer, tester, and reviewer prompts in agent_prompts.ts
- [ ] Template integrated into orchestrator prompt in orchestrator_prompt.ts
- [ ] Template integrated into Codex fixer prompt
- [ ] All prompts tested to ensure template doesn't break existing functionality

---

## Area 2: Enhance Executor Return Types

Tasks:
- Enhance ExecutorOutput Interface
- Create Failure Detection Utilities

This phase enhances the executor return type structure to support both success and failure scenarios with detailed context. The changes are designed to be backward compatible by making new fields optional. This allows executors to provide rich failure information without breaking existing implementations.

**Acceptance Criteria for Phase 2:**
- [ ] ExecutorOutput interface enhanced with optional success and failureDetails fields
- [ ] Type definitions updated to support failure scenarios
- [ ] Backward compatibility verified with existing executor implementations
- [ ] Documentation added for new interface fields

---

## Area 3: Implement Failure Detection in Claude Executor

Tasks:
- Add Failure Detection to Claude Executor
- Update Claude Output Processing
- Handle Orchestrator Subagent Failures

This phase implements the actual failure detection in the Claude executor. It checks both the orchestrator output and individual agent outputs for failure indicators, returning structured failure information when detected. The implementation ensures that task completion is skipped on failure.

**Acceptance Criteria for Phase 3:**
- [ ] Claude executor detects "FAILED:" in orchestrator output
- [ ] Claude executor detects "FAILED:" in subagent outputs
- [ ] Structured failure information returned in ExecutorOutput
- [ ] Task completion skipped when failure detected
- [ ] Existing error handling preserved as fallback

---

## Area 4: Implement Failure Detection in Codex Executor

Tasks:
- Add Failure Detection to Codex Executor
- Make Task Completion Conditional
- Update Codex Output Processing

This phase implements failure detection in the Codex executor, including special handling for the finally block that marks tasks as done. The implementation ensures consistency with the Claude executor while respecting Codex-specific patterns.

**Acceptance Criteria for Phase 4:**
- [ ] Codex executor detects "FAILED:" in agent outputs
- [ ] Finally block skips marking tasks done on failure
- [ ] Structured failure information returned in ExecutorOutput
- [ ] Fixer agent failures detected and handled
- [ ] Review analysis skipped on upstream failure

---

## Area 5: Update Main Agent Loop

Tasks:
- Update Serial Mode Agent Loop
- Update Batch Mode Handler
- Enhance Summary Collection

This phase updates the main agent command to properly handle the new structured failure information from executors. It ensures that failures result in appropriate exit codes and that error details are properly displayed to users. Both serial and batch modes are updated to handle failures consistently.

**Acceptance Criteria for Phase 5:**
- [ ] Agent loop checks ExecutorOutput for failure indication
- [ ] Detailed failure message displayed to user
- [ ] Process exits with non-zero code on failure
- [ ] Summary collector captures failure details
- [ ] Both serial and batch modes handle failures correctly

---

## Area 6: Testing and Documentation

Tasks:
- Create Failure Detection Tests
- Test Executor Failure Scenarios
- Test Agent Loop Failure Handling
- Update Documentation

This phase ensures the reliability of the failure detection feature through comprehensive testing and provides clear documentation for users. Tests cover various failure scenarios across both executors and execution modes.

**Acceptance Criteria for Phase 6:**
- [ ] Unit tests for failure detection utilities
- [ ] Integration tests for Claude executor failure scenarios
- [ ] Integration tests for Codex executor failure scenarios
- [ ] Tests for main agent loop failure handling
- [ ] Tests for batch mode partial failures
- [ ] Documentation updated in README and CLAUDE.md
- [ ] Example failure scenarios documented
