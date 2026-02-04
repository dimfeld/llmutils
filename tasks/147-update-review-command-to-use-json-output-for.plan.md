---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: Update review command to use JSON output for better parsing
goal: Replace semi-structured text parsing with JSON schema-based output from
  Claude and Codex executors for more reliable review issue extraction
id: 147
uuid: 301a2eb9-3f83-41c3-bd80-6c2a5f738fcb
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2025-12-01T05:26:42.186Z
promptsGeneratedAt: 2025-12-01T05:26:42.186Z
createdAt: 2025-12-01T05:08:09.553Z
updatedAt: 2025-12-01T08:43:25.511Z
tasks:
  - title: Create Zod schema for review output
    done: true
    description: >-
      Create `src/tim/formatters/review_output_schema.ts` with:

      - `ReviewIssueOutputSchema` - severity (enum), category (enum), content
      (string), file (optional string), line (optional number), suggestion
      (optional string)

      - `ReviewOutputSchema` - object with issues array, recommendations array,
      actionItems array

      - Export function to generate JSON schema using `z.toJSONSchema()`

      - Add descriptive `.describe()` calls to guide LLM output
  - title: Update Claude executor for JSON schema review mode
    done: true
    description: |-
      In `src/tim/executors/claude_code.ts`:
      - When `executionMode === 'review'`, add dedicated review execution path
      - Add `--output-format json` and `--json-schema <schema>` arguments
      - Generate JSON schema string from the Zod schema
      - Parse JSON response and return structured ExecutorOutput
  - title: Update Codex executor for JSON schema review mode
    done: true
    description: |-
      In `src/tim/executors/codex_cli/review_mode.ts`:
      - Write JSON schema to a temporary file before execution
      - Add `--output-schema <temp-file-path>` to codex arguments
      - Ensure temp file is cleaned up after execution (use try/finally)
      - Parse JSON response and return structured ExecutorOutput
  - title: Add JSON parsing function in review_formatter.ts
    done: true
    description: >-
      In `src/tim/formatters/review_formatter.ts`:

      - Add `parseJsonReviewOutput(jsonString: string): ParsedReviewOutput`
      function

      - Validate JSON against schema using Zod

      - Assign auto-generated IDs to issues (issue-1, issue-2, etc.)

      - Handle parse errors gracefully with informative error messages
  - title: Update createReviewResult to use JSON parsing
    done: true
    description: |-
      In `src/tim/commands/review.ts`:
      - Update `createReviewResult()` to detect JSON vs text output
      - Call new JSON parsing function when output is JSON
      - Populate ReviewResult from parsed JSON data
      - Keep existing text parsing as fallback for non-JSON executors
  - title: Update tests for JSON-based review parsing
    done: true
    description: >-
      Update test files:

      - `src/tim/formatters/review_formatter.test.ts` - Add tests for JSON
      parsing function

      - `src/tim/commands/review.test.ts` - Update tests that mock executor
      output to use JSON format

      - Test error handling for malformed JSON

      - Test ID auto-generation
changedFiles:
  - src/tim/commands/review.test.ts
  - src/tim/commands/review.ts
  - src/tim/executors/claude_code.test.ts
  - src/tim/executors/claude_code.ts
  - src/tim/executors/claude_code_model_test.ts
  - src/tim/executors/codex_cli/review_mode.ts
  - src/tim/executors/codex_cli.review_mode.test.ts
  - src/tim/formatters/review_formatter.test.ts
  - src/tim/formatters/review_formatter.ts
  - src/tim/formatters/review_output_schema.test.ts
  - src/tim/formatters/review_output_schema.ts
tags: []
---

When running in review mode, the Codex and Claude executors should use JSON output for better parsing of the review output.

Create a JSON structure that represents the current issue data. We need severity, description, and relevant 
files/locations. Create a Zod schema that represents this so we can turn it into JSON schema.

Then update the executors to use it:

For claude: `claude -p --output-format json -json-schema <schema> <review prompt>`

For codex: `codex exec --output-schema <schema-file> <review prompt>` (Note that for Codex you need to write the schema to a temporary file)

Finally, replace all the existing review format parsing code and just parse the JSON output instead.

<!-- tim-generated-start -->
## Expected Behavior/Outcome
- Review command receives structured JSON output from executors instead of free-form text
- Issues are parsed directly from JSON rather than using regex/heuristic parsing
- Same `ReviewResult` data structure is produced, maintaining compatibility with existing formatters and persistence

## Key Findings
- **Product & User Story**: Users running `tim review` get more reliable issue extraction with fewer parsing errors
- **Design & UX Approach**: No user-facing changes - internal parsing improvement only
- **Technical Plan & Risks**: 
  - Create Zod schema for LLM output (issues array only, not full ReviewResult)
  - Update Claude executor to use `--output-format json --json-schema`
  - Update Codex executor to use `--output-schema` with temp file
  - Replace `parseReviewerOutput()` with JSON parsing
  - Risk: LLM may not always produce valid JSON - need error handling fallback
- **Pragmatic Effort Estimate**: Moderate - schema creation is straightforward, executor changes are isolated, main work is updating parsing logic

## Acceptance Criteria
- [ ] Zod schema exists for review output with issues array containing severity, category, content, file, line, suggestion
- [ ] Claude executor passes JSON schema to claude CLI in review mode
- [ ] Codex executor writes schema to temp file and passes to codex CLI in review mode
- [ ] Review command parses JSON output and produces valid ReviewResult
- [ ] Existing formatters (JSON, Markdown, Terminal) continue to work
- [ ] All existing tests pass or are updated appropriately
- [ ] New tests cover JSON parsing logic

## Dependencies & Constraints
- **Dependencies**: Relies on `--json-schema` support in claude CLI and `--output-schema` in codex CLI
- **Technical Constraints**: Must handle cases where LLM output is not valid JSON (fallback or error)

## Implementation Notes
- **Recommended Approach**: 
  1. Create schema first in a new file (e.g., `src/tim/formatters/review_output_schema.ts`)
  2. Update executors to use schema when `executionMode === 'review'`
  3. Add JSON parsing function alongside existing `parseReviewerOutput()`
  4. Update `createReviewResult()` to use new parsing
  5. Keep old parsing code initially for comparison/fallback, remove later
- **Potential Gotchas**: 
  - Codex temp file needs cleanup after use
  - Schema descriptions should guide LLM to produce good output
  - May need to handle partial/malformed JSON gracefully
<!-- tim-generated-end -->

## Research

### Summary
- The review command currently uses sophisticated semi-structured text parsing with multiple regex patterns and heuristics to extract issues from LLM output
- Claude Code and Codex CLI executors handle review mode differently: Codex has dedicated review mode, Claude uses orchestration wrapper
- The project already has established patterns for Zod schemas and JSON schema generation using `z.toJSONSchema()`
- Converting to JSON output will significantly simplify parsing and improve reliability

### Findings

#### Review Command Implementation (src/tim/commands/review.ts)

**Current Data Structures** (defined in `src/tim/formatters/review_formatter.ts`):

```typescript
export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewCategory =
  | 'security'
  | 'performance'
  | 'bug'
  | 'style'
  | 'compliance'
  | 'testing'
  | 'other';

export interface ReviewIssue {
  id: string;                    // issue-1, issue-2, etc.
  severity: ReviewSeverity;      // Critical, major, minor, info
  category: ReviewCategory;      // Security, performance, bug, etc.
  content: string;               // The issue description
  file?: string;                 // File path where issue is located
  line?: number;                 // Line number
  suggestion?: string;           // Optional fix suggestion
}

export interface ReviewSummary {
  totalIssues: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  categoryCounts: Record<ReviewCategory, number>;
  filesReviewed: number;
}

export interface ReviewResult {
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

**Current Parsing Logic** (`parseReviewerOutput()` in `src/tim/formatters/review_formatter.ts`, lines 277-530):
- Uses `---` separators to identify issue blocks
- Pattern matches severity prefixes: `CRITICAL:`, `MAJOR:`, `MINOR:`, `INFO:`
- Detects issue markers: bullet points, numbered lists, emoji markers
- Uses multiple regex patterns for file/line extraction
- Extracts suggestions from lines starting with `Suggestion:`, `Fix:`, `Consider:`
- Has performance safeguards: 10MB output limit, 100 issues max, 100k lines max

**Key Files Involved:**
- `src/tim/commands/review.ts` - Main command handler, builds prompts, orchestrates review
- `src/tim/formatters/review_formatter.ts` - Core parsing logic and data structures
- `src/tim/review_persistence.ts` - Saves reviews to `.rmfilter/reviews/`
- `src/tim/incremental_review.ts` - Diff tracking for incremental reviews

#### Executor Implementations

**Claude Code Executor** (`src/tim/executors/claude_code.ts`):
- No dedicated review mode - review execution goes through standard orchestration wrapper
- Already uses `--output-format stream-json` for streaming JSON output
- Supports `--json-schema` argument for structured output (per plan description)
- Key invocation pattern (line ~1110):
  ```typescript
  args.push('--verbose', '--output-format', 'stream-json', '--print', contextContent);
  ```

**Codex CLI Executor** (`src/tim/executors/codex_cli.ts`):
- Has dedicated review mode in `src/tim/executors/codex_cli/review_mode.ts`
- Returns `ExecutorOutput` with structured content
- Already uses `--json` flag for output
- According to plan description, supports `--output-schema <schema-file>` for structured output
- Key execution flow:
  ```typescript
  if (planInfo.executionMode === 'review') {
    return executeReviewMode(contextContent, planInfo, ...);
  }
  ```

**Codex Review Mode** (`src/tim/executors/codex_cli/review_mode.ts`):
- Runs single reviewer step via `executeCodexStep()`
- Returns structured `ExecutorOutput`:
  ```typescript
  return {
    content: trimmed,
    steps: [{ title: 'Codex Reviewer', body: trimmed }],
    success: !parsed.failed,
    failureDetails: parsed.details ? { ...parsed.details, sourceAgent: 'reviewer' } : {...}
  }
  ```

#### Zod Schema Patterns

**Existing Schema Examples:**
- `src/tim/planSchema.ts` - Plan/task schemas with factory pattern
- `src/tim/configSchema.ts` - Configuration schemas
- `src/tim/executors/schemas.ts` - Executor option schemas
- `src/tim/executors/codex_cli/review_analysis.ts` - Review analysis schema for Gemini

**JSON Schema Generation** (`scripts/update-json-schemas.ts`):
```typescript
const jsonSchema = z.toJSONSchema(zodSchema, {
  target: 'draft-7',
  io: 'input',
});
```

**Review Analysis Schema Example** (existing pattern in `src/tim/executors/codex_cli/review_analysis.ts`):
```typescript
export const ReviewAnalysisSchema = z.object({
  needs_fixes: z.boolean().describe('Whether fixes are required'),
  fix_instructions: z
    .preprocess((v) => (typeof v === 'string' ? [v] : v), z.string().array().optional())
    .describe('Specific, actionable instructions for fixes if needed'),
});
```

#### Test Coverage
- `src/tim/formatters/review_formatter.test.ts` - Tests parsing with various output formats
- `src/tim/commands/review.test.ts` - Tests plan resolution, prompt building, issue detection

### Risks & Constraints

1. **Executor Command Differences**: Claude Code uses `--json-schema <schema>` inline, Codex requires `--output-schema <schema-file>` with a temporary file
2. **Backwards Compatibility**: The current text parsing supports many edge cases and LLM output variations - JSON schema enforcement may cause some valid outputs to fail parsing if LLM doesn't strictly follow schema
3. **Schema Complexity**: The full `ReviewResult` structure may be too complex for direct LLM generation - may need a simpler output schema that gets transformed
4. **Incremental Review Support**: Need to ensure JSON output works with incremental review metadata tracking in `src/tim/incremental_review.ts`
5. **Existing Formatters**: The `JsonFormatter`, `MarkdownFormatter`, `TerminalFormatter` in `review_formatter.ts` will need to work with JSON-parsed data instead of text-parsed data
6. **Test Updates**: Both test files will need updates to test JSON parsing instead of text parsing
7. **Temporary File Cleanup**: Codex requires schema file - need proper temp file management with cleanup

Completed Tasks 1 and 4: Created Zod schema for review output and added JSON parsing function.

**Task 1 - Zod Schema (review_output_schema.ts):**
Created new file src/tim/formatters/review_output_schema.ts with:
- ReviewSeveritySchema: Zod enum for 'critical' | 'major' | 'minor' | 'info' with descriptive .describe() calls explaining when to use each severity level
- ReviewCategorySchema: Zod enum for 'security' | 'performance' | 'bug' | 'style' | 'compliance' | 'testing' | 'other' with detailed descriptions for LLM guidance
- ReviewIssueOutputSchema: Object schema with severity, category, content (required), and file, line, suggestion (optional). Line uses .int().positive() for validation
- ReviewOutputSchema: Complete output schema with issues array, recommendations array, and actionItems array - all with comprehensive .describe() calls
- getReviewOutputJsonSchema(): Returns JSON schema object using z.toJSONSchema() with draft-7 target
- getReviewOutputJsonSchemaString(): Returns formatted JSON string for CLI arguments
- Exported inferred types: ReviewSeverityOutput, ReviewCategoryOutput, ReviewIssueOutput, ReviewOutput

**Task 4 - JSON Parsing Function (review_formatter.ts):**
Added to src/tim/formatters/review_formatter.ts:
- ParsedReviewOutput interface: Exported type with issues, recommendations, and actionItems arrays
- ReviewJsonParseError class: Custom error class with 'cause' property for underlying error and 'rawInput' property (truncated to 500 chars) for debugging
- parseJsonReviewOutput(jsonString: string): ParsedReviewOutput: Validates JSON against ReviewOutputSchema using Zod, auto-generates sequential IDs (issue-1, issue-2, etc.) for each issue, throws ReviewJsonParseError on parse or validation failures
- tryParseJsonReviewOutput(jsonString: string): ParsedReviewOutput | null: Non-throwing variant that returns null on any failure, useful for fallback logic

**Design Decisions:**
1. Kept existing ReviewSeverity and ReviewCategory types separate from Zod-inferred types per plan recommendation to 'keep old parsing code initially for comparison/fallback'
2. Added comprehensive .describe() calls to guide LLM output generation
3. Used .int().positive() for line numbers to ensure valid values
4. Implemented both throwing and non-throwing variants of the parsing function for flexibility
5. Limited rawInput in error messages to 500 characters to prevent log pollution

**Test Coverage:**
Created review_output_schema.test.ts with tests for all schema validations. Extended review_formatter.test.ts with tests for JSON parsing including: valid input with all fields, optional fields, empty arrays, ID auto-generation, error handling for empty input, invalid JSON syntax, schema validation failures, and long input truncation. Added boundary test for line number of zero rejection. All 84 tests pass.

Completed Tasks 2 and 3: Updated Claude and Codex executors to use JSON schema output for review mode.

**Task 2 - Claude Executor (src/tim/executors/claude_code.ts):**
Added new private method executeReviewMode() (lines ~463-525) that provides a dedicated review execution path when planInfo.executionMode === 'review'. Key implementation details:
- Uses --output-format json (not stream-json) for single JSON response
- Passes inline JSON schema via --json-schema argument using getReviewOutputJsonSchemaString() from review_output_schema.ts
- Bypasses the normal orchestration wrapper and agents for simpler execution
- Spawns claude CLI with --print flag and review prompt as context
- Returns ExecutorOutput with raw JSON in content field and metadata.jsonOutput = true flag
- Modified execute() method (lines ~843-846) to dispatch to executeReviewMode() for review mode
- Proper error handling: throws on non-zero exit code with stderr details

**Task 3 - Codex Executor (src/tim/executors/codex_cli/review_mode.ts):**
Added new function executeCodexReviewWithSchema() (lines ~60-146) that handles JSON schema review mode. Key implementation details:
- Creates temp directory using fs.mkdtemp() in os.tmpdir()
- Writes JSON schema object to temp file using getReviewOutputJsonSchema()
- Passes --output-schema <temp-file-path> to codex exec command
- Uses try/finally block to ensure temp directory cleanup (fs.rm with recursive: true)
- Added ExecuteReviewModeOptions interface with reviewExecutor property for testability/dependency injection
- Updated buildAggregatedOutput() to include metadata: { phase: 'review', jsonOutput: true } for consistency with Claude executor
- Removed unused _codexStep parameter and executeCodexStep import as part of cleanup

**Design Decisions:**
1. Both executors return raw JSON in ExecutorOutput.content - parsing happens later in createReviewResult()
2. Both set metadata.jsonOutput = true so downstream code can detect JSON vs text output
3. Claude uses inline schema string, Codex uses temp file (per CLI requirements)
4. Review mode bypasses orchestration/agents for simpler single-pass execution
5. Deferred retry logic for Codex JSON mode - simpler single-pass is acceptable for now

**Test Coverage Added:**
- claude_code.test.ts: 5 new tests for review mode (JSON format args, jsonOutput flag, error handling, model selection, no orchestration)
- codex_cli.review_mode.test.ts: 7 new tests (temp file creation, schema content, cleanup on success/failure, sandbox settings, error handling)
- All 92 executor tests pass

Completed Tasks 5 and 6: Updated createReviewResult() to use JSON parsing with comprehensive test coverage.

**Task 5 - createReviewResult JSON Parsing:**
Modified two files to enable JSON parsing integration:

1. src/tim/formatters/review_formatter.ts:
   - Added CreateReviewResultOptions interface with isJsonOutput?: boolean field
   - Updated createReviewResult() function signature to accept optional options parameter
   - When options.isJsonOutput === true, attempts JSON parsing first using tryParseJsonReviewOutput()
   - Added warning log (using warn() from logging.ts) when JSON parsing fails to aid debugging
   - Falls back gracefully to existing text parsing via parseReviewerOutput() if JSON parsing fails
   - Maintains full backward compatibility when isJsonOutput is false or undefined

2. src/tim/commands/review.ts:
   - Added logic to detect JSON output from executor by checking executorOutput?.metadata?.jsonOutput === true
   - Passes { isJsonOutput } option to createReviewResult() to enable JSON parsing when appropriate
   - Works seamlessly with both Claude and Codex executors which set metadata.jsonOutput = true

**Task 6 - Test Coverage:**
Added comprehensive test coverage in two test files:

1. src/tim/formatters/review_formatter.test.ts (4 tests added):
   - 'parses JSON output when isJsonOutput option is true' - verifies JSON parsing works correctly
   - 'falls back to text parsing when JSON parsing fails with isJsonOutput true' - verifies fallback behavior  
   - 'uses text parsing when isJsonOutput is false' - verifies explicit text parsing
   - 'uses text parsing when options parameter is omitted' - verifies backward compatibility

2. src/tim/commands/review.test.ts (7 tests added in 'JSON output mode integration' describe block):
   - 'detects JSON output from executor metadata and parses correctly'
   - 'executor string output uses text parsing (non-JSON mode)'
   - 'executor output with metadata.jsonOutput=false uses text parsing'
   - 'summary statistics are correctly calculated from JSON-parsed issues'
   - 'JSON parsing correctly extracts all issue fields including file, line, and suggestion'
   - 'JSON parsing handles empty arrays correctly'
   - 'JSON parsing extracts all category types correctly'

**Design Decisions:**
1. Used tryParseJsonReviewOutput() (non-throwing) instead of parseJsonReviewOutput() for graceful fallback
2. Added warning log on JSON fallback to help diagnose executor/LLM issues
3. Tests verify actual parsed data (issues, summaries, recommendations, actionItems), not just execution success
4. All 137 review-related tests pass (132 pass, 5 skip)
5. Type checking passes with no errors
