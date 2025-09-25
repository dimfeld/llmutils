---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Store task files locally when repository has no config
goal: Work better with third-party projects
id: 125
generatedBy: agent
status: pending
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-09-25T09:16:20.304Z
createdAt: 2025-09-25T08:58:56.840Z
updatedAt: 2025-09-25T09:16:20.304Z
tasks:
  - title: Create Git URL Parser Module
    done: false
    description: Create `src/common/git_url_parser.ts` with functions to parse
      various git remote URL formats and extract normalized repository
      information. Include support for GitHub, GitLab, Bitbucket, and generic
      git URLs.
    steps: []
  - title: Implement Repository Name Derivation
    done: false
    description: Add `deriveRepositoryName()` function that converts parsed URLs to
      filesystem-safe directory names. Handle special characters, ensure
      uniqueness, and provide fallback for local-only repositories.
    steps: []
  - title: Update getGitRepository Function
    done: false
    description: Refactor `getGitRepository()` in `src/common/git.ts` to use the new
      parser for more robust URL handling while maintaining backward
      compatibility.
    steps: []
  - title: Add Comprehensive Tests
    done: false
    description: Write unit tests covering all supported URL formats, edge cases,
      and fallback scenarios. Include tests for repositories without remotes.
    steps: []
  - title: Create RepositoryConfigResolver Class
    done: false
    description: Implement `src/rmplan/repository_config_resolver.ts` with methods
      for determining external config paths, checking existence, and creating
      directory structure.
    steps: []
  - title: Extend Config Loading Logic
    done: false
    description: Update `loadEffectiveConfig()` in `src/rmplan/configLoader.ts` to
      use RepositoryConfigResolver when no local config exists. Add
      `isUsingExternalStorage` flag to config.
    steps: []
  - title: Add User Messaging
    done: false
    description: Implement clear messaging that informs users when external
      configuration storage is being used, including the specific path being
      used.
    steps: []
  - title: Create Directory Structure Tests
    done: false
    description: Add integration tests that verify directory creation, permission
      handling, and config discovery with various repository configurations.
    steps: []
  - title: Update resolveTasksDir Function
    done: false
    description: Modify `resolveTasksDir()` in `src/rmplan/configSchema.ts` to check
      for external storage mode and return appropriate directory path.
    steps: []
  - title: Verify Plan Operations Compatibility
    done: false
    description: Test and fix any issues with plan file operations when using
      external storage, ensuring proper path resolution for both plans and
      repository files.
    steps: []
  - title: Add Path Resolution Helpers
    done: false
    description: Create helper functions to manage path resolution between
      repository files and external storage, ensuring clear separation of
      concerns.
    steps: []
  - title: Create Integration Tests
    done: false
    description: Write comprehensive integration tests covering all plan commands
      with external storage, including edge cases like moving between
      repositories.
    steps: []
  - title: Update Claude Code Executor
    done: false
    description: Modify `src/rmplan/executors/claude_code.ts` to add `--add-dir`
      argument when external storage is active, passing the repository config
      directory path.
    steps: []
  - title: Update Codex CLI Executor
    done: false
    description: Modify `src/rmplan/executors/codex_cli.ts` to include external
      config directory in `sandbox_workspace_write.writable_roots`
      configuration.
    steps: []
  - title: Add Conditional Logic
    done: false
    description: Implement logic to only add directory access when
      `isUsingExternalStorage` flag is true in the configuration.
    steps: []
  - title: Test Executor Configurations
    done: false
    description: Create tests verifying correct command construction for both
      executors with and without external storage.
    steps: []
  - title: Update README Documentation
    done: false
    description: Add comprehensive documentation to README explaining external
      storage, including when it's used, directory structure, and examples.
    steps: []
  - title: Improve User Messaging
    done: false
    description: Enhance messages shown when external storage is activated to
      include helpful information about storage location and management.
    steps: []
  - title: Add Storage Management Commands (Optional)
    done: false
    description: Consider adding `rmplan storage list` and `rmplan storage clean`
      commands for managing external storage directories.
    steps: []
  - title: Create Example Workflows
    done: false
    description: Document example workflows for common scenarios like contributing
      to open-source projects or working with client repositories.
    steps: []
changedFiles: []
rmfilter: []
---

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
