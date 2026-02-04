---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: improved intra-task progress tracking
goal: ""
id: 152
uuid: ed37390d-a63a-4b0c-a7b8-c656e276f62d
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2025-12-31T07:51:51.951Z
promptsGeneratedAt: 2025-12-31T07:51:51.951Z
createdAt: 2025-12-29T01:29:59.680Z
updatedAt: 2026-01-02T00:41:00.484Z
tasks:
  - title: Remove progressNotes data model and CLI surfaces
    done: true
    description: Update plan schema and persistence to eliminate progressNotes.
      Remove the add-progress-note command and all CLI surfaces that display
      progress notes. Strip legacy progressNotes on write to prevent
      re-serialization. Update or delete related tests (plan schema tests,
      add-progress-note tests, show/list progress notes tests). Ensure no
      remaining references in code.
  - title: Replace progress notes guidance with structured progress section template
      in prompts
    done: true
    description: Remove progress notes sections from prompt builder and add
      structured `## Progress` guidance (detailed, no timestamps,
      update-in-place, placed at end of file) in Claude orchestrator prompts and
      agent prompts. Update Codex single-shot prompt with the same structured
      template and update-in-place rules. Adjust prompt tests accordingly.
  - title: Update discovery guidance, compaction config, docs, and schemas
    done: true
    description: Expand planning guidance to create new plans for discovered issues
      (`tim add ... --discovered-from <planId>`). Remove progress-notes
      compaction support and config, update README and tim usage skill docs
      to reflect the new progress section model, and regenerate JSON schemas.
      Update tests impacted by compaction/docs changes.
changedFiles:
  - README.md
  - claude-plugin/skills/tim-usage/SKILL.md
  - claude-plugin/skills/tim-usage/references/cli-commands.md
  - schema/tim-config-schema.json
  - schema/tim-plan-schema.json
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/compact.test.ts
  - src/tim/commands/compact.ts
  - src/tim/commands/list.test.ts
  - src/tim/commands/list.ts
  - src/tim/commands/merge.test.ts
  - src/tim/commands/merge.ts
  - src/tim/commands/show.test.ts
  - src/tim/commands/show.ts
  - src/tim/commands/split.test.ts
  - src/tim/commands/workspace.ts
  - src/tim/configSchema.ts
  - src/tim/display_utils.test.ts
  - src/tim/display_utils.ts
  - src/tim/executors/claude_code/agent_prompts.test.ts
  - src/tim/executors/claude_code/agent_prompts.ts
  - src/tim/executors/claude_code/orchestrator_integration.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.test.ts
  - src/tim/executors/claude_code/orchestrator_prompt.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/codex_cli/prompt.test.ts
  - src/tim/executors/codex_cli/prompt.ts
  - src/tim/planSchema.test.ts
  - src/tim/planSchema.ts
  - src/tim/plan_display.test.ts
  - src/tim/plans.test.ts
  - src/tim/plans.ts
  - src/tim/prompt.test.ts
  - src/tim/prompt.ts
  - src/tim/prompt_builder.test.ts
  - src/tim/prompt_builder.ts
  - src/tim/ready_plans.test.ts
  - src/tim/tim.ts
  - src/tim/workspace/workspace_manager.test.ts
  - src/tim/workspace/workspace_manager.ts
tags: []
---

- add more instructions in the skill and prompt around adding new issues for things it found 
- Tell orchestrator that when finished it should update the plan file progress section with notes about what it did, adding or updating existing text to match the current state of the plan. 
- Do similar in codex, but just for each prompt.
- Note that these messages don't have to be abut the testing or review, it just has to explain what progress has been
made on the task, and how and why.
- Remove the dedicated progressNotes section from the plan data model, and remove the CLI command and references to it in prompts

## Implementation Guide

### Overview / Opportunity
The current progress tracking relies on a dedicated `progressNotes` array in plan YAML frontmatter and a CLI command (`tim add-progress-note`). This creates a parallel progress channel that is detached from the plan's main narrative in `details`, complicates prompt/context assembly, and adds extra schema/CLI/test surface area. The goal is to shift progress tracking into a human-readable "progress section" inside the plan file itself, instruct orchestrators and Codex prompts to update that section with meaningful progress notes, and remove the legacy `progressNotes` data model and CLI command entirely.

### Expected Behavior/Outcome
- Progress tracking lives in the plan file's Markdown body under a clearly named section (recommended: `## Progress`), not in YAML frontmatter.
- Orchestrator guidance (Claude Code) instructs updating this progress section at the end of a successful iteration with a concise summary of what was done, why, and the current state. It should insert the section if missing and update existing content if present.
- Codex prompts include similar progress-update instructions, but repeated per prompt/step rather than only at the end of orchestration.
- The dedicated `progressNotes` field is removed from the plan schema and no longer appears in prompts, CLI output, or documentation.
- The `tim add-progress-note` command and its tests/docs are removed; progress updates are done by editing the plan file directly.
- The system still supports plan status states (`pending`, `in_progress`, `done`, `cancelled`, `deferred`); progress tracking is purely narrative and does not change status automatically.

### Relevant States (explicit definitions)
- Plan lifecycle status (unchanged):
  - `pending`: Not started.
  - `in_progress`: Active work.
  - `done`: Completed.
  - `cancelled` / `deferred`: Closed without completion.
- Progress section state in `details`:
  - Missing: Must be created on first update.
  - Present: Must be updated in-place to reflect current reality.
  - Stale: Must be edited to remove outdated statements while still capturing the full history of meaningful progress.

### Key Findings
**Product & User Story**
- tim already captures implementation history via `# Implementation Notes` (appended by `tim add-implementation-note`), but progress notes live in a separate YAML array. This split makes "what happened recently" hard to discover in the main plan narrative.
- Orchestrators and Codex agents are already instructed to add progress notes; shifting to a `## Progress` section keeps those updates visible in the plan file itself without special tooling.
- There is already a pattern for inline plan updates in the orchestrator prompts (task completion, implementation notes). Extending this to progress updates aligns with existing workflow.

**Design & UX Approach**
- Place the `## Progress` section at the end of the plan file (outside generated delimiters), so it is visible in `tim show` and when reading the plan directly.
- Keep progress updates factual and tied to the current plan state (what changed, why, next status). Be as detailed as necessary so the next iteration can understand context without re-discovery.
- Use a structured template in the progress section (see Implementation Notes) to keep updates consistent and scannable. Do not add timestamps anywhere in the section.
- Treat the progress section as a living summary: include earlier meaningful progress but rewrite/remove outdated statements so the section stays accurate.
- Avoid tying progress updates to "testing/review" only; progress should describe actual work done and rationale, per requirements.

**Technical Plan & Risks**
- Removing `progressNotes` touches schema, CLI commands, plan display, prompt composition, compaction, tests, and docs.
- Risk: plan files that already have `progressNotes` will still parse because the schema is `passthrough`, but the field becomes "unknown". We should explicitly strip it during writes to avoid perpetuating legacy data.
- Risk: compaction prompts and config currently refer to progress notes; removing or rewording must not break compaction flows.
- Risk: prompt tests expect progress notes guidance; these must be updated to check for progress-section guidance instead.
- Risk: progress section semantics must avoid append-only logs; guidance must explicitly allow editing earlier text while preserving meaningful history.

**Pragmatic Effort Estimate**
- Medium effort: multi-file refactor with doc/test updates. Expect a few hours of focused changes plus test fixes and schema regeneration.

### Dependencies & Constraints
- **Dependencies**: `src/tim/planSchema.ts` (data model), `scripts/update-json-schemas.ts` (schema regeneration), executor prompts (`src/tim/executors/claude_code/*`, `src/tim/executors/codex_cli/*`), and CLI docs/skills.
- **Technical Constraints**:
  - Plan schema uses `.passthrough()`, so legacy fields may persist unless explicitly removed.
  - `mergeDetails`/`updateDetailsWithinDelimiters` manage generated sections; progress updates should live outside generated delimiters to avoid being overwritten.
  - Configuration schema changes should avoid defaults in Zod if new config values are introduced (per project guidance).

### Subagent Reports (parallel analysis recap)
**Report: Plan schema & file I/O**
- `src/tim/planSchema.ts` defines `progressNotes` in `phaseSchema`. Removing it will require updating `PlanSchema` tests.
- `src/tim/plans.ts` removes empty arrays for `progressNotes` during write; update to stop mentioning it and optionally strip legacy field.
- `schema/tim-plan-schema.json` is generated from Zod via `scripts/update-json-schemas.ts`.

**Report: CLI commands & display**
- `src/tim/tim.ts` wires `tim add-progress-note`; this needs removal.
- `src/tim/commands/show.ts` and `src/tim/commands/list.ts` show progress notes; these must be removed or replaced with progress-section-aware output if desired.
- `src/tim/commands/merge.ts`, `split.test.ts`, `compact.ts` all touch progress notes; update or remove.

**Report: Prompt and executor flows**
- `src/tim/executors/claude_code/orchestrator_prompt.ts` injects `progressNotesGuidance` (add-progress-note) into orchestration. Replace with progress-section update guidance.
- `src/tim/executors/claude_code/agent_prompts.ts` includes `progressNotesGuidance` in implementer/tester/reviewer/verifier prompts.
- Codex CLI uses the same agent prompts in `simple_mode.ts`/`normal_mode.ts`, plus a separate `codex_cli/prompt.ts` for single-shot runs. Both need progress-section update guidance.
- `src/tim/prompt_builder.ts` injects a `## Progress Notes` section into execution prompts; remove.

**Report: Documentation & skills**
- `claude-plugin/skills/tim-usage/SKILL.md` and `claude-plugin/skills/tim-usage/references/cli-commands.md` mention progress notes and `tim add-progress-note`.
- `README.md` includes progress notes in plan structure, show output, and compaction description.

### Implementation Notes
**Recommended Approach**
1. Remove `progressNotes` from the plan schema (`src/tim/planSchema.ts`) and update any type usage. Explicitly strip legacy fields on write (in `writePlanFile`).
2. Remove the `tim add-progress-note` command wiring (`src/tim/tim.ts`) and delete `src/tim/commands/add-progress-note.ts` plus related tests (`add-progress-note*.test.ts`, `progress_notes*.test.ts`).
3. Remove progress-notes display from CLI outputs:
   - `src/tim/commands/show.ts`: remove latest notes summary and the full "Progress Notes" section.
   - `src/tim/commands/list.ts`: drop Notes column and related logic.
4. Remove prompt-time progress notes context:
   - `src/tim/prompt_builder.ts`: remove `buildProgressNotesSection` and its truncation helpers.
   - `src/tim/truncation.ts`: remove constants only used for progress notes or repurpose if still needed.
5. Replace progress notes guidance with progress-section guidance:
   - `src/tim/executors/claude_code/orchestrator_prompt.ts`: add a new guidance block telling orchestrator to update the plan file's `## Progress` section at the end of a successful loop (and when tasks are marked done).
   - `src/tim/executors/claude_code/agent_prompts.ts`: add a short instruction that each agent should include a progress update in its final response and update the plan file if it is directly responsible for edits.
   - `src/tim/executors/codex_cli/prompt.ts`: add per-prompt instructions to update `## Progress` after each implement/test/review cycle.
6. Add/expand guidance about creating new issues/plans:
   - `src/tim/prompt.ts`: extend the "Blocking Subissues" section or add a new "Discovered Issues" section describing when to create new plans for newly discovered work. Use `tim add ... --discovered-from <planId>` as the standard.
   - `claude-plugin/skills/tim-usage/SKILL.md` and `references/cli-commands.md`: include explicit instructions and examples for adding new issues when discovered during research/implementation.
7. Update compaction configuration/docs:
   - Remove `progressNotes` compaction toggles and guidance in `src/tim/commands/compact.ts`.
   - Remove `progressNotes` config in `src/tim/configSchema.ts` and regenerate `schema/tim-config-schema.json`.
8. Update docs and schema artifacts:
   - `README.md` references to progress notes and `tim add-progress-note`.
   - Regenerate JSON schemas using `scripts/update-json-schemas.ts`.
9. Adjust tests to reflect the new guidance and removed features.

**Potential Gotchas**
- Existing plan files with `progressNotes` may linger; explicitly delete the field in `writePlanFile` to prevent re-serialization.
- `mergeDetails` inserts generated content using delimiters; progress updates should be outside delimiters to avoid being overwritten by plan regeneration.
- Codex CLI uses Claude-style agent prompts; update those prompts carefully to avoid duplicating instructions or conflicting with Codex single-shot prompt.
- Removing `progressNotes` will break tests in multiple suites; update or delete them in a consistent pass to avoid partial failures.
- The progress template must be detailed enough to support the next iteration without re-discovery, while still avoiding stale statements that no longer reflect reality.

**Structured Progress Template (recommended)**
- `## Progress`
  - `### Current State`
    - Detailed bullets describing the plan’s current reality (what is implemented, what is pending, and why).
  - `### Completed (So Far)`
    - Detailed bullet list of meaningful, durable milestones (avoid transient testing/review steps).
  - `### Remaining`
    - Detailed bullet list of next concrete items, aligned with plan tasks.
  - `### Next Iteration Guidance`
    - Actionable bullets for the next agent run (what to do first, pitfalls, and where to look).
  - `### Decisions / Changes`
    - Detailed bullet list of scope changes, pivots, or notable discoveries with rationale.
  - `### Risks / Blockers`
    - Detailed bullet list of current blockers or risks (use “None” if empty).
  - **Formatting rule**: No timestamps in any section (the progress section is a living summary, not a log).

**Conflicting, Unclear, or Impossible Requirements**
- None detected, but the exact format of the new `## Progress` section should be standardized to avoid inconsistent updates.

### Notable Files and What They Do
- `src/tim/planSchema.ts`: plan data model; remove `progressNotes` and update tests.
- `src/tim/plans.ts`: read/write logic; currently removes empty `progressNotes` arrays on write.
- `src/tim/tim.ts`: CLI wiring for `tim add-progress-note`.
- `src/tim/commands/add-progress-note.ts`: progress note creation (remove).
- `src/tim/commands/show.ts`: displays progress notes summary and full list.
- `src/tim/commands/list.ts`: conditionally adds a "Notes" column.
- `src/tim/prompt_builder.ts`: injects `## Progress Notes` into prompts; remove.
- `src/tim/executors/claude_code/orchestrator_prompt.ts`: orchestrator guidance; replace progress notes with progress-section update guidance.
- `src/tim/executors/claude_code/agent_prompts.ts`: agent prompts reuse progress notes guidance.
- `src/tim/executors/codex_cli/prompt.ts`: single-shot Codex prompt; add progress-section update guidance.
- `src/tim/commands/compact.ts` + `src/tim/configSchema.ts`: compaction config mentions progress notes.
- `claude-plugin/skills/tim-usage/SKILL.md`, `claude-plugin/skills/tim-usage/references/cli-commands.md`, `README.md`: document progress notes and should be updated.
- `scripts/update-json-schemas.ts`: regenerates JSON schemas after Zod changes.

### Step-by-Step Implementation Guide
1. **Schema cleanup**
   - Remove `progressNotes` from `phaseSchema` in `src/tim/planSchema.ts`.
   - Update or remove `planSchema` tests that validate progress notes.
   - Explicitly strip legacy `progressNotes` in `writePlanFile` to avoid reserializing old data.
2. **CLI removal**
   - Delete `add-progress-note` command wiring from `src/tim/tim.ts`.
   - Remove `src/tim/commands/add-progress-note.ts` and its tests.
3. **CLI output adjustments**
   - Remove progress notes output from `src/tim/commands/show.ts` and tests.
   - Remove Notes column logic from `src/tim/commands/list.ts` and tests.
4. **Prompt updates**
   - Replace `progressNotesGuidance` with new "progress section update" guidance in `orchestrator_prompt.ts` that explicitly calls for updating the section in-place (edit outdated text, preserve meaningful prior progress).
   - Update `agent_prompts.ts` to include a brief, consistent instruction about updating `## Progress` as a living summary.
   - Update Codex CLI prompt (`codex_cli/prompt.ts`) to instruct progress-section updates for each prompt cycle, emphasizing "update-in-place" rather than append-only logs.
   - Embed the structured progress template in prompt guidance so agents have a consistent format to update.
5. **New issue discovery guidance**
   - Update `src/tim/prompt.ts` (research + generation prompts) to explicitly call out when to create new plans for discovered issues.
   - Update skill docs (`claude-plugin/skills/tim-usage/SKILL.md` and references) with a short, concrete example.
6. **Compaction + config cleanup**
   - Remove progress-notes compaction toggles from `src/tim/commands/compact.ts` and config schema.
   - Regenerate `schema/tim-config-schema.json` and `schema/tim-plan-schema.json`.
7. **Docs & README updates**
   - Remove progress-notes references and add new progress-section guidance.
8. **Testing**
   - Update test suites and add new expectations for progress-section guidance in prompts.
   - Run `bun test`, `bun run check`, `bun run lint`, `bun run format`.

### Automated Test Coverage (targets to update/add)
- Remove/adjust:
  - `src/tim/progress_notes.integration.test.ts`
  - `src/tim/progress_notes.edge_cases.test.ts`
  - `src/tim/commands/add-progress-note*.test.ts`
  - `src/tim/commands/list.progress_notes.test.ts`
  - `src/tim/planSchema.test.ts` progress notes cases
  - `src/tim/prompt_builder.test.ts` progress notes section tests
  - `src/tim/executors/claude_code/orchestrator_prompt.test.ts` progress notes assertions
  - `src/tim/commands/show.test.ts` progress notes assertions
  - `src/tim/commands/merge.test.ts`, `split.test.ts`, `compact.test.ts` progress notes cases
- Add/adjust:
  - Prompt tests to assert new progress-section update guidance for orchestrator and Codex prompts.
  - CLI show/list tests to ensure no Notes column or progress-notes output.

### Manual Testing Steps (for human verification)
- Run `tim show <planId>` and confirm no progress-notes section is displayed.
- Run `tim list` and confirm there is no Notes column.
- Run `tim agent <planId> --executor claude-code` and verify the prompt includes progress-section update guidance.
- Run `tim agent <planId> --executor codex-cli` and confirm Codex prompt includes progress-section update guidance.

<!-- tim-generated-start -->
Expected Behavior/Outcome
- Progress tracking lives in a structured `## Progress` section at the end of the plan file (outside generated delimiters).
- Orchestrator (Claude Code) and Codex prompts instruct updating `## Progress` in place: insert if missing, preserve meaningful history while removing outdated statements, and **no timestamps anywhere**.
- `progressNotes` is removed from the plan schema, CLI, prompts, and docs. The `tim add-progress-note` command is removed.
- Legacy `progressNotes` are stripped in `writePlanFile` to prevent re-serialization.
- Plan status states remain unchanged.

Relevant States
- Plan status: `pending` / `in_progress` / `done` / `cancelled` / `deferred`.
- Progress section: Missing → created on first update. Present → updated in place. Stale → edited to remove outdated info while preserving meaningful history.

Key Findings
- Product & User Story: Progress notes in YAML are detached from the plan narrative; a structured `## Progress` section keeps context visible for future runs.
- Design & UX Approach: Place `## Progress` at the end of the file; use a structured, detailed template; update in place; no timestamps.
- Technical Plan & Risks: Removal touches schema/CLI/prompts/docs/tests; must strip legacy `progressNotes` on write; prompt tests will need updates.
- Pragmatic Effort Estimate: Medium.

Dependencies & Constraints
- Dependencies: `planSchema.ts`, `plans.ts`, `prompt_builder.ts`, `orchestrator_prompt.ts`, `agent_prompts.ts`, `codex_cli/prompt.ts`, CLI commands, docs, schema generator.
- Constraints: Progress section must live outside generated delimiters; no manual verification tasks.

Implementation Notes
- Place `## Progress` at the end of the plan file (outside generated delimiters).
- Use a structured template with detailed content; no timestamps.

Structured Progress Template (no timestamps)
- `## Progress`
  - `### Current State`
    - Detailed bullets: what is implemented, what is pending, and why.
  - `### Completed (So Far)`
    - Detailed bullets for durable milestones (avoid transient testing/review steps).
  - `### Remaining`
    - Detailed bullets aligned with plan tasks.
  - `### Next Iteration Guidance`
    - Actionable bullets for next run (first steps, pitfalls, key files).
  - `### Decisions / Changes`
    - Detailed bullets on scope changes or discoveries with rationale.
  - `### Risks / Blockers`
    - Detailed bullets; use “None” if empty.

Potential Gotchas
- Strip legacy `progressNotes` in `writePlanFile` to prevent re-serialization.
- Ensure progress section stays outside generated delimiters.
- Avoid duplicate/conflicting guidance across orchestrator + agent + Codex prompts.

Acceptance Criteria
- Functional: `progressNotes` and `tim add-progress-note` are removed; progress tracking uses only `## Progress`.
- UX: Prompts instruct detailed, structured, timestamp-free updates at the end of the plan file.
- Technical: `progressNotes` stripped on write; schemas updated; no remaining references.
- Tests: All updated tests pass.
<!-- tim-generated-end -->

Implemented review fixes for intra-task progress tracking and plan generation prompts. Tasks worked on: remove subagent progress-update instructions, prevent merge from duplicating progress sections, and keep discovered-issue guidance YAML-friendly. Updated src/tim/executors/claude_code/agent_prompts.ts to replace progressSectionGuidance with a Progress Reporting block that tells implementer/tester/reviewer/verifier to report status to the orchestrator and not edit plan files directly. Updated src/tim/commands/merge.ts to strip child ## Progress sections before appending child details so merged plans keep a single progress section, and added coverage in src/tim/commands/merge.test.ts asserting the child progress content is removed and only one Progress header remains. Adjusted discovered-issue and blocking-subissue prompt wording in src/tim/prompt.ts so summaries are placed inside the plan Details section instead of before output, preserving YAML extraction; updated src/tim/prompt.test.ts expectations accordingly. Updated agent prompt tests in src/tim/executors/claude_code/agent_prompts.test.ts to validate the new reporting guidance. Design choice: strip progress sections only from children during merge so the parent progress summary remains the single source of truth while avoiding duplicate sections. Integration points: merge command details concatenation, claude_code subagent prompt composition, and plan prompt generation for discovered issues. No deviations from the requested fixes beyond aligning blocking-subissue guidance with the same Details-section placement for consistency.

Worked on tasks: Replace progress notes guidance with structured progress section template in prompts; Update discovery guidance, compaction config, docs, and schemas. Added progress guidance mode handling in src/tim/executors/claude_code/agent_prompts.ts, wiring to progressSectionGuidance for Codex executions and keeping report-only guidance for Claude orchestrator subagents; updated Codex normal/simple mode runners in src/tim/executors/codex_cli/normal_mode.ts and src/tim/executors/codex_cli/simple_mode.ts plus agent definition wiring in src/tim/executors/claude_code.ts to pass explicit progress guidance options. Updated src/tim/commands/merge.ts to extract the parent plan's Progress section, strip progress from children, and re-append the parent section at the end after merged details so merged plans keep a single progress section in the required location; covered by updated assertions in src/tim/commands/merge.test.ts. Added discovered-issue guidance to Claude Code planning prompts in src/tim/prompt.ts and expanded tests in src/tim/commands/generate.test.ts to assert the new section and command examples. Design decisions: reuse the orchestrator progress-section template to keep a single canonical format for Codex prompts, and only reposition the parent progress section during merge so it stays the sole source of truth. Integration points include codex agent prompt composition, Claude Code agent definition setup, plan merge details concatenation, and planning prompt generation. No deviations from the plan requirements; changes focus on restoring missing progress/discovered-issue guidance and maintaining progress section placement.

Implemented Codex fix-loop progress updates and Codex-friendly plan path guidance. Added an optional useAtPrefix flag to progressSectionGuidance in src/tim/executors/claude_code/orchestrator_prompt.ts and threaded it through ProgressGuidanceOptions in src/tim/executors/claude_code/agent_prompts.ts so Codex prompts can emit plain filesystem paths while Claude keeps the @ reference style. Updated Codex normal and simple mode calls in src/tim/executors/codex_cli/normal_mode.ts and src/tim/executors/codex_cli/simple_mode.ts to pass useAtPrefix false for update-mode progress guidance. Added progress update guidance to fixer and fix-review prompts in src/tim/executors/codex_cli/context_composition.ts and passed the planFilePath into composeFixReviewContext so each fix iteration updates the plan progress section. Tests updated in src/tim/executors/claude_code/agent_prompts.test.ts and src/tim/executors/codex_cli.fixer_prompt.test.ts to cover the no-@ path and fixer progress guidance. This addresses the tasks for keeping progress updated during fix loops and ensuring Codex prompts reference real paths.

Implemented review fixes for merge progress handling in the tim merge command (task: fix merge progress section handling to avoid data loss and overbroad matching). Updated src/tim/commands/merge.ts to replace the regex-based progress stripping with a line-based parser that finds exact '## Progress' headings outside fenced code blocks, keeps subheadings (### etc.) within the section, and avoids touching '## Progress Tracking' or code-fenced headings. Added helpers getHeadingLevel, findProgressSectionRanges, extractProgressSections, and buildMergedProgressSection to capture progress sections safely. The merge flow now extracts the parent progress section (if present) and, when the parent lacks one, synthesizes a merged progress section from child progress sections labeled with each child plan's title/goal/ID so progress data is preserved instead of dropped. Integration points: handleMergeCommand now uses extractProgressSections for both parent and children, accumulates child progress sections, and appends either the parent progress section or a merged fallback at the end of the combined details.

Updated tests in src/tim/commands/merge.test.ts to cover the new behavior: added a case ensuring child progress is preserved when the parent has no progress section, and a case ensuring non-matching headings ('## Progress Tracking') and code-fenced '## Progress' content remain intact after merge. Existing test for stripping child progress when the parent has one continues to assert only one Progress section remains and appears after child details. Design decision: keep the parent progress as the single source of truth when it exists, but use a merged child progress section to avoid silent data loss when no parent progress exists. No deviations from the plan requirements; this change strictly addresses review issues 1 and 2 while preserving existing merge semantics.

Addressed reviewer issues for merge progress handling and progress detection. Tasks worked on: merge child progress into parent progress sections without data loss, and prevent indented code blocks from being treated as headings. Updated src/tim/commands/merge.ts to tighten progress heading detection to only match headings starting at column 0-3 spaces, and to use non-trimmed heading level detection so indented code blocks (4 spaces or tabs) are ignored. Reworked buildMergedProgressSection to accept the parent ProgressSection and, when child progress exists, synthesize a single ## Progress block that keeps the parent content first and appends labeled child sections (### From <child>), instead of dropping child progress when the parent already had a progress section. Updated src/tim/commands/merge.test.ts: replaced the parent plus child test to assert child progress is preserved and labeled, and added a regression test to keep indented code blocks containing ## Progress. Design decision: keep one Progress section at the end while preserving both parent and child content to avoid data loss.
