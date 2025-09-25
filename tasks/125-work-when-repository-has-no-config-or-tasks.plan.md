---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Store task files locally when repository has no config
goal: Work better with third-party projects
id: 125
generatedBy: agent
status: in_progress
priority: medium
container: false
dependencies: []
issue: []
pullRequest: []
docs: []
planGeneratedAt: 2025-09-25T09:16:20.304Z
createdAt: 2025-09-25T08:58:56.840Z
updatedAt: 2025-09-25T13:28:54.437Z
progressNotes:
  - timestamp: 2025-09-25T10:09:43.140Z
    text: Set up new git URL parsing utilities with filesystem-safe name derivation
      and switched getGitRepository() to use them with better fallbacks for
      repositories without remotes.
    source: "implementer: tasks 1-3"
  - timestamp: 2025-09-25T10:26:21.179Z
    text: parseGitRemoteUrl fails to recognize scp-style remotes without an explicit
      username (e.g. example.com:owner/repo.git), causing getGitRepository to
      return just 'repo'.
    source: "reviewer: Create Git URL Parser Module"
  - timestamp: 2025-09-25T10:46:43.221Z
    text: Added repository configuration resolver with external storage fallback,
      integrated loadEffectiveConfig metadata/logging, and updated
      resolveTasksDir plus new tests.
    source: "implementer: tasks 5-9"
  - timestamp: 2025-09-25T10:53:19.937Z
    text: Added remote-origin coverage verifying RepositoryConfigResolver and
      loadEffectiveConfig capture external storage metadata and directory
      creation.
    source: "tester: tasks 5-9"
  - timestamp: 2025-09-25T11:10:54.405Z
    text: Updated Claude and Codex executors to pass the external config directory
      when external storage is active and added tests ensuring the new arguments
      appear only in that mode.
    source: "implementer: tasks 13-16"
  - timestamp: 2025-09-25T12:19:48.805Z
    text: Created shared path_resolver helpers for plan directories and swapped
      add/promote/generate/import/renumber flows to use them so tasks now
      resolve into external storage correctly.
    source: "implementer: tasks 10-11"
  - timestamp: 2025-09-25T12:28:18.610Z
    text: Updated add/promote/import suites plus new path_resolver coverage to
      exercise external storage flows and confirmed success with `bun test`.
    source: "tester: tasks 10-11"
  - timestamp: 2025-09-25T12:53:45.734Z
    text: Enhanced external storage logging to detail config and plan locations,
      added test coverage for the message output, and documented the fallback
      workflow plus agent access in the README.
    source: "implementer: tasks 7,17,18"
  - timestamp: 2025-09-25T12:56:47.466Z
    text: Ran bun test (full suite) to cover external-storage messaging updates; all
      tests passed despite expected YAML warnings.
    source: "tester: tasks 7/18"
  - timestamp: 2025-09-25T12:59:38.108Z
    text: Found that the new external-storage status message prints the raw origin
      URL, leaking embedded credentials (tokens/usernames).
    source: "reviewer: tasks 7,17,18"
  - timestamp: 2025-09-25T13:15:16.360Z
    text: Hardened remote sanitisation to strip credentials, query strings, and
      fragments from external-storage messaging and repository directory names,
      and added targeted unit plus rmplan add integration tests to lock in the
      behaviour.
    source: "implementer: tasks 8/12"
tasks:
  - title: Create Git URL Parser Module
    done: true
    description: Create `src/common/git_url_parser.ts` with functions to parse
      various git remote URL formats and extract normalized repository
      information. Include support for GitHub, GitLab, Bitbucket, and generic
      git URLs.
    files: []
    docs: []
    steps: []
  - title: Implement Repository Name Derivation
    done: true
    description: Add `deriveRepositoryName()` function that converts parsed URLs to
      filesystem-safe directory names. Handle special characters, ensure
      uniqueness, and provide fallback for local-only repositories.
    files: []
    docs: []
    steps: []
  - title: Update getGitRepository Function
    done: true
    description: Refactor `getGitRepository()` in `src/common/git.ts` to use the new
      parser for more robust URL handling while maintaining backward
      compatibility.
    files: []
    docs: []
    steps: []
  - title: Add Comprehensive Tests
    done: true
    description: Write unit tests covering all supported URL formats, edge cases,
      and fallback scenarios. Include tests for repositories without remotes.
    files: []
    docs: []
    steps: []
  - title: Create RepositoryConfigResolver Class
    done: true
    description: Implement `src/rmplan/repository_config_resolver.ts` with methods
      for determining external config paths, checking existence, and creating
      directory structure.
    files: []
    docs: []
    steps: []
  - title: Extend Config Loading Logic
    done: true
    description: Update `loadEffectiveConfig()` in `src/rmplan/configLoader.ts` to
      use RepositoryConfigResolver when no local config exists. Add
      `isUsingExternalStorage` flag to config.
    files: []
    docs: []
    steps: []
  - title: Add User Messaging
    done: true
    description: Implement clear messaging that informs users when external
      configuration storage is being used, including the specific path being
      used.
    files: []
    docs: []
    steps: []
  - title: Create Directory Structure Tests
    done: true
    description: Add integration tests that verify directory creation, permission
      handling, and config discovery with various repository configurations.
    files: []
    docs: []
    steps: []
  - title: Update resolveTasksDir Function
    done: true
    description: Modify `resolveTasksDir()` in `src/rmplan/configSchema.ts` to check
      for external storage mode and return appropriate directory path.
    files: []
    docs: []
    steps: []
  - title: Verify Plan Operations Compatibility
    done: true
    description: Test and fix any issues with plan file operations when using
      external storage, ensuring proper path resolution for both plans and
      repository files.
    files: []
    docs: []
    steps: []
  - title: Add Path Resolution Helpers
    done: true
    description: Create helper functions to manage path resolution between
      repository files and external storage, ensuring clear separation of
      concerns.
    files: []
    docs: []
    steps: []
  - title: Create Integration Tests
    done: true
    description: Write comprehensive integration tests covering all plan commands
      with external storage, including edge cases like moving between
      repositories.
    files: []
    docs: []
    steps: []
  - title: Update Claude Code Executor
    done: true
    description: Modify `src/rmplan/executors/claude_code.ts` to add `--add-dir`
      argument when external storage is active, passing the repository config
      directory path.
    files: []
    docs: []
    steps: []
  - title: Update Codex CLI Executor
    done: true
    description: Modify `src/rmplan/executors/codex_cli.ts` to include external
      config directory in `sandbox_workspace_write.writable_roots`
      configuration.
    files: []
    docs: []
    steps: []
  - title: Add Conditional Logic
    done: true
    description: Implement logic to only add directory access when
      `isUsingExternalStorage` flag is true in the configuration.
    files: []
    docs: []
    steps: []
  - title: Test Executor Configurations
    done: true
    description: Create tests verifying correct command construction for both
      executors with and without external storage.
    files: []
    docs: []
    steps: []
  - title: Update README Documentation
    done: true
    description: Add comprehensive documentation to README explaining external
      storage, including when it's used, directory structure, and examples.
    files: []
    docs: []
    steps: []
  - title: Improve User Messaging
    done: true
    description: Enhance messages shown when external storage is activated to
      include helpful information about storage location and management.
    files: []
    docs: []
    steps: []
  - title: Add Storage Management Commands (Optional)
    done: false
    description: Consider adding `rmplan storage list` and `rmplan storage clean`
      commands for managing external storage directories.
    files: []
    docs: []
    steps: []
  - title: Create Example Workflows
    done: false
    description: Document example workflows for common scenarios like contributing
      to open-source projects or working with client repositories.
    files: []
    docs: []
    steps: []
changedFiles:
  - README.md
  - src/common/git.test.ts
  - src/common/git.ts
  - src/common/git_url_parser.js
  - src/common/git_url_parser.test.ts
  - src/common/git_url_parser.ts
  - src/rmplan/commands/add.test.ts
  - src/rmplan/commands/add.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/import/import.integration.test.ts
  - src/rmplan/commands/import/import.test.ts
  - src/rmplan/commands/import/import.ts
  - src/rmplan/commands/import/import_hierarchical.test.ts
  - src/rmplan/commands/promote.test.ts
  - src/rmplan/commands/promote.ts
  - src/rmplan/commands/renumber.ts
  - src/rmplan/configLoader.test.ts
  - src/rmplan/configLoader.ts
  - src/rmplan/configSchema.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/executors/claude_code/orchestrator_integration.test.ts
  - src/rmplan/executors/claude_code/orchestrator_prompt.ts
  - src/rmplan/executors/claude_code.test.ts
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/codex_cli/format.ts
  - src/rmplan/executors/codex_cli.test.ts
  - src/rmplan/executors/codex_cli.ts
  - src/rmplan/path_resolver.js
  - src/rmplan/path_resolver.test.ts
  - src/rmplan/path_resolver.ts
  - src/rmplan/plans/mark_done.ts
  - src/rmplan/plans.ts
  - src/rmplan/repository_config_resolver.js
  - src/rmplan/repository_config_resolver.test.ts
  - src/rmplan/repository_config_resolver.ts
  - src/rmplan/resolvePlanFile.external.test.ts
  - src/rmplan/utils/cleanup_plan_creator.ts
rmfilter: []
---

# Implemented Functionality Notes

- Built `RepositoryConfigResolver` to derive per-repository directories at `~/.config/rmfilter/repositories/<name>`, using sanitized remote metadata and automatically creating both `.rmfilter/config` and `tasks` subdirectories whenever a local config is absent.
- Updated `loadEffectiveConfig` to route through the resolver, attach runtime metadata (`isUsingExternalStorage`, `externalRepositoryConfigDir`, and the resolved config path), key cache entries by git root, and emit a detailed multi-line message the first time external storage is engaged covering base directory, config/plan paths, remote, and the opt-out hint.
- Adjusted `resolveTasksDir` to honor external storage mode, normalize relative task paths against the repository config directory, and proactively ensure target directories exist before plan operations run.
- Added targeted coverage via `src/rmplan/repository_config_resolver.test.ts`, expanded scenarios in `src/rmplan/configLoader.test.ts`, and new `resolveTasksDir` cases in `src/rmplan/configSchema.test.ts` to validate directory creation, metadata propagation, and path resolution for both local and external storage modes.
- Hardened `src/rmplan/resolvePlanFile.external.test.ts` so every filesystem operation first asserts the target lives inside the test's temporary home directory, preventing the suite from deleting a contributor's real `~/.config/rmfilter/repositories/...` data if the mocked homedir ever fails.
- Provided bridge modules (`src/common/git_url_parser.js`, `src/rmplan/repository_config_resolver.js`) alongside the earlier git URL parser work so runtime consumers and the CLI resolve the new implementations without a build step.
- Updated `ClaudeCodeExecutor` and `CodexCliExecutor` to automatically include the external repository configuration directory in their access arguments (`--add-dir` and sandbox `-c` writable roots) whenever `isUsingExternalStorage` metadata is true, ensuring agents can read/write configs outside the working tree.
- Added focused executor tests that assert the new arguments appear only when external storage is active, preventing regressions in command construction for both Claude and Codex flows.
- Introduced `path_resolver` helper utilities that compute git-aware task directories and configuration roots, providing a single source of truth for external storage resolution.
- Refactored plan operations (`rmplan add`, `generate`, `promote`, hierarchical imports, cleanup utilities, renumbering, and mark-done flows) to consume the shared helpers so plan files always land in the external repository directory when required.
- Expanded automated coverage with `path_resolver.test.ts` and new external-storage scenarios across add/promote/import unit and integration suites, ensuring command behavior remains stable in both local and external modes.
- Hardened git remote sanitisation by trimming credentials, query parameters, and fragments in `stripGitSuffix()` and `describeRemoteForLogging()` before deriving repository names or emitting external-storage notices, and added high-signal unit plus integration coverage (config loader logging, repository resolver naming, rmplan add with credentialed remotes) to prevent regressions.
- Enhanced external-storage messaging tests in `src/rmplan/configLoader.test.ts` to assert the new guidance, and documented the automatic fallback plus executor access in `README.md` for users working on third-party repositories.
- Introduced credential-safe remote reporting via `describeRemoteForLogging()` so the external-storage notice now renders `host/owner/repository` without tokens, refreshed the README to call out the sanitisation, and updated config loader tests to expect the scrubbed value.

# Original Plan Details

When working with third-party projects, we can't always just dump a bunch of Markdown files into it, so we need another way to do this.

If a directory being worked in does not have an rmfilter/rmplan config, then we should put all the configuration and task files under
`~/.config/rmfilter/repositories/{name}` where the name is derived from the git remote "origin" URL.

This config directory should be able to have an rmfilter config and also a tasks directory to hold the plans. We should not
expect this directory to exist at all.

In this case we just need to be careful that we properly resolve the directory to use for plan files vs. running
commands in the repository.

We should also pass arguments to the Claude and Codex executors to allow access to the repository config directory.
- For Claude this is `--add-dir <directory>`
- For Codex this is `-c sandbox_workspace_write.writable_roots=["<directory>"]`

When running in this mode, print a message at the start that we are using the config directory.

# Processed Plan Details

## Store task files locally when repository has no config

When working with third-party projects where we cannot add configuration files directly to the repository, rmplan should automatically use an external storage location at `~/.config/rmfilter/repositories/{name}` derived from the git remote origin URL. This allows users to manage plans for any repository without modifying the repository itself.

### Expected Behavior/Outcome
- When no `.rmfilter/config/rmplan.yml` exists in a repository, rmplan automatically uses `~/.config/rmfilter/repositories/{repo-name}/` for configuration and task storage
- A message is displayed informing the user that external configuration storage is being used
- All rmplan commands work transparently whether using local or external storage
- Claude and Codex executors have access to the external configuration directory

### Key Findings
- **Product & User Story**: Users need to manage tasks and plans for repositories they don't own or can't modify (e.g., open-source projects, client codebases)
- **Design & UX Approach**: Transparent fallback to external storage with clear user messaging about storage location
- **Technical Plan & Risks**:
  - Leverage existing `resolveTasksDir()` function as single point of control
  - Extend config loading to check external locations
  - Risk: Git URL parsing complexity for deriving consistent repository names
  - Risk: Path resolution complexity between repository and external storage
- **Pragmatic Effort Estimate**: 3-4 days of development including testing

### Acceptance Criteria
- [ ] When no local config exists, rmplan uses `~/.config/rmfilter/repositories/{name}/` automatically
- [ ] Repository name is correctly derived from various git remote URL formats (HTTPS, SSH, different hosts)
- [ ] All rmplan commands function correctly with external storage
- [ ] User sees clear message indicating external storage is being used
- [ ] Claude executor receives `--add-dir` argument for external config directory
- [ ] Codex executor receives sandbox configuration for external config directory
- [ ] External storage directory is created automatically if it doesn't exist
- [ ] Tests cover scenarios with/without git repos and with/without local configs

### Dependencies & Constraints
- **Dependencies**: Existing git integration (`getGitRepository()`), config loading system, executor infrastructure
- **Technical Constraints**:
  - Must maintain backward compatibility with existing local configuration
  - Cannot modify behavior when local config exists
  - Must handle repositories without git remotes gracefully

### Implementation Notes
- **Recommended Approach**:
  - Create a `RepositoryConfigResolver` class to encapsulate external storage logic
  - Extend `resolveTasksDir()` to use resolver when no local config exists
  - Add `isUsingExternalStorage` flag to config to track storage mode
  - Update executors to conditionally add directory access based on storage mode
- **Potential Gotchas**:
  - Git remote URLs have many formats requiring robust parsing
  - Need to handle repositories with no remote origin
  - Must ensure external directory permissions are correct
  - Path resolution between repository files and external storage needs careful handling

---

## Area 1: Enhanced Git URL Parsing and Repository Identification

Tasks:
- Create Git URL Parser Module
- Implement Repository Name Derivation
- Update getGitRepository Function
- Add Comprehensive Tests

Implement comprehensive git URL parsing that handles all common formats (HTTPS, SSH, different hosts) and converts them to consistent repository identifiers. This forms the foundation for determining external storage paths.

**Acceptance Criteria for Phase 1:**
- [ ] New `parseGitRemoteUrl()` function handles HTTPS, SSH, and SSH with protocol formats
- [ ] Function extracts consistent owner/repo format from GitHub, GitLab, Bitbucket URLs
- [ ] Edge cases handled: URLs with ports, subdomains, .git suffix
- [ ] New `deriveRepositoryName()` function creates filesystem-safe directory names
- [ ] Fallback mechanism for repositories without remotes (use directory name)
- [ ] Unit tests cover all URL format variations

---

## Area 2: External Configuration Directory Structure

Tasks:
- Create RepositoryConfigResolver Class
- Extend Config Loading Logic
- Add User Messaging
- Create Directory Structure Tests

Create the infrastructure for managing external configuration directories at `~/.config/rmfilter/repositories/{name}/`. Implement discovery logic that checks for external config when no local config exists.

**Acceptance Criteria for Phase 2:**
- [ ] `RepositoryConfigResolver` class manages external config paths
- [ ] Directory structure created automatically when needed
- [ ] Config discovery checks external location when no local config found
- [ ] External config can contain both rmfilter and rmplan configurations
- [ ] User messaging indicates when external storage is being used
- [ ] Tests verify directory creation and discovery logic

---

## Area 3: Integrate External Storage with Plan Operations

Tasks:
- Update resolveTasksDir Function
- Verify Plan Operations Compatibility
- Add Path Resolution Helpers
- Create Integration Tests

Modify `resolveTasksDir()` and related plan operations to use external storage when appropriate. Ensure all plan commands work transparently with external storage while maintaining clear separation between repository files and external plans.

**Acceptance Criteria for Phase 3:**
- [ ] `resolveTasksDir()` returns external tasks directory when using external config
- [ ] All plan read/write operations work with external storage
- [ ] Plan file paths are correctly resolved relative to external directory
- [ ] Repository file references remain relative to actual repository
- [ ] No changes required to individual command implementations
- [ ] Integration tests verify all commands work with external storage

---

## Area 4: Update Executors for External Directory Access

Tasks:
- Update Claude Code Executor
- Update Codex CLI Executor
- Add Conditional Logic
- Test Executor Configurations

Update executor configurations to include access to external configuration directories when using external storage mode. Add appropriate command-line arguments and sandbox configurations.

**Acceptance Criteria for Phase 4:**
- [ ] Claude executor receives `--add-dir` argument with external config path
- [ ] Codex executor receives sandbox configuration with external config in writable_roots
- [ ] Directory access only added when using external storage
- [ ] Executor tests verify correct argument construction
- [ ] No security implications from added directory access

---

## Area 5: Documentation and User Experience

Tasks:
- Update README Documentation
- Improve User Messaging
- Add Storage Management Commands (Optional)
- Create Example Workflows

Create documentation explaining the external storage feature, when it's used, and how to manage it. Improve user messaging and add commands for managing external storage.

**Acceptance Criteria for Phase 5:**
- [ ] README updated with external storage documentation
- [ ] Clear messages shown when using external storage
- [ ] Optional: Command to list repositories with external storage
- [ ] Optional: Command to clean up external storage
- [ ] Help text updated for relevant commands
- [ ] Example workflows documented

## Research

### Summary
- The feature aims to enable rmplan to work with third-party repositories by storing configuration and task files in `~/.config/rmfilter/repositories/{name}` when no local config exists in the repository.
- Critical discovery: `resolveTasksDir()` in `src/rmplan/configSchema.ts` is the single function that determines where all plan files are stored, making it the primary integration point.
- The codebase already has established patterns for global config storage (`~/.config/rmfilter/`), workspace isolation, and executor configuration that can be extended.
- Git repository identification via `getGitRepository()` exists but needs enhancement to handle various URL formats and derive consistent directory names.
- Both Claude and Codex executors have existing patterns for accepting additional directories, requiring only argument additions.

### Findings
- Listed below are the detailed findings from each analysis area, including specific files inspected and patterns discovered.

#### Configuration Loading Analysis

**Current Configuration Loading Mechanisms**

**rmfilter Configuration Loading**

**File:** `/Users/dimfeld/Documents/projects/llmutils/src/rmfilter/config.ts`

**Key Functions:**
- `findPresetFile(preset: string, gitRoot: string)`: Searches for preset files
- `getCurrentConfig()`: Main configuration loading function 
- `findAllPresetFiles()`: Discovers available presets

**Search Pattern:**
1. **Local Repository Search**: Searches from current directory up to git root for `.rmfilter/<preset>.yml`
2. **Global Fallback**: Falls back to `~/.config/rmfilter/<preset>.yml`
3. **Prioritization**: Repository-specific configs override global ones

**Missing Config Handling:**
- Returns error message and exits with code 1 if specified preset not found
- No automatic fallback to default config when preset is missing

**rmplan Configuration Loading**

**File:** `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/configLoader.ts`

**Key Functions:**
- `findConfigPath(overridePath?: string)`: Locates the main config file
- `loadConfig(configPath: string | null)`: Loads and validates config
- `loadEffectiveConfig(overridePath?: string)`: Main orchestration function
- `findLocalConfigPath()`: Finds local override configs (`rmplan.local.yml`)

**Search Pattern:**
1. **Override Path**: If specified via CLI, uses that path exactly
2. **Default Path**: `{gitRoot}/.rmfilter/config/rmplan.yml`
3. **Local Override**: `rmplan.local.yml` in same directory as main config

**Missing Config Handling:**
- **Graceful degradation**: Returns `getDefaultConfig()` when no config found
- **Validation errors**: Throws error and halts execution
- **Caching**: Caches loaded configs to avoid repeated file reads

**Configuration Directory Patterns**

**Existing Patterns:**
- **User Global**: `~/.config/rmfilter/` for presets and rules
- **Repository Local**: `.rmfilter/` directory in git root
- **Workspace Tracking**: `~/.config/rmfilter/workspaces.json`
- **Rules/Documentation**: `~/.config/rmfilter/rules/` for MDC files

**Tasks Directory Resolution**

**File:** `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/configSchema.ts`

**Function:** `resolveTasksDir(config: any)`: 
- Uses `config.paths.tasks` if configured
- Falls back to git root directory
- Handles both absolute and relative paths

**Current Behavior:**
- All rmplan commands use `resolveTasksDir()` to determine where plan files are stored/searched
- Always assumes git root is available and writable

#### Plan Storage Analysis

**Current Plan Storage Architecture**

**Storage Location Resolution**

**Primary Configuration:**
- Plans are stored in a directory determined by the `config.paths.tasks` setting in `.rmfilter/config/rmplan.yml`
- If no tasks path is configured, plans default to the git repository root
- Path resolution follows this hierarchy:
  1. Absolute path if `config.paths.tasks` is absolute
  2. Relative to git root if `config.paths.tasks` is relative
  3. Git root as fallback

**Key Functions:**
- `resolveTasksDir(config)` in `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/configSchema.ts` (lines 317-327)
- `loadEffectiveConfig()` in `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/configLoader.ts` manages configuration loading and merging

**Plan File Formats and Naming**

**Supported File Formats:**
- `.plan.md` files (YAML frontmatter + markdown content)
- `.yml` files (pure YAML)
- `.yaml` files (pure YAML)

**File Discovery Pattern:**
- Uses Bun's `Glob` with pattern `**/*.{plan.md,yml,yaml}` for recursive scanning
- Implemented in `readAllPlans()` in `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/plans.ts` (lines 123-127)

**Naming Conventions:**
- Numeric ID-based naming: `{planId}-{slugified-title}.plan.md`
- Example: `125-work-when-repository-has-no-config-or-tasks.plan.md`
- Plan IDs are auto-generated using `generateNumericPlanId()` from `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/id_utils.ts`

**Core Plan File Operations**

**Reading Operations:**
- `readPlanFile(filePath)` - Parses YAML frontmatter and markdown content
- `readAllPlans(directory)` - Scans directory for all plan files with caching
- `resolvePlanFile(planArg, configPath)` - Resolves plan by ID or file path

**Writing Operations:**
- `writePlanFile(filePath, plan)` - Writes YAML frontmatter + markdown format
- Includes yaml-language-server schema line for IDE support
- Automatically sets `updatedAt` timestamp

**Path Resolution:**
- `resolvePlanFile()` in `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/plans.ts` (lines 166-247) handles:
  - Direct file path resolution
  - Plan ID lookup with fallbacks (.plan.md, .yml extensions)
  - Duplicate ID detection and error handling

**Plan File Schema and Structure**

**Core Schema Elements:**
- Defined in `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/planSchema.ts`
- Uses Zod v4 for validation with `passthrough()` for flexibility
- Key fields: `id`, `title`, `goal`, `details`, `status`, `priority`, `dependencies`, `tasks[]`

**Caching and Performance**

**Plan Cache Management:**
- `cachedPlans` Map in `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/plans.ts` (lines 34-41)
- Caches parsed plans by directory to avoid repeated file system operations
- `clearPlanCache()` available for testing and cache invalidation

**Duplicate Detection:**
- Tracks duplicate plan IDs across multiple files
- Prevents operations on ambiguous plan references
- Returns duplicate information in `readAllPlans()` response

**Current Usage Patterns**

Most commands follow this pattern:
```typescript
const config = await loadEffectiveConfig(globalOpts.config);
const tasksDir = await resolveTasksDir(config);
const { plans } = await readAllPlans(tasksDir);
```

**Key Modules Involved**

**Core Storage Layer**
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/plans.ts` - Primary plan file operations
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/configSchema.ts` - Configuration and path resolution
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/configLoader.ts` - Configuration loading and merging

**Supporting Utilities**  
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/id_utils.ts` - Plan ID generation and slugification
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/planSchema.ts` - Plan structure validation
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/planPropertiesUpdater.ts` - Plan property updates

**Workspace Management (Reference Pattern)**
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/workspace/workspace_manager.ts` - Shows abstracted workspace creation
- `/Users/dimfeld/Documents/projects/llmutils/src/rmplan/workspace/workspace_tracker.ts` - JSON-based tracking with default locations

#### Git Integration Analysis

**Current Git Integration Capabilities**

**Core Git Functions (`src/common/git.ts`)**

**Repository Information:**
- `getGitRoot(cwd?)` - Finds git repository root with caching, supports both Git and Jujutsu
- `getGitRepository()` - Extracts owner/repo format from git remote origin URL
- `getCurrentBranchName(cwd?)` - Gets current branch name (supports both Git and Jujutsu)
- `getCurrentCommitHash(gitRoot)` - Gets current commit hash

**Key Implementation for Remote URL Retrieval:**
```typescript
export async function getGitRepository(): Promise<string> {
  if (!cachedGitRepository) {
    let remote = (await $`git remote get-url origin`.quiet().nothrow().text()).trim();
    // Parse out the repository from the remote URL
    let lastColonIndex = remote.lastIndexOf(':');
    cachedGitRepository = remote.slice(lastColonIndex + 1).replace(/\.git$/, '');
  }
  return cachedGitRepository;
}
```

**Current URL Processing Logic:**
- Uses `git remote get-url origin` to retrieve remote URL
- Finds last colon in URL and extracts everything after it
- Removes `.git` suffix if present
- Returns in `owner/repo` format
- Results are cached for performance

**URL Parsing Patterns**

**GitHub Issue/PR Identification (`src/common/github/identifiers.ts`):**
- Supports multiple URL formats:
  - GitHub URLs: `https://github.com/owner/repo/issues/123`
  - Short format: `owner/repo#123`  
  - Alternative short: `owner/repo/123`
  - Just numbers: `123` (uses current repo context)

**GitHub Issue Tracker (`src/common/issue_tracker/github.ts`):**
- Advanced URL parsing with `new URL()` constructor
- Extracts owner/repo from GitHub URLs: `/owner/repo/issues/123`
- Handles both issues and pull requests
- Includes fallback parsing for non-URL formats

**Repository Identity Usage**

**Workspace Management:**
- `WorkspaceInfo` interface includes `repositoryUrl` field
- URL normalization for comparison: `normalizeUrl = (url: string) => url.replace(/\.git$/, '').replace(/\/$/, '')`
- Used in workspace tracking and auto-selection

**Pull Request Detection (`src/common/github/pull_requests.ts`):**
- Uses `getGitRepository()` to get current repo context
- Auto-detects PRs based on current branch and repo

**Multiple Remote URL Retrieval Points**

The codebase retrieves git remote URLs in several locations:
- `src/common/git.ts:413` - Main `getGitRepository()` function
- `src/rmplan/workspace/workspace_auto_selector.ts:64` - For workspace creation
- `src/rmplan/commands/workspace.ts:44` and `:418` - For workspace commands

**Current Limitations**

**Simple URL Parsing Logic**
The current `getGitRepository()` function uses basic string manipulation that has limitations:
- Doesn't handle different URL formats systematically
- May not work correctly with all SSH URL variants
- Doesn't validate URL format
- No normalization beyond removing `.git` suffix

**No Comprehensive URL Normalization**
While there's basic normalization in workspace tracker, it's limited and doesn't handle:
- Converting between HTTPS and SSH formats
- Extracting consistent owner/repo from different URL types
- Handling edge cases like URLs with ports or subdomains

**Missing URL-to-Name Conversion**
No systematic way to convert various git URL formats to consistent repository names.

#### Executor Configuration Analysis

**Current Executor Configuration Mechanisms**

**Claude Code Executor (`src/rmplan/executors/claude_code.ts`)**

**Configuration Structure:**
- Uses `ClaudeCodeExecutorConfig` schema with support for additional directories
- Key configuration field: `additionalAccessDirectories?: string[]`
- Command construction in `buildCommand()` function (lines 70-94)

**Current Implementation:**
```typescript
if (config.additionalAccessDirectories) {
  for (const dir of config.additionalAccessDirectories) {
    commandArgs.push('--add-dir', dir);
  }
}
```

**Integration Points:**
- Configuration comes from plan's `executor` field or global config
- Supports both plan-specific and global additional directories
- Already has the infrastructure to pass extra directories

**Codex CLI Executor (`src/rmplan/executors/codex_cli.ts`)**

**Configuration Structure:**
- Uses `CodexCliExecutorConfig` schema
- Supports complex configuration through `-c` flag for sandbox settings

**Current Sandbox Configuration:**
```typescript
const sandboxConfig = config.sandbox || {};
// Configuration passed via command line arguments
```

**Required Addition:**
Need to add support for `sandbox_workspace_write.writable_roots` configuration:
```typescript
sandboxConfig.sandbox_workspace_write = {
  writable_roots: [repositoryConfigDir]
};
```

**Integration Points:**
- Configuration building happens in executor initialization
- Supports environment variables and command-line arguments
- Can dynamically add sandbox configuration

**Shared Executor Infrastructure**

**Common Options (`src/rmplan/executors/common.ts`):**
- Provides `CommonOptions` interface used by all executors
- Includes `workingDirectory`, `gitRoot`, and other shared parameters
- Could be extended with `repositoryConfigDirectory` field

**Executor Factory (`src/rmplan/executors/factory.ts`):**
- Creates executor instances based on configuration
- Routes configuration to appropriate executor type
- Single point for injecting repository-specific configuration

**Configuration Flow:**
1. Plan configuration loaded from YAML
2. Merged with global configuration
3. Passed to executor factory
4. Executor builds command with configuration
5. Command executed with proper access permissions

**Existing Patterns for Dynamic Configuration**

**File Generation for Context:**
Both executors generate temporary files with instructions:
- Claude: Creates instruction file with plan details
- Codex: Creates prompt file with context

**Environment Variable Support:**
Both executors support environment variables:
- Claude: Uses environment for API keys
- Codex: Passes through environment configuration

**Working Directory Management:**
Both executors handle working directory resolution:
```typescript
const cwd = options.workingDirectory || options.gitRoot;
```

#### Directory Resolution Analysis

**Current Directory Resolution Patterns**

**Primary Directory Resolution Functions**

The codebase uses several key functions for directory resolution:
- `getGitRoot(cwd?: string)` - Core function that finds repository root by detecting `.git` or `.jj` directories
- `resolveTasksDir(config)` - Resolves the tasks directory path (defaults to git root if not configured)
- `path.resolve(process.cwd(), file)` - Used sparingly for relative path resolution

**Working Directory vs Storage Directory Distinction**

**Git Root (Repository Base Directory)**
```typescript
const gitRoot = (await getGitRoot()) || process.cwd();
```
- Used as the foundation for most operations
- Falls back to `process.cwd()` if no git repository found
- Cached for performance (in `src/common/git.ts`)

**Tasks Directory (Storage Directory)**
```typescript
return path.isAbsolute(config.paths.tasks)
  ? config.paths.tasks
  : path.join(gitRoot, config.paths.tasks);
```
- Configurable through `config.paths.tasks`
- Defaults to git root if not specified
- Can be absolute or relative to git root

**Working Directory (Operations Directory)**
```typescript
const cwd = commandConfig.workingDirectory
  ? path.resolve(effectiveGitRoot, commandConfig.workingDirectory)
  : effectiveGitRoot;
```
- Used for command execution contexts
- Resolved relative to git root when specified
- Defaults to git root for consistency

**Key Directory Resolution Patterns**

**Pattern 1: Git Root as Base**
Most operations use git root as the primary reference

**Pattern 2: Relative Resolution Against Git Root**
Working directories are resolved relative to repository root

**Pattern 3: Configuration-Driven Path Resolution**
Tasks directory supports both absolute and relative paths

**Pattern 4: Workspace Path Override**
Workspace operations use workspace path as base directory

**Directory Usage Categories**

**Repository Operations**
- Use `gitRoot` from `getGitRoot()`
- Examples: commit operations, file tracking, branch detection

**Plan File Operations** 
- Use `resolveTasksDir(config)` for storage
- Plans are read/written relative to tasks directory

**Command Execution**
- Use resolved working directory with `executePostApplyCommand()`
- Can be overridden with `overrideGitRoot` parameter

**Workspace Operations**
- Use workspace path as isolated working environment
- Override git root for contained operations

**Base Directory Parameter Patterns**

Several functions accept `baseDir` parameters for directory context, typically used to:
- Override git root detection
- Support workspace-isolated operations
- Enable testing with temporary directories

**Current Architecture Strengths**
- Clear separation between repository root, tasks storage, and working contexts
- Configurable paths allow customization of storage locations
- Workspace isolation enables parallel execution environments
- Consistent fallbacks to git root when specific paths aren't configured

**Areas Needing Clean Abstraction**

**Directory Context Management**
Currently scattered across multiple files:
- `getGitRoot()` in `src/common/git.ts`
- `resolveTasksDir()` in `configSchema.ts`
- Working directory resolution in `actions.ts`
- Workspace path handling in agent commands

**Base Directory Threading**
Many functions manually thread `baseDir` parameters

**Path Resolution Inconsistencies**
Some areas still use `process.cwd()` directly

**Key Areas Requiring Updates**
1. **Core Commands** (`src/rmplan/commands/`) - 89 files using `getGitRoot()`
2. **Executor Systems** - Need context-aware directory handling
3. **Plan Operations** - Require consistent base directory handling
4. **Workspace Management** - Already well-abstracted, could be model for other areas

### Risks & Constraints
- **Git URL Parsing Limitation**: Current `getGitRepository()` function uses simplistic string manipulation that won't handle all git URL formats (SSH variants, HTTPS with authentication, different hosts like GitLab/Bitbucket).
- **Directory Permission Issues**: External config directory (`~/.config/rmfilter/repositories/`) may have different permissions than repository directory, potentially causing file operation failures.
- **Plan Cache Invalidation**: The plan caching system in `readAllPlans()` assumes plans are in a single directory - will need updates to handle external storage.
- **Relative Path Resolution**: Many operations assume paths are relative to git root - need careful handling when plans are stored externally.
- **Backward Compatibility**: Must maintain compatibility with existing repositories that have local configs.
- **Testing Complexity**: Test suite assumes writable repository directories - will need updates to test external storage scenarios.
- **Executor Sandbox Constraints**: Codex executor's sandbox may have restrictions on accessing directories outside the repository.
- **Config Merging Complexity**: Need to handle config precedence when both local and external configs exist.
- **Repository Name Collisions**: Different repositories might map to the same directory name (e.g., forks with same repo name).
- **Cross-Platform Path Handling**: Must ensure paths work correctly on Windows, macOS, and Linux.

### Follow-up Questions
- Should the external config directory structure mirror the repository structure (e.g., maintain same relative paths for organization)? Answer: no need to mirror
- What should happen if a repository gains a local config after using external storage - should plans migrate automatically? Answer: No
- Should there be a command to explicitly migrate plans between local and external storage? Answer: Not for now
- How should we handle repository name collisions (e.g., multiple forks with the same name but different owners)? Answer: Ensure that the name includes enough information to avoid this.
- Should external configs be automatically cleaned up when no longer needed, or require manual cleanup? Answer: Manual
- What level of logging/verbosity should be used when operating in external storage mode?: Answer: No different, just one extra message when we first decide to use the .config directory
- Should we support a `.rmplanignore` file in the external config directory to exclude certain files from operations? Answer: No

# Implemented Functionality Notes
- Built `RepositoryConfigResolver` to derive per-repository directories at `~/.config/rmfilter/repositories/<name>`, using sanitized remote metadata and automatically creating both `.rmfilter/config` and `tasks` subdirectories whenever a local config is absent.
- Updated `loadEffectiveConfig` to route through the resolver, attach runtime metadata (`isUsingExternalStorage`, `externalRepositoryConfigDir`, and the resolved config path), key cache entries by git root, and surface a log message the first time external storage is engaged.
- Adjusted `resolveTasksDir` to honor external storage mode, normalize relative task paths against the repository config directory, and proactively ensure target directories exist before plan operations run.
- Added targeted coverage via `src/rmplan/repository_config_resolver.test.ts`, expanded scenarios in `src/rmplan/configLoader.test.ts`, and new `resolveTasksDir` cases in `src/rmplan/configSchema.test.ts` to validate directory creation, metadata propagation, and path resolution for both local and external storage modes.
- Provided bridge modules (`src/common/git_url_parser.js`, `src/rmplan/repository_config_resolver.js`) alongside the earlier git URL parser work so runtime consumers and the CLI resolve the new implementations without a build step.
- Introduced `path_resolver` helper utilities that compute git-aware task directories and configuration roots, providing a single source of truth for external storage resolution.
- Refactored plan operations (`rmplan add`, `generate`, `promote`, hierarchical imports, cleanup utilities, renumbering, and mark-done flows) to consume the shared helpers so plan files always land in the external repository directory when required.
- Expanded automated coverage with `path_resolver.test.ts` and new external-storage scenarios across add/promote/import unit and integration suites, ensuring command behavior remains stable in both local and external modes.
