---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Old plan compaction
goal: Implement a command to compact completed plans for archival purposes,
  reducing verbose research and details while preserving critical decisions and
  outcomes
id: 144
uuid: fa3280d0-1624-4c73-9471-590f641765f5
generatedBy: agent
status: in_progress
priority: low
container: false
temp: false
dependencies: []
references: {}
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-10-29T22:44:18.265Z
promptsGeneratedAt: 2025-10-29T22:44:18.265Z
createdAt: 2025-10-27T19:26:47.021Z
updatedAt: 2025-10-30T00:40:52.226Z
progressNotes:
  - timestamp: 2025-10-29T23:37:35.209Z
    text: Implemented initial compact command scaffold with executor integration and
      CLI registration.
    source: "implementer: Task 1-3"
  - timestamp: 2025-10-29T23:43:23.633Z
    text: Added comprehensive compact command tests, configuration schema, and
      README docs; ran bun run check, bun run format, and full bun test.
    source: "implementer: Task 8-10"
  - timestamp: 2025-10-29T23:47:38.207Z
    text: Added new compact command tests covering fenced YAML output parsing,
      recent plan warning behavior, and missing details validation; bun test
      src/rmplan/commands/compact.test.ts now passes with 7 cases.
    source: "tester: Task 8"
  - timestamp: 2025-10-30T00:05:34.088Z
    text: Updated generateCompactionPrompt to spell out preservation vs compression
      rules, added anti-hallucination guidance, and embedded a sample YAML
      output so executors have a concrete target.
    source: "implementer: Task 4"
  - timestamp: 2025-10-30T00:07:04.511Z
    text: Reworked validateCompaction to return structured results, enforce required
      field invariants, and detect serialization/control-character issues; added
      targeted unit coverage for task mutations and unreadable output.
    source: "implementer: Task 5"
  - timestamp: 2025-10-30T00:09:25.340Z
    text: Added tests covering prompt instructions, validation success, and metadata
      invariants for compact command.
    source: "tester: Tasks 4-5"
  - timestamp: 2025-10-30T00:20:00.738Z
    text: Reviewed existing compact command implementation; dry-run preview
      currently only shown on --dry-run and no file backup is created before
      writes. Will add shared preview reporting and backup handling next.
    source: "implementer: Task 6-7"
  - timestamp: 2025-10-30T00:26:00.984Z
    text: Implemented shared compaction preview output for both dry-run and apply
      flows, added backup-aware write helper with restore handling, and updated
      the CLI to log backup locations after successful writes.
    source: "implementer: Task 6-7"
  - timestamp: 2025-10-30T00:26:31.055Z
    text: Ran bun run format, bun run check, and bun test after updating the compact
      command; all checks passed with new backup helper and preview coverage.
    source: "tester: Task 6-7"
  - timestamp: 2025-10-30T00:28:36.869Z
    text: Ran bun test src/rmplan/commands/compact.test.ts; all 16 tests passed in
      347ms.
    source: "tester: Tasks 6-7"
  - timestamp: 2025-10-30T00:29:36.076Z
    text: Added coverage for missing progress note summary and confirmation abort
      path; bun test src/rmplan/commands/compact.test.ts now passes 18 cases.
    source: "tester: Tasks 6-7"
tasks:
  - title: Create compact command handler
    done: true
    description: >-
      Create `src/rmplan/commands/compact.ts` with `handleCompactCommand()`
      function. Follow the pattern from extract.ts:

      - Accept plan identifier (ID or path) as argument

      - Parse options: --executor (default: claude-code), --dry-run, --model

      - Load config with `loadEffectiveConfig()`

      - Resolve plan file with `resolvePlanFile()`

      - Validate plan is eligible for compaction (status is
      done/cancelled/deferred)

      - Check plan age and warn if too recent (< 30 days)

      - Delegate to compaction logic function
  - title: Register compact command in CLI
    done: true
    description: |-
      Add command registration in `src/rmplan/rmplan.ts`:
      - Add `.command('compact [plan]')` with description
      - Add options: --executor, --dry-run, --model
      - Wire up dynamic import and error handling
      - Follow the pattern of existing commands
  - title: Implement compaction logic function
    done: true
    description: >-
      Create `compactPlan()` function in compact.ts that:

      - Reads the plan file with `readPlanFile()`

      - Extracts sections to compact (details within delimiters, research
      section, progress notes)

      - Builds compaction prompt with clear instructions to preserve: goal,
      outcome, key decisions, acceptance criteria, task results

      - Calls executor with prompt and plan content

      - Parses LLM response to extract compacted sections

      - Uses `mergeDetails()` to update details within delimiters

      - Updates research section with compacted version

      - Condenses progress notes array to summary

      - Adds archival metadata to frontmatter (compactedAt timestamp,
      originalSize)

      - Returns compacted plan object
  - title: Create compaction prompt template
    done: true
    description: >-
      Create `generateCompactionPrompt()` function that builds a detailed prompt
      for the LLM:

      - Explain the archival purpose (preserve key info, remove verbose
      research)

      - Specify what to preserve: original goal, final outcome, key technical
      decisions, acceptance criteria results, implementation approach summary

      - Specify what to compress: verbose research notes, detailed exploration
      logs, redundant explanations

      - Provide output format instructions (structured sections)

      - Include example of good compaction

      - Emphasize factual accuracy (no hallucination)
  - title: Implement validation step
    done: true
    description: >-
      Create `validateCompaction()` function that verifies:

      - Compacted plan still parses as valid YAML (use
      `phaseSchema.safeParse()`)

      - Required fields are preserved (id, uuid, title, goal, status, tasks)

      - Critical metadata intact (dependencies, parent, references)

      - Task list unchanged (compaction shouldn't modify tasks)

      - Plan still readable as plain text

      - Return validation result with any issues found
  - title: Add dry-run mode
    done: true
    description: |-
      Implement --dry-run flag behavior:
      - Execute compaction logic but don't write to file
      - Display before/after comparison (file sizes, section lengths)
      - Show compacted content preview
      - Display what would be changed
      - Ask for confirmation in interactive mode before proceeding
      - Use logging functions to output comparison
  - title: Implement file writing with backup
    done: true
    description: >-
      Add safe file write operation:

      - If not dry-run, validate compacted plan

      - Add compaction metadata to frontmatter (compactedAt, compactedBy:
      executor name)

      - Add progress note documenting compaction

      - Write compacted plan with `writePlanFile()`

      - Log success message with size reduction stats

      - Handle write errors gracefully
  - title: Add tests for compact command
    done: true
    description: >-
      Create `src/rmplan/commands/compact.test.ts` with tests for:

      - Basic compaction of a done plan with verbose research

      - Preservation of frontmatter metadata (id, uuid, dependencies, parent)

      - Preservation of task list

      - Delimiter handling (content within generated delimiters)

      - Research section compaction

      - Progress notes condensing

      - Validation that ineligible plans are rejected (pending/in_progress
      status)

      - Dry-run mode doesn't write files

      - Invalid YAML handling

      - Use real filesystem with temp directories per testing conventions
  - title: Add configuration schema for compaction
    done: true
    description: |-
      Update `src/rmplan/configSchema.ts` to add optional compaction config:
      - Default executor for compaction (claude-code)
      - Default model for compaction (faster/cheaper model)
      - Minimum age threshold in days (default: 30)
      - Sections to compact (details, research, progressNotes)
      - Add to RmplanConfig type
      - Update effective config loading if needed
  - title: Update documentation
    done: true
    description: |-
      Update README.md with compact command documentation:
      - Add command description and usage examples
      - Document all options (--executor, --dry-run, --model)
      - Explain archival use case
      - Show before/after example
      - Document what's preserved vs. compacted
      - Add to command reference section
  - title: Add MCP prompt for compaction
    done: false
    description: >-
      Create MCP prompt in `src/rmplan/mcp/prompts/` directory to enable
      compaction from within Claude Code:

      - Create `compact_plan.ts` with prompt registration

      - Accept planId as argument

      - Load plan and validate eligibility (done/cancelled/deferred status)

      - Build compaction prompt emphasizing preservation of critical info

      - Return structured prompt with plan content and clear instructions

      - Register in `src/rmplan/mcp/generate_mode.ts` prompts array

      - Follow pattern of existing prompts like generate_plan.ts

      - Include instructions for user to review compacted output before applying

      - Document in MCP section of README
    files: []
    docs: []
    steps: []
changedFiles:
  - README.md
  - src/rmplan/commands/compact.test.ts
  - src/rmplan/commands/compact.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/rmplan.ts
rmfilter: []
---

We should have a way to compact old plans so they take up less space.

The command should use the claude (or optionally codex) executors to strip the plan free text down. The idea is that someone can look at the plan now that it has been finished and see what was done and why, but they don't need all the research that originally went into the plan.

### Summary

The plan compaction feature aims to reduce the storage footprint of completed plans by using LLM-based summarization. After exploring the codebase, I found:

- **All infrastructure exists** for status tracking, filtering, and plan management
- **No existing compaction feature** - this will be built from scratch
- **Strong reference implementations** available (extract, split commands) showing LLM integration patterns
- **Key challenge**: Preserving critical information while condensing verbose research sections

The feature should target plans with status `done`, `cancelled`, or `deferred` that are older than a configurable threshold (e.g., 30+ days). The compaction process will use claude or codex executors to intelligently strip down the verbose research and details sections while preserving:
- Original goal and outcome
- Key technical decisions and rationale
- Implementation approach summary
- Acceptance criteria results

### Findings

#### Command Structure (from Explore Agent: rmplan command structure)

The rmplan CLI uses Commander.js with dynamic imports. Each command has a dedicated handler in `src/rmplan/commands/` that gets imported at runtime.

**Pattern for new commands:**
```typescript
program
  .command('compact [plan]')
  .description('Compact old plan to reduce storage')
  .option('--executor <name>', 'Executor to use (claude or codex)')
  .option('--age <days>', 'Minimum age in days (default: 30)')
  .option('--dry-run', 'Preview without writing changes')
  .action(async (plan, options, command) => {
    const { handleCompactCommand } = await import('./commands/compact.js');
    await handleCompactCommand(plan, options, command).catch(handleCommandError);
  });
```

**Key files:**
- Entry point: `src/rmplan/rmplan.ts`
- Error handling: `src/rmplan/utils/commands.ts` (handleCommandError function)
- Configuration: `src/rmplan/configLoader.ts` (loadEffectiveConfig function)

**Global options available:**
- `-c, --config <path>` - Configuration file path
- `--debug` - Enable debug logging

**Common handler patterns:**
```typescript
export async function handleCompactCommand(planFile: string, options: any, command: any) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const plan = await readPlanFile(resolvedPlanFile);
  
  // Main logic here
  
  await writePlanFile(resolvedPlanFile, plan);
  log('Plan compacted successfully');
}
```

#### Plan File Structure (from Explore Agent: plan file structure)

Plan files use YAML frontmatter with optional markdown body:

**Structure:**
```markdown
---
# yaml-language-server: $schema=...
id: 144
title: "Old plan compaction"
status: done
priority: low
tasks: [...]
progressNotes: [...]
createdAt: 2025-10-01T...
updatedAt: 2025-10-29T...
---

<!-- rmplan-generated-start -->
## Expected Behavior/Outcome

Users can run `rmplan compact <plan-id>` to condense completed plans for archival purposes. The command will:

- Accept a plan identifier (numeric ID or file path)
- Verify the plan is eligible (status: done, cancelled, or deferred)
- Use the Claude Code executor by default to intelligently summarize verbose sections
- Preserve critical information (goal, outcome, decisions, task results)
- Compress research notes and progress logs
- Write the compacted version back to the same file location
- Add archival metadata (compactedAt timestamp, size reduction stats)

The compacted plan remains fully functional within rmplan - it can still be referenced as a dependency, appears in filtered lists, and maintains all structural integrity.

**States:**
- **Before compaction**: Plan has verbose research section, detailed progress notes, extensive generated details
- **After compaction**: Plan has concise summary sections while preserving all metadata, tasks, and critical decisions
- **Dry-run mode**: Shows preview of changes without writing to disk

## Key Findings

### Product & User Story

**User Story**: As a developer maintaining a large collection of completed plans, I want to compact old plans to reduce repository size and improve readability of historical context, without losing critical decisions or outcomes.

**Use Case**: After completing a complex feature with extensive research (20+ KB of notes), compact the plan to a concise 3-5 KB summary that preserves what was decided and why, making it easier to reference in the future.

### Design & UX Approach

**Command Interface:**
```bash
# Compact a specific plan (uses claude-code executor by default)
rmplan compact 144

# Preview changes without writing
rmplan compact 144 --dry-run

# Use different executor
rmplan compact 144 --executor direct-call

# Use specific model
rmplan compact 144 --model claude-3-5-haiku-20241022
```

**Output:**
- Progress indicator during LLM processing
- Before/after size comparison
- List of sections compacted
- Confirmation message with stats

**Error Handling:**
- Reject plans with status pending/in_progress
- Warn if plan is < 30 days old (configurable threshold)
- Validate compacted output before writing
- Provide clear error messages with recovery suggestions

### Technical Plan & Risks

**Architecture:**
1. **Command handler** (`handleCompactCommand`) - CLI entry point, validation, orchestration
2. **Compaction logic** (`compactPlan`) - Core transformation logic
3. **Prompt generation** (`generateCompactionPrompt`) - LLM prompt construction
4. **Validation** (`validateCompaction`) - Output verification
5. **Executor integration** - Use Claude Code executor by default for high-quality summarization

**Key Technical Decisions:**
- Use `claude-code` executor by default for highest quality summarization
- Preserve delimiter structure for future updates
- Add archival metadata to frontmatter
- Keep compacted plans in original location (no special archive directory)
- Use existing plan merge utilities to safely update sections

**Risks:**
- **LLM over-summarization**: Mitigated by explicit prompt instructions and validation
- **YAML format breakage**: Mitigated by schema validation and `fixYaml()` utility
- **Loss of critical info**: Mitigated by dry-run mode and clear preservation guidelines in prompt
- **Delimiter corruption**: Mitigated by using existing `mergeDetails()` function

### Pragmatic Effort Estimate

**Complexity: Medium**

**Estimated effort: 4-6 hours**
- Command setup and registration: 30 min
- Core compaction logic: 2 hours
- Prompt engineering and testing: 1.5 hours
- Validation and safety checks: 1 hour
- Tests: 1.5 hours
- Documentation: 30 min

**Dependencies:**
- Existing executor system (claude-code)
- Existing plan I/O utilities (readPlanFile, writePlanFile)
- Existing merge utilities (mergeDetails)
- Existing validation (phaseSchema)

## Acceptance Criteria

- [ ] User can run `rmplan compact <plan-id>` on a done plan
- [ ] Command uses claude-code executor by default
- [ ] Command validates plan eligibility (status must be done/cancelled/deferred)
- [ ] LLM compacts details section while preserving delimiters
- [ ] Research section is condensed to key findings
- [ ] Progress notes are summarized
- [ ] All frontmatter metadata is preserved (id, uuid, dependencies, parent, tasks)
- [ ] Task list remains unchanged
- [ ] Compacted plan passes schema validation
- [ ] `--dry-run` flag shows preview without writing
- [ ] Archival metadata added (compactedAt timestamp)
- [ ] File size reduction is logged
- [ ] Command rejects plans with pending/in_progress status
- [ ] All new code paths are covered by tests
- [ ] README is updated with command documentation

## Dependencies & Constraints

**Dependencies:**
- Existing executor system (src/rmplan/executors/)
- Plan I/O utilities (src/rmplan/plans.ts)
- Plan merge utilities (src/rmplan/plan_merge.ts)
- Configuration system (src/rmplan/configLoader.ts)
- Schema validation (src/rmplan/planSchema.ts)

**Technical Constraints:**
- Must maintain YAML schema validity
- Must preserve delimiter structure for future updates
- Must not modify task list or completion status
- Must preserve dependency relationships
- Compacted plans must remain at original file path
- LLM context window must accommodate full plan content (typically < 50K tokens)

**Configuration Constraints:**
- Default minimum age: 30 days (configurable)
- Default executor: claude-code (can override with --executor)
- Must respect user's model configuration

## Implementation Notes

### Recommended Approach

**Phase 1: Core Implementation**
1. Create command handler following extract.ts pattern
2. Implement basic compaction logic with claude-code executor
3. Add validation and safety checks
4. Implement dry-run mode

**Phase 2: Quality & Testing**
5. Create comprehensive prompt template
6. Add full test coverage
7. Update configuration schema
8. Document in README

**File Structure:**
- `src/rmplan/commands/compact.ts` - Main command implementation
- `src/rmplan/commands/compact.test.ts` - Test suite
- Registration in `src/rmplan/rmplan.ts`
- Config updates in `src/rmplan/configSchema.ts`

### Potential Gotchas

1. **Delimiter preservation**: Must use `mergeDetails()` function rather than string replacement to ensure delimiters aren't lost

2. **Progress notes handling**: Array of objects needs special handling - can't just truncate, need to summarize meaningfully

3. **LLM output parsing**: May need `fixYaml()` if LLM returns malformed YAML sections

4. **Reference integrity**: The `references` map (plan ID to UUID mappings) must never be compacted as it's critical for plan renumbering

5. **Container plans**: Plans with children might need special handling - consider warning user or skipping

6. **Multiple compactions**: Should handle re-compaction gracefully (what if user runs compact twice?)

### Conflicting, Unclear, or Impossible Requirements

None identified. All requirements are achievable with existing infrastructure.
<!-- rmplan-generated-end -->

## Research
[Manual research notes]
```

**Critical functions for compaction:**
- `readPlanFile(path)` - Read and parse plan file (src/rmplan/plans.ts:525-605)
- `writePlanFile(path, plan, options)` - Write plan with validation (src/rmplan/plans.ts:614-661)
- `mergeDetails(newDetails, originalDetails)` - Smart merge preserving manual sections (src/rmplan/plan_merge.ts)
- `updateDetailsWithinDelimiters(newDetails, originalDetails, append)` - Update only generated content

**Key sections to compact:**
- Details (between `<!-- rmplan-generated-start/end -->` delimiters)
- Research section (after `## Research` heading)
- Progress notes (in frontmatter `progressNotes` array)

**Sections to preserve:**
- Frontmatter metadata (id, status, dependencies, etc.)
- Task list with completion status
- Manual content outside delimiters

**Delimiter system:**
The `GENERATED_START_DELIMITER` and `GENERATED_END_DELIMITER` constants allow safe updates to generated content while preserving manual research notes. This is critical for the compaction feature to avoid destroying manually-added insights.

#### Executor System (from Explore Agent: executor system)

Five executors available in `src/rmplan/executors/`:

**1. claude-code** (Primary choice for compaction)
- Full multi-agent orchestration (implementer/tester/reviewer)
- Tool permission management with MCP support
- File path prefix: `@` for automatic file reading
- Best for: Complex multi-step transformations

**2. codex-cli** (Alternative choice)
- Standalone Codex CLI integration
- Implement → Test → Review loop
- Good planning-only detection
- Best for: Simpler transformations with validation

**3. direct-call** (Simplest option)
- Single LLM call with rmfilter
- Automatic edit application
- Minimal overhead
- Best for: Quick summarization tasks

**4. copy-paste / copy-only** (Manual modes)
- Interactive workflows
- Not suitable for automated compaction

**Core interface all executors implement:**
```typescript
interface Executor {
  execute(contextContent: string, planInfo: PlanInfo): Promise<ExecutorOutput>;
  prepareStepOptions?(): Promise<void>;
  filePathPrefix?: string;
  supportsSubagents?: boolean;
}
```

**Integration pattern:**
```typescript
// Build executor from config
const executor = buildExecutorAndLog(executorName, sharedOptions, config);

// Execute with plan context
const output = await executor.execute(prompt, {
  planId, planTitle, planFilePath,
  captureOutput: 'result',
  executionMode: 'normal'  // or 'planning', 'simple', 'review'
});

// Handle result
if (output?.success === false) {
  throw new Error(`Compaction failed: ${output.error}`);
}
```

**Configuration:**
- Global config: `rmplanConfig.executors[executorName]`
- CLI options override config values
- Zod schemas validate executor options
- Model selection via `createModel()` function

**Recommendation for compaction:**
Use `direct-call` executor initially for simplicity. This gives us:
- Single LLM call with clear prompt
- Automatic validation
- Simple error handling
- Can upgrade to `claude-code` later if we need multi-step orchestration

#### Similar Commands (from Explore Agent: find similar commands)

**EXTRACT command** (src/rmplan/commands/extract.ts) is the best reference:

**Why it's similar:**
- Converts input format (Markdown → YAML) like compaction (verbose → concise)
- Uses LLM to process content via `extractMarkdownToYaml()`
- Reads from multiple sources (file, stdin, clipboard)
- Preserves metadata when needed
- Handles configuration and model setup

**Key pattern from extract:**
```typescript
export async function handleExtractCommand(inputFile: string | undefined, options: any) {
  // 1. Read input
  let inputText: string;
  if (inputFile === '-') {
    inputText = await readStdin();
  } else if (inputFile) {
    inputText = await Bun.file(inputFile).text();
  } else {
    inputText = await clipboard.read();
  }
  
  // 2. Load config
  const config = await loadEffectiveConfig(options.config);
  
  // 3. Process with LLM
  await extractMarkdownToYaml(inputText, config, options.quiet ?? false, extractOptions);
}
```

**Other relevant commands:**

**SPLIT command** (src/rmplan/commands/split.ts):
- Uses `createModel()` for LLM initialization
- Uses `runStreamingPrompt()` for LLM interaction
- Generates prompts using dedicated functions
- Parses YAML from LLM output using `fixYaml()`
- Writes multiple output files

**MERGE command** (src/rmplan/commands/merge.ts):
- Combines plan content
- Updates plan metadata
- Maintains consistency across plans
- Pure data transformation (no LLM)

**Shared utilities to use:**
- `loadEffectiveConfig()` - Load configuration
- `createModel()` - Initialize LLM
- `runStreamingPrompt()` / `generateText()` - Execute LLM
- `readPlanFile()` / `writePlanFile()` - Plan I/O
- `resolvePlanFile()` - Resolve plan by ID or path
- `fixYaml()` - Repair malformed YAML from LLM
- Logging: `log()`, `warn()`, `error()`

#### Plan Status System (from Explore Agent: plan status system)

**Available statuses:**
- `pending` - Not started
- `in_progress` - Currently being worked on
- `done` - Completed
- `cancelled` - Abandoned
- `deferred` - Postponed

**Status storage:**
- In YAML frontmatter as `status` field
- With optional `statusDescription` field for context
- Timestamps: `createdAt`, `updatedAt` (ISO 8601 format)

**Finding old plans for compaction:**

Use `readAllPlans(directory)` to get all plans, then filter by:
```typescript
// 1. Status check
const isCompletedStatus = ['done', 'cancelled', 'deferred'].includes(plan.status);

// 2. Age check
const ageInDays = (Date.now() - new Date(plan.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
const isOldEnough = ageInDays > options.age;

// 3. Dependency check (optional - only compact if nothing depends on it)
const blockedPlans = getBlockedPlans(plan.id, allPlans);
const hasNoDependents = blockedPlans.length === 0;

// Combine checks
const isCompactionCandidate = isCompletedStatus && isOldEnough && hasNoDependents;
```

**Key filtering utilities:**
- `getBlockedPlans(planId, allPlans)` - Find plans that depend on this one (src/rmplan/plans.ts)
- `getChildPlans(planId, allPlans)` - Find child plans
- `getDiscoveredPlans(planId, allPlans)` - Find plans discovered from this one
- `findNextPlan(directory, options)` - Find next ready plan

**List command filtering** (src/rmplan/commands/list.ts):
- Default: shows only `pending` and `in_progress`
- Can filter by: `--status pending done cancelled deferred`
- Special filters: `ready` (pending with resolved deps), `blocked` (pending with unresolved deps)

**Done command behavior** (src/rmplan/commands/done.ts):
- Marks plan as `done`
- Updates `updatedAt` timestamp
- Removes assignments and workspace locks
- Cascading: if parent plan has all children done, marks parent as done too

**No existing archival/compaction feature** - this is new functionality.

### Risks & Constraints

**Architectural constraints:**
1. **Delimiter preservation**: Must respect `<!-- rmplan-generated-start/end -->` delimiters to avoid destroying manual research
2. **YAML schema validation**: All plan writes go through `phaseSchema.safeParse()` - compacted plans must remain valid
3. **Dependency integrity**: Cannot compact plans that other plans depend on (use `getBlockedPlans()` check)
4. **Bidirectional updates**: If plan has parent/children, must maintain reference consistency

**Edge cases:**
1. **Plans with no research section**: May only have frontmatter + tasks
2. **Plans with multiple progress notes**: Should be condensed into summary
3. **Plans with large task lists**: Tasks should be preserved but descriptions may be compacted
4. **Plans referenced by UUID**: The `references` map must be preserved for renumbering safety
5. **Container plans**: Should consider compacting children first or skip containers

**LLM quality risks:**
1. **Over-summarization**: May lose critical technical details
2. **Hallucination**: LLM might add information not in original
3. **Format breakage**: LLM might not preserve valid YAML structure
4. **Delimiter removal**: LLM might accidentally remove delimiter comments

**Mitigation strategies:**
- Use explicit prompts emphasizing preservation of key facts
- Validate output with `fixYaml()` and schema parsing
- Provide examples in prompt of good compaction
- Add `--dry-run` flag to preview before writing
- Keep backup of original in progress notes

**Technical constraints:**
1. **File size**: Plans are typically < 100KB, so memory is not a constraint
2. **LLM context**: Full plan content should fit in context window (< 50K tokens typically)
3. **Rate limits**: For batch operations, may need throttling
4. **Git history**: Original verbose version remains in git history

**Configuration requirements:**
1. **Age threshold**: Default 30 days, configurable
2. **Executor choice**: claude or codex, with fallback
3. **Model selection**: Should use faster/cheaper models for summarization
4. **Batch processing**: May need option to compact multiple plans at once

### Follow-up Questions

1. **Batch vs. single mode**: Should the command support compacting all old plans at once (`rmplan compact --all`) or only one at a time?

2. **Progress note handling**: Should we condense all progress notes into a single summary, keep the most recent N notes, or preserve all notes in compacted form?

3. **Reversibility**: Should we keep a backup of the original plan before compaction (e.g., in a `.backup` file or git commit), or rely solely on git history for recovery?

4. **Default executor**: Should we default to `direct-call` for simplicity or `claude-code` for higher quality summarization?

5. **Compaction depth**: Should we compact just the details/research sections, or also condense task descriptions and progress notes?

6. **Validation step**: Should the command automatically validate that critical information (goal, outcome, acceptance criteria) is preserved in the compacted version before writing?

Implemented compact command (Tasks 1-7) that resolves plan files, enforces completed-status/age checks, invokes the configured executor, and rewrites generated details, research, and progress notes while recording compaction metadata. Added dedicated compaction prompt builder emphasizing preservation of goal, outcome, and decisions, plus validation to ensure schema compliance and task/metadata integrity before writes. Introduced compaction configuration schema (Task 9) and CLI wiring (Task 2) with options for executor, model, age, dry-run, and confirmation bypass. Created test suite (Task 8) verifying core compaction behavior, dry-run safety, and status enforcement using module mocks for executors/config; updated README with usage examples and option descriptions (Task 10).

Addressed reviewer fixes for the compact command. Task: Fix research section delimiter corruption. Task: Honor compaction section toggles. Updated src/rmplan/commands/compact.ts so updateResearchSection scans for the rmplan generated delimiters before replacing `## Research` headings, ensuring an executor-supplied research heading inside `details_markdown` no longer truncates the manual sections or removes the `<!-- rmplan-generated-end -->` marker. At the same time, applyCompactionSections now accepts compaction section toggles and only mutates details, research, or progress notes when the matching `config.compaction.sections` flag is true, while still recording compaction metadata. Added regression coverage in src/rmplan/commands/compact.test.ts that exercises an executor response containing an extra research heading and verifies both the delimiter preservation and the new configuration gating to guide future maintenance.

Expanded the compaction prompt (Task 4: Create compaction prompt template) to explicitly delineate which plan details must be preserved versus trimmed, emphasized anti-hallucination rules, and embedded a representative YAML example so executors consistently target the desired structure. Reworked validateCompaction (Task 5: Implement validation step) into a structured validator that enforces schema parsing, required field presence, invariant metadata comparisons, and readability checks by serializing the plan and scanning for control characters. The validator now returns both the normalized plan and any issues so compactPlan can surface precise failures. Added targeted tests in src/rmplan/commands/compact.test.ts ensuring validateCompaction flags task mutations and non-printable output, and updated the import to exercise the new export. These changes integrate with existing compaction flow by keeping mergeDetails and serialization untouched while strengthening pre-write safeguards.

Addressed reviewer feedback for Task 5 – Implement validation step by tightening validateCompaction so parent metadata cannot disappear unnoticed. Updated src/rmplan/commands/compact.ts to explicitly compare invariant fields when either side is undefined, reusing the existing JSON-based equality for defined values to retain consistency while surfacing removals and additions of parent data. Added regression coverage in src/rmplan/commands/compact.test.ts that constructs a plan with a parent and verifies the validator now flags the removal, ensuring future compactions preserve critical parent/child relationships.

Implemented Task 6: Add dry-run mode and Task 7: Implement file writing with backup. Updated src/rmplan/commands/compact.ts so compactPlan now returns the executor output alongside applied section flags, configuration toggles, and the original plan content. handleCompactCommand reuses a new reportCompactionPreview() helper to show the size delta, section status, and content previews for both dry-run and applying flows, then calls writeCompactedPlanWithBackup() which snapshots the original file to <plan>.backup-<timestamp>, attempts to write via writePlanFile(), and restores from the captured content if the write fails. applyCompactionSections now reports which sections actually changed and respects missing research summaries, while reportSuccessfulCompaction logs the backup location for auditing. Added writeCompactedPlanWithBackup() tests plus assertions about preview logging and backup creation in src/rmplan/commands/compact.test.ts to enforce the new behavior. These changes ensure dry runs surface the intended edits, compaction applies only to enabled sections, and users always have a recoverable backup when we write the condensed plan.

Addressed review fixes for compact command size tracking and metrics. Updated src/rmplan/commands/compact.ts to recompute serialization after attaching compaction metadata using an iterative loop so compactedBytes/compactedReductionBytes reflect the actual post-metadata file size. Adjusted calculateMetrics to derive "after" lengths from the finalized plan details/progress notes, ensuring toggle-suppressed sections report accurate deltas during previews. Revised reportSuccessfulCompaction to surface the signed byte delta instead of clamping negative growth, avoiding contradictory logging. These changes keep compaction previews, stats, and completion messages aligned with what is written to disk.
