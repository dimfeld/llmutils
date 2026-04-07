# tim import Command

The `tim import` command allows you to import issues from configured issue trackers (GitHub or Linear) and create corresponding plans in the database. This streamlines the process of turning feature requests and bug reports into actionable development plans within the `tim` ecosystem.

Issue import is also available from the **web interface** — see the "Web UI Import" section below for details.

## Purpose

The import command bridges the gap between issue tracking and implementation planning by:

- Converting issues from GitHub or Linear into structured plans
- Providing a foundation for detailed task planning
- Ensuring issue context is preserved for development work
- Creating "stub" plans ready for further expansion with `tim generate`

## Two Modes of Operation

### Single-Issue Import Mode

When you specify a specific issue, the command imports that single issue directly:

```bash
# Import a specific issue by number
tim import --issue 123

# Import an issue by full URL
tim import --issue https://github.com/owner/repo/issues/456
```

### Interactive Multi-Issue Import Mode

When no specific issue is provided, the command enters interactive mode:

```bash
# Interactive mode - select multiple issues
tim import
```

In interactive mode, the command will:

1. List all open issues for the current repository
2. Allow you to select multiple issues using checkboxes
3. Import each selected issue as a separate plan

## Key Features

### Duplicate Prevention

The command automatically prevents creating duplicate plans by:

- Checking existing plans in the database for matching issue URLs
- Refreshing the plan snapshot after each successful import, so subsequent imports in the same batch see newly created plans
- Filtering out any issues that have already been imported

### Content Selection

For each issue being imported, you can choose which parts to include:

- **Issue body**: The main description and content of the issue
- **Comments**: Individual comments from the issue thread
- Interactive prompts let you select exactly what content becomes the plan's `details`

### Atomic Hierarchical Imports

When importing issues with sub-issues (hierarchical imports), all related plans (parent + children) are written to the database atomically in a single transaction. This ensures that if the process fails midway through, the DB remains consistent — either all plans from the hierarchy are created, or none are. File writes happen after the transaction completes.

### rmfilter Argument Parsing

Similar to the `generate` command, the import command can parse embedded `rmfilter` arguments from issue text. This allows issues to specify which files should be included for context when working on the implementation.

### Stub Plan Output

Each imported issue creates a "stub" plan in the database containing:

- **Title**: Derived from the issue title
- **Goal**: Summary of what the issue aims to accomplish
- **Details**: Selected content from the issue body and comments
- **Issue link**: Direct reference to the original GitHub issue
- **Empty task list**: Ready for population with `tim generate`

## Usage Examples

```bash
# Import a specific issue
tim import --issue 123

# Import using full GitHub URL
tim import --issue https://github.com/dimfeld/llmutils/issues/42

# Interactive mode to select multiple issues
tim import

```

## Integration with Existing Workflow

The import command is designed to work seamlessly with the existing tim workflow:

1. **Import**: Use `tim import` to create stub plans from GitHub issues
2. **Generate**: Use `tim generate` to add detailed implementation steps
3. **Execute**: Use `tim agent` to automatically implement, or use `tim show` to view and execute manually
4. **Track**: Use `tim done` to mark progress and commit changes

## Web UI Import

The web interface provides the same import functionality through a visual two-step wizard at `/projects/[projectId]/import/`. An "Import Issue" button appears on the Plans tab when an issue tracker is configured for the project.

**Step 1:** Enter an issue identifier (ID, URL, or branch name) and select an import mode (single, separate subissues, or merged subissues).

**Step 2:** Select which content to include via checkboxes (issue body, comments, subissues), then import.

The web import shares core logic with the CLI via extracted helpers in `src/tim/commands/import/import_helpers.ts`. It supports the same duplicate detection, hierarchical imports, and content selection. See `docs/web-interface.md` for full details on the web import flow.

## Requirements

- Issue tracker API token set in the environment (`GITHUB_TOKEN` for GitHub, `LINEAR_API_KEY` for Linear)
- Current working directory must be within a Git repository (CLI) or project must have a `last_git_root` (web UI)
- Issues must be accessible with the provided token

## Output Format

Imported plans are stored in the SQLite database as the source of truth. Each plan follows the standard tim schema:

```yaml
id: 123
title: 'Implement new feature X'
goal: 'Add functionality Y to improve user experience'
status: pending
issue: 'https://github.com/owner/repo/issues/123'
details: |
  [Selected issue content and comments]
tasks: []
```

The empty `tasks` array can then be populated using `tim generate` to create a fully executable implementation plan.
