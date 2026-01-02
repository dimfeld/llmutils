---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: workspace switcher should run outside a project
goal: ""
id: 156
uuid: 6dc6b938-bac2-460e-8d69-58eb913b8acb
status: done
priority: medium
createdAt: 2026-01-02T01:08:14.981Z
updatedAt: 2026-01-02T01:56:19.247Z
tasks:
  - title: Add isInGitRepository utility function
    done: true
    description: >
      Add a new `isInGitRepository(cwd?: string): Promise<boolean>` function to
      `src/common/git.ts`.

      This function should check if the given directory (or cwd) is inside a Git
      or Jujutsu repository

      by verifying that a `.git` directory/file or `.jj` directory exists at the
      git root returned by

      `getGitRoot()`. Follow the existing pattern used by `getUsingJj()`.
  - title: Add quiet option to loadEffectiveConfig
    done: true
    description: >
      Modify `loadEffectiveConfig()` in `src/rmplan/configLoader.ts` to accept
      an optional second

      parameter `options: { quiet?: boolean }`. When `quiet: true`, suppress the
      'Using external

      rmplan storage at ...' log message on line 264.
  - title: Modify handleWorkspaceListCommand for outside-repo behavior
    done: true
    description: >
      Update `handleWorkspaceListCommand()` in
      `src/rmplan/commands/workspace.ts` to:

      1) Import `isInGitRepository` from `../../common/git.js`

      2) Check if in a git repo before loading config

      3) Pass `{ quiet: true }` to `loadEffectiveConfig` when outside a git repo

      4) Skip `determineRepositoryId()` and set `repositoryId = undefined` when
      outside a git repo
         (equivalent to --all behavior)
  - title: Add tests for isInGitRepository function
    done: true
    description: >
      Add unit tests for the new `isInGitRepository()` function in
      `src/common/git.ts`.

      Test cases: returns true when `.git` directory exists, returns true when
      `.jj` directory exists,

      returns false when neither exists, works with different `cwd` values.
  - title: Add integration tests for workspace list outside git repo
    done: true
    description: >
      Add integration tests for `handleWorkspaceListCommand` when run outside a
      git repository.

      Test that: all workspaces are returned (not filtered by repository), no
      'Using external rmplan

      storage' message is logged, existing behavior inside a git repo is
      preserved.
changedFiles:
  - claude-plugin/skills/rmplan-usage/SKILL.md
  - src/common/git.test.ts
  - src/common/git.ts
  - src/rmplan/commands/shell-integration.test.ts
  - src/rmplan/commands/shell-integration.ts
  - src/rmplan/commands/workspace.list.test.ts
  - src/rmplan/commands/workspace.ts
  - src/rmplan/configLoader.ts
  - src/rmplan/mcp/generate_mode.ts
  - src/rmplan/rmplan.ts
tags: []
---

If we aren't in a git repository, just run as if the --all flag was passed. Also make sure to suppress the "Using
external rmplan storage" message.

## Implementation Guide

### Expected Behavior/Outcome

When running `rmplan workspace list` outside of a git repository:
- The command should automatically behave as if `--all` was passed
- The "Using external rmplan storage at ..." message should be suppressed
- All workspaces from all repositories should be listed
- No error message or confusing "No workspaces found for this repository" should appear

**User Experience:**
- User navigates to any directory outside a git repository (e.g., `~` or `/tmp`)
- User runs `rmplan workspace list`
- All tracked workspaces are shown, allowing the user to select and navigate to any workspace

### Key Findings

#### Product & User Story
The workspace switcher is a tool that helps users quickly navigate between different project workspaces. Currently, when run outside a git repository, it tries to derive a repository ID from the current directory name and filters workspaces by that ID, which typically matches nothing. This makes the tool unusable from common locations like the home directory, which is a common use case for users who want to quickly jump to a project.

#### Design & UX Approach
- Detect when not in a git repository at the start of `handleWorkspaceListCommand`
- Automatically enable `--all` behavior (skip repository filtering)
- Suppress the "Using external rmplan storage" message in this context
- This should be transparent to the user - they just get the full workspace list

#### Technical Plan & Risks
**Approach:**
1. Create a utility function `isInGitRepository(cwd?: string): Promise<boolean>` in `src/common/git.ts`
2. Modify `handleWorkspaceListCommand` in `src/rmplan/commands/workspace.ts` to check if we're in a git repo and auto-enable `--all` if not
3. Add a `quiet` option to `loadEffectiveConfig` to suppress the external storage message

**Risks:**
- Low risk overall - this is a UI/UX improvement with no changes to data handling
- The `getGitRoot()` function returns `cwd` as a fallback, so we need to be careful to detect the "not in repo" case properly

#### Pragmatic Effort Estimate
This is a small, focused change affecting 2-3 files with minimal complexity.

### Acceptance Criteria
- [ ] `rmplan workspace list` shows all workspaces when run outside a git repository
- [ ] The "Using external rmplan storage" message is not shown when running outside a git repository
- [ ] When inside a git repository without `--all`, behavior remains unchanged (filters by current repo)
- [ ] All new code paths are covered by tests

### Dependencies & Constraints
- **Dependencies**: Uses existing `getGitRoot()` function from `src/common/git.ts`
- **Technical Constraints**: Must not break existing behavior when inside a git repository

### Scope Boundaries
- **In scope**: `rmplan workspace list` command only
- **Out of scope**: `rmplan workspace lock --available` should continue to require being inside a git repository (this command is for claiming a workspace in the current project context)

### Implementation Notes

#### Recommended Approach

**Step 1: Add git repository detection utility**

File: `src/common/git.ts`

Add a new function to detect if the current directory is in a git repository. The key insight is that `getGitRoot()` returns the `cwd` as a fallback when not in a git repository, so we need to verify whether the returned path actually contains a `.git` directory (or `.jj` for Jujutsu).

```typescript
/**
 * Checks if the given directory (or cwd) is inside a Git or Jujutsu repository.
 * Returns true if a .git directory or .jj directory exists at the git root.
 */
export async function isInGitRepository(cwd = process.cwd()): Promise<boolean> {
  const gitRoot = await getGitRoot(cwd);

  // Check if .git directory exists at the root
  const hasGit = await Bun.file(path.join(gitRoot, '.git'))
    .stat()
    .then((s) => s.isDirectory() || s.isFile()) // .git can be a file for worktrees
    .catch(() => false);

  if (hasGit) return true;

  // Check if .jj directory exists at the root
  const hasJj = await Bun.file(path.join(gitRoot, '.jj'))
    .stat()
    .then((s) => s.isDirectory())
    .catch(() => false);

  return hasJj;
}
```

**Step 2: Modify workspace list command**

File: `src/rmplan/commands/workspace.ts`

Modify `handleWorkspaceListCommand()` to check if we're in a git repository before calling `loadEffectiveConfig`. If not in a git repo, enable `--all` behavior and suppress the external storage message.

Key changes in `handleWorkspaceListCommand()`:
1. Import `isInGitRepository` from `../../common/git.js`
2. Before loading config, check if we're in a git repository
3. If not in a git repo:
   - Set `repositoryId = undefined` (equivalent to `--all`)
   - Pass a `quiet` flag to `loadEffectiveConfig` to suppress the external storage message

```typescript
export async function handleWorkspaceListCommand(options: WorkspaceListOptions, command: Command) {
  const globalOpts = command.parent!.parent!.opts();

  // Check if we're in a git repository
  const inGitRepo = await isInGitRepository();

  // If not in a git repo, suppress the external storage message
  const config = await loadEffectiveConfig(globalOpts.config, { quiet: !inGitRepo });
  const trackingFilePath = config.paths?.trackingFile;

  const format: WorkspaceListFormat = options.format ?? 'table';
  const showHeader = options.header ?? true;

  // Determine repository ID (unless --all is specified OR we're outside a git repo)
  let repositoryId: string | undefined;
  if (!options.all && inGitRepo) {
    repositoryId = options.repo ?? (await determineRepositoryId());
  }
  // ... rest of function unchanged
}
```

**Step 3: Add quiet option to loadEffectiveConfig**

File: `src/rmplan/configLoader.ts`

Modify the `loadEffectiveConfig` function signature to accept an options object with a `quiet` property.

```typescript
interface LoadEffectiveConfigOptions {
  quiet?: boolean;
}

export async function loadEffectiveConfig(
  overridePath?: string,
  options: LoadEffectiveConfigOptions = {}
): Promise<RmplanConfig> {
  // ... existing code ...

  // Only log the external storage message if not in quiet mode
  if (resolution.usingExternalStorage && resolution.repositoryConfigDir && !options.quiet) {
    log(`Using external rmplan storage at ${resolution.repositoryConfigDir}`);
  }

  // ... rest of function unchanged
}
```

#### Relevant Files and Modules

1. **`src/common/git.ts`** (lines 38-65):
   - Contains `getGitRoot()` function which returns the git root or falls back to `cwd`
   - Add new `isInGitRepository()` function here
   - Note the existing pattern: `getUsingJj()` checks for `.jj` directory similarly

2. **`src/rmplan/commands/workspace.ts`** (lines 55-115):
   - `handleWorkspaceListCommand()` is the main entry point
   - Line 63-67: Current logic for determining repository ID
   - Line 57: Currently calls `loadEffectiveConfig(globalOpts.config)` - needs to pass quiet option

3. **`src/rmplan/configLoader.ts`** (lines 206-273):
   - `loadEffectiveConfig()` function
   - Line 263-265: The "Using external rmplan storage" log message
   - Uses the `log()` function from `../../logging.js`

#### Existing Patterns to Follow

1. **Git detection pattern** (from `src/common/git.ts:76-87`):
   ```typescript
   export async function getUsingJj(): Promise<boolean> {
     if (typeof cachedUsingJj === 'boolean') {
       return cachedUsingJj;
     }
     const gitRoot = await getGitRoot();
     cachedUsingJj = await Bun.file(path.join(gitRoot, '.jj'))
       .stat()
       .then((s) => s.isDirectory())
       .catch(() => false);
     return cachedUsingJj;
   }
   ```

2. **Options parameter pattern** (from other functions):
   - Many functions use optional options objects as the last parameter
   - Follow the pattern of making it optional with a default empty object

#### Testing Strategy

1. **Unit test for `isInGitRepository()`**:
   - Test returns `true` when `.git` directory exists
   - Test returns `true` when `.jj` directory exists
   - Test returns `false` when neither exists
   - Test with different `cwd` values

2. **Integration test for workspace list outside git repo**:
   - Create a temporary directory that is NOT a git repo
   - Create some workspaces in tracking file
   - Run `handleWorkspaceListCommand` from that directory
   - Verify all workspaces are returned (not filtered)
   - Verify no "Using external rmplan storage" message is logged

3. **Regression test for workspace list inside git repo**:
   - Ensure existing behavior is preserved when inside a git repo
   - Verify repository filtering still works

#### Manual Testing Steps

1. Navigate to a directory outside any git repository (e.g., `/tmp` or `~`)
2. Run `rmplan workspace list`
3. Verify that all workspaces are shown
4. Verify that no "Using external rmplan storage" message appears
5. Navigate to a git repository
6. Run `rmplan workspace list`
7. Verify that only workspaces for that repository are shown
8. Run `rmplan workspace list --all`
9. Verify that all workspaces are shown

## Current Progress
### Current State
- All tasks completed and plan marked as done

### Completed (So Far)
- Added `isInGitRepository(cwd?: string)` utility function to `src/common/git.ts`
- Added `LoadEffectiveConfigOptions` interface with `quiet` option to `src/rmplan/configLoader.ts`
- Modified `handleWorkspaceListCommand()` in `src/rmplan/commands/workspace.ts` to auto-enable `--all` behavior and suppress storage message when outside a git repo
- Added 5 unit tests for `isInGitRepository` in `src/common/git.test.ts` (covering .git dir, .jj dir, worktrees, subdirectories, non-repo directories)
- Added 4 integration tests for workspace list outside git repo in `src/rmplan/commands/workspace.list.test.ts`
- All 51 workspace tests and 26 git tests pass

### Remaining
- None

### Next Iteration Guidance
- None - all tasks complete

### Decisions / Changes
- Followed existing pattern from `getUsingJj()` for the `isInGitRepository` implementation
- Used `.git` file check (not just directory) to support git worktrees
- Reviewer approved the implementation as acceptable

### Risks / Blockers
- None
