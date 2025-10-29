# rmplan import Command

The `rmplan import` command allows you to import GitHub issues and create corresponding local plan files. This streamlines the process of turning feature requests and bug reports from GitHub into actionable development plans within the `rmplan` ecosystem.

## Purpose

The import command bridges the gap between issue tracking and implementation planning by:

- Converting GitHub issues into structured plan files
- Providing a foundation for detailed task planning
- Ensuring issue context is preserved for development work
- Creating "stub" plans ready for further expansion with `rmplan generate`

## Two Modes of Operation

### Single-Issue Import Mode

When you specify a specific issue, the command imports that single issue directly:

```bash
# Import a specific issue by number
rmplan import --issue 123

# Import an issue by full URL
rmplan import --issue https://github.com/owner/repo/issues/456
```

### Interactive Multi-Issue Import Mode

When no specific issue is provided, the command enters interactive mode:

```bash
# Interactive mode - select multiple issues
rmplan import
```

In interactive mode, the command will:

1. List all open issues for the current repository
2. Allow you to select multiple issues using checkboxes
3. Import each selected issue as a separate plan file

## Key Features

### Duplicate Prevention

The command automatically prevents creating duplicate plans by:

- Checking existing plan files in the configured tasks directory
- Looking for the issue's URL in the `issue` field of existing plan files
- Filtering out any issues that have already been imported

### Content Selection

For each issue being imported, you can choose which parts to include:

- **Issue body**: The main description and content of the issue
- **Comments**: Individual comments from the issue thread
- Interactive prompts let you select exactly what content becomes the plan's `details`

### rmfilter Argument Parsing

Similar to the `generate` command, the import command can parse embedded `rmfilter` arguments from issue text. This allows issues to specify which files should be included for context when working on the implementation.

### Stub Plan Output

Each imported issue creates a "stub" plan file containing:

- **Title**: Derived from the issue title
- **Goal**: Summary of what the issue aims to accomplish
- **Details**: Selected content from the issue body and comments
- **Issue link**: Direct reference to the original GitHub issue
- **Empty task list**: Ready for population with `rmplan generate`

## Usage Examples

```bash
# Import a specific issue
rmplan import --issue 123

# Import using full GitHub URL
rmplan import --issue https://github.com/dimfeld/llmutils/issues/42

# Interactive mode to select multiple issues
rmplan import

# Import with custom output location
rmplan import --issue 123 --output custom-tasks/feature-123.yml
```

## Integration with Existing Workflow

The import command is designed to work seamlessly with the existing rmplan workflow:

1. **Import**: Use `rmplan import` to create stub plans from GitHub issues
2. **Generate**: Use `rmplan generate` to add detailed implementation steps
3. **Execute**: Use `rmplan agent` to automatically implement, or use `rmplan show` to view and execute manually
4. **Track**: Use `rmplan done` to mark progress and commit changes

## Requirements

- GitHub token set in the `GITHUB_TOKEN` environment variable
- Current working directory must be within a Git repository
- Issues must be accessible with the provided GitHub token

## Output Format

The generated plan files follow the standard rmplan YAML schema:

```yaml
id: issue-123-implement-feature
title: 'Implement new feature X'
goal: 'Add functionality Y to improve user experience'
status: pending
issue: 'https://github.com/owner/repo/issues/123'
details: |
  [Selected issue content and comments]
tasks: []
```

The empty `tasks` array can then be populated using `rmplan generate` to create a fully executable implementation plan.
