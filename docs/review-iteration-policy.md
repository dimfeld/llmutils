# Review Iteration Policy

How the orchestrator prompts drive the review → fix → re-review loop, and how
reviewer prompts assign severity. This is prompt policy: the rules live in the
generated prompt text, not in runtime code.

Sources:

- `src/tim/review_severity.ts` — the single source of truth for severity levels,
  their definitions, and their blocking semantics.
- `src/tim/executors/shared/orchestrator_prompt.ts` —
  `buildReviewIterationGuidance()` and `buildFinalBatchReviewGuidance()`.
- `src/tim/executors/shared/review_guidance.ts` — the review command builders and
  `structuralPassApplies()`, the one predicate that gates every structural-pass
  fragment of the prompt.
- `src/tim/commands/review.ts` (`buildReviewPrompt`) and
  `src/tim/executors/claude_code/agent_prompts.ts` (`getReviewerPrompt`) — the
  reviewer-side rubric and duplication guidance.

## Severity rubric

`src/tim/review_severity.ts` renders one rubric that is embedded in the reviewer
prompts, in the orchestrator's severity gate, and in the `severity` field
description of the structured review output schema
(`src/tim/formatters/review_output_schema.ts`). Change the definitions there and
every consumer follows.

| Severity   | Meaning                                                                                                    | Default      |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------ |
| `critical` | The change is broken or dangerous as-is: data loss, security vulnerability, crash, silently wrong results. | blocking     |
| `major`    | A real correctness, regression, or missing-coverage problem; a reviewer would block a merge on it.         | blocking     |
| `minor`    | A genuine improvement that does not block: naming, small refactors, non-mainline polish, better messages.  | non-blocking |
| `info`     | Observations, style, wording, and anything pre-existing.                                                   | non-blocking |

Calibration rules that ship with the rubric: do not inflate style or preference
findings to `major`, and do not downgrade correctness problems to `minor`
because the fix is small. Fix effort is not part of severity; only impact is.
Pre-existing issues are always `info`, so they are automatically non-blocking.

## Severity decision

For findings from ordinary reviews inside the iteration loop, severity is a default signal, not a fixed gate. The orchestrator decides whether a finding blocks completion from its actual impact, evidence, scope, and plan context. Normally critical and major findings block, and minor and info findings do not; the orchestrator can override either default when it gives a concrete reason.

- Findings that the orchestrator decides are **blocking** are fixed in-loop.
- Findings that the orchestrator decides are **non-blocking** are recorded with
  the `non-blocking` state and a concrete reason, or captured immediately as follow-up tasks through the bounded handoff.
  They never by themselves trigger an implementer round or a review rerun. A
  rejection is recorded on the plan — see the rejected-findings ledger below.
- Legacy free-text reviewer output uses `CRITICAL`/`MAJOR` as a default blocking
  signal and `MINOR` as a default non-blocking signal.
- When the orchestrator reviews a batch itself instead of running the reviewer
  command, it assigns its own findings one of the same four severities first.

The gate covers ordinary reviews only. When `structuralReviewAt` is unset,
findings from the standalone `--structural-only` pass follow that pass's own
instructions, and findings from the single post-structural validation review go
through the bounded handoff rather than reopening the loop. When the marker is
set, the batch prompt omits both of those stages; the ordinary review loop stays
bounded by the no-new-blocking-findings rule.

## Rejected-findings ledger

A reviewer subprocess has no memory of earlier rounds, so a finding that the
orchestrator (or a person) rejects comes back on the next review unless the
rejection is recorded. `planData.reviewIssues` is that record. This part is
runtime code, not only prompt text.

Sources: `src/tim/commands/review.ts` (`rejectReviewIssue`,
`persistReviewIssueDisposition`, `applyReviewIssueSave`, `clearSavedReviewIssues`,
`reviewIssueKey`, `buildReviewPrompt`), `src/tim/utils/review_issue_filters.ts`
(`partitionReviewIssues`), and the `review-issues` wiring in `src/tim/tim.ts`.

### Schema

Review-issue objects take a `state` disposition field with `rejected` and
`non-blocking` values, plus `rejectedReason` (string) and `rejectedAt` (ISO
timestamp). The older `rejected` boolean remains supported for existing plan
files and means `state: rejected`. These fields are declared in
`src/tim/planSchema.ts` and mirrored in `SyncReviewIssueValueSchema`
(`src/tim/sync/types.ts`), so dispositions sync between nodes like any other
review issue. The change is additive and needs no DB migration: `review_issues`
is a JSON TEXT column, and older nodes drop the unknown keys instead of failing.

`reviewIssueKey()` builds an issue's identity from `category`, `content`,
`file`, and `line` only. Disposition fields are not identity, so changing a
finding's disposition does not change which issue it is.

### Lifecycle

- `applyReviewIssueSave()` never overwrites the disposition ledger. Existing
  dispositioned entries stay, and a new finding whose key matches one is
  dropped. It has two modes, selected by the disposition
  `persistReviewIssueDisposition()` is given: a `save` disposition replaces the
  open queue with this review's findings, while an `append` disposition merges
  its non-blocking remainder into the existing queue. Replace is right for a
  review's complete issue set; merge is right for a partial subset, which would
  otherwise delete open issues it never looked at.
- `clearSavedReviewIssues()` — used by the clean-review path — removes only the
  open entries and keeps dispositioned ones. `{ all: true }` clears everything.
  It returns the number of entries removed so callers report a no-op honestly.
- `resolveSavedReviewIssues()` is unchanged. Fixed findings are verified by the
  diff-scoped rerun, so they need no ledger memory.
- Key matching is best-effort, because finding `content` is LLM free text and
  varies between runs. The dependable suppression mechanism is the prompt
  section below, not the key merge.

### Recording a disposition

```bash
tim review-issues reject <planId> --from-review <output.json> --issue <n> --reason "..."
tim review-issues reject <planId> --from-review <output.json> --issue <n> --state non-blocking --reason "..."
tim review-issues reject <planId> --content "..." --file <path> --line <n> --reason "..."
tim review-issues clear <planId> [--all]
```

`--from-review` reads the finding from the structured output the reviewer wrote
with `--output-file`, addressed by 1-based `--issue` index. Because every field
then comes from that file, combining `--from-review` with `--file`, `--line`,
`--severity`, `--category`, or `--suggestion` is an error rather than a silent
drop. The `--content` form supplies the finding explicitly and is the path for
findings the orchestrator raised itself. `--reason` is always required. The
command upserts through the routed plan write, so a second disposition of the
same finding refreshes the reason and timestamp instead of adding a duplicate.

`tim review-issues list` marks rejected and non-blocking entries with their reason and timestamp.
`tim review --issues` acts on open issues only; when a plan has nothing but
dispositioned entries it says so and points at `review-issues list`.

### How later reviews see it

`buildReviewPrompt()` emits a `# Previously Dispositioned Findings` section from
the plan's rejected and non-blocking entries. It includes each finding, its
reason, and an instruction not to re-raise it without new evidence. The section
is omitted when no dispositioned entries exist.

The orchestrator prompt therefore no longer tells the orchestrator to re-type
dispositioned findings into `--input-file`. Every review phase instructs it to run
`tim review-issues reject ... --from-review <output.json> --issue <n>` right
after each rejection. The orchestrator-owned batch review produces no reviewer
output file, so that phase points at the explicit `--content/--file/--line`
form instead. If multiple findings in the same review describe the same
underlying issue, the orchestrator records only one disposition and does not
add a separate rejected issue for the duplicate. This is most common when
different reviewer subagents report the same issue. For a valid non-blocking
finding, it adds the `--state non-blocking` option. `--input-file` remains
available as a fallback.

## Structural-review marker

A fresh orchestrator process gets fresh prompt text every iteration, so a "run
the structural pass only once" rule that lives in prompt text alone cannot hold
across iterations. `structuralReviewAt` is the durable record: a nullable ISO
timestamp on the plan that says the standalone `--structural-only` pass already
ran for this plan at its completed state.

It is a synced plan scalar (`structural_review_at` on `plan` and
`plan_canonical`, migration v50), not a workspace-local file, because plans are
often rerun in a different workspace and a local marker would be lost.

The marker is consumed at the start of each fresh batch iteration.
`src/tim/commands/agent/batch_mode.ts` passes
`planData.structuralReviewAt != null` through `ExecutePlanInfo` to both
executors, which expose it as `OrchestrationOptions.structuralReviewCompleted`.
When set, `buildFinalBatchReviewGuidance()` in
`src/tim/executors/shared/orchestrator_prompt.ts` omits the standalone structural
pass and post-structural validation review, and the completion branch in
`src/tim/commands/agent/batch_mode.ts` skips the simplify pass. The completion
review still runs in either marker state; `blockingIssuesOnlyAppendTasks` in
`src/tim/commands/review.ts` allows only `critical` and `major` findings to
append tasks, while saving `minor` and `info` findings as review issues for
human triage. That gate applies to the interactive "append as plan tasks"
action only: the non-interactive path reaches no action branch, so it appends
nothing and saves every finding through `--save-issues`, and the `autofix`,
`cleanup`, and `exit` actions are unaffected. When the marker is unset, the
full final sequence and simplify pass run.

Saved non-blocking findings are transient. They land in the same `reviewIssues`
list that `handleReviewCommand` clears whenever a later review comes back clean
(keeping only the `rejected` ledger). So a minor/info finding saved for triage
survives until the next clean review of the plan, not indefinitely. Triage them
with `tim review-issues list <planId>` before the next run, or reject them so
they move into the ledger, which the clear preserves.

All structural-pass prompt text is gated by one predicate,
`structuralPassApplies()` in `src/tim/executors/shared/review_guidance.ts`:
`batchMode === true && structuralReviewCompleted !== true`. Batch mode is part
of the condition because a non-batch orchestrator is never instructed to run the
standalone pass — `buildFinalBatchReviewGuidance()` returns an empty string
outside batch mode, and `structuralReviewCompleted` is only ever set from
`batch_mode.ts`. So the structural carve-out described above, the
post-structural validation paragraph, the extra-review allowance, and the TDD
wrapper's structural clause all appear in batch-mode prompts only. Before this,
non-batch prompts qualified a pass that would never run.

### Lifecycle

- **Set** by `handleReviewCommand` in `src/tim/commands/review.ts` when a
  `--structural-only` review completes successfully, through a routed plan write
  so it syncs. A failed, aborted, or `--dry-run` structural review does not set
  it. The review command writes it; the orchestrator is not trusted to.
- **Cleared** when a substantive task is added to the plan, through
  `clearStructuralReviewMarkerForTaskAdd()`
  (`src/tim/plans/review_follow_up_title.ts`). Both task-adding entry points call
  it — `tim add-task` (`src/tim/commands/add-task.ts`) and the MCP add-task tool
  (`src/tim/tools/manage_plan_task.ts`) — so the two cannot diverge. A plan whose
  marker is already unset is left untouched, queueing no redundant write.
- **Preserved** when the added task is review follow-up work rather than new
  scope, on either of two signals: the explicit `--review-follow-up` flag
  (CLI) / `reviewFollowUp` parameter (MCP tool), which is the primary signal; or
  a title starting with a known follow-up prefix, which is the fallback.
  `isReviewFollowUpTaskTitle()` owns the prefix list —
  `Address Review Feedback:` and `Address review:` — and lives next to the
  constants the title builders in `review.ts` use, so the prefixes cannot drift
  from the code that generates them.
- The `append` disposition never clears the marker. Review-generated follow-up
  tasks are cleanup, not new scope.

Both failure directions are cheap: a substantive task that happens to carry a
follow-up title keeps the marker and skips one final structural pass; a
forgotten flag on real follow-up work clears the marker and merely re-runs one.

## Review scope tiers

Ordinary reviews follow a three-tier scope rule instead of always re-reviewing
the full declared scope:

1. **First review of a task batch** — full declared scope: the same
   `--task-index` scope that was worked on, no `--since`.
2. **Intermediate fix-verification reviews** — diff-scoped. Immediately _before_
   applying fixes, the orchestrator records the current commit
   (`git rev-parse HEAD`, or `jj log --no-graph -r @- -T commit_id` in a
   Jujutsu workspace). After the fixes it reruns the review with
   `--since <that commit>` plus the same `--task-index` scope, and enumerates the
   findings being re-checked in `--input`.
3. **Closing review** — full declared scope again, no `--since`, whenever the
   loop is about to stop (no new blocking findings, or the four-review bound).

The closing full-scope review is the last review inside the four-review budget,
not an extra one. If a review that turns out to be terminal was already full
scope, it _is_ the closing review. The effect is full-scope fresh eyes at both
bookends of the loop, with the cheaper diff-scoped reviews in between.

The final full-plan sequence in batch mode uses the same three tiers under its
own four-review budget, counted independently of the orchestrator-owned
per-batch reviews. Review #1 is full-plan, reruns 2..n are diff-scoped
fix-verification reviews, and the last review before stopping is full-plan
again.

`--since` cannot be combined with `--structural-only`, so the structural pass
always runs at full scope.

## Review-fix subagent scope

When delegating a review fix, the orchestrator passes repeatable or
comma-separated `--task-index` values to the implementer, tester, or `tdd-tests`
subagent for exactly the tasks that own the findings. The indexes are
plan-absolute and 1-based, numbered over every plan task including completed
ones — the same numbering the reviewer's `--task-index` uses. The findings being
fixed are passed through `--input` or `--input-file`, and the subagent must not
touch code outside those findings.

The subagent flag differs from the reviewer's in one way: it accepts only tasks
that are still incomplete, and fails on an index that names a completed task.
That check catches an orchestrator pointing a fix round at settled work. When a
finding genuinely belongs to a task that is already done — which happens in the
final full-plan sequence, after earlier iterations have completed their tasks —
the orchestrator omits `--task-index` and states the scope of the fix in
`--input` instead.

Only fix rounds are scoped. The first implementation, TDD-test, and testing run
of a batch passes no `--task-index`.

### Where the index resolution lives

`src/tim/plans/task_scope.ts` is the one place that turns a raw `--task-index`
option into tasks. Both the review command and the subagent commands call it, so
the numbering stays identical between them. Do not add a second parser.

- `normalizeTaskFilterInput()` splits the repeatable / comma-separated Commander
  value into tokens.
- `resolveTaskIndexes()` is the entry point. It returns the selected incomplete
  tasks and the selected completed tasks in separate buckets, plus the remaining
  tasks, all with plan-absolute 1-based indexes. The token parser is
  module-private, so no caller can parse indexes without also applying these
  rules.
- `resolveSubagentTaskScope()` adds the subagent policy on top: completed
  selections become an error listing the valid incomplete indexes.

Keeping the completed-task decision in the callers is deliberate. The review
command accepts completed tasks (you often review finished work); the subagent
command rejects them (a fix round must not reopen settled work).

## Termination

The loop stops when either:

1. targeted checks pass and a complete ordinary review produces **no new
   blocking findings** — a review whose only unhandled findings are non-blocking
   is terminal; or
2. the fourth ordinary review has completed and the bounded handoff procedure
   has been completed.

New blocking findings extend the loop up to the four-review bound, which
preserves the discovery value of repeated passes without letting cosmetic
findings reopen finished work.

## Repeated defects and the consolidation proposal

The reviewer reports a repeated defect class as **one** finding: it states the
shared root cause and lists every location in the issue `content` with the
wording "this pattern appears at: <file:line list>", while `file`/`line` point at
the primary instance. The output schema is unchanged.

The orchestrator acts on this at the **first** review that reports the same
defect class at multiple locations — it does not wait for a second occurrence
across rounds. It pauses instance-by-instance patching, identifies the failed
invariant or duplicated responsibility itself, and writes a concrete
**consolidation proposal** that goes to the implementer as one instruction.

Naming: "consolidation proposal" is the cascade root-cause output; "structural
pass" refers only to the standalone `--structural-only` reviewer invocation. The
two are unrelated, and the batch guidance says so explicitly.

## Review command spelling

When `experimental.agentMessaging` is `true`, the orchestrator prompt renders
`tim review` for ordinary, full-plan, and structural review commands. When the
flag is absent or `false`, prompts use the equivalent `tim subagent reviewer`
alias. Both commands share the same handler, options, and review policy.

The review policy itself — severity rubric, severity gate, scope tiers,
fix-verification scoping, closing full-scope review, four-review bound,
structural-review marker, rejected-findings ledger, and bounded handoff — is
unchanged regardless of the flag value.

## Related

- `docs/codex-cli-integration.md` — the shared orchestration prompt and its modes.
- `docs/batch-tasks-feature.md` — batch execution and the final full-plan sequence.
- `docs/reviewer-instructions.md` — repository-specific review pointers.
- `docs/agent-messaging.md` — the collaborative orchestration feature and advisory-reviewer versus formal-review distinction.
