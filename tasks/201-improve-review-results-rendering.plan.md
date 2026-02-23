---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Better review rendering
goal: ""
id: 201
uuid: a2e13a19-4d9a-44da-ab4f-c6f566ecacc1
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-02-23T09:09:52.475Z
promptsGeneratedAt: 2026-02-23T09:09:52.475Z
createdAt: 2026-02-21T01:14:58.731Z
updatedAt: 2026-02-23T20:20:59.037Z
tasks:
  - title: Combine ReviewResultMessage and ReviewVerdictMessage
    done: true
    description: "In src/logging/structured_messages.ts: Add verdict (ReviewVerdict,
      required), fixInstructions (optional string) fields to
      ReviewResultMessage. Remove ReviewVerdictMessage interface. Remove
      review_verdict from StructuredMessage union and structuredMessageTypeList.
      Keep the ReviewVerdict type alias."
  - title: Update tunnel server validation
    done: true
    description: "In src/logging/tunnel_server.ts: Update the review_result
      validation case to also check verdict (required string in reviewVerdicts
      set) and fixInstructions (optional string). Remove the review_verdict case
      entirely."
  - title: Extract issue formatting from TerminalFormatter
    done: true
    description: "In src/tim/formatters/review_formatter.ts: Extract the
      issue-formatting portion from TerminalFormatter into a standalone exported
      function. Accept issues in ReviewOutput issues format (without id field)
      and return formatted string with severity-grouped issues. Extract private
      groupIssuesBySeverity(), getSeverityIcon(), getSeverityColor() as
      standalone functions. Do not include recommendations, action items, or
      full header. Add tests in review_formatter.test.ts."
  - title: Update console formatter for review_result
    done: true
    description: "In src/logging/console_formatter.ts: Import the new extracted
      function. Replace empty-string return for review_result with call to
      extracted function passing message.issues. Remove review_verdict case.
      Update console_formatter.test.ts accordingly."
  - title: Update review command to send combined message
    done: true
    description: "In src/tim/commands/review.ts: Move detectIssuesInReview() before
      sendStructured. Include verdict and fixInstructions in review_result
      message. Remove review_verdict sendStructured call. Remove
      log(formattedOutput) call. Keep console.log for tunnel mode. Update
      review.notifications.test.ts."
  - title: Update codex executor modes to send combined message
    done: true
    description: "In src/tim/executors/codex_cli/normal_mode.ts and simple_mode.ts:
      Convert all review_verdict sendStructured calls to review_result with full
      issues data from ExternalReviewResult. Update codex_cli.test.ts and
      codex_cli.simple_mode.test.ts."
  - title: Update Swift GUI data models and rendering
    done: true
    description: "In tim-gui/TimGUI/SessionModels.swift: Add verdict and
      fixInstructions to ReviewResultPayload. Remove .reviewVerdict case from
      StructuredMessagePayload. Update JSON decoding. Update .reviewResult
      rendering to group issues by severity. No recommendations, action items,
      or verdict text. Remove .reviewVerdict rendering. Update Swift tests."
  - title: Update structured_messages.test.ts and tunnel_server.test.ts
    done: true
    description: Update structured_messages.test.ts for review_verdict removal and
      new verdict field on review_result. Update tunnel_server.test.ts
      validation tests for combined format.
branch: "201"
changedFiles:
  - README.md
  - src/logging/console_formatter.test.ts
  - src/logging/console_formatter.ts
  - src/logging/structured_messages.test.ts
  - src/logging/structured_messages.ts
  - src/logging/tunnel_server.test.ts
  - src/logging/tunnel_server.ts
  - src/tim/commands/review.notifications.test.ts
  - src/tim/commands/review.ts
  - src/tim/executors/codex_cli/normal_mode.ts
  - src/tim/executors/codex_cli/review_message.ts
  - src/tim/executors/codex_cli/simple_mode.ts
  - src/tim/executors/codex_cli.simple_mode.test.ts
  - src/tim/executors/codex_cli.test.ts
  - src/tim/formatters/review_formatter.test.ts
  - src/tim/formatters/review_formatter.ts
  - tim-gui/TimGUI/SessionModels.swift
  - tim-gui/TimGUITests/MessageFormatterTests.swift
  - tim-gui/TimGUITests/SessionModelTests.swift
tags: []
---

We currently send a review result message and also render the review results on the terminal. Instead, we should just send the review result message and have the console formatter format it the same way that we currently do right now. The explicit call to console.log in the review in tunneling mode should remain unchanged.

It also seems like we have a separate review result and review verdict message. These should be combined into a single message.

Also improve the formatting of the review result message in the GUI to look a bit more like the one in the terminal. Where the issues are grouped by severity. Perhaps it's best to just have the code sending the message do this, since we're it's already grouping it to display on the terminal anyway.

## Expected Behavior/Outcome

- Review results are displayed on the terminal via the console formatter processing the `review_result` structured message, rather than a separate explicit `log()` call.
- The `review_result` and `review_verdict` messages are combined into a single `review_result` structured message that includes the verdict and fix instructions.
- The console formatter produces severity-grouped issue output by calling an extracted function from the `TerminalFormatter`. This does NOT include the full header (plan/date/branch/summary table) — just the severity-grouped issues. No recommendations or action items.
- The explicit `console.log(formattedOutput)` for tunneling mode remains unchanged and continues to use the full `TerminalFormatter` output (the calling agent still needs to see the output on stdout).
- The `log(formattedOutput)` call is removed — the console formatter handles this via the structured message.
- The GUI renders review results with issues grouped by severity. No recommendations or action item counts are shown in the GUI.
- The verdict is not explicitly shown as text in the console formatter output (it's implicit from whether issues exist). It is still available in the structured message for programmatic consumers.
- No backward compatibility for the removed `review_verdict` message type — old sessions may show unknown entries for that type.

## Key Findings

### Product & User Story
As a developer using tim's review command, I want to see review results consistently formatted whether I'm viewing them locally on the terminal, through a tunnel, or in the GUI, so that I can quickly scan issues by severity and understand the verdict without looking at multiple separate messages.

### Design & UX Approach
- **Terminal**: The console formatter will call an extracted function from `TerminalFormatter` that formats just the severity-grouped issues (without the full header/summary table). The full `TerminalFormatter` output is still used for the `console.log()` in tunnel mode.
- **GUI**: Review results will be displayed with issues grouped by severity (critical, major, minor, info). No recommendations or action items displayed. No verdict text shown explicitly.
- **Tunnel mode**: The explicit `console.log()` call in review.ts for tunnel mode stays as-is, using the full `TerminalFormatter` output. The `log()` call is removed.

### Technical Plan & Risks
- **Message schema change**: Combining `review_result` and `review_verdict` requires updating the TypeScript message types, tunnel server validation, and Swift GUI payload types. This is a coordinated cross-layer change.
- **Console formatter dependency on review_formatter.ts**: The console formatter will import a new extracted function from `review_formatter.ts`. This creates a dependency from `logging/` to `tim/formatters/`, which is consistent with existing imports from `tim/` in the console formatter.
- **Risk: Breaking existing tunnel consumers**: Any consumer that currently expects separate `review_result` and `review_verdict` messages will need updating. This is limited to the GUI (Swift) and the tunnel server validation.
- **Risk: Timing change**: Currently the verdict is sent after the review result. Combining them means the verdict must be determined before sending the message. This is already the case in the code flow, so no behavioral change.

### Pragmatic Effort Estimate
This is a medium-sized change touching TypeScript message types, console formatter, review command, codex executor modes, tunnel server validation, and Swift GUI code. Roughly 10-12 source files modified plus 8-10 test files across two codebases (TS + Swift).

## Acceptance Criteria

- [ ] `review_result` structured message includes verdict and fixInstructions fields
- [ ] `review_verdict` message type is removed from the codebase (TypeScript types, tunnel validation, Swift GUI)
- [ ] Issue formatting extracted from `TerminalFormatter` into a standalone function
- [ ] Console formatter produces severity-grouped, colored terminal output for `review_result` messages using the extracted function
- [ ] The explicit `log(formattedOutput)` call in review.ts is removed (replaced by console formatter handling)
- [ ] The explicit `console.log(formattedOutput)` for tunnel mode remains unchanged, using full `TerminalFormatter` output
- [ ] GUI renders review results with issues grouped by severity (no recommendations/action items/verdict text)
- [ ] Tunnel server validation updated for the combined message format
- [ ] All existing review-related tests updated and passing
- [ ] New test coverage for the extracted issue formatting function and console formatter review rendering

## Dependencies & Constraints

- **Dependencies**: The TerminalFormatter in `src/tim/formatters/review_formatter.ts` provides the grouping/formatting logic to extract and reuse.
- **Technical Constraints**: The `logging/` module already imports from `tim/` (e.g., `formatExecutionSummaryToLines`, `formatTodoLikeLines`), so importing from `tim/formatters/` is acceptable.
- **Cross-codebase coordination**: Changes span both the TypeScript codebase and the Swift GUI codebase.

## Implementation Notes

### Recommended Approach
1. Add verdict/fixInstructions fields to `ReviewResultMessage`, remove `ReviewVerdictMessage`
2. Extract the issue-formatting portion (severity-grouped issues, recommendations, action items) from `TerminalFormatter` into a standalone exported function in `review_formatter.ts`
3. Update the console formatter to call the extracted function instead of returning ''
4. Update review.ts to send a single combined message and remove the explicit `log()` call (keep `console.log` for tunnel mode with full `TerminalFormatter` output)
5. Update tunnel server validation
6. Update Swift GUI to parse combined message and render issues grouped by severity (no recommendations/action items, no verdict text)

### Potential Gotchas
- The order of operations in review.ts: currently `sendStructured(review_result)` happens before the verdict is determined via `detectIssuesInReview()`. The combined message needs the verdict, so `detectIssuesInReview()` must be called first.
- The extracted function needs to accept a simple issues array (not the full `ReviewResult`) and produce colored terminal output. It should reuse the existing `groupIssuesBySeverity()`, `getSeverityIcon()`, and `getSeverityColor()` helpers from `TerminalFormatter`.
- The `ReviewResultMessage.issues` uses `ReviewOutput['issues']` which has slightly different types than `ReviewIssue` (no `id` field, `line` is string not number). The extracted function needs to accept the message's issue format.

## Research

### Current Architecture

#### Message Types (`src/logging/structured_messages.ts`)
Two separate review message types exist:
- `ReviewResultMessage` (type: `review_result`): Contains `issues` (array from `ReviewOutput['issues']`), `recommendations` (string[]), `actionItems` (string[])
- `ReviewVerdictMessage` (type: `review_verdict`): Contains `verdict` (`'ACCEPTABLE' | 'NEEDS_FIXES' | 'UNKNOWN'`), `fixInstructions?` (string)

Both are part of the `StructuredMessage` discriminated union (line 277) and the `structuredMessageTypeList` (lines 309-340).

#### Console Formatter (`src/logging/console_formatter.ts`)
Lines 216-223: Both `review_result` and `review_verdict` intentionally return empty strings:
```typescript
case 'review_result':
case 'review_verdict':
  // Intentionally silent on console because `tim review` already renders
  // detailed human-facing output through explicit `log()` call...
  return '';
```

#### Review Command Flow (`src/tim/commands/review.ts`, lines 690-742)
The current flow is:
1. Create `FormatterOptions` and format the review result using `TerminalFormatter` (line 704-708)
2. Send `review_result` structured message with issues/recommendations/actionItems (lines 710-723)
3. If tunnel active: `console.log(formattedOutput)` then `Bun.sleep(500)` (lines 725-731)
4. `log(formattedOutput)` — this is what displays the review on the terminal (line 733)
5. Determine verdict via `detectIssuesInReview()` (line 736)
6. Send `review_verdict` structured message (lines 737-742)

Key observation: The verdict is determined *after* the review_result message is sent. For the combined message, this order must be rearranged.

#### Terminal Formatter (`src/tim/formatters/review_formatter.ts`)
The `TerminalFormatter` class (line 437) produces rich output with:
- Header: Plan ID, title, date, base branch (lines 450-454)
- Summary: Total issues, files reviewed (lines 457-459)
- Severity summary table using the `table` npm package (lines 464-492)
- Issues grouped by severity with icons (🔴🟡🟠ℹ️) and colors (lines 496-530)
- Recommendations with bullet points (lines 534-539)
- Action items with bullet points (lines 543-549)

The formatter requires a full `ReviewResult` object:
```typescript
interface ReviewResult {
  planId: string;
  planTitle: string;
  reviewTimestamp: string;
  baseBranch: string;
  changedFiles: string[];
  summary: ReviewSummary;
  issues: ReviewIssue[];
  rawOutput: string;
  recommendations: string[];
  actionItems: string[];
}
```

Helper functions:
- `groupIssuesBySeverity()`: Groups issues into `Record<ReviewSeverity, ReviewIssue[]>`
- `getSeverityIcon()`: Returns emoji for each severity level
- `getSeverityColor()`: Returns chalk color function for each severity

#### Tunnel Server Validation (`src/logging/tunnel_server.ts`, lines 309-317)
Validates `review_result` with `isValidReviewIssue()` checks and string array checks for recommendations/actionItems. Validates `review_verdict` with verdict string in the `reviewVerdicts` set.

#### GUI Data Models (`tim-gui/TimGUI/SessionModels.swift`)
- `ReviewIssueItem` struct (line 475): severity, category, content, file, line, suggestion (all optional strings)
- `ReviewResultPayload` struct (line 493): issues array, recommendations, actionItems, timestamp
- `StructuredMessagePayload` enum cases (lines 363-365): `.reviewResult(ReviewResultPayload)`, `.reviewVerdict(verdict, fixInstructions, timestamp)`

#### GUI Rendering (`tim-gui/TimGUI/SessionModels.swift`, lines 1224-1256)
`reviewResult`: Renders as flat list with "Issues: N" header, then each issue as `- [severity] content (file:line)`.
`reviewVerdict`: Renders as "Verdict: ACCEPTABLE/NEEDS_FIXES" with optional fix instructions.

#### GUI Tests (`tim-gui/TimGUITests/MessageFormatterTests.swift`)
Tests at lines 904-984 verify:
- `review_result` renders issue count, severity tags, content, file locations
- Empty review_result shows "Issues: 0"
- `review_verdict` ACCEPTABLE and NEEDS_FIXES formatting

#### Existing Test Files
- `src/logging/console_formatter.test.ts`: Tests that `review_result` returns empty string (line 160)
- `src/logging/structured_messages.test.ts`: Tests review message type validation
- `src/logging/tunnel_server.test.ts`: Tests review message validation
- `src/tim/formatters/review_formatter.test.ts`: Tests for TerminalFormatter, MarkdownFormatter, JsonFormatter
- `tim-gui/TimGUITests/MessageFormatterTests.swift`: Tests for GUI message formatting

### Review Output Schema (`src/tim/formatters/review_output_schema.ts`)
Defines Zod schemas for LLM executor output. Issues have: severity, category, content, file, line, suggestion. The `ReviewOutput` type has: issues[], recommendations[], actionItems[].

### Key Dependency Note
The `logging/` directory should not import from `tim/`. Currently the console formatter imports `formatExecutionSummaryToLines` from `tim/summary/format.ts` and `formatTodoLikeLines` from `tim/executors/shared/todo_format.ts`. So there is already precedent for the console formatter importing from `tim/` — the concern mentioned in the plan description may not apply.

## Implementation Guide

### Step 1: Combine ReviewResultMessage and ReviewVerdictMessage

**File: `src/logging/structured_messages.ts`**

1. Add verdict-related fields to `ReviewResultMessage`:
   - `verdict: ReviewVerdict` (required)
   - `fixInstructions?: string` (optional)

2. Remove `ReviewVerdictMessage` interface.

3. Remove `'review_verdict'` from the `StructuredMessage` union type and `structuredMessageTypeList`.

4. Keep the `ReviewVerdict` type alias since it documents the valid values.

**Rationale**: Combining into one message simplifies the protocol and ensures consumers always see verdict + issues together atomically.

### Step 2: Update Tunnel Server Validation

**File: `src/logging/tunnel_server.ts`**

1. Update the `review_result` validation case to also check `verdict` (required string in reviewVerdicts set) and `fixInstructions` (optional string).
2. Remove the `review_verdict` case entirely.

### Step 3: Extract Issue Formatting and Update Console Formatter

**File: `src/tim/formatters/review_formatter.ts`**

Extract the issue-formatting portion from `TerminalFormatter` into a standalone exported function. This function should:
- Accept an array of issues (in the `ReviewOutput['issues']` format, i.e. without `id` field)
- Group issues by severity using the existing `groupIssuesBySeverity()` logic
- Format each group with severity icons and colors using the existing helpers
- Return a formatted string with severity-grouped issues only (no recommendations, no action items)

The existing `groupIssuesBySeverity()`, `getSeverityIcon()`, and `getSeverityColor()` methods are currently private on `TerminalFormatter`. They should be extracted as standalone functions (or at least the new exported function should replicate the logic).

**File: `src/logging/console_formatter.ts`**

1. Import the new extracted function from `review_formatter.ts`.
2. Replace the empty-string return for `review_result` with a call to the extracted function, passing `message.issues`.
3. Remove the `review_verdict` case from the switch statement.

### Step 4: Update Review Command and Codex Executor

**File: `src/tim/commands/review.ts`**

1. Move `detectIssuesInReview()` call to *before* sending the structured message (currently at line 736, move to before line 710).
2. Update the `sendStructured()` call to include verdict and fixInstructions:
   ```typescript
   sendStructured({
     type: 'review_result',
     timestamp: timestamp(),
     verdict: hasIssues ? 'NEEDS_FIXES' : 'ACCEPTABLE',
     fixInstructions: hasIssues ? reviewResult.actionItems.join('\n') : undefined,
     issues: reviewResult.issues.map(...),
     recommendations: reviewResult.recommendations,
     actionItems: reviewResult.actionItems,
   });
   ```
3. Remove the second `sendStructured()` call for `review_verdict` (lines 737-742).
4. Remove the `log(formattedOutput)` call (line 733) — the console formatter will handle this now via the structured message.
5. Keep the `console.log(formattedOutput)` block for tunnel mode (lines 725-731) unchanged.

**Files: `src/tim/executors/codex_cli/normal_mode.ts` and `src/tim/executors/codex_cli/simple_mode.ts`**

These files currently only send `review_verdict` messages (not `review_result`). They need updating to send the combined `review_result` message instead. They have access to the full `ExternalReviewResult` (which contains `ReviewResult` with issues, recommendations, actionItems) from `external_review.ts`, so they can populate all the fields. Each file has multiple `sendStructured({ type: 'review_verdict', ... })` calls that need to be converted to `review_result` with the issues data included.

### Step 5: Update Swift GUI Data Models

**File: `tim-gui/TimGUI/SessionModels.swift`**

1. Add verdict/fixInstructions fields to `ReviewResultPayload`:
   ```swift
   struct ReviewResultPayload: Sendable {
       let issues: [ReviewIssueItem]
       let recommendations: [String]
       let actionItems: [String]
       let verdict: String?
       let fixInstructions: String?
       let timestamp: String?
   }
   ```

2. Remove the `.reviewVerdict` case from `StructuredMessagePayload` enum.

3. Update the JSON decoding for `"review_result"` to parse the new fields.

4. Remove the `"review_verdict"` decoding case entirely.

### Step 6: Update GUI Rendering

**File: `tim-gui/TimGUI/SessionModels.swift`** (in the `MessageFormatter.format()` function)

Update the `.reviewResult` case to group issues by severity:
1. Group issues into severity buckets (critical, major, minor, info)
2. Show a summary line with total issue count
3. For each non-empty severity group, show a section header then list issues
4. Do NOT show recommendations, action items, or verdict text

Remove the `.reviewVerdict` case entirely (no backward compatibility fallback).

Example rendered output:
```
Issues: 3

Critical:
- SQL injection vulnerability (src/db.ts:42)

Major:
- Missing error handling (src/api.ts:15)

Minor:
- Unused import (src/utils.ts:1)
```

### Step 7: Update Tests

**Files to update:**
- `src/logging/console_formatter.test.ts`: Update the test that expects `review_result` to return `''` — it should now return formatted output with severity-grouped issues. Remove the `review_verdict` assertion (line 161). The `review_result` test message will need `verdict` field added.
- `src/logging/structured_messages.test.ts`: Update any tests referencing `review_verdict` message type. Add tests for the combined message fields.
- `src/logging/tunnel_server.test.ts`: Update validation tests for the combined message format (verdict required, fixInstructions optional). Remove `review_verdict` validation tests.
- `src/tim/formatters/review_formatter.test.ts`: Add tests for the new extracted standalone issue-formatting function.
- `src/tim/executors/codex_cli.test.ts`: Update assertions that check for `review_verdict` structured message — should now check for `verdict` field on `review_result` message instead.
- `src/tim/executors/codex_cli.simple_mode.test.ts`: Same as above.
- `src/tim/commands/review.notifications.test.ts`: Update assertion checking for `review_verdict` message.
- `tim-gui/TimGUITests/MessageFormatterTests.swift`: Update review_result tests to verify severity-grouped rendering. Remove `review_verdict` tests entirely.
- `tim-gui/TimGUITests/SessionModelTests.swift`: Remove any `review_verdict` references.

**Additional source files that reference `ReviewVerdict`:**
- `src/tim/executors/codex_cli/external_review.ts`: Has its own `ReviewVerdict` type alias and `deriveReviewVerdict()` function. This is a separate type from the structured message one and does NOT need to be changed (it's used internally by the codex executor, not for structured messages).
- `src/tim/executors/codex_cli/normal_mode.ts` and `simple_mode.ts`: Use `ReviewVerdict` from `external_review.ts` — no changes needed for the type, but may reference the `review_verdict` structured message in their `sendStructured()` calls which would need updating.

### Manual Testing Steps
1. Run `tim review` on a plan with known issues — verify terminal output matches the current format
2. Run `tim review` in tunnel mode — verify the parent process sees the review output both via `console.log` (stdout) and via the structured message
3. Open the GUI, trigger a review, verify issues are grouped by severity with the verdict shown
4. Run `tim review` on a clean plan (no issues) — verify ACCEPTABLE verdict renders correctly

### Rationale for This Approach
- **Extracted function from TerminalFormatter**: Reuses existing severity-grouping and formatting logic without requiring the full `ReviewResult` object. The console formatter calls this extracted function directly with the message's issues array.
- **Combined message**: Simplifies the protocol, reduces message handling complexity, ensures atomic delivery of review data.
- **Keeping console.log with full TerminalFormatter for tunnel mode**: The tunnel mode needs stdout output for the parent executor to capture, and the full header/summary table is valuable there.
- **No verdict text in console formatter**: The verdict is implicit from the presence/absence of issues. Programmatic consumers can read the verdict from the structured message data.
- **GUI shows only severity-grouped issues**: Recommendations and action items are being removed in a future change, so the GUI only renders the core issue data.

## Current Progress
### Current State
- Current iteration completed a strict review-feedback follow-up with two low-risk fixes: removed duplicate timestamp logic in Codex simple-mode executor wiring and replaced a vacuous review formatter test with real assertions.
### Completed (So Far)
- `src/tim/executors/codex_cli/simple_mode.ts`
  - Removed the local `timestamp()` helper.
  - Imported shared `timestamp` from `./agent_helpers`.
- `src/tim/formatters/review_formatter.test.ts`
  - Replaced a no-assertion `determines overall rating correctly` test with concrete `generateReviewSummary` assertions.
- `tasks/201-improve-review-results-rendering.plan.md`
  - Updated this `Current Progress` section to capture the current state and what remains.
### Remaining
- Any additional hardening around review-result scoring semantics if rating fields are introduced later.
### Next Iteration Guidance
- If review-result rating metadata is added to the formatter summary in a later change, add unit tests that assert the rating mapping alongside issue-count assertions.
### Decisions / Changes
- Kept changes minimal and local: no protocol schema changes or behavioral refactors outside the requested reviewer follow-ups.
### Lessons Learned
- Duplicate utility implementations can persist across mode-specific files; when touching a file, align it with the paired implementation (`normal_mode.ts` vs `simple_mode.ts`) before larger refactors.
- Review-feedback-identified empty tests are effectively failing tests by omission; they should either be deleted or converted to explicit assertions to avoid false coverage.
### Risks / Blockers
- None
