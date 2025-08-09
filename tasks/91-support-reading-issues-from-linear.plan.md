---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Support reading issues from Linear
goal: Integrate the Linear SDK and refactor the existing GitHub issue-fetching
  logic to use a common, abstract interface, enabling support for both
  platforms.
id: 91
status: in_progress
priority: medium
dependencies: []
docs:
  - https://linear.app/developers/sdk
planGeneratedAt: 2025-08-09T01:09:41.856Z
promptsGeneratedAt: 2025-08-09T01:16:36.710Z
createdAt: 2025-08-09T00:50:13.309Z
updatedAt: 2025-08-09T01:16:37.066Z
tasks:
  - title: Update Configuration Schema for Issue Tracker Selection
    description: >
      Add a new configuration option to `configSchema.ts` that allows users to
      select between 'github' and 'linear' as their issue tracker. This setting
      will control which service is used for issue-related commands. The default
      value should remain 'github' to ensure backward compatibility.


      The configuration should be added at the root level of the
      rmplanConfigSchema object, similar to how other service configurations are
      handled in the codebase. The field should use a zod enum validator to
      ensure only valid values are accepted.
    files:
      - src/rmplan/configSchema.ts
      - src/rmplan/configSchema.test.ts
    steps:
      - prompt: >
          Add a new optional field `issueTracker` to the rmplanConfigSchema in
          configSchema.ts using z.enum(['github', 'linear']).

          Set the default value to 'github' and add a description explaining it
          controls which issue tracking service to use.
        done: false
      - prompt: >
          Create a test file configSchema.test.ts that validates the new
          issueTracker field accepts both 'github' and 'linear' values,

          defaults to 'github' when not specified, and rejects invalid values.
        done: false
  - title: Define Generic Issue Tracker Data Structures
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
    files:
      - src/common/issue_tracker/types.ts
      - src/common/issue_tracker/types.test.ts
    steps:
      - prompt: >
          Create src/common/issue_tracker/types.ts with TypeScript interfaces
          for IssueData (containing id, number/key, title, body, htmlUrl,
          createdAt, updatedAt),

          CommentData (containing id, body, user info, createdAt), and
          IssueWithComments (combining issue and comments array).
        done: false
      - prompt: >
          Add an IssueTrackerClient interface that defines methods:
          fetchIssue(identifier: string), fetchAllOpenIssues(), 

          and parseIssueIdentifier(spec: string) that returns parsed issue info
          or null.
        done: false
      - prompt: >
          Create a test file that validates the type definitions work correctly
          with sample data from both GitHub and Linear formats,

          ensuring the interfaces are flexible enough to handle both services.
        done: false
  - title: Implement Linear SDK Client Initialization
    description: >
      Create a utility to initialize and provide access to the Linear SDK
      client. This module will be responsible for reading the `LINEAR_API_KEY`
      from the environment and configuring the SDK instance for use in other
      parts of the application.


      Follow the pattern used in model_factory.ts for handling environment
      variables and configuration. The module should provide clear error
      messages if the API key is missing when Linear is selected as the issue
      tracker.
    files:
      - src/common/issue_tracker/linear_client.ts
      - src/common/issue_tracker/linear_client.test.ts
    steps:
      - prompt: >
          Create linear_client.ts that exports a function getLinearClient()
          which reads LINEAR_API_KEY from environment variables,

          initializes the LinearClient from @linear/sdk with the API key, and
          caches the client instance for reuse.
        done: false
      - prompt: >
          Add error handling that throws a descriptive error if LINEAR_API_KEY
          is not set when attempting to create the client.

          Include a helper function to check if Linear is configured (API key
          present).
        done: false
      - prompt: >
          Create tests that verify the client initialization works with a valid
          API key, throws appropriate errors when the key is missing,

          and properly caches the client instance across multiple calls.
        done: false
  - title: Develop Linear Issue Fetching Logic
    description: >
      Implement functions to fetch an issue and its comments from the Linear API
      using the SDK. This logic will handle parsing Linear issue IDs (e.g.,
      TEAM-123), making the necessary API calls, and mapping the response data
      to the generic issue and comment structures defined previously.


      The implementation should follow the patterns in
      src/common/github/issues.ts but work with Linear's GraphQL API through the
      SDK. Include support for fetching all open issues in a team/project.
    files:
      - src/common/issue_tracker/linear.ts
      - src/common/issue_tracker/linear.test.ts
    steps:
      - prompt: >
          Create linear.ts implementing the IssueTrackerClient interface for
          Linear. Start with parseIssueIdentifier that handles Linear issue keys
          (TEAM-123 format)

          and URLs (linear.app/team/issue/...), extracting the issue identifier.
        done: false
      - prompt: >
          Implement fetchIssue method that uses the Linear SDK to fetch an issue
          by identifier, including its comments through the GraphQL API.

          Map the Linear issue and comment data to the generic IssueData and
          CommentData interfaces.
        done: false
      - prompt: >
          Implement fetchAllOpenIssues that queries Linear for all open issues
          in the user's workspace, handling pagination if needed.

          Return them mapped to the generic IssueData format.
        done: false
      - prompt: >
          Create comprehensive tests using the ModuleMocker to mock Linear SDK
          responses, testing issue fetching, comment retrieval,

          identifier parsing for various formats, and error handling for
          non-existent issues.
        done: false
  - title: Create an Issue Tracker Abstraction Layer
    description: >
      Build a factory or service that provides an issue tracker client (either
      GitHub or Linear) based on the project configuration. This will abstract
      the implementation details, allowing commands to request an issue tracker
      without needing to know which service is being used.


      Follow the factory pattern used in model_factory.ts. The factory should
      read the configuration, validate that the selected tracker is properly
      configured (API keys present), and return the appropriate implementation.
    files:
      - src/common/issue_tracker/github.ts
      - src/common/issue_tracker/factory.ts
      - src/common/issue_tracker/factory.test.ts
    steps:
      - prompt: >
          Create github.ts that implements IssueTrackerClient by wrapping the
          existing functions from src/common/github/issues.ts.

          Map the GitHub API responses to the generic interfaces, maintaining
          backward compatibility.
        done: false
      - prompt: >
          Create factory.ts with a getIssueTracker function that reads the
          issueTracker config value and returns either the GitHub or Linear
          implementation.

          Include validation that the selected tracker is properly configured
          (GITHUB_TOKEN or LINEAR_API_KEY present).
        done: false
      - prompt: >
          Add a helper function in factory.ts to check which trackers are
          available based on configured API keys,

          useful for providing helpful error messages to users.
        done: false
      - prompt: >
          Create tests for the factory that verify it returns the correct
          implementation based on config, handles missing API keys gracefully,

          and provides clear error messages when misconfigured.
        done: false
  - title: Refactor `import` Command to Use Abstraction Layer
    description: >
      Update the `rmplan import` command to use the new issue tracker
      abstraction layer. This will involve replacing direct calls to
      GitHub-specific functions with calls to the generic issue tracker
      interface, enabling the command to work with both GitHub and Linear
      seamlessly.


      The refactoring should maintain all existing functionality while adding
      Linear support. The command should automatically detect which tracker to
      use based on configuration.
    files:
      - src/rmplan/commands/import.ts
      - src/rmplan/commands/generate.ts
      - src/rmplan/issue_utils.ts
      - src/rmplan/commands/import.test.ts
    steps:
      - prompt: >
          Update import.ts to import getIssueTracker from the factory instead of
          GitHub-specific functions.

          Replace fetchIssueAndComments and fetchAllOpenIssues calls with the
          generic tracker methods.
        done: false
      - prompt: >
          Modify the issue selection logic in import.ts to work with the generic
          IssueData interface,

          ensuring the interactive selection works for both GitHub and Linear
          issues.
        done: false
      - prompt: >
          Update issue_utils.ts to use the generic IssueData type instead of
          GitHub-specific types,

          adjusting the createStubPlanFromIssue function to work with the
          abstracted data.
        done: false
      - prompt: >
          Update generate.ts to use getIssueTracker for fetching issues when the
          --issue flag is used,

          maintaining compatibility with the existing RmprOptions parsing.
        done: false
      - prompt: >
          Update existing import.test.ts to test both GitHub and Linear
          implementations,

          using the ModuleMocker to mock the factory and verify both paths work
          correctly.
        done: false
  - title: Add Comprehensive Tests for Linear Integration
    description: >
      Create new tests to validate the Linear API fetching logic and ensure it
      correctly maps data to the generic interfaces. Update existing tests for
      the `import` command to cover the new Linear workflow, including creating
      and updating plans from Linear issues.


      Follow the testing patterns established in the codebase, using the
      ModuleMocker for external dependencies and real filesystem operations
      where appropriate.
    files:
      - src/rmplan/commands/integration_linear.test.ts
      - src/common/issue_tracker/integration.test.ts
    steps:
      - prompt: >
          Create integration_linear.test.ts that tests the full import workflow
          with Linear issues,

          including importing single issues, batch importing, and updating
          existing plans from Linear.
        done: false
      - prompt: >
          Add tests for edge cases like Linear issues without comments, issues
          with many comments,

          and handling of Linear-specific fields like priority and status.
        done: false
      - prompt: >
          Create integration.test.ts that tests the issue tracker abstraction
          works correctly for both services,

          verifying that switching between GitHub and Linear via config works as
          expected.
        done: false
      - prompt: >
          Add tests that verify the plan files created from Linear issues have
          the correct structure,

          including proper issue URLs and formatted content from Linear's
          markdown.
        done: false
  - title: Update Project Documentation
    description: >
      Document the new Linear integration feature in the project's `README.md`
      or other relevant documentation files. This should include instructions on
      how to configure the `issueTracker` setting and set up the
      `LINEAR_API_KEY` environment variable.


      The documentation should include examples of using the import command with
      Linear issues and explain any differences in behavior between GitHub and
      Linear integration.
    files:
      - README.md
      - docs/linear-integration.md
    steps:
      - prompt: >
          Add a new section to README.md explaining Linear integration support,
          including how to set the LINEAR_API_KEY environment variable

          and configure issueTracker in rmplan.yml with a clear example
          configuration.
        done: false
      - prompt: >
          Create docs/linear-integration.md with detailed documentation
          including Linear issue ID formats (TEAM-123),

          supported Linear features, example workflows, and any limitations
          compared to GitHub integration.
        done: false
      - prompt: >
          Add examples showing how to import Linear issues using both
          interactive mode and direct issue IDs,

          including sample output to help users understand the feature.
        done: false
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
