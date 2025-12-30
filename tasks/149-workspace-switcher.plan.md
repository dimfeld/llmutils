---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: workspace switcher
goal: ""
id: 149
uuid: 4a39959d-e9fb-4fa6-b4ed-774a5b4dfd4d
generatedBy: agent
simple: false
status: done
priority: medium
createdAt: 2025-12-29T01:17:52.736Z
updatedAt: 2025-12-29T17:28:36.033Z
progressNotes:
  - timestamp: 2025-12-29T07:00:49.233Z
    text: >-
      Added comprehensive test coverage for workspace switcher features:

      - patchWorkspaceMetadata: 10 tests covering update, create, clear,
      timestamps, and plan metadata

      - buildWorkspaceListEntries: 6 tests covering filtering, list structure,
      optional fields, and locks

      - workspace update command: 16 tests covering name/description updates,
      task ID resolution, from-plan loading, error cases, and issue URL
      extraction (GitHub, GitLab, Linear, Jira)

      All 44 new/updated workspace tests pass. TypeScript type check passes.
    source: "tester: Tasks 1,2,4"
  - timestamp: 2025-12-29T07:17:33.165Z
    text: Implemented workspace list output formats (table/TSV/JSON) with --format,
      --no-header, --all options. Added shell-integration command that generates
      bash/zsh function for workspace switching with fzf. Created comprehensive
      tests (18 tests) covering all output formats and shell integration.
      Updated README and docs/multi-workspace-workflow.md with documentation.
    source: "implementer: Task 3 + Task 6"
  - timestamp: 2025-12-29T07:21:44.143Z
    text: "All workspace tests pass (38 tests). Added additional tests for: 1) JSON
      output with all WorkspaceListEntry fields (createdAt, updatedAt,
      repositoryUrl, branch), 2) Table format displaying workspace
      name/description with path. Type checking passes. Test coverage verified
      for: output formats (table/TSV/JSON), header options, repo filtering,
      --all flag, shell integration for bash/zsh, fzf check, query argument, and
      cancellation handling."
    source: "tester: Tasks 3 & 6"
  - timestamp: 2025-12-29T07:37:40.672Z
    text: "Implemented agent auto-description updates. After plan is read, workspace
      description is updated using buildDescriptionFromPlan and
      patchWorkspaceMetadata. Updates are applied on every run for tracked
      workspaces, with failures logged as warnings but not aborting the agent.
      Added 5 tests covering: description update with issue URL, without issue
      URL, untracked workspace (silent skip), update failure (warn but
      continue), and project title handling."
    source: "implementer: Task 5"
  - timestamp: 2025-12-29T07:42:52.189Z
    text: Reviewed agent auto-description updates. Implementation is correct and
      tests pass. Found no critical or major issues. Minor suggestion about test
      isolation.
    source: "reviewer: Task 5"
  - timestamp: 2025-12-29T07:43:54.972Z
    text: "Completed Task 5 (Agent auto-description updates). Added
      updateWorkspaceDescriptionFromPlan() function to agent.ts that updates
      workspace description with format #issueNumber title on every agent run.
      Function silently skips untracked workspaces and warns but doesn't abort
      on failures. Created 5 tests covering all scenarios. All tests pass, type
      checking passes. Implementation reuses existing helpers
      (buildDescriptionFromPlan, patchWorkspaceMetadata, etc.) for consistency."
    source: "orchestrator: Task 5"
  - timestamp: 2025-12-29T16:38:00.783Z
    text: Reviewed workspace switcher changes; found issues around repo URL
      detection (git-only), missing repositoryUrl when creating entries via
      update, stale issueUrls/planId not cleared, and deletion of entries on
      stat errors.
    source: "reviewer: workspace switcher review"
  - timestamp: 2025-12-29T17:05:58.559Z
    text: Updated workspace list/update/agent flows to use repository identity
      fallback, avoid deleting entries on stat errors, clear stale plan
      metadata, and adjusted tests (list/update/lock/workspace tracker/agent)
      with new coverage for no-origin and error cases.
    source: "implementer: workspace switcher fixes"
  - timestamp: 2025-12-29T17:12:36.117Z
    text: Added jj repository fallback coverage in workspace_identifier.test to
      ensure getRepositoryIdentity works without git remotes.
    source: "tester: add jj identity test"
  - timestamp: 2025-12-29T17:14:46.021Z
    text: Adjusted WorkspaceLock to honor RMPLAN_LOCK_DIR and updated workspace
      list/lock tests to set it, avoiding EPERM on ~/.config/rmplan/locks during
      tests.
    source: "tester: fix lock dir tests"
  - timestamp: 2025-12-29T17:21:46.995Z
    text: Found remaining git-remote dependency in WorkspaceAutoSelector
      (src/rmplan/workspace/workspace_auto_selector.ts) that still fails in
      jj/no-origin repos; auto workspace selection returns null instead of using
      repository identity fallback.
    source: "reviewer: workspace switcher review"
tasks:
  - title: Extend workspace metadata storage + patch helper
    done: true
    description: Update `src/rmplan/workspace/workspace_tracker.ts` to persist new
      optional fields (name, description, planId, planTitle, issueUrls,
      updatedAt). Add a patch/merge helper that can update existing entries or
      create new ones (with minimal required fields). Cover clearing values
      (empty strings) and creation in
      `src/rmplan/workspace/workspace_tracker.test.ts`.
  - title: Add VCS-aware branch helper + list data model
    done: true
    description: Add/extend a helper in `src/common/git.ts` (or a new helper module)
      that returns the current branch/bookmark for both git and jj (first
      bookmark only). Refactor workspace list assembly to use this helper, build
      a structured list entry (full path, basename, name, description, branch,
      taskId, planTitle, issueUrls). Add unit tests for the helper and list
      assembly behavior.
  - title: Workspace list output formats + repo scope
    done: true
    description: Update `src/rmplan/commands/workspace.ts` to render list output in
      table/TSV/JSON, defaulting to current repo and abbreviated path in table
      output; add `--format` and `--no-header` plus `--all` to list across
      repositories. TSV should include full path + basename + hidden fields;
      JSON should include full metadata; omit lock status from TSV/JSON. Add
      command-level tests for list output and repo filtering.
  - title: Workspace update command
    done: true
    description: Add `rmplan workspace update [workspaceIdentifier]` in
      `src/rmplan/rmplan.ts` and handler in `src/rmplan/commands/workspace.ts`.
      Support `--name`, `--description`, clearing via empty strings, and
      `--from-plan <id>` to seed description only from the plan. Use the patch
      helper to update/create entries. Add tests with ModuleMocker and temp
      tracking file.
  - title: Agent auto-description updates
    done: true
    description: "In `src/rmplan/commands/agent/agent.ts`, after workspace selection
      and plan resolution, update workspace description on every run. Format:
      `#<issueNumber> <plan title>` using the first issue URL if present (issue
      number only). Use patch helper; failures should warn but not abort. Add
      targeted tests if feasible."
  - title: Shell integration command + docs
    done: true
    description: Add `rmplan workspace shell-integration --shell bash|zsh` (default
      zsh) that prints a fixed-name function. The function should call `rmplan
      workspace list --format tsv --no-header`, use `fzf` with delimiter and
      preview (full path + description/branch), accept optional query
      (`--query`), and `cd` to selected full path; handle missing `fzf` and
      cancel. Add tests for generated output strings and update README +
      `docs/multi-workspace-workflow.md`.
changedFiles:
  - README.md
  - claude-plugin/skills/rmplan-usage/SKILL.md
  - claude-plugin/skills/rmplan-usage/references/mcp-tools.md
  - docs/multi-workspace-workflow.md
  - src/rmplan/commands/agent/agent.ts
  - src/rmplan/commands/agent/agent.workspace_description.test.ts
  - src/rmplan/commands/workspace.list.test.ts
  - src/rmplan/commands/workspace.ts
  - src/rmplan/commands/workspace.update.test.ts
  - src/rmplan/rmplan.ts
  - src/rmplan/workspace/workspace_tracker.test.ts
  - src/rmplan/workspace/workspace_tracker.ts
tags: []
---

- Named workspaces with rmplan command to switch via a bash function, add a selector that lets you find based on the issue, branch, issue title, etc.
- Add a command to update a workspace (or the current one) with a name and description.
- When running the `agent` command automatically update the description of the current workspace
- This will need to end with a `cd` command, so the implementation here should be a combination of:
  - workspaces list command should list the directory, name, description, and branch
  - use fzf to allow the user to select a workspace
  - run the `cd` command on the result 
- Then a `shell-integration` command that outputs a bash or zsh function for the above that can be put into a file and sourced

## Implementation Guide

### Overview / Opportunity
This feature turns the existing workspace tracking into a first-class workspace switcher. Today rmplan can create, list, lock, and unlock workspaces, but switching between them requires manual `cd` and there is no naming/description metadata to make selection easy. The goal is to add lightweight metadata (name/description plus plan/issue context), expose it through `rmplan workspace list`, and provide a shell integration function that uses `fzf` to select a workspace and `cd` into it. The agent command should keep workspace descriptions fresh so the selection stays relevant without extra manual effort.

### Subagent Research Reports (Parallel Exploration)

#### Subagent A: CLI Command Surface & Patterns
- Inspected `src/rmplan/rmplan.ts` for how subcommands are registered (Commander patterns and dynamic imports). Workspace commands are currently `list`, `add`, `lock`, `unlock` with handlers in `src/rmplan/commands/workspace.ts`.
- Observed pattern: commands use `handleCommandError`, and handlers accept `(options, command)` with `command.parent!.parent!.opts()` to access global config.
- No existing shell-integration command; will need to introduce a new command entry in `src/rmplan/rmplan.ts` and a handler module under `src/rmplan/commands/`.

#### Subagent B: Workspace Tracking & Creation
- `src/rmplan/workspace/workspace_tracker.ts` owns the tracking file (`~/.config/rmfilter/workspaces.json`) and defines `WorkspaceInfo` with `taskId`, `workspacePath`, `branch`, `createdAt`, `repositoryUrl`, etc. No name/description metadata yet.
- `recordWorkspace` overwrites entries; no dedicated “update/patch” helper exists.
- `src/rmplan/workspace/workspace_manager.ts` records workspaces after creation and can be extended to include new metadata fields (name/description/plan info) on initial creation.

#### Subagent C: Agent / Auto-Workspace Flow
- `src/rmplan/commands/agent/agent.ts` copies the plan file into the workspace root, updates `currentBaseDir`, and acquires a workspace lock when needed.
- No current hook to update workspace metadata or descriptions during agent execution, but the code has the necessary context (`currentPlanFile`, `workspace.path`).

#### Subagent D: Interactive Selection & External Tooling
- `src/rmfind/rmfind.ts` shows established `fzf` usage patterns: pre-flight `which fzf`, pipe newline-delimited input, handle exit code 130 (cancel) gracefully.
- This is a good model for the workspace selector, especially when the shell integration wants to rely on `rmplan` to produce a machine-friendly list.

### Expected Behavior/Outcome

New user-facing behavior:
- `rmplan workspace list` displays each workspace’s directory, name, description, and branch (plus lock state if available), so users can scan and filter quickly.
- `rmplan workspace update [workspaceIdentifier] --name <name> --description <desc>` updates a workspace’s name/description. If no identifier is given, it targets the current directory’s workspace entry.
- `rmplan agent` auto-updates the current workspace description using the plan’s title/goal context (only when a tracked workspace is in use).
- `rmplan workspace shell-integration --shell bash|zsh` (or equivalent command name) prints a shell function that uses `rmplan workspace list` + `fzf` to select a workspace and `cd` into it.

Relevant states (explicit definition):
- Workspace tracking state: tracked vs untracked directory.
- Lock state: unlocked, locked (pid), locked (persistent), stale lock cleared.
- Metadata state: name/description present vs missing.
- Selection state: workspaces exist vs none; user selects vs cancels; `fzf` not installed.
- Agent context state: running in tracked workspace vs not; plan file available vs missing.

### Key Findings

**Product & User Story**
- Users have multiple clones/workspaces and need a fast, fuzzy-searchable switcher keyed on plan/issue context instead of raw paths.
- The existing workspace tracking file is the natural place to store names and descriptions; it already spans multiple clones.

**Design & UX Approach**
- Keep `rmplan workspace list` human-readable by default, but support a stable machine-friendly format (TSV/JSON) for shell integration and `fzf`.
- Present the workspace path in the output but make it optionally hidden in the `fzf` display using `--with-nth` so the search surface emphasizes name/description/issue/branch.
- Make the shell function do the `cd` so it works in the current shell process (Node cannot `cd` a parent shell).

**Technical Plan & Risks**
- Extend `WorkspaceInfo` to include `name`, `description`, and plan/issue-derived fields (plan title, plan id, issue URLs or extracted issue labels) so selection can match on them.
- Add an update/patch helper in `workspace_tracker.ts` to merge metadata updates without clobbering existing data.
- Update `rmplan agent` to refresh workspace metadata after the plan file is copied and `currentPlanFile` is known.
- Risk: stored `branch` may become stale; decision: recompute branch live during list and treat failures as a non-fatal empty/unknown branch field. Use shared VCS helpers that support both jj and git instead of shelling out directly to `git`.
- Risk: shell integration relies on `fzf` being installed. The CLI should give a clear error path similar to `rmfind`.

**Pragmatic Effort Estimate**
- Medium complexity. Expect ~2–4 engineering days: 1 day for core data model/list/update changes, 1 day for shell integration & agent hook, 0.5–1 day for tests and docs.

### Dependencies & Constraints

**Dependencies**
- `fzf` external CLI dependency for interactive selection (optional but required for switcher UX).
- `table` npm package already in repo and can be reused for tabular display.

**Technical Constraints**
- `rmplan` cannot change the parent shell’s working directory; must output a shell function or `cd` string.
- Workspace tracking file is global; list commands should filter by repository URL to avoid cross-repo confusion.
- Keep Zod schema defaults rules in mind if config changes are introduced (avoid new defaults in schema).
- Use existing VCS helper functions that support both jj and git when reading branch/status info.

### Notable Files and Patterns Inspected

- `src/rmplan/commands/workspace.ts`: current list/add/lock/unlock command handlers; will need new update + list formatting.
- `src/rmplan/rmplan.ts`: command registration patterns for Commander, dynamic imports, and global options.
- `src/rmplan/workspace/workspace_tracker.ts`: workspace tracking file schema and I/O. Needs optional metadata fields + update helper.
- `src/rmplan/workspace/workspace_manager.ts`: records workspace data on creation.
- `src/rmplan/workspace/workspace_auto_selector.ts`: list with lock status; likely refactor to return data rather than print for reusability.
- `src/rmplan/commands/agent/agent.ts`: best hook point for automatic description updates.
- `src/rmfind/rmfind.ts`: `fzf` usage and cancellation handling pattern.
- `src/rmplan/display_utils.ts`: helper to format workspace paths (relative/home). Useful for list display.

### Implementation Notes

**Recommended Approach**
- Extend `WorkspaceInfo` to add optional metadata fields: `name`, `description`, `planId`, `planTitle`, `issueUrls` (or `issueLabels`), and `updatedAt`. Keep them optional for backward compatibility.
- Add a `patchWorkspaceMetadata(workspacePath, patch)` helper in `workspace_tracker.ts` that merges `patch` into existing entry and writes the tracking file. Include `updatedAt` timestamp.
- Update `createWorkspace` (in `workspace_manager.ts`) to include name/description defaults derived from the plan when possible (e.g., `name = taskId`, `description = combined plan title`).
- Refactor `WorkspaceAutoSelector.listWorkspacesWithStatus` to return a structured list so `workspace list` can render either table or TSV/JSON.
- Update `workspace list` to:
  - Remove missing directory entries (existing behavior).
  - Assemble enriched display data: directory, name, description, branch, lock state, and derived plan/issue fields.
  - Offer `--format table|tsv|json` (default `table`) and `--no-header` for machine use.
- Add `workspace update` to set name/description. Resolve identifier the same way as lock/unlock. If no identifier, use current directory’s entry.
- Add `workspace shell-integration` (or top-level `shell-integration`) to print a function that:
  - Calls `rmplan workspace list --format tsv --no-header`.
  - Pipes into `fzf` with a `--delimiter '\t'` and `--with-nth=2..` display.
  - Extracts the workspace path field and runs `cd`.
  - Exits gracefully on cancel or missing `fzf`.
- Add `rmplan agent` hook: when `currentBaseDir` points to a tracked workspace, update description from the plan (e.g., combined title/goal). Do not error if the workspace is untracked.

**Potential Gotchas**
- Path resolution mismatches (symlink vs real path) can prevent updates from locating a workspace entry. Decide whether to normalize with `realpath` or keep existing `resolveWorkspaceIdentifier` behavior.
- Existing tracking file entries will be missing new fields; list and switcher must handle undefined values cleanly.
- `fzf` preview windows or ANSI coloring can break parsing; ensure TSV mode is raw and uncolored.
- On Windows, `fzf` invocation and path separators may differ; document that the shell integration targets bash/zsh environments.

**Conflicting, Unclear, or Impossible Requirements**
- None identified. Decisions captured: workspace name/description metadata will be persisted in the tracking file (not computed on the fly), and `workspace update` may create a new tracking entry if the directory is not already tracked.

### Acceptance Criteria

- [ ] Functional Criterion: `rmplan workspace list` shows directory, name, description, and branch for every tracked workspace in the current repo.
- [ ] Functional Criterion: `rmplan workspace update` updates name/description for the specified workspace or the current workspace when no identifier is provided.
- [ ] UX Criterion: Shell integration function can be sourced and uses `fzf` to select a workspace, then `cd` into it; canceling selection leaves the current directory unchanged.
- [ ] Technical Criterion: `rmplan agent` updates the current workspace description when running in a tracked workspace without crashing if no workspace entry exists.
- [ ] All new code paths are covered by tests.

### Manual Testing Steps (for later validation)

1. Create or ensure multiple tracked workspaces exist for a repo.
2. Run `rmplan workspace update --name "my ws" --description "API auth"` in one workspace and confirm metadata is persisted in the tracking file.
3. Run `rmplan workspace list` and confirm directory/name/description/branch are present and readable.
4. Source the shell function from `rmplan workspace shell-integration --shell zsh` and use it to switch between workspaces.
5. Run `rmplan agent <plan>` inside a workspace and confirm the description updates automatically in the tracking file.

### Step-by-Step Implementation Guide

1. Data model updates
   - Extend `WorkspaceInfo` in `src/rmplan/workspace/workspace_tracker.ts` with optional metadata fields (`name`, `description`, `planId`, `planTitle`, `issueUrls`, `updatedAt`) and persist these values in the tracking file.
   - Add `patchWorkspaceMetadata` (or similar) to merge updates into existing tracking data without overwriting other fields.

2. Workspace list data assembly
   - Create a helper (in `workspace.ts` or a new module) to assemble `WorkspaceInfo` + derived plan/issue data into a `WorkspaceListEntry` structure.
   - Consider using `getCombinedTitleFromSummary` from `src/rmplan/display_utils.ts` for plan title/issue title derivation.
   - Refresh `branch` via shared VCS helpers that support jj/git (decision captured: live recompute).

3. `rmplan workspace list` output modes
   - Default to a clean table output including directory (abbreviated path), name, description, branch, and lock state, filtered to the current repository by default.
   - Provide a flag (e.g., `--all`) to list workspaces across all repositories when needed.
   - Add `--format tsv|json` and `--no-header` so a shell function can consume deterministic output.
   - Include hidden/searchable fields (plan title, issue URLs, taskId) in TSV to enable `fzf` matching on those fields. Decision captured: use the full TSV with extra searchable fields for the switcher, and include a display column that is only the basename of the workspace path (separate column from the full path). Lock status is not required in TSV/JSON. JSON output should include all metadata fields (full payload, not just visible fields).

4. `rmplan workspace update` command
   - Add a new subcommand in `src/rmplan/rmplan.ts` (e.g., `workspace update [workspaceIdentifier]`).
   - Handler should resolve workspace identifier the same way as lock/unlock. If missing, use current directory. If the target directory is not already tracked, create a new tracking entry with the provided metadata (and minimal required fields).
   - Update name/description using the new patch helper; support `--from-plan <id>` to seed description (only) from the specified plan file. Allow clearing values (empty string) explicitly.

5. Agent auto-description update
   - In `src/rmplan/commands/agent/agent.ts`, after `currentBaseDir` is set to workspace and `currentPlanFile` is known, read the plan and update workspace description in the tracking file (overwrite every run). Use a concise format: issue reference extracted from the issue URL (if present, just the issue number like `#123`) plus the plan title.
   - Guard for missing tracking entry or read errors (log a warning but do not fail the agent).

6. Shell integration command
   - Add `rmplan workspace shell-integration --shell bash|zsh` (default: zsh) to print a function that:
     - Calls `rmplan workspace list --format tsv --no-header`.
     - Pipes to `fzf` with `--delimiter '\t' --with-nth=2..`, using the basename column for display while keeping the full path as the first TSV field.
     - Extracts the full path and executes `cd`.
     - Accepts an optional query argument and passes it to `fzf --query` when provided.
     - Use an fzf preview window to show the full path plus description/branch fields.
     - Use a fixed function name (no configurability needed).
   - Follow the `rmfind` pattern for checking `fzf` availability and handling cancellation (exit code 130).

7. Tests
   - Update/add tests in `src/rmplan/workspace/workspace_tracker.test.ts` for patching metadata.
   - Add command tests for `workspace update` and list output formats (likely under `src/rmplan/commands/` with ModuleMocker + temp tracking file).
   - Add tests for shell integration output string (bash/zsh) to ensure formatting and quoting stability.
   - Update or add tests for agent description updates (mock tracking file and plan data) if feasible.

8. Docs
   - Update README with the new workspace switcher workflow and shell integration usage.
   - Optionally add a short section to `docs/multi-workspace-workflow.md` referencing `workspace update` and the shell switcher function.

## Tasks 1, 2, and 4 Implementation (workspace metadata, list data model, update command)

### Task 1: Extend workspace metadata storage + patch helper

**Files Modified:**
- `src/rmplan/workspace/workspace_tracker.ts`

**Changes:**
1. Extended the `WorkspaceInfo` interface with new optional fields for backward compatibility:
   - `name?: string` - Human-readable workspace name
   - `description?: string` - Description of current work
   - `planId?: string` - Associated plan ID
   - `planTitle?: string` - Title of the associated plan
   - `issueUrls?: string[]` - Issue URLs associated with the workspace
   - `updatedAt?: string` - ISO timestamp for when metadata was last updated

2. Added `WorkspaceMetadataPatch` interface for partial updates containing all patchable fields.

3. Added `patchWorkspaceMetadata(workspacePath: string, patch: WorkspaceMetadataPatch)` function that:
   - Reads the current workspaces tracking file
   - Finds existing workspace by normalized path or creates a new entry with minimal required fields
   - Merges the patch into the workspace entry without clobbering unspecified fields
   - Handles empty strings as explicit clears (deletes the field from the entry)
   - Always sets `updatedAt` timestamp
   - Writes back to the tracking file

**Tests Added:**
- 16 new tests in `workspace_tracker.test.ts` covering: updating existing workspaces, creating new entries for untracked directories, clearing fields with empty strings, preserving unmodified fields, handling all metadata fields including planId/planTitle/issueUrls/repositoryUrl.

### Task 2: Add VCS-aware branch helper + list data model

**Files Modified:**
- `src/rmplan/workspace/workspace_tracker.ts`

**Changes:**
1. Leveraged the existing `getCurrentBranchName()` function from `src/common/git.ts` which already supports both git and jj (returns first bookmark for jj repositories).

2. Added `WorkspaceListEntry` interface containing:
   - `fullPath` - Full absolute path to workspace
   - `basename` - Directory basename for display
   - `name`, `description` - Metadata fields
   - `branch` - Current branch/bookmark (computed live)
   - `taskId`, `planTitle`, `planId`, `issueUrls` - Plan-related metadata
   - `repositoryUrl`, `lockedBy`, `createdAt`, `updatedAt` - Other tracking fields

3. Added `buildWorkspaceListEntries(workspaces: WorkspaceWithLockInfo[])` function that:
   - Filters out workspaces with missing directories (directory no longer exists)
   - Gets live branch info for each workspace using `getCurrentBranchName()`
   - Returns an array of structured `WorkspaceListEntry` objects ready for display

**Tests Added:**
- 6 tests in `workspace_tracker.test.ts` covering: empty input, filtering missing directories, proper field mapping, handling missing optional fields, preserving lock info, filtering non-directory paths.

### Task 4: Workspace update command

**Files Modified:**
- `src/rmplan/rmplan.ts` - Added command registration
- `src/rmplan/commands/workspace.ts` - Added handler and helper functions

**Command Registration:**
Added `rmplan workspace update [workspaceIdentifier]` command with options:
- `--name <name>` - Set workspace name (empty string to clear)
- `--description <description>` - Set workspace description (empty string to clear)
- `--from-plan <planId>` - Seed description from a plan file

**Handler Implementation:**
`handleWorkspaceUpdateCommand()` resolves the workspace identifier in order:
1. If a path is provided and exists as a directory, use that path
2. If it looks like a task ID, look up the workspace tracking entry by taskId
3. If no identifier provided, use the current working directory
4. If target doesn't exist and can't be resolved, throws an error

The handler then validates that at least one update option is provided and uses `patchWorkspaceMetadata()` to apply the changes.

**Helper Functions (exported for Task 5 reuse):**
- `extractIssueNumber(url: string)` - Extracts issue number from GitHub, GitLab, Linear, and Jira URLs. Returns formats like `#123` for GitHub/GitLab or `PROJ-123` for Linear/Jira.
- `buildDescriptionFromPlan(plan: PlanSummary)` - Builds a description string from plan data in format `#issueNumber planTitle` or just `planTitle` if no issue URL.

**Tests Added:**
- 16 new tests in `workspace.update.test.ts` covering: updating by path, by task ID, current directory fallback, creating entries for untracked directories, clearing fields, error cases (no options, invalid path, unknown task ID, multiple workspaces for task ID), and --from-plan functionality with various issue URL formats.

## Tasks 3 and 6 Implementation (workspace list output formats, shell integration)

### Task 3: Workspace list output formats + repo scope

**Files Modified:**
- `src/rmplan/commands/workspace.ts` - Added output formatting logic
- `src/rmplan/rmplan.ts` - Updated command options

**Changes:**
1. Enhanced `handleWorkspaceListCommand()` with new options:
   - `--format table|tsv|json` (default: table)
   - `--no-header` - Omit header row for machine consumption
   - `--all` - List workspaces across all repositories instead of filtering to current repo

2. Implemented three output formatters in `workspace.ts`:
   - `outputWorkspaceTable()` - Human-readable table with abbreviated paths using the existing formatWorkspacePath helper, showing name, description, branch, and lock status
   - `outputWorkspaceTsv()` - Tab-separated format with field order: fullPath, basename, name, description, branch, taskId, planTitle, issueUrls. Lock status is intentionally omitted per requirements. Issue URLs are joined by comma.
   - `outputWorkspaceJson()` - Full WorkspaceListEntry metadata in JSON format, also omitting lockedBy field

3. Added `removeAllMissingWorkspaceEntries()` function to clean up stale workspace entries across all repositories when using `--all` flag, maintaining consistency with the repo-filtered behavior.

4. Edge case handling: When no workspaces exist, table shows a message, JSON outputs empty array, TSV outputs header only (if showHeader is true).

### Task 6: Shell integration command + docs

**Files Modified:**
- `src/rmplan/commands/workspace.ts` - Added shell integration handler
- `src/rmplan/rmplan.ts` - Registered shell-integration subcommand
- `README.md` - Added workspace switcher usage documentation
- `docs/multi-workspace-workflow.md` - Added shell integration setup instructions

**Changes:**
1. Added `rmplan workspace shell-integration --shell bash|zsh` command (default: zsh)

2. Implemented `generateShellFunction(shell: 'bash' | 'zsh')` that creates a shell function named `rmplan_ws`:
   - Checks for fzf availability with `command -v fzf`
   - Calls `rmplan workspace list --format tsv --no-header`
   - Uses fzf with `--delimiter '\t' --with-nth '2..'` to hide full path from display while keeping basename, name, description, branch, etc. visible for fuzzy matching
   - Shows preview window displaying: Path (field 1), Name (field 3), Description (field 4), Branch (field 5)
   - Accepts optional query argument: `rmplan_ws <query>` passes to `fzf --query`
   - Handles cancellation (exit code 130) by returning silently
   - Extracts full path (first TSV field) using cut and runs `cd`

3. Shell-specific handling:
   - Both bash and zsh use the same function body
   - Added usage instructions in function header

**Tests Added:**
- 22 tests in `workspace.list.test.ts` covering all output formats, header options, repository filtering, --all flag behavior, stale entry cleanup, empty workspace handling, and shell integration function generation for both bash and zsh

**Documentation Updates:**
- README.md: Added workspace switcher section explaining the shell integration setup and usage
- docs/multi-workspace-workflow.md: Added detailed instructions for sourcing the shell function and using rmplan_ws

## Task 5 Implementation: Agent Auto-Description Updates

### Files Modified
- `src/rmplan/commands/agent/agent.ts` - Added the auto-description update functionality
- `src/rmplan/commands/agent/agent.workspace_description.test.ts` - New test file with 5 comprehensive tests

### Implementation Details

Added `updateWorkspaceDescriptionFromPlan(baseDir, planData, config)` function that:

1. **Checks if workspace is tracked**: Uses `getWorkspaceMetadata()` to verify the current directory is a tracked workspace. If not tracked, silently returns without error.

2. **Builds description**: Uses the existing `buildDescriptionFromPlan()` helper which formats as `#issueNumber title` when an issue URL exists, or just the title otherwise. For example: `#456 Implement Feature X` or `Refactor Module`.

3. **Gets combined title**: Uses `getCombinedTitleFromSummary()` to properly combine project and phase titles when applicable (e.g., `Project X - Phase 1`).

4. **Updates workspace metadata**: Calls `patchWorkspaceMetadata()` to update:
   - `description`: The formatted description string
   - `planId`: The plan's ID if available
   - `planTitle`: The combined title from the plan
   - `issueUrls`: Array of issue URLs from the plan

5. **Error handling**: Entire function is wrapped in try/catch. On failure, logs a warning using `warn()` but does not abort agent execution.

### Function Call Location

The function is called at line 297 in agent.ts, immediately after `readPlanFile(currentPlanFile, true)` succeeds. This ensures:
- The plan data is available
- `currentBaseDir` is already set to the workspace directory
- The update happens on every agent run as required

### Test Coverage

Created 5 tests covering:
1. Updates workspace description with issue number format (`#456 Implement Feature X`)
2. Updates description without issue URL (just the title)
3. Silently skips when workspace is not tracked (no warning issued)
4. Warns but does not fail when update errors occur
5. Correctly combines project title with phase title (`#111 Project X - Phase 1`)

All tests pass. Type checking passes. The implementation reuses existing helpers (`buildDescriptionFromPlan`, `extractIssueNumber`, `getCombinedTitleFromSummary`, `patchWorkspaceMetadata`, `getWorkspaceMetadata`) to maintain consistency with the workspace update command.

Fixed workspace switcher repo identity and metadata handling across list/update/agent flows (Tasks: Extend workspace metadata storage + patch helper; Workspace list output formats + repo scope; Workspace update command; Agent auto-description updates). In src/rmplan/commands/workspace.ts I replaced direct git remote probing with getRepositoryIdentity-based resolution (determineRepositoryUrl now returns remoteUrl or repositoryId), so list/lock-available work in jj/no-origin repos, and update now seeds repositoryUrl when missing by resolving identity for the target path. I also updated from-plan handling to explicitly clear stale planId/issueUrls when absent (planId set to empty string, issueUrls to []), and to normalize planTitle so old values don’t linger. In src/rmplan/commands/agent/agent.ts I aligned the auto-description update to clear missing planId/issueUrls and to clear planTitle when empty, ensuring the description is derived only from current plan content. For cleanup, I introduced a directory status check in workspace list cleanup to treat non-ENOENT stat errors as unknown (warn but keep entries) so transient permission/mount errors don’t delete tracked workspaces. In src/rmplan/workspace/workspace_tracker.ts I made patchWorkspaceMetadata derive a taskId from planId when creating new entries (task-<planId>), keeping task IDs aligned with plan identifiers when updates create tracking entries. Tests were updated and expanded: workspace.list.test.ts now mocks getRepositoryIdentity, adds coverage for no-origin fallback and for stat-error cleanup; workspace.lock.test.ts adds a no-origin lock-available test; workspace.update.test.ts now verifies repositoryUrl is set for new entries and stale plan/issue metadata is cleared; workspace_tracker.test.ts covers planId-derived taskIds; agent.workspace_description.test.ts ensures issue-less plans don’t retain prefixes and that stale metadata is cleared. These changes integrate with existing workspace tracking (WorkspaceInfo), list output (WorkspaceListEntry), and agent flow (rmplanAgent) without altering other behavior.

Implemented reviewer fix for auto workspace selection in the workspace switcher (tasks: Workspace list output formats + repo scope; Workspace update command; Agent auto-description updates). Updated src/rmplan/workspace/workspace_auto_selector.ts to use getRepositoryIdentity with cwd set to the main repo root and to select the repository key via remoteUrl or repositoryId instead of shelling out to git remote, so jj-only or no-origin repositories still match tracked workspace entries. Added coverage in src/rmplan/workspace/workspace_auto_selector.test.ts for the origin-missing/jj-style identity path by mocking getRepositoryIdentity, asserting findWorkspacesByRepoUrl receives the repositoryId, and verifying an unlocked workspace is selected; also set RMPLAN_LOCK_DIR per test so WorkspaceLock files stay in a temp directory. This keeps auto-selection aligned with the repository identity fallback already used in workspace list/update flows and avoids returning null when git remote commands fail.
