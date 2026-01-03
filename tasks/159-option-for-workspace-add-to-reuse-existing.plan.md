---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: option for workspace add to reuse existing workspace
goal: ""
id: 159
uuid: 2e7fd645-2945-4e49-a485-3cf5a4ba81ff
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-01-04T01:53:28.667Z
promptsGeneratedAt: 2026-01-04T01:53:28.667Z
createdAt: 2026-01-02T19:34:21.192Z
updatedAt: 2026-01-04T01:53:28.667Z
tasks:
  - title: Add CLI options to workspace add command
    done: false
    description: Add `--reuse`, `--try-reuse`, and `--from-branch` options to the
      workspace add command in `src/rmplan/rmplan.ts`. Include validation that
      `--reuse` and `--try-reuse` are mutually exclusive.
  - title: Add branch field to WorkspaceMetadataPatch interface
    done: false
    description: Update `WorkspaceMetadataPatch` interface in
      `src/rmplan/workspace/workspace_tracker.ts` to include an optional
      `branch` field so it can be updated when reusing workspaces.
  - title: Implement findUniqueBranchName utility function
    done: false
    description: Create a function in `workspace_manager.ts` that checks if a branch
      name exists and auto-suffixes it (`-2`, `-3`, etc.) until finding a unique
      name. Support both Git (`git rev-parse --verify`) and Jujutsu (`jj
      bookmark list`) for branch existence checks.
  - title: Implement prepareExistingWorkspace function
    done: false
    description: >-
      Create `prepareExistingWorkspace()` in
      `src/rmplan/workspace/workspace_manager.ts` that:

      1. Detects VCS type (git vs jj)

      2. Fetches latest from remote (`git fetch origin` / `jj git fetch`) -
      abort on failure unless `ALLOW_OFFLINE` env var is set

      3. Determines base branch using `getTrunkBranch()` or `--from-branch`
      option

      4. Checks out base branch (`git checkout` / `jj new`)

      5. Finds unique branch name using auto-suffix if needed

      6. Creates new branch (`git checkout -b` / `jj bookmark set`)


      Return the actual branch name used (may include suffix).
  - title: Implement tryReuseExistingWorkspace helper function
    done: false
    description: >-
      Create helper function in `src/rmplan/commands/workspace.ts` that:

      1. Finds repository ID using `determineRepositoryId()`

      2. Removes missing workspace entries

      3. Finds available workspaces (unlocked AND clean - no uncommitted
      changes)

      4. If available workspace found: call `prepareExistingWorkspace()`,
      acquire lock, update metadata via `patchWorkspaceMetadata()`, copy plan
      file if needed

      5. Return success/failure boolean
  - title: Modify handleWorkspaceAddCommand to support reuse flags
    done: false
    description: >-
      Update `handleWorkspaceAddCommand()` in `src/rmplan/commands/workspace.ts`
      to:

      1. Validate `--reuse` and `--try-reuse` are mutually exclusive

      2. If either flag is set, call `tryReuseExistingWorkspace()`

      3. If reuse succeeds, handle remaining logic (issue import, plan claiming,
      etc.) and return

      4. If reuse fails with `--reuse`, throw error

      5. If reuse fails with `--try-reuse`, fall through to normal workspace
      creation
  - title: Write tests for prepareExistingWorkspace function
    done: false
    description: |-
      Add tests in `src/rmplan/workspace/workspace_manager.test.ts` covering:
      - Successfully fetches, checks out base, creates branch (Git)
      - Successfully fetches, creates new change with bookmark (Jujutsu)
      - Fetch failure aborts by default
      - Fetch failure continues with warning when ALLOW_OFFLINE is set
      - Handles checkout failure
      - Handles branch creation failure
      - Uses specified `--from-branch` instead of auto-detected trunk
      - Auto-suffixes branch name when it already exists
  - title: Write tests for workspace reuse in handleWorkspaceAddCommand
    done: false
    description: |-
      Add tests in `src/rmplan/commands/workspace.test.ts` covering:
      - Finds and reuses available workspace
      - Skips workspaces with uncommitted changes
      - `--reuse` fails when no workspace available
      - `--try-reuse` creates new workspace when none available
      - Validates `--reuse` and `--try-reuse` are mutually exclusive
      - Copies plan file to reused workspace
      - Updates workspace metadata (including branch field)
      - Locks the reused workspace
      - Works with `--issue` option
      - Works with `--from-branch` option
tags: []
---

This should work similarly to the `workspace lock` command, in that it can find and reuse an existing workspace if there is one available that is unlocked.

In this case, we also want to make sure the reused workspace is up to date:
- `jj git fetch` or `git pull`
- `jj new main` or `git checkout main`
- And then create the new branch and do everything else we tend to do

We should also add a `--from-branch` argument which allows it to create the new branch off of a different base instead of main.

## Expected Behavior/Outcome

Two new flags for `rmplan workspace add`:

### `--reuse` (strict mode)
Reuses an existing unlocked workspace. **Fails if no suitable workspace is available.**

### `--try-reuse` (fallback mode)
Tries to reuse an existing workspace. If none available, **falls back to creating a new workspace**.

### Common behavior for both flags:

1. **Find an available workspace**: Search for an existing unlocked, clean workspace for the same repository
2. **Prepare the workspace**: Update the workspace to the latest state:
   - Fetch latest changes from remote (`git fetch origin` or `jj git fetch`)
   - Checkout the base branch (`git checkout main` or `jj new main`)
3. **Create a new branch**: Create and checkout a new branch from the base (same as normal workspace add)
4. **Update workspace metadata**: Update the workspace tracking info with the new plan details
5. **Lock the workspace**: Acquire a lock on the reused workspace

The `--from-branch` option allows specifying a different base branch instead of the detected trunk branch (main/master).

## Key Findings

### Product & User Story

**As a developer**, I want to reuse an existing workspace when adding a new task, so that I can avoid the overhead of cloning the repository each time, especially for large repositories.

**User workflow:**
```bash
# Reuse an existing workspace (fails if none available)
rmplan workspace add 42 --reuse

# Try to reuse, create new if none available
rmplan workspace add 42 --try-reuse

# Reuse with a custom base branch
rmplan workspace add 42 --reuse --from-branch feature/base

# Try reuse with issue import
rmplan workspace add --issue DF-1234 --try-reuse
```

### Design & UX Approach

- **`--reuse` flag**: Strict mode - reuse existing workspace, fail if none available
- **`--try-reuse` flag**: Fallback mode - try to reuse, create new if unavailable
- **`--from-branch <branch>` option**: Specify alternate base branch for the new working branch
- **Status feedback**: Clear logging of what's happening (reusing workspace X, fetching, checking out, etc.)
- **Dirty workspace handling**: Skip workspaces with uncommitted changes (treat as unavailable, like locked workspaces)

### Technical Plan & Risks

**Implementation approach:**
1. Add `--reuse`, `--try-reuse`, and `--from-branch` flags to the workspace add command
2. Create `prepareExistingWorkspace()` function in workspace_manager.ts that handles:
   - Fetching latest from remote (git/jj aware)
   - Checking out the base branch (git/jj aware)
   - Creating and checking out the new branch
3. Modify `handleWorkspaceAddCommand()` to use existing workspace finding logic from `lockAvailableWorkspace()`
4. Update workspace tracking metadata when reusing

**Risks:**
- **Dirty workspaces**: Skip workspaces with uncommitted changes (treat as unavailable)
- **Jujutsu compatibility**: Need to test both git and jj paths thoroughly
- **Branch conflicts**: Auto-suffix branch names when they already exist (e.g., `task-42-2`)
- **Metadata update**: Need to properly update planId, planTitle, etc. in tracking file (taskId stays unchanged)

### Pragmatic Effort Estimate

This is a medium-complexity feature touching:
- CLI argument parsing (straightforward)
- New workspace preparation logic (moderate complexity - git/jj dual support)
- Integration with existing workspace selection logic (reuse from lockAvailableWorkspace)
- Metadata update logic (straightforward using existing patchWorkspaceMetadata)

## Acceptance Criteria

- [ ] `--reuse` flag finds and reuses an unlocked workspace, fails if none available
- [ ] `--try-reuse` flag finds and reuses an unlocked workspace, creates new if none available
- [ ] Reused workspaces are updated (fetched, checked out to base, new branch created)
- [ ] `--from-branch` option allows specifying an alternate base branch
- [ ] Workspaces with uncommitted changes are skipped (treated as unavailable)
- [ ] Workspace metadata is updated to reflect the new plan/task association
- [ ] Lock is acquired on the reused workspace
- [ ] Both Git and Jujutsu repositories are supported
- [ ] All new code paths are covered by tests

## Dependencies & Constraints

**Dependencies:**
- Existing `lockAvailableWorkspace()` logic for finding available workspaces
- Existing `WorkspaceLock` system for lock acquisition
- Existing `patchWorkspaceMetadata()` for updating tracking info
- Existing `getTrunkBranch()` for determining default base branch
- Existing `getUsingJj()` for git/jj detection

**Technical Constraints:**
- Must support both Git and Jujutsu repositories
- Must not lose uncommitted work in existing workspaces
- Must properly clean up locks if operation fails partway through

## Research

### Workspace Command Structure

The workspace commands are defined in `src/rmplan/rmplan.ts` (lines 962-1033) and implemented in `src/rmplan/commands/workspace.ts`. The relevant subcommands are:

- **`workspace add`**: Creates a new workspace (lines 354-570)
- **`workspace lock`**: Locks a workspace, with `--available` flag to find and lock an unlocked one (lines 572-618)

### Current `handleWorkspaceAddCommand` Implementation

Location: `src/rmplan/commands/workspace.ts:354-570`

The function:
1. Loads configuration and validates workspace creation is enabled
2. Parses issue input if `--issue` provided
3. Determines workspace ID (from options, issue, or plan)
4. Resolves plan file if identifier provided
5. Calls `createWorkspace()` to clone/copy the repository
6. Imports issue into workspace if applicable
7. Updates plan status to in_progress
8. Claims the plan

### `lockAvailableWorkspace` Function - Key Logic to Reuse

Location: `src/rmplan/commands/workspace.ts:692-735`

This function demonstrates the pattern for finding and selecting an available workspace:

```typescript
async function lockAvailableWorkspace(
  config: RmplanConfig,
  trackingFilePath: string | undefined,
  options: { create?: boolean }
): Promise<void> {
  const repositoryId = await determineRepositoryId();
  await removeMissingWorkspaceEntries(repositoryId, trackingFilePath);

  const workspaces = await findWorkspacesByRepositoryId(repositoryId, trackingFilePath);
  const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);
  const available = workspacesWithStatus.find((workspace) => !workspace.lockedBy);

  if (available) {
    await WorkspaceLock.acquireLock(available.workspacePath, ...);
    // Use available workspace
    return;
  }

  if (!options.create) {
    throw new Error('No available workspace found.');
  }

  // Create new workspace as fallback
}
```

### Workspace Creation Logic

Location: `src/rmplan/workspace/workspace_manager.ts:429-721`

The `createWorkspace()` function:
1. Validates config and determines source (repository URL or source directory)
2. Sets up clone location and target directory path
3. Clones/copies using selected method (git, cp, mac-cow)
4. Sets up git remote for copy methods
5. **Creates and checks out new branch** (lines 575-600):
   ```typescript
   if (shouldCreateBranch) {
     const { exitCode, stderr } = await spawnAndLogOutput(['git', 'checkout', '-b', branchName], {
       cwd: targetClonePath,
     });
   }
   ```
6. Copies plan file to workspace
7. Runs post-clone commands
8. Records workspace in tracking file
9. Acquires lock

### Git/Jujutsu Detection and Operations

Location: `src/common/git.ts`

**Detection:**
- `getUsingJj()`: Checks for `.jj` directory in repo root, returns cached boolean
- `isInGitRepository()`: Non-cached check for `.git` or `.jj` directory

**Trunk Branch Detection:**
- `getTrunkBranch(gitRoot)`: Returns 'main', 'master', 'trunk', or 'default' based on what exists
  - For jj: uses `jj bookmark list` to find candidates
  - For git: uses `git branch --list main master`

**Uncommitted Changes Detection:**
- `hasUncommittedChanges(cwd)`: Returns true if working directory has changes
- For jj: uses `jj diff`
- For git: uses `git status --porcelain`

### Workspace Tracking

Location: `src/rmplan/workspace/workspace_tracker.ts`

Key functions:
- `recordWorkspace(info, trackingFilePath)`: Adds/updates workspace in tracking file
- `findWorkspacesByRepositoryId(repoId, trackingFilePath)`: Finds workspaces for a repo
- `updateWorkspaceLockStatus(workspaces)`: Enriches with current lock status
- `patchWorkspaceMetadata(path, patch, trackingFilePath)`: Partial update of metadata

**WorkspaceInfo structure:**
```typescript
interface WorkspaceInfo {
  taskId: string;
  originalPlanFilePath?: string;
  repositoryId?: string;
  workspacePath: string;
  branch?: string;
  createdAt: string;
  name?: string;
  description?: string;
  planId?: string;
  planTitle?: string;
  issueUrls?: string[];
  updatedAt?: string;
}
```

### Workspace Auto Selector

Location: `src/rmplan/workspace/workspace_auto_selector.ts`

The `WorkspaceAutoSelector` class provides a pattern for workspace selection:
1. Gets repository ID from current git repo
2. Finds existing workspaces for the repository
3. Sorts by lock status and creation date
4. Returns first unlocked workspace
5. Handles stale locks (interactive prompt or auto-clear)
6. Falls back to creating new workspace

### Git/Jujutsu Commands for Workspace Preparation

For preparing an existing workspace, we need:

**Git:**
```bash
git fetch origin              # Fetch latest from remote
git checkout main             # Switch to base branch (or specified branch)
git checkout -b <new-branch>  # Create and checkout new branch
```

**Jujutsu:**
```bash
jj git fetch                  # Fetch latest from remote
jj new main                   # Create new change off of main (or specified branch)
# jj creates new "changes" rather than traditional branches
# The new change becomes the working copy
```

Note: For jj, there's no direct equivalent to `git checkout -b`. The `jj new` command creates a new change based on the specified revision. If we want to associate a bookmark (branch) with it, we'd use:
```bash
jj bookmark set <bookmark-name>  # Associate current change with a bookmark
```

## Implementation Guide

### Step 1: Add CLI Options to `workspace add` Command

Location: `src/rmplan/rmplan.ts` (around line 978)

Add the new options to the workspace add command definition:
```typescript
.option('--reuse', 'Reuse an existing unlocked workspace (fails if none available)')
.option('--try-reuse', 'Try to reuse an existing workspace, create new if unavailable')
.option('--from-branch <branch>', 'Create new branch from this base instead of main/master')
```

Note: `--reuse` and `--try-reuse` are mutually exclusive - validate this in the handler.

### Step 2: Create `prepareExistingWorkspace` Function

Location: `src/rmplan/workspace/workspace_manager.ts`

Create a new exported function that handles preparing an existing workspace for reuse:

```typescript
export interface PrepareWorkspaceOptions {
  baseBranch?: string;  // Branch to checkout before creating new branch
  branchName: string;   // Name of new branch to create
  interactive?: boolean; // Whether to prompt for dirty workspace handling
}

export interface PrepareWorkspaceResult {
  success: boolean;
  error?: string;
  previousBranch?: string;
}

export async function prepareExistingWorkspace(
  workspacePath: string,
  options: PrepareWorkspaceOptions
): Promise<PrepareWorkspaceResult>
```

Implementation steps within this function:
1. **Detect VCS type** by checking for `.jj` directory in workspacePath
2. **Fetch latest from remote:**
   - Git: `git fetch origin`
   - Jujutsu: `jj git fetch`
   - If fetch fails: abort with error unless `ALLOW_OFFLINE` env var is set (then log warning and continue)
3. **Determine base branch** using `getTrunkBranch(workspacePath)` if not specified in options
4. **Checkout base branch:**
   - Git: `git checkout <base-branch>`
   - Jujutsu: `jj new <base-branch>`
5. **Create new branch:**
   - Git: `git checkout -b <branchName>`
   - Jujutsu: `jj bookmark set <branchName>` (after `jj new` already created the change)
6. Return success result

Note: The dirty workspace check happens during workspace selection (before calling this function), not inside this function. Dirty workspaces are filtered out as "unavailable" alongside locked workspaces.

Use `spawnAndLogOutput` for all git/jj commands, respecting the `cwd` parameter.

### Step 3: Modify `handleWorkspaceAddCommand` to Support Reuse

Location: `src/rmplan/commands/workspace.ts:354-570`

After loading configuration (around line 363), add logic to handle `--reuse` and `--try-reuse`:

```typescript
// Validate mutually exclusive options
if (options.reuse && options.tryReuse) {
  throw new Error('Cannot use both --reuse and --try-reuse');
}

const shouldTryReuse = options.reuse || options.tryReuse;

if (shouldTryReuse) {
  const result = await tryReuseExistingWorkspace(
    config,
    globalOpts.config,
    planIdentifier,
    options,
    issueInfo,
    customBranchName
  );
  if (result) {
    // Reuse successful - handle remaining logic (plan copy, issue import, etc.)
    return;
  }

  // No workspace available
  if (options.reuse) {
    throw new Error('No available workspace found for reuse');
  }

  // --try-reuse: fall through to normal workspace creation
  log('No available workspace found, creating new workspace...');
}
```

Create helper function `tryReuseExistingWorkspace`:

```typescript
async function tryReuseExistingWorkspace(
  config: RmplanConfig,
  configPath: string | undefined,
  planIdentifier: string | undefined,
  options: any,
  issueInfo: ParsedIssueInput | null,
  customBranchName: string | undefined
): Promise<boolean>
```

This function should:
1. Find repository ID using `determineRepositoryId()`
2. Remove missing workspace entries using `removeMissingWorkspaceEntries()`
3. Find available workspaces using existing logic from `lockAvailableWorkspace()`
4. If available workspace found:
   - Call `prepareExistingWorkspace()` with appropriate options
   - If preparation fails, log warning and return false (fall back to new workspace)
   - Acquire lock on the workspace
   - Update workspace metadata using `patchWorkspaceMetadata()` with new taskId, planId, etc.
   - Copy plan file to workspace if planIdentifier provided
   - Return true
5. If no available workspace, return false

### Step 4: Handle Plan File Copying for Reused Workspaces

When reusing a workspace, we need to copy the plan file to the workspace. Extract the plan copying logic from `createWorkspace` into a reusable function:

```typescript
export async function copyPlanToWorkspace(
  originalPlanFilePath: string,
  mainRepoRoot: string,
  workspacePath: string
): Promise<string | null>  // Returns path in workspace, or null on failure
```

This already exists partially in `createWorkspace` (lines 602-626) - extract and reuse.

### Step 5: Update Workspace Metadata on Reuse

Use `patchWorkspaceMetadata` to update the tracking file with new information:

```typescript
await patchWorkspaceMetadata(
  workspacePath,
  {
    name: planData?.title || issueInfo?.identifier,
    description: buildDescriptionFromPlan(planData),
    planId: planData?.id?.toString(),
    planTitle: planData?.title,
    branch: actualBranchName,  // Update to the new branch (may include auto-suffix)
    // Note: taskId in WorkspaceInfo is fixed at creation time
  },
  trackingFilePath
);
```

Note: The `branch` field needs to be added to `WorkspaceMetadataPatch` interface in `workspace_tracker.ts`.

### Step 6: Handle Branch Name Conflicts

Before creating the new branch, check if it already exists and auto-suffix if needed:

**Git:**
```bash
git rev-parse --verify <branchName>  # Returns 0 if branch exists
```

**Jujutsu:**
```bash
jj bookmark list | grep "^<branchName>"
```

If branch exists, append suffix (`-2`, `-3`, etc.) until a unique name is found:

```typescript
async function findUniqueBranchName(
  workspacePath: string,
  baseName: string,
  isJj: boolean
): Promise<string> {
  let candidate = baseName;
  let suffix = 2;

  while (await branchExists(workspacePath, candidate, isJj)) {
    candidate = `${baseName}-${suffix}`;
    suffix++;
  }

  return candidate;
}
```

Log when a suffix is added so the user knows the actual branch name used.

### Step 7: Write Tests

Location: `src/rmplan/workspace/workspace_manager.test.ts` and `src/rmplan/commands/workspace.test.ts`

Tests should cover:

1. **`prepareExistingWorkspace` function:**
   - Successfully fetches, checks out base, creates branch (Git)
   - Successfully fetches, creates new change with bookmark (Jujutsu)
   - Fetch failure aborts by default
   - Fetch failure continues with warning when `ALLOW_OFFLINE` env var is set
   - Handles checkout failure
   - Handles branch creation failure
   - Uses specified `--from-branch` instead of auto-detected trunk
   - Auto-suffixes branch name when it already exists (e.g., `task-42` → `task-42-2`)

2. **`handleWorkspaceAddCommand` with `--reuse` and `--try-reuse`:**
   - Finds and reuses available workspace
   - Skips workspaces with uncommitted changes (treats as unavailable)
   - `--reuse` fails when no workspace available
   - `--try-reuse` creates new workspace when none available
   - Validates `--reuse` and `--try-reuse` are mutually exclusive
   - Copies plan file to reused workspace
   - Updates workspace metadata
   - Locks the reused workspace
   - Works with `--issue` option
   - Works with `--from-branch` option

3. **Integration tests:**
   - End-to-end test of `rmplan workspace add <plan> --reuse`
   - Verify workspace state after reuse (correct branch, fetched content)

### Manual Testing Steps

1. Create a workspace normally: `rmplan workspace add 1`
2. Unlock the workspace: `rmplan workspace unlock <path>`
3. Reuse with a new task: `rmplan workspace add 2 --reuse`
4. Verify:
   - Same workspace path is used
   - New branch was created
   - Workspace is locked
   - Workspace metadata updated with task 2

5. Test with dirty workspace:
   - Make changes in one workspace without committing
   - Have another clean, unlocked workspace available
   - Run `rmplan workspace add 3 --reuse`
   - Should skip the dirty workspace and use the clean one

6. Test `--reuse` failure mode:
   - Lock all existing workspaces (or have only dirty ones)
   - Run `rmplan workspace add 4 --reuse`
   - Should fail with error "No available workspace found for reuse"

7. Test `--try-reuse` fallback:
   - Lock all existing workspaces
   - Run `rmplan workspace add 4 --try-reuse`
   - Should create new workspace

8. Test with `--from-branch`:
   - `rmplan workspace add 5 --reuse --from-branch develop`
   - Verify new branch is created off `develop`

9. Test mutual exclusivity:
   - Run `rmplan workspace add 6 --reuse --try-reuse`
   - Should fail with error about mutually exclusive options

### Potential Gotchas

1. **Jujutsu bookmark handling**: In jj, branches are "bookmarks" and work differently. `jj new main` creates a new change at main, but doesn't automatically create a bookmark. Need to explicitly set bookmark with `jj bookmark set`.

2. **Dirty workspace detection**: When filtering workspaces, need to check `hasUncommittedChanges()` for each candidate. This adds some overhead but ensures we don't disrupt work-in-progress.

3. **Workspace tracking updates**: The `taskId` in `WorkspaceInfo` is set at creation time and remains unchanged on reuse (it's effectively a workspace ID). Only update the display fields (`name`, `planTitle`, `planId`, `description`).

4. **Lock acquisition timing**: Must acquire lock before making changes to prevent race conditions. If preparation fails, must release lock.

5. **Remote branch fetch**: If the base branch doesn't exist locally, `git checkout` will fail. May need `git fetch origin <branch>:<branch>` or similar.

6. **Jj colocated repos**: Some jj repos are "colocated" with git (have both `.jj` and `.git`). The detection logic using `getUsingJj()` should handle this, but test thoroughly.
