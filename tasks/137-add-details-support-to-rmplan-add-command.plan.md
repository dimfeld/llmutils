---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add details support to rmplan add command
goal: ""
id: 137
uuid: ece4b9f5-eb81-40ed-85b5-217b93f947e7
status: done
priority: medium
container: false
temp: false
dependencies: []
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
issue: []
pullRequest: []
docs: []
createdAt: 2025-10-26T22:51:32.843Z
updatedAt: 2025-10-29T08:46:14.273Z
progressNotes:
  - timestamp: 2025-10-29T08:40:38.223Z
    text: Successfully implemented details support for rmplan add command. Added
      three new CLI options (--details, --editor-details, --details-file) that
      allow users to provide plan details during creation. Created new utility
      functions for editor interaction and stdin reading. All tests pass (8 new
      tests + 15 existing tests), type checking passes, and linting is clean.
    source: "implementer: add details support"
  - timestamp: 2025-10-29T08:44:22.536Z
    text: All verification steps completed successfully. Type checking passes, all
      tests pass (2241 total, including 8 new tests for details support), no
      debug code found, imports use proper .js extensions, and implementation
      integrates correctly with existing writePlanFile function.
    source: "verifier: verification"
  - timestamp: 2025-10-29T08:45:42.104Z
    text: Successfully completed implementation and verification of details support
      for rmplan add command. All tests pass (2,241 total), type checking clean,
      no linting errors in modified files. Implementation includes four input
      methods (inline, file, stdin, editor) with comprehensive test coverage.
      Ready for production use.
    source: "orchestrator: Implementation and verification"
tasks: []
changedFiles: []
rmfilter: []
---

## Overview

Currently, `rmplan add` creates plan stubs with only frontmatter (title, priority, dependencies, etc.). There's no way to add the details text (markdown content after the frontmatter) at creation time. This enhancement adds several options for providing plan details during creation.

## Problem

When agents or users create plans, they often have context or research to include immediately. Current workflow requires:
1. `rmplan add "title"` - Creates stub
2. Manually edit file or use another tool to add details
3. Or run `rmplan generate` later

This is cumbersome for agents that want to create detailed plans programmatically.

## Proposed Options

Add to `src/rmplan/commands/add.ts`:

### Option 1: Inline details

```typescript
.option('--details <text>', 'Plan details (markdown text)')
```

Usage:
```bash
rmplan add "Implement feature" --details "## Overview\nThis feature requires...\n\n## Approach\n..."
```

Good for: Programmatic creation where details are already formatted

### Option 2: Editor mode

```typescript
.option('--editor-details', 'Open editor to write plan details')
```

Usage:
```bash
rmplan add "Implement feature" --editor-details
# Opens editor, user writes markdown, saves and closes
```

Good for: Interactive creation with longer details

### Option 3: From file

```typescript
.option('--details-file <path>', 'Read details from markdown file')
```

Usage:
```bash
rmplan add "Implement feature" --details-file research-notes.md
```

Good for: When details already exist in a separate file

### Option 4: From stdin

Support reading from stdin when `--details-file -` is specified:

```bash
cat research.md | rmplan add "Implement feature" --details-file -
```

Good for: Pipeline automation

## Implementation

File: `src/rmplan/commands/add.ts`

1. Add the new options to the command definition
2. In the handler, after creating the plan object but before writing:

```typescript
// Collect details if provided
let details = '';

if (options.details) {
  details = options.details;
} else if (options.detailsFile) {
  if (options.detailsFile === '-') {
    // Read from stdin
    details = await readStdin();
  } else {
    details = await fs.readFile(options.detailsFile, 'utf-8');
  }
} else if (options.editorDetails) {
  details = await openEditorForInput('Enter plan details (markdown):');
}

// Add to plan object (details go after frontmatter in the file)
if (details) {
  plan.details = details;
}
```

3. Update the plan file writing logic to include details after frontmatter:

```typescript
const yamlContent = yaml.stringify(plan, { lineWidth: 0 });
const fileContent = `---\n${yamlContent}---\n\n${plan.details || ''}`;
await fs.writeFile(planFile, fileContent, 'utf-8');
```

## Utility Functions

Consider extracting shared utilities to `src/rmplan/utils/editor.ts`:

```typescript
export async function openEditorForInput(prompt: string): Promise<string> {
  const editor = process.env.EDITOR || 'nano';
  const tempFile = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-'));
  const tempPath = path.join(tempFile, 'details.md');
  
  // Write prompt as comment
  await fs.writeFile(tempPath, `# ${prompt}\n\n`);
  
  // Open editor
  await spawnSync(editor, [tempPath], { stdio: 'inherit' });
  
  // Read result
  const content = await fs.readFile(tempPath, 'utf-8');
  
  // Clean up
  await fs.rm(tempFile, { recursive: true });
  
  // Remove comment lines
  return content.split('\n').filter(line => !line.startsWith('#')).join('\n').trim();
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
```

## Examples

### Agent creating discovered work with context

```bash
rmplan add "Fix authentication edge case" \
  --discovered-from 42 \
  --priority high \
  --details "## Problem
Found during implementation of plan 42:

Users with null email addresses cause auth middleware to crash.

## Root Cause
The validateEmail() function assumes email is always a string.

## Approach
1. Add null check in validateEmail()
2. Add tests for null/undefined cases
3. Update error messaging"
```

### Using research notes as details

```bash
rmplan add "Implement caching layer" \
  --priority medium \
  --details-file research/caching-options.md
```

### Interactive with editor

```bash
rmplan add "Refactor database layer" --editor-details
# Opens nano/vim with template
```

### Pipeline from LLM output

```bash
echo "## Research\nLLM found that..." | \
  rmplan add "Generated plan" --details-file -
```

## CLI Integration

Update command definition in `src/rmplan/rmplan.ts`:

```typescript
program
  .command('add [title...]')
  .description('Create a new plan stub file that can be filled with tasks using generate')
  .option('--edit', 'Open the newly created plan file in your editor')
  .option('--details <text>', 'Plan details (markdown text)')
  .option('--editor-details', 'Open editor to write plan details')
  .option('--details-file <path>', 'Read details from file (use "-" for stdin)')
  .option('-d, --depends-on <ids...>', 'Specify plan IDs that this plan depends on')
  // ... existing options ...
```

## Testing

### Unit Tests

File: `src/rmplan/commands/add.test.ts`

- Add plan with inline details
- Add plan with details from file
- Add plan with stdin details
- Add plan with editor details (mock editor)
- Verify details appear after frontmatter in file
- Verify existing functionality still works without details options

### Integration Tests

- Create plan with details, then show it, verify details display
- Create plan with details file, verify content matches
- Test with multiline details including special characters
- Verify YAML frontmatter isn't affected by details content

## Backwards Compatibility

All changes are additive - existing behavior without the new flags remains unchanged:
- Plans without details still work
- All existing options continue to function
- No breaking changes to command interface

## Dependencies

None - enhances existing `add` command functionality.

## MCP Integration

The existing `update-plan-tasks` MCP tool doesn't support creating new plans - it only updates existing ones. A comprehensive MCP tools plan (plan 138) will add a `create-plan` tool that includes details support:

```typescript
{
  title: string,
  goal?: string,
  details?: string,  // Initial plan details
  priority?: string,
  parent?: number,
  dependsOn?: number[],
  discoveredFrom?: number,
  // ... other fields from rmplan add
}
```

This will enable agents to create fully-formed plans programmatically without needing to run CLI commands.

# Implementation Notes

Successfully implemented details support for the `rmplan add` command, enabling users to provide plan details at creation time through multiple input methods.

## Implementation Overview

Added four different ways to provide plan details when creating a new plan:
1. Inline text via `--details <text>` option
2. From a file via `--details-file <path>` option  
3. From stdin via `--details-file -` option
4. Interactive editor via `--editor-details` option

## Files Created

### src/rmplan/utils/editor.ts
New utility module providing two core functions:
- `openEditorForInput(prompt?: string): Promise<string>` - Opens the user's configured editor (from $EDITOR env var, defaults to nano) in a temporary file, allows user to write markdown content, then returns the content with comment lines removed
- `readStdin(): Promise<string>` - Reads complete input from stdin using Node.js stream API

### src/rmplan/commands/add.details.test.ts
Comprehensive test suite with 8 tests covering:
- Inline details functionality
- File-based details input
- Stdin input (details-file -)
- Backwards compatibility (no details)
- Edge cases: empty strings, multiline content, special characters, YAML-like content
- Integration with other command options (priority, status, etc.)
- Error handling for missing files

### src/rmplan/utils/editor.test.ts
Basic test coverage for the editor utility functions

## Files Modified

### src/rmplan/rmplan.ts (lines 166-168)
Added three new CLI options to the 'add' command definition:
```typescript
.option('--details <text>', 'Plan details (markdown text)')
.option('--editor-details', 'Open editor to write plan details')
.option('--details-file <path>', 'Read details from file (use "-" for stdin)')
```

### src/rmplan/commands/add.ts (lines 160-175)
Added details collection logic after `updatePlanProperties` call and before plan file writing:
- Checks options in priority order: inline details > file > editor
- Uses dynamic imports for editor utilities (only loaded when needed)
- Handles stdin input when `--details-file -` is specified
- Assigns collected details to `plan.details` field

## Technical Design Decisions

1. **Priority order**: Inline details take precedence over file-based, which takes precedence over editor mode. This allows scripts to override without triggering interactive prompts.

2. **Dynamic imports**: The editor utilities are loaded dynamically only when needed, reducing startup time for the common case where details aren't provided.

3. **Reuse existing infrastructure**: The implementation leverages the existing `writePlanFile` function which already properly handles the details field, separating it from YAML frontmatter and writing it as markdown body after the `---` delimiter.

4. **Stdin detection**: Following common CLI conventions, using `-` as the filename triggers stdin reading mode, enabling pipeline integration.

5. **Editor cleanup**: The `openEditorForInput` function creates a temporary directory, writes a template with optional prompt comment, spawns the editor, reads the result, and cleans up the temp directory. Comment lines (starting with #) are filtered out to remove the prompt.

6. **Backwards compatibility**: All changes are purely additive. Plans created without the new options behave exactly as before, with `details` initialized to empty string.

## Integration Points

The implementation integrates cleanly with:
- Existing `writePlanFile` function in src/rmplan/plans.ts which already handles details separation
- Other add command options (priority, status, parent, dependencies, etc.)
- Plan file format (YAML frontmatter + markdown body)
- Test infrastructure (Bun test runner, temp directory fixtures)

## Test Results

All verification passed:
- Type checking: ✅ No errors
- Linting: ✅ No errors in modified files (18 pre-existing errors in unrelated files)
- Test suite: ✅ 2,241 pass, 80 skip, 0 fail
- New tests: ✅ 10 new tests, all passing

## Usage Examples

Inline details for quick notes:
```bash
rmplan add "Fix auth bug" --details "## Problem\nUsers getting 401 errors\n\n## Solution\nAdd token refresh"
```

From research notes file:
```bash
rmplan add "Implement caching" --details-file docs/caching-research.md
```

Interactive editor for longer content:
```bash
rmplan add "Refactor database" --editor-details
```

Pipeline from other tools:
```bash
cat research.md | rmplan add "Generated plan" --details-file -
```

Combined with other options:
```bash
rmplan add "Urgent fix" --priority high --parent 128 --discovered-from 42 --details "Critical security patch needed"
```
