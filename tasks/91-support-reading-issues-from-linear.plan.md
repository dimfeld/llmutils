---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support reading issues from Linear
goal: Integrate the Linear SDK and refactor the existing GitHub issue-fetching
  logic to use a common, abstract interface, enabling support for both
  platforms.
id: 91
uuid: d6114fc2-6855-4e4d-984d-ef0a03fb91cb
status: done
priority: medium
dependencies: []
docs:
  - https://linear.app/developers/sdk
planGeneratedAt: 2025-08-09T01:09:41.856Z
promptsGeneratedAt: 2025-08-09T01:16:36.710Z
createdAt: 2025-08-09T00:50:13.309Z
updatedAt: 2025-10-27T08:39:04.224Z
tasks:
  - title: Update Configuration Schema for Issue Tracker Selection
    done: true
    description: >
      Add a new configuration option to `configSchema.ts` that allows users to
      select between 'github' and 'linear' as their issue tracker. This setting
      will control which service is used for issue-related commands. The default
      value should remain 'github' to ensure backward compatibility.


      The configuration should be added at the root level of the
      rmplanConfigSchema object, similar to how other service configurations are
      handled in the codebase. The field should use a zod enum validator to
      ensure only valid values are accepted.
  - title: Define Generic Issue Tracker Data Structures
    done: true
    description: >
      Create a set of generic interfaces for issues and comments to decouple the
      application from GitHub-specific data models. This will ensure that data
      from both GitHub and Linear can be handled uniformly throughout the
      application.


      The interfaces should be created in a new directory
      `src/common/issue_tracker/` following the pattern used in other common
      modules. The types should cover all fields currently used by the import
      and generate commands, including issue metadata, body content, comments,
      and user information.
  - title: Implement Linear SDK Client Initialization
    done: true
    description: >
      Create a utility to initialize and provide access to the Linear SDK
      client. This module will be responsible for reading the `LINEAR_API_KEY`
      from the environment and configuring the SDK instance for use in other
      parts of the application.


      Follow the pattern used in model_factory.ts for handling environment
      variables and configuration. The module should provide clear error
      messages if the API key is missing when Linear is selected as the issue
      tracker.
  - title: Develop Linear Issue Fetching Logic
    done: true
    description: >
      Implement functions to fetch an issue and its comments from the Linear API
      using the SDK. This logic will handle parsing Linear issue IDs (e.g.,
      TEAM-123), making the necessary API calls, and mapping the response data
      to the generic issue and comment structures defined previously.


      The implementation should follow the patterns in
      src/common/github/issues.ts but work with Linear's GraphQL API through the
      SDK. Include support for fetching all open issues in a team/project.
  - title: Create an Issue Tracker Abstraction Layer
    done: true
    description: >
      Build a factory or service that provides an issue tracker client (either
      GitHub or Linear) based on the project configuration. This will abstract
      the implementation details, allowing commands to request an issue tracker
      without needing to know which service is being used.


      Follow the factory pattern used in model_factory.ts. The factory should
      read the configuration, validate that the selected tracker is properly
      configured (API keys present), and return the appropriate implementation.
  - title: Refactor `import` Command to Use Abstraction Layer
    done: true
    description: >
      Update the `rmplan import` command to use the new issue tracker
      abstraction layer. This will involve replacing direct calls to
      GitHub-specific functions with calls to the generic issue tracker
      interface, enabling the command to work with both GitHub and Linear
      seamlessly.


      The refactoring should maintain all existing functionality while adding
      Linear support. The command should automatically detect which tracker to
      use based on configuration.
  - title: Add Comprehensive Tests for Linear Integration
    done: true
    description: >
      Create new tests to validate the Linear API fetching logic and ensure it
      correctly maps data to the generic interfaces. Update existing tests for
      the `import` command to cover the new Linear workflow, including creating
      and updating plans from Linear issues.


      Follow the testing patterns established in the codebase, using the
      ModuleMocker for external dependencies and real filesystem operations
      where appropriate.
  - title: Update Project Documentation
    done: true
    description: >
      Document the new Linear integration feature in the project's `README.md`
      or other relevant documentation files. This should include instructions on
      how to configure the `issueTracker` setting and set up the
      `LINEAR_API_KEY` environment variable.


      The documentation should include examples of using the import command with
      Linear issues and explain any differences in behavior between GitHub and
      Linear integration.
changedFiles:
  - README.md
  - docs/linear-integration.md
  - package.json
  - src/common/issue_tracker/factory.integration.test.ts
  - src/common/issue_tracker/factory.test.ts
  - src/common/issue_tracker/factory.ts
  - src/common/issue_tracker/github.test.ts
  - src/common/issue_tracker/github.ts
  - src/common/issue_tracker/index.ts
  - src/common/issue_tracker/types.test.ts
  - src/common/issue_tracker/types.ts
  - src/common/linear.test.ts
  - src/common/linear.ts
  - src/common/linear_client.test.ts
  - src/common/linear_client.ts
  - src/rmfilter/rmfilter.ts
  - src/rmplan/commands/documentation_consistency_check.test.ts
  - src/rmplan/commands/generate.test.ts
  - src/rmplan/commands/generate.ts
  - src/rmplan/commands/import.integration.test.ts
  - src/rmplan/commands/import.test.ts
  - src/rmplan/commands/import.ts
  - src/rmplan/commands/integration_linear.test.ts
  - src/rmplan/commands/issue_tracker_integration.test.ts
  - src/rmplan/commands/linear_documentation_examples.test.ts
  - src/rmplan/commands/linear_plan_structure.test.ts
  - src/rmplan/commands/plan_file_validation.test.ts
  - src/rmplan/configLoader.test.ts
  - src/rmplan/configSchema.test.ts
  - src/rmplan/configSchema.ts
  - src/rmplan/issue_utils.ts
  - src/rmplan/plans/prepare_phase.ts
rmfilter:
  - src/rmplan
  - src/common/github*
---

# Original Plan Details

Any rmplan command that reads from a Github issue and its comments should be able to read from Linear instead. No need
to add any support here for pull requests since Linear doesn't host those.

The choice of Github or Linear should be configurable in the project config in configSchema.ts. Look for LINEAR_API_KEY
in the environment to get the API key for the Linear SDK.

Use the @linear/sdk NPM package for the SDK.

# Processed Plan Details

### Analysis
The current implementation for importing issues is tightly coupled with the GitHub API. Specifically, commands like `rmplan import` rely on functions in `src/common/github/issues.js` to fetch issue and comment data. To support Linear, we need to introduce an abstraction layer for issue tracking services.

This involves:
1.  **Configuration:** Adding a new setting in `src/rmplan/configSchema.ts` to let users specify their issue tracker (`github` or `linear`).
2.  **Abstraction:** Creating a generic interface for issue trackers and common data structures (for issues, comments, etc.) that both GitHub and Linear implementations will adhere to.
3.  **Linear Implementation:** Creating a new module that uses the `@linear/sdk` package to fetch issue and comment data from the Linear API, authenticating via the `LINEAR_API_KEY` environment variable.
4.  **Refactoring:** Updating the `rmplan import` command and related utilities to use the new abstraction layer, allowing them to function with either GitHub or Linear based on the user's configuration.

This approach will make the system more modular and easier to extend with other issue trackers in the future.

### Acceptance Criteria
- The `rmplan.yml` configuration file accepts a new `issueTracker` property, which can be set to either `'github'` or `'linear'`.
- When `issueTracker` is set to `'linear'`, the `rmplan import` command can successfully fetch an issue and its comments from Linear using a Linear issue ID (e.g., `TEAM-123`).
- The system correctly reads the `LINEAR_API_KEY` from the environment variables to authenticate with the Linear API.
- The existing functionality for importing from GitHub remains unchanged and fully functional when `issueTracker` is set to `'github'` or is not specified.
- The system can handle both creating new plan files from Linear issues and updating existing ones.
- Documentation is updated to explain how to configure and use the Linear integration.

### Technical Considerations
- The `@linear/sdk` package will be added as a project dependency.
- A new abstraction layer will be created to decouple the application logic from specific issue tracker implementations. This will likely involve creating a generic `IssueTracker` interface and corresponding data models.
- The existing GitHub-specific functions in `src/common/github/issues.js` will be refactored to conform to the new generic interface.
- Error handling for Linear API interactions (e.g., invalid API key, issue not found) must be implemented.

This phase focuses on building the core components for Linear integration and creating a flexible architecture for handling different issue trackers. We will start by updating the configuration, then define generic data structures, implement the Linear client, and finally refactor the `import` command to use this new system. By the end of this phase, the primary user-facing feature will be fully functional.
