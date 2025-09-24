---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Catch when Codex implementer doesn't actually do anything
goal: Implement automatic detection and retry when the Codex implementer outputs
  planning text without making actual file changes, improving reliability and
  reducing wasted cycles.
id: 122
generatedBy: agent
status: in_progress
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-24T19:56:12.064Z
createdAt: 2025-09-24T02:30:42.162Z
updatedAt: 2025-09-24T21:20:13.756Z
progressNotes:
  - timestamp: 2025-09-24T20:23:49.826Z
    text: Implemented repository state capture utilities and planning detection
      logic with tests. captureRepositoryState/compareRepositoryStates now
      support git and jj roots; failure detection includes planning-only
      heuristic.
    source: "implementer: tasks 1-3"
  - timestamp: 2025-09-24T20:33:55.252Z
    text: Integrated auto-retry in Codex executor using new planning detection.
      Implementer now captures repository state before/after, retries up to 3
      times with escalating prompts, and emits warnings when planning-only
      responses occur. Added regression tests covering retry flow and adjusted
      existing mocks.
    source: "implementer: tasks 4-6"
  - timestamp: 2025-09-24T20:39:48.041Z
    text: Reviewed existing tests...
    source: "tester: detection-retry"
  - timestamp: 2025-09-24T20:41:23.205Z
    text: Added coverage for planning detection without plan lines, commit-hash
      changes, and ensured Codex retries proceed after exhausting attempts.
    source: "tester: detection-retry"
  - timestamp: 2025-09-24T20:42:05.351Z
    text: Executed updated test suite for planning detection and Codex retries; all
      targeted bun tests pass, type-check still blocked by pre-existing
      researchInsertedAt issue.
    source: "tester: detection-retry"
  - timestamp: 2025-09-24T20:59:16.825Z
    text: Added detailed logging in Codex implementer loop to record planning-only
      detections, retry attempts, and outcomes, including repository state
      diagnostics.
    source: "implementer: Task 6"
  - timestamp: 2025-09-24T21:05:15.136Z
    text: Added Codex executor integration tests that simulate planning-only
      implementer outputs, covering git success-after-retry, jj exhaustion, and
      no-detection edge cases.
    source: "implementer: Task 7"
  - timestamp: 2025-09-24T21:10:39.831Z
    text: Added integration test to assert warning output when repository state
      capture fails, ensuring retries stay disabled under status check failures.
    source: "tester: logging-integration"
  - timestamp: 2025-09-24T21:13:52.055Z
    text: Updated existing Codex executor tests to match new logging strings and ran
      full bun test suite; all tests now passing.
    source: "tester: integration-logging"
tasks:
  - title: Add Repository State Tracking Interface
    done: true
    description: >-
      Create new functions in `src/common/git.ts` to capture and compare
      repository states:

      - Define `RepositoryState` interface with hasChanges, commitHash, and
      optional statusOutput

      - Implement `captureRepositoryState()` that combines existing utilities

      - Add `compareRepositoryStates()` to detect any changes between states

      - Ensure support for both git and jj repositories
    steps: []
  - title: Implement Planning Detection Logic
    done: true
    description: >-
      Add detection functions to `src/rmplan/executors/failure_detection.ts`:

      - Define `PlanningWithoutImplementationDetection` interface

      - Implement `detectPlanningWithoutImplementation()` function

      - Add pattern matching for common planning phrases (e.g., `/^ ?\S*
      ?plan/i`, `/^Here's what I'll do/i`)

      - Combine text analysis with repository state comparison

      - Return structured detection result with retry recommendation
    steps: []
  - title: Create Unit Tests for Detection
    done: true
    description: >-
      Write comprehensive tests for the new detection infrastructure:

      - Test repository state capture with various scenarios (no changes, file
      changes, commits)

      - Test planning text pattern matching with real-world examples

      - Test combined detection logic with different combinations

      - Include edge cases like file deletions, permission errors
    steps: []
  - title: Add State Capture to Codex CLI Executor
    done: true
    description: |-
      Modify `src/rmplan/executors/codex_cli.ts` to capture repository state:
      - Add state capture before implementer execution (around line 131)
      - Add state capture after implementer execution (after line 136)
      - Store retry count in execution context
      - Ensure state capture doesn't interfere with existing flow
    steps: []
  - title: Implement Detection and Retry Loop
    done: true
    description: |-
      Add retry logic when planning-without-implementation is detected:
      - Call detection function with before/after states and output
      - Implement retry loop (max 3 attempts) when detected
      - Enhance implementer prompt for each retry attempt:
        - Retry 1: "Please implement the changes now, not just plan them."
        - Retry 2: "IMPORTANT: Execute the actual code changes immediately."
        - Retry 3: "CRITICAL: You must write actual code files NOW."
      - Preserve original context and task information across retries
    steps: []
  - title: Add Logging and Observability
    done: true
    description: >-
      Implement clear logging for detection and retry events:

      - Log when planning-without-implementation is detected

      - Log retry attempts with counter (e.g., "Retrying implementer (attempt
      2/3)...")

      - Log final outcome (success after retry, or exhausted retries)

      - Ensure logs are actionable and help with debugging
    steps: []
  - title: Create Integration Tests
    done: true
    description: |-
      Write integration tests for the complete flow:
      - Mock Codex executor responses with planning-only output
      - Test successful retry scenarios (plan then implement on retry)
      - Test exhausted retry scenarios (all retries fail)
      - Test with both git and jj repositories
      - Test edge cases (no planning text but no changes, etc.)
    steps: []
  - title: Test Edge Cases and Error Scenarios
    done: false
    description: |-
      Ensure robust handling of edge cases:
      - Test behavior when repository state checks fail
      - Test with file deletions and moves
      - Test with direct commits (using `git commit` or `jj commit`)
      - Test concurrent file system modifications
      - Verify graceful degradation in sandboxed environments
    steps: []
  - title: Update Documentation
    done: false
    description: |-
      Document the new retry mechanism:
      - Update CLAUDE.md with information about automatic retry
      - Document the detection patterns and retry behavior
      - Add troubleshooting section for common scenarios
      - Include examples of when retry is triggered
      - Document any configuration options or environment variables
    steps: []
changedFiles:
  - src/common/git.test.ts
  - src/common/git.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/executors/claude_code/format.ts
  - src/rmplan/executors/codex_cli/format.test.ts
  - src/rmplan/executors/codex_cli/format.ts
  - src/rmplan/executors/codex_cli.capture_output.test.ts
  - src/rmplan/executors/codex_cli.fix_loop.test.ts
  - src/rmplan/executors/codex_cli.retry.test.ts
  - src/rmplan/executors/codex_cli.test.ts
  - src/rmplan/executors/codex_cli.ts
  - src/rmplan/executors/failure_detection.test.ts
  - src/rmplan/executors/failure_detection.ts
  - src/rmplan/executors/shared/todo_format.ts
  - src/rmplan/process_markdown.ts
  - src/rmplan/research_utils.ts
rmfilter: []
---

# Original Plan Details

Sometimes the Codex implementer step will plan some changes but not do anything. The tester step usually does a good job
of raising a FAIL when it finds the things it's supposed to test are not there, but we should try to catch this.

Something like this:
- Last message output contains a line matching /^ ?\S* ?plan/i or /plan:?$/i
- No files have changed since the implementer was started.

For the file detection, we can check:
- Current git SHA has not changed
- `jj status` or `git status -s` has same output before and after the implementer  step runs

Ideally we could resume the same session, but Codex doesn't output the session ID yet. Instead, we should just rerun
the implementer up to 3 times when we detect this.

# Processed Plan Details

## Detect and retry when Codex implementer plans but doesn't execute changes

### Expected Behavior/Outcome
- The system automatically detects when Codex implementer outputs planning text (matches `/^ ?\S* ?plan/i` or `/plan:?$/i`) but makes no actual file changes
- When detected, the implementer is automatically retried up to 3 times with progressively more explicit instructions
- Clear logging indicates when planning-without-implementation is detected and retry attempts are made
- Both git and jj repositories are supported transparently
- The feature works without configuration and doesn't interfere with existing failure detection

### Key Findings

**Product & User Story**
- Users currently experience silent failures when the Codex implementer plans steps but doesn't execute them
- The tester step eventually catches missing implementations, but only after wasted execution cycles
- This creates confusion about whether the implementer actually understood the requirements
- Early detection and retry would improve iteration speed and success rates by catching issues immediately

**Design & UX Approach**
- Detection happens transparently without user intervention
- Clear logging messages indicate when retry is happening and why (e.g., "Implementer appears to have planned but not executed. Retrying (attempt 2/3)...")
- Existing failure patterns are preserved - FAILED protocol continues to work as before
- No additional configuration required - feature works out of the box

**Technical Plan & Risks**
- Integration point: After line 136 in `codex_cli.ts` where `implementerOutput` is captured
- Repository state tracking using existing `hasUncommittedChanges()` and `getCurrentCommitHash()` utilities
- Pattern detection for planning keywords combined with absence of file changes
- Retry mechanism with bounded attempts (max 3) and enhanced prompts
- **Risks**: False positives if implementer makes commits directly (mitigated by checking both uncommitted changes and commit hash); Performance impact from additional status checks (minimal, similar checks already done elsewhere)

**Pragmatic Effort Estimate**
- Core implementation: 4-6 hours
- Testing and edge cases: 2-3 hours  
- Integration testing: 1-2 hours
- Total: ~1.5 days of focused work

### Acceptance Criteria
- [ ] **Functional**: System detects when implementer output contains planning text patterns but no file changes occur
- [ ] **Functional**: Automatic retry happens up to 3 times with progressively more explicit prompts
- [ ] **Functional**: Detection works for both uncommitted changes and direct commits
- [ ] **UX**: Clear logging indicates detection and retry attempts with attempt counter
- [ ] **Technical**: Both git and jj repositories are supported
- [ ] **Technical**: Feature gracefully degrades if repository state checks fail
- [ ] **Technical**: Retry state is properly tracked and bounded to prevent infinite loops
- [ ] All new code paths are covered by unit and integration tests

### Dependencies & Constraints

**Dependencies**
- Existing `hasUncommittedChanges()` function from `src/common/git.ts`
- `getCurrentCommitHash()` for commit-level change detection
- Existing failure detection framework in `src/rmplan/executors/failure_detection.ts`
- Codex CLI stdout formatter for capturing implementer output

**Technical Constraints**
- Must not interfere with existing FAILED protocol detection
- Cannot resume same Codex session (limitation noted in requirements), so retries create new sessions
- Retry attempts must be bounded to prevent infinite loops
- Must handle both git and jj repositories transparently
- Must gracefully degrade if repository state checks fail

### Implementation Notes

**Recommended Approach**
1. Add repository state tracking utilities to capture before/after states
2. Implement planning text detection that checks for common patterns
3. Integrate detection after implementer execution in Codex CLI executor
4. Add retry loop with enhanced prompts for each attempt
5. Ensure proper logging and state management throughout

**Potential Gotchas**
- **Direct Commits**: Implementer might commit changes directly, so check both uncommitted changes AND commit hash
- **File Deletions**: Removing files is a valid change - ensure detection accounts for deletions
- **Planning Text False Positives**: Some legitimate outputs contain "plan" - focus on line start/end patterns
- **Workspace Permissions**: In sandboxed environments, repository state checks might fail
- **Async Race Conditions**: File system changes might not be immediately visible
- **Context Preservation**: Since we can't resume sessions, ensure context is properly passed to retry attempts

---

## Area 1: Core Detection Infrastructure

Tasks:
- Add Repository State Tracking Interface
- Implement Planning Detection Logic
- Create Unit Tests for Detection

This phase establishes the core detection mechanisms for identifying when the implementer has planned but not executed. We'll create utilities for capturing repository state before and after operations, and implement pattern matching for planning-only outputs. The infrastructure will be modular and testable, supporting both git and jj repositories.

**Acceptance Criteria for Phase 1:**
- [ ] Repository state capture function works for both git and jj
- [ ] Planning text detection correctly identifies common patterns
- [ ] Unit tests cover all detection scenarios
- [ ] Functions gracefully handle errors and edge cases

---

## Area 2: Executor Integration and Retry Logic

Tasks:
- Add State Capture to Codex CLI Executor
- Implement Detection and Retry Loop
- Add Logging and Observability

This phase integrates the detection infrastructure into the Codex CLI executor flow. We'll add state capture before and after the implementer step, detect planning-without-implementation scenarios, and implement a bounded retry mechanism with enhanced prompts. The integration will be seamless and maintain backward compatibility.

**Acceptance Criteria for Phase 2:**
- [ ] Detection triggers correctly after implementer execution
- [ ] Retry attempts are bounded to maximum 3 attempts
- [ ] Each retry uses progressively more explicit prompts
- [ ] Logging clearly indicates detection and retry attempts
- [ ] Existing failure detection (FAILED protocol) continues to work

---

## Area 3: Testing and Documentation

Tasks:
- Create Integration Tests
- Test Edge Cases and Error Scenarios
- Update Documentation

This final phase focuses on integration testing, edge case handling, and documentation. We'll create integration tests that simulate real Codex interactions, test the complete flow from detection through retry, and update documentation to inform users about the new capability.

**Acceptance Criteria for Phase 3:**
- [ ] Integration tests cover the complete detection and retry flow
- [ ] Edge cases are tested and handled gracefully
- [ ] Documentation is updated in CLAUDE.md
- [ ] All tests pass consistently in CI environment

## Research

### 2025-09-24 19:55 UTC

## Research

### Summary
- The Codex implementer sometimes outputs planning text describing what it will do, but then fails to actually make any file changes, leaving the system in an unchanged state until the tester catches the missing implementation.
- The codebase already has robust infrastructure for detecting repository changes (`hasUncommittedChanges()`, `getCurrentCommitHash()`) and failure detection (FAILED protocol), which can be leveraged for this feature.
- The optimal integration point is immediately after the implementer output is captured (line 136 in `codex_cli.ts`), where we can compare repository state before and after execution.
- The solution requires detecting both planning text patterns in the output AND verifying no actual file changes occurred, then retrying with progressively more explicit prompts.

### Findings
- The main executor file `src/rmplan/executors/codex_cli.ts` orchestrates a sequential flow: implementer → tester → reviewer → (optional fixer loop)
- The implementer step execution happens at line 132, with output captured and logged at line 136
- The existing failure detection system (`src/rmplan/executors/failure_detection.ts`) uses a FAILED: protocol where agents explicitly report blocking issues
- The `src/common/git.ts` module provides comprehensive repository state utilities supporting both Git and Jujutsu
- The `src/rmplan/executors/codex_cli/format.ts` module handles JSON streaming from Codex and captures agent messages
- Existing retry patterns are found in `src/state_machine/store.ts` (generic retry with exponential backoff) and `src/apply-llm-edits/retry.ts` (LLM correction feedback)

#### Retry Pattern Analysis (from subagent)

Based on my analysis of the codebase, I can now provide a comprehensive report on existing retry implementations, change detection, and resumption patterns.

## Analysis Report: Retry Implementations and Change Detection Patterns

### 1. Current Retry Implementations

#### Apply LLM Edits (`src/apply-llm-edits/retry.ts`)
- **Pattern**: Automatic retry with LLM correction feedback
- **Detection**: Failed edits based on search/replace pattern matching errors
- **Retry Logic**: 
  - Constructs retry prompts with original context + failed output + error details
  - Uses `RetryRequester` callback to request LLM corrections
  - Automatically filters out successfully applied edits to avoid double-application
- **Key Features**:
  - Original context reconstruction via `getOriginalRequestContext()`
  - Structured retry messages with `constructRetryMessage()`
  - Overlap detection to prevent duplicate edit application

#### State Machine Retry System (`src/state_machine/store.ts`)
- **Pattern**: Configurable retry with exponential backoff
- **Implementation**: Generic retry mechanism in `SharedStore.retry()`
- **Features**:
  - Configurable `maxRetries` and `retryDelay` function
  - OpenTelemetry integration for observability
  - Rollback support with `withRollback()` for context consistency
  - Event queuing during rollback operations

#### Codex CLI Executor Fix Loop (`src/rmplan/executors/codex_cli.ts`)
- **Pattern**: Multi-step retry with reviewer feedback
- **Current Logic**: Fix-and-review loop (up to 5 iterations) in lines 295-388
- **Process**: implementer → tester → reviewer → (if NEEDS_FIXES) → fixer → reviewer → repeat

### 2. Existing Change Detection Patterns

#### Git Status Detection (`src/common/git.ts`)
- **Function**: `hasUncommittedChanges(cwd?: string): Promise<boolean>`
- **Implementation**: 
  - Detects Git vs Jujutsu repositories automatically
  - Uses `git status --porcelain` or `jj diff` commands
  - Returns `true` if any output indicates changes
- **Location**: Lines 95-109 in `/Users/dimfeld/Documents/projects/llmutils/src/common/git.ts`

#### File Change Detection in Apply LLM Edits
- **Pattern**: Regenerates context by re-running rmfilter to detect file changes
- **Function**: `getOriginalRequestContext()` in `retry.ts`
- **Process**: Re-executes original rmfilter command to get current file state

### 3. Failure Detection Patterns

#### Standardized FAILED Protocol (`src/rmplan/executors/failure_detection.ts`)
- **Pattern**: Detects "FAILED:" prefix in agent outputs
- **Functions**:
  - `detectFailedLine()`: Checks first non-empty line for FAILED prefix
  - `parseFailedReport()`: Extracts structured failure details
  - `extractFailureDetails()`: Parses requirements, problems, solutions sections
- **Used in**: Codex CLI executor for all agent types (implementer, tester, reviewer, fixer)

#### Codex CLI Current Detection
- **Location**: Lines 139-157, 195-210, 234-249, 314-333 in `codex_cli.ts`
- **Pattern**: Checks each agent's output for FAILED reports
- **Action**: Returns immediately with failure details when detected

### 4. Resumption/Rerun Patterns

#### Batch Mode Continuation (`src/rmplan/commands/agent/batch_mode.ts`)
- **Pattern**: Continue-until-complete loop
- **Logic**: Re-reads plan file each iteration to check for remaining incomplete tasks
- **Process**: Loops until no incomplete tasks remain or error occurs

#### State Machine Resume (`src/state_machine/index.ts`)
- **Pattern**: Event-driven resumption with persistence
- **Features**: Can resume from persisted state with pending events

### 5. Recommendations for Task 122 Implementation

Based on the analysis, here's how to implement the "nothing done" detection for the Codex implementer:

#### Detection Strategy
1. **Git Status Comparison**: Capture git/jj status before and after implementer step
2. **Output Pattern Detection**: Check for planning-only patterns in implementer output
3. **Integration Point**: Add detection logic after line 136 in `codex_cli.ts` (after implementer output capture)

#### Suggested Implementation Location
```typescript
// In CodexCliExecutor.execute(), after line 136:
const implementerOutput = await this.executeCodexStep(implementer.prompt, gitRoot, {
  planTool: true,
});

// ADD DETECTION LOGIC HERE
const didNothing = await this.detectNoWork(implementerOutput, gitRoot);
if (didNothing) {
  // Retry implementer up to 3 times
  // Use existing retry pattern from state machine or create custom logic
}
```

#### Required New Functions
1. `detectNoWork(output: string, gitRoot: string): Promise<boolean>`
   - Check output for planning-only patterns
   - Compare git status before/after
2. `retryImplementer()` - Retry logic following existing patterns
3. Integration with existing failure detection system

#### Existing Utilities to Leverage
- `hasUncommittedChanges()` from `src/common/git.ts`
- Retry patterns from `src/state_machine/store.ts`
- Failure detection patterns from `src/rmplan/executors/failure_detection.ts`

The codebase already has robust patterns for retry logic, change detection, and failure handling that can be adapted for this specific use case of detecting when the Codex implementer plans but doesn't execute any actual changes.

#### Git/JJ Status Checking Analysis (from subagent)

Based on my comprehensive search of the codebase, I can now document the existing utilities and patterns for version control status checking. Here's my analysis:

## Documentation: Git and JJ Status Checking Utilities

### Core Git and JJ Utilities in `src/common/git.ts`

The codebase has a comprehensive set of utilities for checking git and jj repository status:

#### Repository Detection and Root Finding
- **`getGitRoot(cwd?)`**: Finds Git root directory, falls back to `.jj` directory for Jujutsu repositories, with caching
- **`getUsingJj()`**: Detects if repository uses Jujutsu (jj) version control by checking for `.jj` directory

#### Status Checking Functions
- **`hasUncommittedChanges(cwd?)`**: Core utility that checks for uncommitted changes in both Git and Jujutsu
  - For Git: Uses `git status --porcelain` (more reliable than other git status commands)
  - For Jujutsu: Uses `jj diff` and checks for non-empty output
  - Returns `true` if there are any uncommitted changes (staged or unstaged)

#### Commit Hash Retrieval
- **`getCurrentCommitHash(gitRoot)`**: Gets current commit hash from both Git and Jujutsu
  - For Git: Uses `git rev-parse HEAD`
  - For Jujutsu: Uses `jj log -r @ --no-graph -T commit_id`
  - Used for baseline revision tracking

#### Change Detection
- **`getChangedFilesOnBranch(gitRoot, options)`**: Lists files changed compared to a base branch
- **`getChangedFilesBetween(gitRoot, fromRef, toRef?, options)`**: Lists files changed between two specific revisions
- **`getTrunkBranch(gitRoot)`**: Determines main/trunk branch name

### Status Checking Patterns Used in the Codebase

#### 1. Before/After Operation Comparison
**Pattern found in `src/rmplan/summary/collector.ts`:**
```typescript
// Capture baseline before operation
async recordExecutionStart(baseDir?: string): void {
  this.startedAt = new Date().toISOString();
  // Capture baseline revision for accurate change tracking
  getGitRoot(baseDir)
    .then((root) => getCurrentCommitHash(root))
    .then((rev) => {
      this.baselineRevision = rev;
    });
}

// Track changes after operation
async trackFileChanges(baseDir?: string): Promise<void> {
  const gitRoot = await getGitRoot(baseDir);
  let files: string[];
  if (this.baselineRevision) {
    files = await getChangedFilesBetween(gitRoot, this.baselineRevision);
  } else {
    files = await getChangedFilesOnBranch(gitRoot);
  }
  for (const f of files) this.changedFiles.add(f);
}
```

#### 2. Pre-Commit Validation
**Pattern found in `src/common/process.ts` and `src/rmpr/main.ts`:**
```typescript
// Check if there are changes before attempting commit
export async function commitAll(message: string, cwd?: string): Promise<number> {
  if ((await hasUncommittedChanges(cwd)) === false) {
    return 0; // Nothing to commit
  }
  // Proceed with commit...
}

// In rmpr/main.ts:
const hasChanges = await hasUncommittedChanges();
if (hasChanges) {
  log('Committing changes...');
  // Commit logic here...
}
```

#### 3. Plan Metadata Updates
**Pattern found in `src/rmplan/plans/mark_done.ts`:**
```typescript
// Always update metadata after marking steps done
const gitRoot = await getGitRoot(baseDir);
planData.updatedAt = new Date().toISOString();

// Update changedFiles by comparing against baseBranch
const changedFiles = await getChangedFilesOnBranch(gitRoot, {
  baseBranch: planData.baseBranch,
  excludePaths,
});
if (changedFiles.length > 0) {
  planData.changedFiles = changedFiles;
}
```

### Testing Patterns

The test files show comprehensive testing of status functions using real repositories:

#### Real Repository Testing
**Pattern from `src/common/git.test.ts`:**
```typescript
it('should return true for uncommitted changes in working directory', async () => {
  // Create real git repo
  const initProc = Bun.spawn(['git', 'init'], { cwd: tempDir });
  await initProc.exited;
  
  // Set up initial commit
  // ... commit setup ...
  
  // Make changes without committing
  await fs.writeFile(testFile, 'modified content');
  
  const hasChanges = await hasUncommittedChanges(tempDir);
  expect(hasChanges).toBe(true);
});
```

### Key Utilities Summary

| Function | Purpose | Git Command | JJ Command |
|----------|---------|-------------|------------|
| `hasUncommittedChanges()` | Check for any changes | `git status --porcelain` | `jj diff` |
| `getCurrentCommitHash()` | Get current commit SHA | `git rev-parse HEAD` | `jj log -r @ --no-graph -T commit_id` |
| `getChangedFilesOnBranch()` | Files changed vs branch | `git diff --name-only <branch>` | `jj diff --from <ref> --summary` |
| `getChangedFilesBetween()` | Files changed between refs | `git diff --name-only <from> <to>` | `jj diff --from <from> --to <to> --summary` |

### Best Practices from the Codebase

1. **Always check for uncommitted changes before commit operations**
2. **Use baseline revision capture for accurate change tracking**
3. **Prefer `git status --porcelain` over other git status variants for reliability**
4. **Handle both Git and Jujutsu repositories transparently**
5. **Cache expensive operations like repository root detection**
6. **Test with real repositories rather than mocking filesystem operations**
7. **Gracefully handle errors in status checking with fallback behaviors**

The codebase demonstrates mature patterns for repository state management with comprehensive dual VCS support (Git/Jujutsu) and robust error handling.

#### Failure Detection Analysis (from subagent)

Now I have a comprehensive understanding of the failure detection patterns in the codebase. Let me create a detailed analysis document.

# Failure Detection Patterns Analysis

Based on my analysis of the codebase, here's a comprehensive overview of how failures are currently detected and what gaps exist for detecting when an agent plans but doesn't implement.

## Current Failure Detection Mechanisms

### 1. FAILED Protocol Detection (`src/rmplan/executors/failure_detection.ts`)

**Current Implementation:**
- **Primary Detection**: `detectFailedLine()` - looks for `FAILED:` as the first non-empty line
- **Secondary Detection**: `detectFailedLineAnywhere()` - finds `FAILED:` anywhere in the message
- **Pattern**: `/^\s*FAILED:\s*(.*)$/` (case-sensitive, exact format)
- **Structured Parsing**: Extracts requirements, problems, and solutions from standardized sections

**How It Works:**
```typescript
// Detects explicit failure reports from agents
const parsed = parseFailedReport(agentOutput);
if (parsed.failed) {
  return {
    success: false,
    failureDetails: {
      ...parsed.details,
      sourceAgent: 'implementer' | 'tester' | 'reviewer' | 'fixer'
    }
  };
}
```

### 2. Agent-Specific Failure Flows

**Claude Code Executor (`src/rmplan/executors/claude_code.ts`):**
- Monitors orchestrator output for `FAILED:` lines from sub-agents
- Identifies source agent from failure summary
- Returns structured failure with `sourceAgent` field

**Codex CLI Executor (`src/rmplan/executors/codex_cli.ts`):**
- Sequential implement → test → review → fix loop
- Each phase checks for `FAILED:` in output
- Tracks failure state across iterations

**Agent Prompts (`src/rmplan/executors/claude_code/agent_prompts.ts`):**
```typescript
const FAILED_PROTOCOL_INSTRUCTIONS = `
If you encounter conflicting or impossible requirements that you cannot safely resolve, do NOT proceed.

Instead, stop immediately and output a single line starting with:
FAILED: <1-sentence summary>

Follow that line with a detailed report containing:
- Requirements you were trying to satisfy
- Problems encountered (why this is conflicting or impossible)  
- Possible solutions or next steps the user could take
`;
```

### 3. Success vs Failure Detection Flow

**Current Detection Points:**
1. **Explicit FAILED Reports**: Agents emit `FAILED:` when they encounter blocking issues
2. **Review Verdicts**: Reviewer agents output `NEEDS_FIXES` vs `ACCEPTABLE`
3. **Test Failures**: Tester agents report when tests fail
4. **Exit Codes**: Process-level failures from spawned commands

## Current Gaps: "Planning But Not Doing" Detection

### The Problem Identified in Task 122

**Scenario**: The Codex implementer step will plan some changes but not actually implement anything, leaving the tester step to discover missing functionality.

**Current Gap**: There's no detection mechanism for when an agent:
1. Outputs planning text (matches `/^ ?\S* ?plan/i` or `/plan:?$/i`)
2. But makes no actual file changes
3. Appears to succeed (no `FAILED:` output, normal exit code)

### Proposed Detection Strategy (from Task 122)

**File Change Detection:**
```typescript
// Check if files actually changed during implementer step
// Option 1: Git/jj status comparison
const statusBefore = await getRepoStatus(gitRoot);
// ... run implementer ...  
const statusAfter = await getRepoStatus(gitRoot);
const hasChanges = statusBefore !== statusAfter;

// Option 2: Commit hash comparison  
const hashBefore = await getCurrentCommitHash(gitRoot);
// ... run implementer ...
const hashAfter = await getCurrentCommitHash(gitRoot); 
const hasCommits = hashBefore !== hashAfter;
```

**Planning Text Detection:**
```typescript
// Look for planning keywords without implementation
const planningPatterns = [
  /^ ?\S* ?plan/i,
  /plan:?$/i,
  /^I will/i,
  /^Here's the plan/i,
  /^The implementation will/i
];

const containsPlanning = planningPatterns.some(pattern => 
  agentOutput.match(pattern)
);
```

**Recovery Strategy:**
- Rerun implementer up to 3 times when this pattern is detected
- Add more specific instructions about immediate implementation
- Track retry count to avoid infinite loops

## Existing Infrastructure That Can Be Leveraged

### 1. Git/Repository Status Functions (`src/common/git.ts`)

**Available Functions:**
```typescript
// Check for any uncommitted changes
hasUncommittedChanges(cwd?: string): Promise<boolean>

// Get current commit hash  
getCurrentCommitHash(gitRoot: string): Promise<string | null>

// Compare file changes between revisions
getChangedFilesBetween(gitRoot: string, fromRef: string, toRef?: string): Promise<string[]>
```

**Usage Pattern:**
```typescript
// Already used in rmpr/main.ts for similar detection
const hasChanges = await hasUncommittedChanges();
if (!hasChanges) {
  log('No uncommitted changes detected. Executor appears to have already committed.');
  return;
}
```

### 2. Process Spawning Infrastructure (`src/common/process.ts`)

**Available Functions:**
- `spawnAndLogOutput()` - used by executors to run sub-processes
- Git status checking already integrated into process management

### 3. Executor Output Capture

**Claude Code Executor:**
- Tracks file paths created/modified via `trackedFiles` set
- Captures structured output with `captureOutput` modes
- Monitors real-time agent output through JSON streaming

**Codex CLI Executor:**
- Accumulates all agent outputs in `events` array
- Tracks completion status through plan file analysis

## Recommended Implementation Approach

### 1. Enhance Failure Detection Interface

```typescript
// Add to src/rmplan/executors/failure_detection.ts
export interface PlanningWithoutImplementationDetection {
  detected: boolean;
  planningIndicators: string[];
  hasFileChanges: boolean;
  hasCommitChanges: boolean;
  suggestedAction: 'retry' | 'escalate' | 'proceed';
}

export function detectPlanningWithoutImplementation(
  agentOutput: string,
  gitRoot: string,
  beforeState: RepositoryState,
  afterState: RepositoryState
): Promise<PlanningWithoutImplementationDetection>
```

### 2. Repository State Tracking

```typescript
// Add to src/common/git.ts
export interface RepositoryState {
  commitHash: string | null;
  statusOutput: string;
  fileCount: number;
}

export async function captureRepositoryState(gitRoot: string): Promise<RepositoryState> {
  const [commitHash, statusOutput] = await Promise.all([
    getCurrentCommitHash(gitRoot),
    hasUncommittedChanges(gitRoot) ? getStatusOutput(gitRoot) : Promise.resolve('')
  ]);
  
  return {
    commitHash,
    statusOutput, 
    fileCount: statusOutput.split('\n').filter(Boolean).length
  };
}
```

### 3. Integration Points in Executors

**Codex CLI Executor Enhancement:**
```typescript
// Before implementer step
const beforeState = await captureRepositoryState(gitRoot);

// After implementer step  
const afterState = await captureRepositoryState(gitRoot);
const planningDetection = await detectPlanningWithoutImplementation(
  implementerOutput, gitRoot, beforeState, afterState
);

if (planningDetection.detected && planningDetection.suggestedAction === 'retry') {
  // Retry implementer with more specific instructions
  // Track retry count, max 3 attempts
}
```

### 4. Enhanced Agent Instructions

The implementer prompt should be modified to emphasize immediate action:
- "Once you decide how to go about implementing the tasks, do so immediately. No need to wait for approval." (already present)
- Add detection warnings about planning-only responses
- Provide examples of what constitutes actual implementation

## Summary

**Current State:**
- Strong explicit failure detection via `FAILED:` protocol
- Good infrastructure for git/repository state management  
- Structured error handling and recovery flows

**Missing Gap:**
- No detection for "planning but not implementing" scenarios
- Agents can appear successful while doing nothing
- Relies on downstream tester to catch missing implementations

**Solution Approach:**
- Combine repository state monitoring with output text analysis
- Implement retry logic with enhanced instructions
- Leverage existing git utility functions and executor frameworks
- Add new detection interface alongside existing failure detection

The infrastructure exists to implement this detection effectively. The main work involves integrating repository state capture into the executor flows and adding the planning text analysis logic.

### Risks & Constraints
- **False Positives**: The implementer might legitimately commit changes directly (using `jj commit` or `git commit`), bypassing uncommitted change detection. We must check both uncommitted changes AND commit hash changes.
- **Session State Loss**: Codex doesn't output session IDs yet, so we cannot resume the same session. Each retry creates a new session, requiring careful context preservation in prompts.
- **Race Conditions**: File system changes might not be immediately visible after Codex execution. May need small delays or explicit filesystem sync.
- **Sandbox Restrictions**: In sandboxed environments, repository state checks might fail due to permissions. Need graceful fallback behavior.
- **Planning Text Ambiguity**: Legitimate outputs may contain words like "plan" without being planning-only responses. Detection patterns must be precise to avoid false triggers.
- **Performance Impact**: Additional repository state checks add overhead to each implementer execution, though this should be minimal given existing usage patterns.
- **Test Environment Behavior**: The feature is disabled by default in test mode (`NODE_ENV === 'test` or `RMPLAN_DISABLE_AUTO_MARK` environment variables) to avoid flaky tests.
- **Dependency on Git Utilities**: The solution heavily relies on `hasUncommittedChanges()` and `getCurrentCommitHash()` working correctly for both Git and Jujutsu repositories.

### Follow-up Questions
- Should the retry mechanism be configurable (e.g., max retry count, disable entirely) via rmplan config or environment variables?
- When the implementer is retried, should we append information about previous attempts to the prompt, or start fresh each time?
- Should we track metrics about how often this detection triggers to help improve the base implementer prompts over time?
- Is there a preference for how verbose the logging should be when detection and retry occur?
- Should this detection also apply to the fixer agent, or only the implementer?
