---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add manual review answer mode to rmplan
goal: Implement `rmplan address-comments` command to find and address AI review
  comments that are already inserted in source files, similar to `answer-pr` but
  without needing a GitHub PR.
id: 127
uuid: 0533e8b5-6290-4501-9265-57a5dd50b74d
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2025-10-18T18:28:15.722Z
promptsGeneratedAt: 2025-10-18T18:28:15.722Z
createdAt: 2025-10-18T07:39:11.437Z
updatedAt: 2025-10-27T08:39:04.249Z
tasks:
  - title: Create addressComments.ts command file
    done: true
    description: >-
      Create `src/rmplan/commands/addressComments.ts` with:

      - `handleAddressCommentsCommand(paths, options, command)` - Main command
      handler

      - `handleCleanupCommentsCommand(paths, options, command)` - Standalone
      cleanup command handler

      - `createAddressCommentsPrompt(baseBranch, paths)` - Generates prompt for
      executor with path filtering support

      - `findFilesWithAiComments(gitRoot, paths)` - Uses ripgrep to find files
      with AI comment markers

      - `cleanupAiCommentMarkers(gitRoot, paths)` - Removes AI markers from
      files, returns count

      - `smartCleanupAiCommentMarkers(gitRoot, paths)` - Checks for remaining
      markers, prompts user

      - `commitAddressedComments()` - Creates commit with message 'Address
      review comments'


      Main workflow:

      1. Load config

      2. Get git root

      3. Resolve base branch (via getTrunkBranch or --base-branch option)

      4. Build executor

      5. Execute with executionMode: 'review'

      6. Smart cleanup (detect remaining markers, prompt user)

      7. Optional commit


      Files to reference:

      - src/rmplan/commands/answerPr.ts (command structure pattern)

      - src/rmplan/commands/agent/agent.ts (minimal executor setup)

      - src/rmpr/modes/inline_comments.ts (removeAiCommentMarkers function)

      - src/common/git.ts (getTrunkBranch, commitAll, hasUncommittedChanges)
  - title: Register commands in CLI
    done: true
    description: |-
      Update `src/rmplan/cli.ts` to register both new commands:

      1. `address-comments [paths...]` command with options:
         - --base-branch <branch>
         - --executor <name>
         - --model <model>
         - --commit
         - --dry-run
         - --yes

      2. `cleanup-comments [paths...]` command with options:
         - --yes

      Both commands accept optional path arguments for filtering.

      Also update `src/rmplan/commands/index.ts` to export both handlers.
  - title: Implement prompt generation with path filtering
    done: true
    description: >-
      Create `createAddressCommentsPrompt(baseBranch, paths)` function that:


      1. Generates instructions for finding AI comments (single-line and block
      formats)

      2. Includes path scope section if paths are provided

      3. Instructs agent on:
         - Grepping for AI comment markers
         - Diffing against base branch for context
         - Addressing all found comments
         - Removing markers after addressing
         - Running validation (bun run check, lint, test)
      4. Includes base branch context for git/jj diff commands

      5. Adapts grep command suggestions based on whether paths are provided


      The prompt should use executionMode: 'review' to avoid orchestration
      overhead.
  - title: Implement smart cleanup logic
    done: true
    description: >-
      Implement the three cleanup functions:


      1. `findFilesWithAiComments(gitRoot, paths)`: 
         - Uses ripgrep to search for 'AI:' markers
         - Handles optional path filtering
         - Returns empty array if no matches (ripgrep exits with code 1)

      2. `cleanupAiCommentMarkers(gitRoot, paths)`:
         - Gets files with AI comments
         - For each file, reads content, runs removeAiCommentMarkers, writes back
         - Returns count of files cleaned
         - Reuses removeAiCommentMarkers from src/rmpr/modes/inline_comments.ts

      3. `smartCleanupAiCommentMarkers(gitRoot, paths)`:
         - Checks if any markers remain after executor runs
         - If none: logs success and returns
         - If some remain: lists files and prompts user to clean them up
         - Uses @inquirer/prompts confirm() for user prompt

      Ensure proper error handling for ripgrep failures.
  - title: Add base branch resolution logic
    done: true
    description: |-
      In the main command handler:

      1. Check if --base-branch option is provided
      2. If not, call `getTrunkBranch(gitRoot)` from src/common/git.ts
      3. Pass resolved base branch to prompt generation
      4. Ensure base branch is used in:
         - Prompt instructions for git/jj diff commands
         - Any context preparation

      Handle edge cases:
      - Detached HEAD state
      - Missing main/master branches
      - jj vs git repository detection
  - title: Implement commit functionality
    done: true
    description: >-
      Create `commitAddressedComments()` function:


      1. Check for uncommitted changes via `hasUncommittedChanges()` from
      src/common/git.ts

      2. If no changes, log and return

      3. If changes exist, create commit with message: 'Address review comments'

      4. Use `commitAll(message)` from src/common/process.ts

      5. Handle both git and jj repositories


      Only run if --commit flag is set.


      Log appropriate messages for user visibility.
  - title: Write tests for address-comments command
    done: true
    description: |-
      Create `src/rmplan/commands/addressComments.test.ts` with tests for:

      1. **Path filtering**:
         - Search entire repository when no paths provided
         - Filter to specific paths when provided
         - Handle multiple path arguments

      2. **Cleanup logic**:
         - findFilesWithAiComments returns correct files
         - cleanupAiCommentMarkers removes all markers
         - smartCleanupAiCommentMarkers detects remaining markers
         - Handles case when no markers exist

      3. **Prompt generation**:
         - Includes base branch in prompt
         - Adapts grep commands based on paths
         - Includes path scope section when paths provided

      4. **Integration**:
         - End-to-end test with mock executor
         - Test with both git and jj repositories
         - Test different file types (JS, Python, HTML, etc.)

      Use real filesystem operations (mkdtemp) rather than mocks where possible.
      Test both git and jj repository scenarios.
  - title: Write tests for cleanup-comments command
    done: true
    description: >-
      Add tests for the standalone cleanup command:


      1. Successfully finds and removes AI comment markers

      2. Respects path filtering

      3. Prompts user for confirmation (unless --yes)

      4. Handles no markers found case

      5. Reports correct count of cleaned files

      6. Works with different comment styles (single-line, block, hybrid)


      Test with temporary directories containing fixtures with AI comments in
      various formats.
  - title: Update documentation
    done: true
    description: |-
      Update README.md to document the new commands:

      1. Add `rmplan address-comments` section:
         - Purpose and use case
         - Command syntax and options
         - Example usage
         - Workflow explanation

      2. Add `rmplan cleanup-comments` section:
         - Purpose (manual cleanup without executor)
         - Command syntax
         - Example usage

      3. Document AI comment format:
         - Single-line format: `// AI: comment`
         - Block format with AI_COMMENT_START/END
         - Supported file types and comment styles

      4. Add workflow example showing:
         - How AI comments get into files (from answer-pr or manual insertion)
         - Running address-comments to fix them
         - Smart cleanup prompting
         - Optional standalone cleanup

      Include comparison with answer-pr to clarify the difference.
  - title: Manual testing across executors
    done: false
    description: |-
      Manually test the command with different executors:

      1. **Claude Code executor**:
         - Verify it can grep for AI comments
         - Verify it can diff against base branch
         - Verify it removes markers after addressing
         - Test in both normal and simple mode

      2. **Codex CLI executor**:
         - Same verification as Claude Code
         - Test auto-retry if planning-only detection triggers

      3. **Direct-call executor**:
         - Verify single-call workflow works

      4. Test with:
         - Different file types (TypeScript, Python, HTML, CSS)
         - Different comment formats (single-line, block, hybrid)
         - Path filtering (specific files, directories, whole repo)
         - Base branch options (auto-detect vs explicit)

      5. Verify smart cleanup:
         - Detects when all markers removed
         - Prompts when some remain
         - Lists remaining files correctly

      6. Test standalone cleanup-comments command

      Document any executor-specific quirks or limitations.
changedFiles:
  - README.md
  - src/rmplan/commands/addressComments.test.ts
  - src/rmplan/commands/addressComments.ts
  - src/rmplan/rmplan.ts
rmfilter: []
---

Call this new command `rmplan address-comments`

The idea is similar to the `answer-pr` command, except the AI comments are already in the files so it does not need to look at an existing PR, insert the comments itself, or do any of the other preparatory work. 

In this case, we simply want to run the executor and instruct it to grep in the repository for the AI comments, which could be the single line comments or multi-line start and end pair comments.

In this case, we also won't have the diffs readily available, so we should tell the agent to diff against the base branch if it needs to compare to the original. The base branch should be the trunk branch by default, which we already have a function to get, but there should be a command line option to set a different trunk branch to diff against.

## Differences

The answer-pr command does these things, but we *do not* want to do them in the new command:
- Do not select from a subset of comments to address.
- Do not prepare diff context (the separate and hybrid modes)

Instead, we want to let the executor handle these things and direct them via prompting:
- Diffing handled by the agent as needed
- Grepping for the comments handled by the agent 

We should still run the final cleanup step though.

## Research

### Summary

This task introduces a new `rmplan address-comments` command that finds and addresses AI review comments already inserted in source files. Unlike `answer-pr`, this command does not interact with GitHub PRs or insert comments—it assumes AI comments are already present and focuses on directing the executor to find and address them. The agent will handle grepping for comments and diffing against the base branch as needed, with the command only responsible for executor setup and cleanup.

The implementation leverages existing utilities for AI comment detection, base branch resolution, and executor orchestration. Key differences from `answer-pr` include: no GitHub interaction, no comment selection UI, no diff context preparation (agent-driven instead), and simplified workflow focusing on executor prompt construction.

### Findings

#### answer-pr Command Implementation

**Location:** `src/rmplan/commands/answerPr.ts` and `src/rmpr/main.ts`

The `answer-pr` command follows a five-phase workflow:

1. **PR Detection & Validation** (main.ts:106-196)
   - Checks `GITHUB_TOKEN` environment variable
   - Auto-detects PR from current branch via `detectPullRequest()`
   - Validates current branch matches PR head branch
   - Fetches PR data and review comments via `fetchPullRequestAndComments()`

2. **Comment Fetching & Selection** (main.ts:208-256)
   - Filters for unresolved review threads
   - Presents interactive checkbox UI for comment selection via `selectReviewComments()`
   - Groups comments by file path
   - Parses `--rmpr` directives from comment bodies using `parseCommandOptionsFromComment()`
   - Merges options for files with multiple comments

3. **Context Preparation** (main.ts:314-430)
   - Three modes: `inline-comments`, `separate-context`, `hybrid` (default)
   - **Inline mode**: Inserts AI comment markers directly into source files using `insertAiCommentsIntoFileContent()`
   - **Separate mode**: Formats comments as XML with diff context, no file modification
   - **Hybrid mode**: Both inserts AI comments into files AND prepares separate diff contexts with comment IDs
   - All modes use fuzzy matching to handle outdated comments via `findBestMatchLine()`
   - Writes modified files to disk (except separate mode)

4. **LLM Execution** (main.ts:301-486)
   - Optionally prompts user to adjust settings (model, executor, mode, rmfilter args)
   - Builds executor via `buildExecutorAndLog()`
   - Optionally runs `fullRmfilterRun()` to prepare comprehensive context with `--with-diff` and `--diff-from`
   - Executes with `executionMode: 'review'` (bypasses orchestration)

5. **Cleanup & Commit** (main.ts:488-599)
   - Removes AI comment markers via `removeAiCommentMarkers()` (inline/hybrid modes only)
   - Creates commit with multi-line message listing addressed comments (if `--commit` flag)
   - Posts replies to GitHub review threads (if `--comment` flag)
   - Displays summary of addressed comments

**Key Functions:**
- `handleAnswerPrCommand()` (answerPr.ts:9) - Config broker, applies defaults
- `handleRmprCommand()` (main.ts:91) - Main orchestrator
- `selectReviewComments()` - Interactive selection UI
- `parseCommandOptionsFromComment()` (comment_options.ts:127) - Parses `--rmpr` directives

**What address-comments DOES NOT Need:**
- GitHub token checking
- PR detection/fetching
- Comment selection UI
- Comment grouping by file
- `--rmpr` directive parsing
- Mode-specific context preparation (inline/separate/hybrid)
- File modification before executor runs

**What address-comments DOES Need:**
- Executor setup and building
- Prompt construction directing agent to grep for AI comments
- Base branch resolution (via `getTrunkBranch()`)
- CLI option for custom base branch
- Cleanup step (removing AI comment markers)
- Optional commit creation

#### Executor Patterns and Prompting

**Location:** `src/rmplan/executors/types.ts`, `src/rmplan/executors/build.ts`, executor implementations

**Five Executor Types:**
1. **claude-code**: Multi-agent orchestration (implementer→tester→reviewer or implementer→verifier in simple mode)
2. **codex-cli**: OpenAI Codex CLI with built-in implement→test→review loop
3. **direct-call**: Single LLM call with integrated edit application
4. **copy-paste**: Manual clipboard workflow
5. **copy-only**: Display-only for manual intervention

**Executor Interface:**
```typescript
export interface Executor {
  prepareStepOptions?: () => Partial<PrepareNextStepOptions>;
  forceReviewCommentsMode?: 'inline-edits' | 'separate-context';
  filePathPrefix?: string;
  execute: (contextContent: string, planInfo: ExecutePlanInfo) => Promise<ExecutorOutput | void>;
}
```

**ExecutePlanInfo for Review Context:**
```typescript
{
  planId: '',
  planTitle: 'Address AI Review Comments',
  planFilePath: '',
  executionMode: 'review',  // Bypasses multi-agent orchestration
}
```

**Prompt Construction Pattern:**
1. Base context (task description)
2. Orchestration wrapper (if applicable, based on execution mode)
3. Task-specific instructions

**Example from Claude Code** (orchestrator_prompt.ts):
- Normal mode: Wraps with multi-agent instructions (implementer/tester/reviewer)
- Simple mode: Wraps with streamlined instructions (implementer/verifier)
- Review mode: No orchestration wrapper, direct prompt
- Planning mode: No orchestration wrapper, direct prompt

**Tool Patterns:**
Executors define allowed tools via `defaultAllowedTools` array:
- `Bash(grep:*)`, `Bash(rg:*)` - Code search operations
- `Bash(git:*)`, `Bash(jj:*)` - Version control
- `Edit`, `MultiEdit`, `Write` - File modification
- `Read`, `Glob`, `Grep` - File operations

For `address-comments`, we want the agent to use:
- `Grep` or `Bash(rg:*)` to find AI comment markers
- `Bash(git diff:*)` or `Bash(jj diff:*)` to compare against base branch
- `Edit`, `Write` to make changes
- Standard build/test tools

**Result Processing:**
```typescript
interface ExecutorOutput {
  content: string;           // Main response
  steps?: Step[];           // Structured breakdown
  success?: boolean;        // Success indicator
  failureDetails?: {
    requirements: string;
    problems: string;
    solutions: string;
    sourceAgent?: string;
  };
}
```

**Execution Modes:**
- `normal`: Full multi-agent workflow
- `simple`: Streamlined implement→verify
- `review`: Direct review prompts (what we want for address-comments)
- `planning`: Direct planning prompts

**Key Insight for address-comments:**
We should use `executionMode: 'review'` to avoid orchestration overhead and provide a direct, focused prompt that instructs the agent to:
1. Grep for AI comment markers in the repository
2. Understand each comment's context
3. Make necessary changes
4. Remove AI comment markers after addressing them
5. Run tests/checks to validate changes

#### Comment Detection Patterns

**Location:** `src/rmpr/modes/inline_comments.ts`, `src/rmpr/modes/hybrid_context.ts`

**AI Comment Format Patterns:**

**Single-Line Comments:**
```typescript
// AI: This is a review comment          // TypeScript/JavaScript/Go/Java/etc.
# AI: This is a review comment           // Python/Ruby/Shell/YAML
<!-- AI: This is a review comment -->    // HTML/XML/Vue/Markdown
/* AI: This is a review comment */       // CSS/SCSS
-- AI: This is a review comment          // Lua/SQL
```

**Multi-Line Block Comments:**
```typescript
// AI_COMMENT_START
// AI: First line of review
// AI: Second line of review
// AI_COMMENT_END
```

**Hybrid Mode with IDs:**
```typescript
// AI (id: comment-abc123): First line
// AI: Second line
```

**Comment Prefix Generation:**
Function `getLineCommenterForFile(filePath, firstLineOfFile?, prefixOnly?)` (inline_comments.ts:144-226)

Detects file type from extension and returns appropriate comment wrapper function:
```typescript
const commenter = getLineCommenterForFile('file.ts');
const comment = commenter('AI: Review text');
// Result: "// AI: Review text"
```

**Supported File Types:**
- `.js`, `.jsx`, `.ts`, `.tsx`, `.go`, `.java`, `.kt`, `.cs`, `.rs`, `.dart` → `// `
- `.py`, `.rb`, `.pl`, `.sh`, `.yaml`, `.yml` → `# `
- `.html`, `.htm`, `.xml`, `.vue`, `.md`, `.svg` → `<!-- -->`
- `.css`, `.scss`, `.less` → `/* */`
- `.lua`, `.sql` → `-- `
- `.svelte` → Mixed (detects if in script or template)

**Comment Insertion:**
Function `insertAiCommentsIntoFileContent()` (inline_comments.ts:238-378)
- Uses fuzzy matching to find best location for each comment
- Handles outdated comments by finding closest match
- Supports both single-line and block comments
- Strips existing AI comments before inserting new ones

**Comment Detection for Removal:**
Function `removeAiCommentMarkers()` (inline_comments.ts:380-416)

Detects and removes lines containing:
- `AI_COMMENT_START` marker
- `AI_COMMENT_END` marker
- `AI:` prefix
- `AI (id:` prefix (hybrid mode)

Implementation:
```typescript
const candidates = [
  prefixer('AI_COMMENT_START'),
  prefixer('AI_COMMENT_END'),
  prefixer('AI:'),
  prefixer('AI (id:'),
];

return lines.filter(line => 
  !candidates.some(candidate => line.trim().startsWith(candidate))
).join('\n');
```

**Key Functions:**
- `getLineCommenterForFile(filePath)` - Returns comment wrapper function
- `insertAiCommentsIntoFileContent(content, comments, filePath)` - Inserts AI comments
- `removeAiCommentMarkers(content, filePath)` - Removes AI comment markers

**Grep Patterns for Finding AI Comments:**
To find AI comments across the repository, the agent should search for:
- `AI:` (most common prefix)
- `AI_COMMENT_START` (block start)
- `AI_COMMENT_END` (block end)
- `AI (id:` (hybrid mode with IDs)

These patterns work across all supported comment styles since the actual comment text follows the language-specific prefix.

#### Base Branch Detection Logic

**Location:** `src/common/git.ts`

**Primary Function:** `getTrunkBranch(gitRoot: string): Promise<string>` (git.ts:473-497)

**Detection Algorithm:**
1. For **jj repositories**: Runs `jj bookmark list` and looks for bookmarks matching (in order): `main`, `master`, `trunk`, `default`
2. For **Git repositories**: Runs `git branch --list main master` and returns first match
3. **Fallback:** Returns `'main'` if no candidates found

**Branch Comparison Function:** `getChangedFilesOnBranch(gitRoot, options)` (git.ts:502-607)

```typescript
export interface GetChangedFilesOptions {
  baseBranch?: string;      // Explicitly specify base branch
  excludePaths?: string[];  // Paths to exclude
}
```

**Behavior:**
- Uses provided `baseBranch` or auto-detects via `getTrunkBranch()`
- For jj: `jj diff --from "latest(ancestors(${baseBranch})&ancestors(@))" --summary`
- For Git: `git diff --name-only ${baseBranch}`
- Excludes lock files, config files, logs automatically

**CLI Option:** `--diff-from` (rmfilter/config.ts:239, 412)

Used in rmfilter commands:
```bash
rmfilter --with-diff --diff-from staging src/
```

**Usage in Commands:**
- `src/rmfilter/additional_docs.ts:432-494` - `getDiffTag()` uses base branch for diff generation
- `src/rmplan/plans.ts:698-747` - `getNewPlanFilesOnBranch()` finds plan files on current branch
- `src/rmplan/incremental_review.ts` - Incremental review diffing

**Key Insight for address-comments:**
We should add a `--base-branch` or `--diff-from` CLI option that:
- Defaults to `getTrunkBranch(gitRoot)` if not specified
- Gets passed to the executor prompt as context
- Instructs the agent: "If you need to compare with the original code, diff against the `{baseBranch}` branch"

**Diffing Commands for Agent:**
- Git: `git diff ${baseBranch} -- <file>`
- jj: `jj diff --from ${baseBranch} -- <file>`

The agent can use these commands when it needs to understand what changed in a file to provide context for addressing comments.

#### Command Structure Pattern

Looking at similar commands in `src/rmplan/commands/`:

**Typical Command File Structure:**
1. CLI argument parsing and validation
2. Load effective config
3. Build executor
4. Prepare context/prompt
5. Execute
6. Post-processing (cleanup, commit, etc.)

**Example: `src/rmplan/commands/agent/agent.ts`** (minimal setup, delegates to executor)

**For address-comments, we need:**

File: `src/rmplan/commands/addressComments.ts`

1. **CLI Options:**
   - `[paths...]`: Optional file/directory paths to search (default: entire repository)
   - `--base-branch <branch>`: Base branch for diffing (default: auto-detect via `getTrunkBranch()`)
   - `--executor <name>`: Executor to use (default: from config)
   - `--model <model>`: LLM model to use
   - `--commit`: Auto-commit after addressing comments
   - `--dry-run`: Show what would be done without executing
   - `--yes`: Skip confirmation prompts

2. **Main Handler Function:**
```typescript
export async function handleAddressCommentsCommand(paths: string[] = [], options, command) {
  // 1. Load config
  const config = await loadEffectiveConfig(options.config);

  // 2. Get git root
  const gitRoot = await getGitRoot();

  // 3. Resolve base branch
  const baseBranch = options.baseBranch || await getTrunkBranch(gitRoot);

  // 4. Build executor
  const executor = buildExecutorAndLog(options.executor, {
    baseDir: gitRoot,
    model: options.model,
  }, config);

  // 5. Create prompt with optional path filtering
  const prompt = createAddressCommentsPrompt(baseBranch, paths);

  // 6. Execute
  await executor.execute(prompt, {
    planId: '',
    planTitle: 'Address AI Review Comments',
    planFilePath: '',
    executionMode: 'review',
  });

  // 7. Smart cleanup: Check if AI comments remain, prompt user if needed
  await smartCleanupAiCommentMarkers(gitRoot, paths);

  // 8. Optional commit
  if (options.commit) {
    await commitAddressedComments();
  }
}
```

3. **Prompt Template:**
```typescript
function createAddressCommentsPrompt(baseBranch: string, paths: string[] = []): string {
  const pathScope = paths.length > 0
    ? `\n\n## Search Scope\n\nOnly search for AI comments in these paths:\n${paths.map(p => `- ${p}`).join('\n')}\n`
    : '';

  return `You are a code review assistant tasked with addressing AI review comments that have been inserted into source files.

## Your Task

1. **Find AI Comments**: Search ${paths.length > 0 ? 'the specified paths' : 'the repository'} for AI review comment markers. These comments are inserted into source files using language-specific comment syntax:
   - Single-line: \`// AI: <comment>\` or \`# AI: <comment>\` or \`<!-- AI: <comment> -->\`
   - Block comments:
     \`\`\`
     // AI_COMMENT_START
     // AI: <comment text>
     // AI_COMMENT_END
     \`\`\`

2. **Understand Context**: For each AI comment:
   - Read the surrounding code to understand what's being reviewed
   - If needed, compare with the original code by diffing against the \`${baseBranch}\` branch
   - Understand the reviewer's concern or suggestion

3. **Address Comments**: Make the necessary code changes to address each review comment. Ensure changes:
   - Are minimal and focused on the review feedback
   - Preserve code style and conventions
   - Don't introduce unrelated changes
   - Pass existing tests

4. **Remove Markers**: After addressing each comment, remove the AI comment markers from the file. Do not leave any \`AI:\`, \`AI_COMMENT_START\`, or \`AI_COMMENT_END\` markers in the code.

5. **Validate**: Run tests and checks to ensure your changes don't break anything:
   - \`bun run check\` for type checking
   - \`bun run lint\` for linting
   - \`bun test\` for tests

## Important Guidelines

- Use \`rg "AI:" ${paths.length > 0 ? paths.join(' ') : ''}\` or similar grep commands to find all AI comments
- Use \`git diff ${baseBranch} -- <file>\` or \`jj diff --from ${baseBranch} -- <file>\` to see original code when needed
- Address all AI comments you find; don't skip any
- Make sure to remove all AI comment markers after addressing them
- If a comment is unclear, make your best interpretation and note it in your response
${pathScope}
## Base Branch for Comparison

The base branch for diffing is: \`${baseBranch}\`

If you need to see what changed in a file to understand context, diff against this branch.
`;
}
```

4. **Cleanup Functions:**
```typescript
// Find all files containing AI comment markers
async function findFilesWithAiComments(gitRoot: string, paths: string[] = []): Promise<string[]> {
  const rgArgs = ['-l', 'AI:'];
  if (paths.length > 0) {
    rgArgs.push(...paths);
  }

  try {
    const output = await runCommand('rg', rgArgs, { cwd: gitRoot });
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    // ripgrep exits with code 1 when no matches found
    return [];
  }
}

// Remove AI comment markers from all files
async function cleanupAiCommentMarkers(gitRoot: string, paths: string[] = []): Promise<number> {
  const files = await findFilesWithAiComments(gitRoot, paths);
  let cleanedCount = 0;

  for (const file of files) {
    const filePath = path.join(gitRoot, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const cleaned = removeAiCommentMarkers(content, file);

    if (content !== cleaned) {
      await secureWrite(gitRoot, file, cleaned);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

// Smart cleanup: checks if markers remain and prompts user
async function smartCleanupAiCommentMarkers(gitRoot: string, paths: string[] = []): Promise<void> {
  const filesWithComments = await findFilesWithAiComments(gitRoot, paths);

  if (filesWithComments.length === 0) {
    log('All AI comment markers have been removed by the agent.');
    return;
  }

  log(`Found ${filesWithComments.length} file(s) still containing AI comment markers:`);
  filesWithComments.forEach(file => log(`  - ${file}`));

  const shouldCleanup = await confirm({
    message: 'Remove remaining AI comment markers?',
    default: true,
  });

  if (shouldCleanup) {
    const cleanedCount = await cleanupAiCommentMarkers(gitRoot, paths);
    log(`Cleaned up AI comment markers from ${cleanedCount} file(s).`);
  } else {
    log('Skipped cleanup. AI comment markers remain in files.');
  }
}
```

5. **Commit Function:**
```typescript
async function commitAddressedComments(): Promise<void> {
  const hasChanges = await hasUncommittedChanges();

  if (!hasChanges) {
    log('No changes to commit');
    return;
  }

  const commitMessage = 'Address review comments';

  await commitAll(commitMessage);
}
```

#### Standalone Cleanup Command

**New Command:** `rmplan cleanup-comments [paths...]`

Provides a standalone way to remove AI comment markers without running the executor.

**Handler Function:**
```typescript
export async function handleCleanupCommentsCommand(paths: string[] = [], options, command) {
  const gitRoot = await getGitRoot();

  const filesWithComments = await findFilesWithAiComments(gitRoot, paths);

  if (filesWithComments.length === 0) {
    log('No AI comment markers found.');
    return;
  }

  log(`Found AI comment markers in ${filesWithComments.length} file(s):`);
  filesWithComments.forEach(file => log(`  - ${file}`));

  if (!options.yes) {
    const shouldCleanup = await confirm({
      message: 'Remove all AI comment markers from these files?',
      default: true,
    });

    if (!shouldCleanup) {
      log('Cleanup cancelled.');
      return;
    }
  }

  const cleanedCount = await cleanupAiCommentMarkers(gitRoot, paths);
  log(`Successfully removed AI comment markers from ${cleanedCount} file(s).`);
}
```

#### Integration Points

**CLI Integration:** `src/rmplan/cli.ts`

Add command registrations:
```typescript
// Main address-comments command
rmplanCommand
  .command('address-comments [paths...]')
  .description('Find and address AI review comments already inserted in source files')
  .option('--base-branch <branch>', 'Base branch for comparison (default: auto-detect main/master)')
  .option('--executor <name>', 'Executor to use')
  .option('--model <model>', 'LLM model to use')
  .option('--commit', 'Automatically commit changes after addressing comments')
  .option('--dry-run', 'Show what would be done without executing')
  .option('--yes', 'Skip confirmation prompts')
  .action((paths, options, command) => handleAddressCommentsCommand(paths || [], options, command));

// Standalone cleanup command
rmplanCommand
  .command('cleanup-comments [paths...]')
  .description('Remove AI comment markers from source files')
  .option('--yes', 'Skip confirmation prompt')
  .action((paths, options, command) => handleCleanupCommentsCommand(paths || [], options, command));
```

**Exports:** Add to `src/rmplan/commands/index.ts`:
```typescript
export { handleAddressCommentsCommand, handleCleanupCommentsCommand } from './addressComments.js';
```

### Risks & Constraints

1. **Executor Limitations**: Not all executors may handle the grep/diff instructions effectively. Claude Code and Codex CLI should work well, but simpler executors might struggle.

2. **Comment Detection False Positives**: Searching for "AI:" might match non-comment occurrences. The grep should be carefully constructed to avoid false positives.

3. **Cleanup Timing**: The cleanup step must happen AFTER the executor completes but BEFORE any commit. If the executor fails partway through, we may leave some AI markers in place.

4. **Multiple Comment Styles**: Different file types use different comment syntax. The agent needs to understand this or we need to provide clear examples in the prompt.

5. **Concurrent Modifications**: If files are modified between when AI comments were inserted and when address-comments runs, the comments might be in unexpected locations.

6. **Test Coverage**: Since this is a new command flow, comprehensive tests are needed to ensure it works across different executors and file types.

7. **Base Branch Availability**: In detached HEAD state or shallow clones, the base branch might not be available for comparison.

### Follow-up Questions

1. ✅ **RESOLVED**: Should the command support filtering which files or directories to search for AI comments (e.g., `rmplan address-comments src/` vs entire repository)?
   - **Decision**: Support both - accept optional `[paths...]` arguments, default to entire repository if none provided

2. ✅ **RESOLVED**: Should we support incremental mode where only some AI comments are addressed, with others left for later? Or always address all found comments?
   - **Decision**: Implicit incremental support via smart cleanup - if agent doesn't address all comments, user can choose to leave remaining markers and run command again later

3. ✅ **RESOLVED**: How should the command handle cases where the executor fails to address some comments? Should it track which were addressed and which weren't?
   - **Decision**: Smart cleanup detects remaining markers and prompts user, providing visibility into what wasn't addressed

4. ✅ **RESOLVED**: Should the final cleanup step be optional (via flag), allowing users to manually verify changes before removing markers?
   - **Decision**: Smart cleanup automatically detects if markers remain and prompts user. Also added standalone `cleanup-comments` command for manual cleanup

5. ✅ **RESOLVED**: For the commit message when using `--commit`, should it list specific files/comments addressed, or use a generic message?
   - **Decision**: Simple message: "Address review comments"

6. ✅ **RESOLVED**: Should we support a "verify" mode that checks if all AI comments have been removed before completing?
   - **Decision**: Smart cleanup already provides this - it reports remaining markers and prompts user

7. ✅ **RESOLVED**: Should the command integrate with rmplan's workspace isolation feature, or always work in the current directory?
   - **Decision**: Always work in current directory - simpler implementation, user can work on a branch for safety if needed, workspace isolation would be overkill for this use case

# Implemented Functionality Notes

Implemented Task 1 by adding `src/rmplan/commands/addressComments.ts`, which introduces `handleAddressCommentsCommand`, `handleCleanupCommentsCommand`, and the supporting helpers requested in the plan. The handler now loads repository configuration, derives the git root, resolves the base branch via `getTrunkBranch`, and builds the executor with `buildExecutorAndLog`. The new `createAddressCommentsPrompt` produces review-mode prompts that instruct the agent to use ripgrep for markers, diff against the selected base branch, remove comment markers, and run Bun checks; it also respects executor path prefixes so Claude Code can auto-read files. I implemented path normalization to guard against arguments that escape the repo root and re-used `removeAiCommentMarkers` from `rmpr/modes/hybrid_context.ts` so hybrid IDs are stripped as well as plain `AI:` lines.

Tasks 2, 3, 4, 5, and 6 were handled together in the same module: `findFilesWithAiComments` shells out to `rg` with literal patterns covering `AI:`, `AI_COMMENT_START/END`, and `AI (id:` to discover files, `cleanupAiCommentMarkers` rewrites files through `secureWrite`, `smartCleanupAiCommentMarkers` provides the interactive cleanup pass (with a `--yes` bypass), and `commitAddressedComments` calls `commitAll` only when `hasUncommittedChanges` reports worktree modifications. I wired the commands into the CLI in `src/rmplan/rmplan.ts`, registering both `address-comments` and the standalone `cleanup-comments` command with all documented options. The README now documents both commands, their options, example workflows, and the supported AI marker formats so future maintainers understand the intended flow (Task 9).

For Task 7 (and coverage for Task 8’s cleanup workflow) I added `src/rmplan/commands/addressComments.test.ts`. The tests spin up a temporary repository, confirm that ripgrep-based discovery respects path filters, verify that cleaning removes `AI_COMMENT` blocks and `AI (id:` markers, and exercise the prompt builder to ensure base-branch instructions, validation commands, and scoped path lists appear as expected. This gives us regression coverage without mocking the underlying filesystem. README updates and CLI wiring ensure the feature is discoverable, while the helper exports keep the code testable for future enhancements.
