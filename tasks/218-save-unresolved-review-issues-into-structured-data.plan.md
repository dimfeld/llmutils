---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: save unresolved review issues into structured data in the plan
goal: ""
id: 218
uuid: ba4a7ded-213e-4e02-9f05-c7c702c2aab5
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-07T08:34:44.793Z
promptsGeneratedAt: 2026-03-07T08:34:44.793Z
createdAt: 2026-03-07T07:34:29.000Z
updatedAt: 2026-03-07T09:06:04.555Z
tasks:
  - title: Add reviewIssues to plan schema and JSON schema
    done: true
    description: "Add a new optional `reviewIssues` field to the `phaseSchema` in
      `src/tim/planSchema.ts`. Use `objectFactory` for the inner object to match
      existing patterns. The field is an array of objects with: id (string),
      severity (enum), category (enum), content (string), file (string,
      optional), line (number|string, optional), suggestion (string, optional).
      Also add the corresponding property to `schema/tim-plan-schema.json`.
      Update `writePlanFile()` in `src/tim/plans.ts` to strip empty
      `reviewIssues` arrays for clean YAML output (follow the pattern used for
      `dependencies`, `issue`, etc.)."
  - title: Save issues to plan immediately after review detection
    done: true
    description: "In `handleReviewCommand()` in `src/tim/commands/review.ts`, after
      `detectIssuesInReview()` confirms issues exist and before the action
      prompt: re-read the plan file, set `planData.reviewIssues` to
      `reviewResult.issues`, and write back with `writePlanFile()`. This ensures
      issues survive crashes or Ctrl+C. When `--save-issues` is provided in
      non-interactive mode (--print or tunnel), also save issues to the plan
      file."
  - title: Clear reviewIssues after user takes action
    done: true
    description: Add a helper function `clearSavedReviewIssues(planFilePath)` that
      re-reads the plan, deletes `reviewIssues`, and writes it back. Call this
      after the user successfully takes any action (fix, append, or cleanup) in
      both the normal review flow and the `--issues` flow. When the user selects
      "exit", do nothing — the issues remain from the save-before-prompt step.
  - title: Add --issues and --save-issues CLI options
    done: true
    description: "In `src/tim/tim.ts`, add two new options to the review command:
      `--issues` (act on previously saved unresolved review issues instead of
      running a new review) and `--save-issues` (save review issues to the plan
      file in non-interactive mode)."
  - title: Implement --issues flag handler in review command
    done: true
    description: "In `src/tim/commands/review.ts`, add an early branch in
      `executeReviewFlow` when `options.issues` is set. Resolve the plan file,
      read it, check for `planData.reviewIssues`. If no saved issues, log a
      message and return. If issues exist: display a compact severity summary,
      then if `--print` mode output as JSON and return, otherwise show the
      action prompt (promptSelect with fix/cleanup/append/exit). Extract the
      action handling code (fix/append/cleanup switch-case block) into a shared
      function that both the normal flow and the --issues flow can call. After
      action, call clearSavedReviewIssues()."
  - title: Write tests for review issue persistence
    done: true
    description: "In `src/tim/commands/review.test.ts`, add tests: (1) reviewIssues
      round-trips through readPlanFile/writePlanFile, (2) issues saved to plan
      immediately when review finds issues, (3) issues cleared after user
      selects append/fix/cleanup, (4) issues remain when user selects exit, (5)
      --issues reads saved issues and presents action prompt, (6) --issues with
      no saved issues logs message and exits, (7) --save-issues in
      non-interactive mode persists issues, (8) new review replaces previously
      saved issues."
branch: 218-save-unresolved-review-issues-into-structured-data-2
changedFiles:
  - schema/tim-plan-schema.json
  - src/tim/commands/list.ts
  - src/tim/commands/review.test.ts
  - src/tim/commands/review.ts
  - src/tim/commands/show.ts
  - src/tim/db/plan.ts
  - src/tim/db/plan_sync.ts
  - src/tim/planSchema.ts
  - src/tim/plans.test.ts
  - src/tim/plans.ts
  - src/tim/tim.ts
tags: []
---

When we "exit" from the final review without addressing any issues, save the unresolved issues as structured data in the plan. Update the `review` command
with a new option that can just look at the existing unresolved issues for the plan and go straight to the select prompt
that asks what to do about it.

## Research

### Overview

The `tim review` command runs an LLM-based code review against a plan's requirements. When issues are found, the user is presented with a select prompt offering these actions:
- **Append issues to plan as tasks**
- **Fix now with Claude/Codex** (autofix)
- **Create a cleanup plan**
- **Exit (do nothing)**

When the user selects "Exit", all review issues are lost. The only persistence is through the review history file saved to `.rmfilter/reviews/`, which is a formatted output file — not structured data readily usable for re-prompting.

### Key Files and Code Flow

#### Review Command (`src/tim/commands/review.ts`)

The main review flow is in `handleReviewCommand()`. The critical section is around lines 786-862:

1. After the LLM review executes and issues are parsed, `detectIssuesInReview()` determines if issues exist (line 720).
2. If issues exist and we're in interactive mode without explicit flags, the user is prompted with `promptSelect()` (lines 797-809).
3. The action choices are: `fix-claude`, `fix-codex`, `cleanup`, `append`, or `exit`.
4. When `exit` is selected, the code falls through without saving anything — the `ReviewIssue[]` data is simply discarded.

#### ReviewIssue Type (`src/tim/formatters/review_formatter.ts:18-26`)

```typescript
export interface ReviewIssue {
  id: string;
  severity: ReviewSeverity;  // 'critical' | 'major' | 'minor' | 'info'
  category: ReviewCategory;  // 'security' | 'performance' | 'bug' | 'style' | 'compliance' | 'testing' | 'other'
  content: string;
  file?: string;
  line?: number | string;
  suggestion?: string;
}
```

#### Plan Schema (`src/tim/planSchema.ts`)

The plan schema uses `z.object({...}).passthrough()`, meaning extra fields added to plan data survive parsing and are written back via `writePlanFile()`. This is critical — it means we can add a `reviewIssues` field to plan data and it will be preserved through read/write cycles even before we formally add it to the schema.

To do this properly, we should add the field to both:
1. The Zod schema in `planSchema.ts` (for TypeScript type support)
2. The JSON schema in `schema/tim-plan-schema.json` (for YAML editor validation)

#### Plan File I/O (`src/tim/plans.ts`)

- `readPlanFile()` parses plan files through the Zod schema (passthrough preserves unknown fields)
- `writePlanFile()` validates plan data, updates `updatedAt`, serializes to YAML with markdown details section
- The `PlanSchemaInput` type is used for write operations

#### Existing Issue-to-Task Conversion (`src/tim/commands/review.ts:1454-1518`)

The `createTaskFromIssue()` and `appendIssuesToPlanTasks()` functions already convert `ReviewIssue[]` to plan tasks. This is the "append" action. The same conversion could be reused when the user later decides to act on saved issues.

#### Select Issues Prompt (`src/tim/commands/review.ts:1359-1432`)

`selectIssuesToFix()` presents a checkbox prompt grouped by severity, with critical/major pre-selected. This is the prompt we want to reuse when the user invokes the new `--issues` option.

#### CLI Registration (`src/tim/tim.ts:1092-1189`)

The review command is registered with Commander.js. New options are added as `.option()` calls before the `.action()` handler.

### Architectural Considerations

1. **Schema Passthrough**: Since the schema uses `passthrough()`, we can start storing `reviewIssues` immediately. Adding it to the formal schema is optional but recommended for type safety.

2. **Data Format**: The `ReviewIssue` interface maps cleanly to YAML. Each issue has a small footprint (id, severity, category, content, optional file/line/suggestion).

3. **Clearing Issues**: When issues are addressed (via fix, append-to-tasks, or cleanup plan), the `reviewIssues` field should be cleared from the plan to avoid stale data.

4. **Non-interactive Mode**: The new `--issues` flag should work in non-interactive mode too (e.g., just list the saved issues in JSON for `--print` mode).

5. **Multiple Reviews**: If a user runs review again without addressing issues, the new review results should replace the old saved issues.

## Expected Behavior / Outcome

When `tim review` finds issues, they are immediately saved as structured data (`reviewIssues` field) in the plan file before the action prompt appears. This ensures issues survive crashes or Ctrl+C. When the user takes any action on the issues (fix, append, cleanup), the `reviewIssues` field is cleared. When the user selects "exit", the field remains populated.

A new `--issues` flag lets the user revisit saved issues without running a new review. It shows a compact summary and goes straight to the action prompt. Combined with `--print`, it outputs the saved issues as JSON.

A new `--save-issues` flag enables saving issues in non-interactive mode (e.g. `--print` or tunnel mode), allowing orchestrated reviews to persist issues for later human action.

### States

- **No `reviewIssues` field**: No unresolved issues — either never reviewed, or issues were addressed.
- **`reviewIssues` populated**: Issues exist from a review that the user hasn't acted on yet.

## Key Findings

### Product & User Story

A user runs `tim review`, sees issues, but isn't ready to act on them yet. They select "Exit". Later, they want to come back and deal with those issues without re-running the (expensive) LLM review. With `tim review --issues`, they get the same action prompt and can append tasks, autofix, or create a cleanup plan from the saved data.

### Design & UX Approach

- Issues saved immediately on detection (crash-safe)
- Issues cleared on any action (fix/append/cleanup); persist only on "exit"
- `--issues` shows a compact severity summary before the action prompt
- `--issues --print` outputs saved issues as JSON for tooling
- `--save-issues` enables persistence in non-interactive mode

### Technical Plan & Risks

- Plan schema already uses `passthrough()`, so the new field works immediately even before formal schema updates
- The `ReviewIssue` type from `review_formatter.ts` maps directly to YAML
- Main risk: plan file could be modified between saving issues and revisiting with `--issues` (e.g., tasks added manually). This is acceptable since the issues are informational, not authoritative.

### Pragmatic Effort Estimate

Small-to-medium feature. The schema change and save logic are straightforward. The `--issues` flag reuses existing prompts and action handling code with a new early-return branch.

## Acceptance Criteria

- [ ] When review finds issues, they are saved to the plan file as `reviewIssues` immediately (before action prompt)
- [ ] When user selects fix/append/cleanup, `reviewIssues` is cleared from the plan
- [ ] When user selects "exit", `reviewIssues` remains in the plan
- [ ] `tim review --issues` reads saved issues and shows the action prompt
- [ ] `tim review --issues` with no saved issues displays a message and exits
- [ ] `tim review --issues --print` outputs saved issues as JSON
- [ ] `--save-issues` enables issue persistence in non-interactive mode
- [ ] New review replaces any previously saved issues
- [ ] `reviewIssues` field round-trips through `readPlanFile`/`writePlanFile`
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

- **Dependencies**: Relies on existing `ReviewIssue` type, `selectIssuesToFix()`, action handling code, `readPlanFile()`/`writePlanFile()`
- **Technical Constraints**: Plan schema uses `passthrough()` so extra fields survive, but we should formally add the field for type safety

## Implementation Notes

### Recommended Approach

The implementation is structured as: schema change → save logic → CLI option → `--issues` handler → tests.

### Potential Gotchas

- `writePlanFile()` calls `phaseSchema.safeParse()` for validation. The `passthrough()` setting means extra fields survive, but adding `reviewIssues` to the schema formally avoids any future issues if the schema validation is tightened.
- The save-before-prompt approach means every review with issues writes to the plan file. This is acceptable since reviews already write incremental metadata.
- When `--issues` is used with autofix, the diff context from the original review is not available. The autofix prompt should be built from the saved issue data only (file, line, content, suggestion).

## Implementation Guide

### Step 1: Add `reviewIssues` to the Plan Schema and JSON Schema

**Files**: `src/tim/planSchema.ts`, `schema/tim-plan-schema.json`

Add a new optional field `reviewIssues` to the `phaseSchema` object in `planSchema.ts`:

```typescript
reviewIssues: z.array(objectFactory({
  id: z.string(),
  severity: z.enum(['critical', 'major', 'minor', 'info']),
  category: z.enum(['security', 'performance', 'bug', 'style', 'compliance', 'testing', 'other']),
  content: z.string(),
  file: z.string().optional(),
  line: z.union([z.number(), z.string()]).optional(),
  suggestion: z.string().optional(),
})).optional(),
```

Use `objectFactory` (not `z.object`) for the inner object to match the existing pattern in the schema. This mirrors the `ReviewIssue` interface from `review_formatter.ts`. We define it inline rather than importing to avoid circular dependencies between the plan schema module and the review formatter module.

Also add the corresponding property to `schema/tim-plan-schema.json` so YAML editors provide validation and auto-complete.

Also update `writePlanFile()` in `src/tim/plans.ts` to strip empty `reviewIssues` arrays (similar to how empty `dependencies`, `issue`, etc. arrays are stripped for clean YAML output).

### Step 2: Save Issues Immediately After Review Detection

**File**: `src/tim/commands/review.ts`

In `handleReviewCommand()`, after `detectIssuesInReview()` confirms issues exist (around line 720) and before the action prompt:

1. Re-read the plan file to get the latest state.
2. Set `planData.reviewIssues` to the current `reviewResult.issues`.
3. Write the plan file back with `writePlanFile()`.
4. This ensures issues are persisted even if the process is interrupted before the user answers the prompt.

### Step 3: Clear Issues on Action, Preserve on Exit

**File**: `src/tim/commands/review.ts`

After the user takes an action (fix, append, or cleanup) and the action succeeds:

1. Re-read the plan file (it may have been modified by the action itself, e.g., append adds tasks).
2. Delete `planData.reviewIssues` (or set to undefined).
3. Write the plan file back.
4. When the user selects "exit", do nothing — the issues remain from step 2.

Add a helper function `clearSavedReviewIssues(planFilePath)` that encapsulates steps 1-3 for reuse.

### Step 4: Add `--issues` and `--save-issues` CLI Options

**File**: `src/tim/tim.ts`

Add new options to the review command:
```
.option('--issues', 'Act on previously saved unresolved review issues instead of running a new review.')
.option('--save-issues', 'Save review issues to the plan file in non-interactive mode (e.g. with --print).')
```

### Step 5: Handle `--issues` Flag in Review Command

**File**: `src/tim/commands/review.ts`

Add an early branch at the beginning of `executeReviewFlow`, before the LLM review execution:

1. If `options.issues` is set:
   a. Resolve the plan file (reuse existing plan resolution logic).
   b. Read the plan file and check if `planData.reviewIssues` exists and has entries.
   c. If no saved issues, log "No saved review issues found for this plan." and return.
   d. Display a compact summary of saved issues (count by severity).
   e. If `--print` mode: output the saved issues as JSON to stdout and return.
   f. Otherwise, show the action prompt (`promptSelect` with fix/cleanup/append/exit choices).
   g. Handle the selected action the same way as the normal flow, using the saved issues as `reviewResult.issues`.
   h. If the user takes an action (not exit), call `clearSavedReviewIssues()`.

The action handling code for fix/append/cleanup should be extracted into a shared function that both the normal review flow and the `--issues` flow can call. Currently this logic is inline in `executeReviewFlow` — refactoring it into a helper avoids duplicating the switch-case block.

### Step 6: Handle `--save-issues` in Non-Interactive Mode

**File**: `src/tim/commands/review.ts`

In the existing review flow, after issues are detected and formatted:

1. If `--save-issues` is set (and we're in non-interactive mode like `--print` or tunnel), save the issues to the plan file using the same logic as step 2.
2. The normal `--print` output (JSON to stdout) still happens — `--save-issues` just adds the plan file persistence.

### Step 7: Write Tests

**File**: `src/tim/commands/review.test.ts`

Add tests for:
1. `reviewIssues` field round-trips through `readPlanFile`/`writePlanFile` correctly
2. Issues are saved to plan file immediately when review finds issues (before action prompt)
3. Issues are cleared from plan after user selects append/fix/cleanup
4. Issues remain in plan when user selects "exit"
5. `--issues` flag reads saved issues and presents the action prompt
6. `--issues` with no saved issues logs appropriate message and exits
7. `--save-issues` in non-interactive mode saves issues to plan file
8. New review replaces previously saved issues

### Manual Testing Steps

1. Run `tim review` on a plan with known issues
2. Ctrl+C before answering the prompt — verify `reviewIssues` is in the plan file
3. Run `tim review --issues` — verify saved issues are displayed with summary and action prompt appears
4. Select "Append issues to plan as tasks" — verify tasks are appended and `reviewIssues` is cleared
5. Run `tim review --issues` again — should show "no saved issues" message
6. Run `tim review` again, select "Exit" — verify `reviewIssues` remains in plan
7. Run `tim review --issues --print` — verify JSON output of saved issues

### Rationale

- **Storing in plan file vs. separate file**: The plan file is the natural home for this data. It travels with the plan, is version-controlled, and is already structured YAML. A separate file would add complexity and risk desynchronization.
- **Reusing `ReviewIssue` format**: Using the same structure avoids conversion overhead and ensures the select/action prompts work identically whether issues come from a fresh review or saved data.
- **Save-before-prompt**: Saving immediately after detection ensures crash safety. The cost of an extra plan file write is negligible since reviews already write incremental metadata.
- **Clear on action**: Prevents confusion from stale issues. If the user wants to see issues after fixing some, they can run a new review.

## Current Progress
### Current State
- All 6 tasks completed and passing tests/type checking.
### Completed (So Far)
- Task 1: Added `reviewIssues` to Zod schema (`planSchema.ts`), JSON schema (`tim-plan-schema.json`), and empty-array stripping in `writePlanFile()`.
- Task 2: `saveReviewIssuesToPlan()` helper saves issues before action prompt; `--save-issues` saves in non-interactive mode.
- Task 3: `clearSavedReviewIssues()` helper clears after fix/append/cleanup; issues persist on exit.
- Task 4: `--issues` and `--save-issues` CLI options added to `tim.ts`.
- Task 5: `--issues` handler with early branch in `executeReviewFlow`, shared `handleReviewIssueActions()` function.
- Task 6: Tests for round-trip, save/clear helpers, schema validation, empty array stripping.
- Review fix: `createReviewResultFromSavedIssues` now builds `ReviewResult` directly instead of routing through `parseJsonReviewOutput` (which would crash on numeric `line` values and missing optional fields).
- Review fix: Restored try/catch around `appendIssuesToPlanTasks` in `handleReviewIssueActions`.
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- `saveReviewIssuesToPlan` and `clearSavedReviewIssues` were exported to enable direct testing.
- `createReviewResultFromSavedIssues` bypasses `createReviewResult`/`parseJsonReviewOutput` to avoid schema mismatch (saved issues use `z.union([z.number(), z.string()])` for `line`, but `ReviewIssueOutputSchema` requires `z.string()`).
### Lessons Learned
- When constructing objects from saved/persisted data, avoid re-validating through schemas designed for raw LLM output — the validation rules may be stricter or incompatible with round-tripped types (e.g., YAML converting string `"42"` to number `42`).
### Risks / Blockers
- None
