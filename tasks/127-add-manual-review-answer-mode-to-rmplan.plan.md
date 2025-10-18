---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add manual review answer mode to rmplan
goal: Implement `rmplan address-comments` command to find and address AI review
  comments that are already inserted in source files, similar to `answer-pr` but
  without needing a GitHub PR.
id: 127
generatedBy: agent
status: pending
priority: medium
dependencies: []
issue: []
docs: []
planGeneratedAt: 2025-10-18T07:52:38.770Z
createdAt: 2025-10-18T07:39:11.437Z
updatedAt: 2025-10-18T07:52:38.770Z
tasks:
  - title: Create command registration and handler structure
    done: false
    description: Register the `address-comments` command in `src/rmplan/rmplan.ts`
      with appropriate options (--yes, --executor, --model, --base-branch,
      --dry-run, --commit). Create the command handler in
      `src/rmplan/commands/address-comments.ts` following the established
      pattern from answer-pr, setting up configuration loading and option
      defaulting.
    steps: []
  - title: Implement comment discovery system
    done: false
    description: Create a comment discovery module that uses grep to find AI comment
      patterns (`AI:`, `AI_COMMENT_START/END`, `AI (id:`) across the repository.
      Parse found comments into structured data including file path, line
      numbers, comment body, and detected language type. Handle multi-line
      comments and different comment syntaxes based on file extensions.
    steps: []
  - title: Build interactive comment selection interface
    done: false
    description: Implement an interactive checkbox UI using inquirer that displays
      found comments with their file locations, line numbers, and comment
      bodies. Support select all/none options and allow filtering by file path.
      Include preview of surrounding code context for each comment.
    steps: []
  - title: Create context building with rmfilter integration
    done: false
    description: Build rmfilter arguments including selected files with comments,
      optional dependency inclusion (--with-imports), and custom instructions
      for the AI. Integrate optional diff generation against base branch using
      `generateDiffForReview()`. Format the context appropriately for the review
      execution mode.
    steps: []
  - title: Implement executor invocation with review mode
    done: false
    description: "Set up executor creation with proper model selection and
      configuration. Build the prompt combining comment context, code files, and
      optional diffs. Execute with `executionMode: 'review'` to bypass
      orchestration. Handle executor output and any failure scenarios using the
      FAILED protocol."
    steps: []
  - title: Add comment cleanup after processing
    done: false
    description: Implement removal of AI comment markers from processed files using
      utilities from `src/rmpr/modes/inline_comments.ts`. Ensure all comment
      formats are properly cleaned based on file type. Preserve the actual code
      changes while removing only the comment markers.
    steps: []
  - title: Implement commit functionality
    done: false
    description: Add automatic commit creation when --commit flag is provided,
      building descriptive commit messages that list all addressed comments with
      file locations. Support both Git and Jujutsu commit commands. Include
      commit hash in success output for reference.
    steps: []
  - title: Add dry-run mode
    done: false
    description: Implement --dry-run flag that shows which comments would be
      processed, displays the prompt that would be sent to the LLM, and previews
      the rmfilter context without making any changes. This allows users to
      verify behavior before execution.
    steps: []
  - title: Create comment filtering capabilities
    done: false
    description: Add --include and --exclude options for filtering comments by file
      path patterns. Support --pattern option for filtering by comment content
      using regex. Allow --max-comments to limit the number of comments
      processed in a single run.
    steps: []
  - title: Build configuration integration
    done: false
    description: Add `addressComments` section to rmplan config schema with defaults
      for mode, executor, model, and auto-commit settings. Implement
      configuration loading and merging with CLI options following established
      precedence patterns. Document configuration options in schema files.
    steps: []
  - title: Implement comprehensive test suite
    done: false
    description: Create unit tests for comment discovery, parsing, and cleanup
      functions. Add integration tests for the full command flow using temporary
      directories. Test different file types and comment formats. Include edge
      cases like malformed comments and empty files.
    steps: []
  - title: Update documentation
    done: false
    description: Add command documentation to README with usage examples, option
      descriptions, and common workflows. Create example configuration showing
      addressComments settings. Document the AI comment format conventions for
      users who want to manually add comments.
    steps: []
  - title: Add plan file integration
    done: false
    description: Support optional --plan flag to associate comment addressing with
      an existing plan. Update plan task status as comments are addressed.
      Generate plan-aware context for better AI understanding of the broader
      goal.
    steps: []
  - title: Implement workspace lock support
    done: false
    description: When a plan is specified, acquire and manage workspace locks
      appropriately. Release locks when all plan-related comments are addressed.
      Support both PID-based and persistent lock types.
    steps: []
  - title: Extend comment format support
    done: false
    description: 'Parse extended comment metadata like `AI (priority: high, author:
      @user):` for richer context. Support comment threading where responses
      reference previous comments. Allow custom comment prefixes beyond "AI:"
      for team-specific conventions.'
    steps: []
  - title: Create bulk processing mode
    done: false
    description: Implement --bulk flag for processing all comments without
      selection. Add --parallel option to process independent comments
      concurrently. Support output to structured format (JSON/YAML) for CI
      integration.
    steps: []
  - title: Build comment reporting system
    done: false
    description: Generate summary reports showing comments found, addressed, failed,
      and remaining. Support export to Markdown format for documentation.
      Include time tracking and success metrics.
    steps: []
  - title: Add agent integration
    done: false
    description: Create specialized agent prompts for comment addressing workflows.
      Support comment addressing as a step in larger agent orchestrations.
      Enable the command to be called programmatically from other rmplan
      commands.
    steps: []
changedFiles: []
rmfilter: []
---

# Original Plan Details

Call this new command `rmplan address-comments`

This should work similar to the existing `answer-pr` command, except the AI comments are already in the files so it does not need to look at an existing PR or insert the comments itself. 

In this case, we want to instruct the agent to grep in the repository for the AI comments, which could be the single line comments or multi-line start and end pair comments.

In this case, we also won't have the diffs readily available, so we should tell the agent to diff against the base branch if it needs to compare to the original. The base branch should be the trunk branch by default, which we already have a function to get, but there should be a command line option to set a different trunk branch to diff against.

# Processed Plan Details

## Add manual review answer mode to rmplan for addressing AI comments already in files

This command provides a way to address code review comments that have been manually inserted into source files as AI comments, enabling users to process review feedback without needing an GitHub Pull Request. The command will grep for AI comment markers in the repository, gather context about the commented code, optionally diff against a base branch to show what changed, and invoke an LLM executor to address the comments.

---

## Area 1: Core Command Implementation

Tasks:
- Create command registration and handler structure
- Implement comment discovery system
- Build interactive comment selection interface
- Create context building with rmfilter integration
- Implement executor invocation with review mode
- Add comment cleanup after processing

This phase establishes the foundational command structure, comment discovery mechanism, and basic processing flow. The command will find AI comments in the repository, allow user selection, build appropriate context, and execute via the review mode executor. This provides the minimum viable functionality for addressing comments without GitHub PR dependency.

### Acceptance Criteria for Phase 1
- [ ] Command registered and accessible via CLI
- [ ] AI comments discovered via grep across repository
- [ ] Interactive selection UI displays found comments
- [ ] Selected comments processed with rmfilter context
- [ ] Executor invoked in review mode
- [ ] AI comment markers removed after processing
- [ ] Basic error handling for malformed comments

---

## Area 2: Enhanced Features and Polish

Tasks:
- Implement commit functionality
- Add dry-run mode
- Create comment filtering capabilities
- Build configuration integration
- Implement comprehensive test suite
- Update documentation

This phase enhances the core functionality with production-ready features including automatic commit creation, dry-run preview mode, advanced comment filtering options, and robust error handling. It also includes comprehensive test coverage and documentation updates to ensure the feature is ready for general use.

### Acceptance Criteria for Phase 2
- [ ] Automatic commit with descriptive messages when --commit flag used
- [ ] Dry-run mode shows what would be processed without changes
- [ ] Comment filtering by file pattern or comment content
- [ ] Batch mode with --yes flag for non-interactive execution
- [ ] Configuration support via rmplan.yaml
- [ ] Comprehensive test suite with >80% coverage
- [ ] README documentation with usage examples
- [ ] Error recovery for partial failures

---

## Area 3: Advanced Integration Features

Tasks:
- Add plan file integration
- Implement workspace lock support
- Extend comment format support
- Create bulk processing mode
- Build comment reporting system
- Add agent integration

This phase adds sophisticated integration with the broader rmplan ecosystem including plan file association, workspace lock management, and support for extended comment formats with metadata. These features enable the command to work seamlessly with existing rmplan workflows and support more complex review scenarios.

### Acceptance Criteria for Phase 3
- [ ] Optional plan file association for comment addressing tasks
- [ ] Workspace lock integration when plan is provided
- [ ] Support for comment metadata (priority, author, date)
- [ ] Bulk processing mode for CI/CD pipelines
- [ ] Comment report generation showing addressed vs remaining
- [ ] Integration with rmplan agent for automated workflows
