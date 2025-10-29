---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add details support to rmplan add command
goal: ""
id: 137
uuid: ece4b9f5-eb81-40ed-85b5-217b93f947e7
status: pending
priority: medium
temp: false
parent: 128
references:
  "128": f69d418b-aaf1-4c29-88a9-f557baf8f81e
createdAt: 2025-10-26T22:51:32.843Z
updatedAt: 2025-10-27T08:39:04.202Z
tasks: []
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
