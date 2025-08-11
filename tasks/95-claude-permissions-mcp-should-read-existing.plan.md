---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Claude Permissions MCP should read existing allowlist
goal: To add the core logic for checking permission requests against the
  configured `allowedTools` list and to add comprehensive tests verifying the
  new behavior.
id: 95
status: pending
priority: high
dependencies: []
planGeneratedAt: 2025-08-11T07:03:16.500Z
promptsGeneratedAt: 2025-08-11T07:07:40.456Z
createdAt: 2025-08-11T07:00:46.652Z
updatedAt: 2025-08-11T07:07:40.456Z
tasks:
  - title: "Task 1: Pre-process `allowedTools` into an efficient lookup structure"
    description: >
      In the `ClaudeCodeExecutor`, the existing `alwaysAllowedTools` map will be
      repurposed and populated at the beginning of the `execute` method. This
      map will be pre-filled by parsing the `allowedTools` configuration array
      into a structured format that is optimized for quick lookups. This
      structure will handle rules for simple tools (e.g., `Edit` -> `true`) and
      patterned tools (e.g., `Bash` -> `['jj commit', 'jj log']`), making it
      easy to check against incoming permission requests.


      The `allowedTools` array is already constructed from default tools and
      user configuration (lines 500-542). We need to parse this array and
      populate the `alwaysAllowedTools` map before the permission socket server
      is created. The parsing logic needs to handle:

      - Simple tool names like "Edit", "Write" which map to `true`

      - Bash command patterns like "Bash(jj commit:*)" which extract the prefix
      "jj commit"

      - Exact Bash commands like "Bash(pwd)" which should be stored without the
      wildcard
    files:
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          At the beginning of the `execute` method in claude_code.ts, after the
          `allowedTools` array is constructed (around line 542), add code to
          parse and populate the `alwaysAllowedTools` map.

          Parse each entry in `allowedTools`: if it's a simple tool name, set it
          to `true` in the map. If it matches the pattern "Bash(...)", extract
          the command pattern and add it to an array of allowed Bash prefixes.
        done: false
      - prompt: >
          For Bash command patterns, handle both exact matches (like
          "Bash(pwd)") and wildcard patterns (like "Bash(jj commit:*)").

          Strip the trailing ":*" from wildcard patterns to get the prefix.
          Store all Bash patterns in a single array under the "Bash" key in the
          map.
        done: false
  - title: "Task 2: Update the permission handler to use the allowlist for
      auto-approval"
    description: >
      Modify the `createPermissionSocketServer` method in `claude_code.ts`.
      Inside the socket's `data` event handler, enhance the logic that checks
      `alwaysAllowedTools`. This check will now also cover the pre-configured
      allowlist rules populated in the previous task. If an incoming `tool_name`
      and `input` match a rule, the handler will immediately send an `approved:
      true` response, log that the action was auto-approved based on the
      configuration, and bypass the user prompt entirely.


      The existing code already checks `alwaysAllowedTools` (lines 258-283), so
      the main change is to add a log message that distinguishes between
      configuration-based auto-approval and session-based "Always Allow"
      choices. The log message should clearly indicate when a tool is
      auto-approved based on the pre-configured allowlist versus runtime
      choices.
    files:
      - src/rmplan/executors/claude_code.ts
    steps:
      - prompt: >
          In the `createPermissionSocketServer` method where tools are
          auto-approved from `alwaysAllowedTools` (around lines 266 and 275),
          update the log messages to indicate that the approval is based on the
          configuration allowlist.

          Change the messages from "automatically approved (always allowed)" to
          something like "automatically approved (configured in allowlist)".
        done: false
  - title: "Task 3: Add unit tests for allowlist-based auto-approval"
    description: >
      In `claude_code.test.ts`, add a new suite of tests to verify the
      auto-approval functionality. These tests will simulate permission requests
      for various scenarios, including a tool that should be approved exactly
      (e.g., `WebFetch`), a `Bash` command that matches an allowed prefix (e.g.,
      `jj commit`), and cases where a command does not match and should fall
      through to the normal permission flow. The tests must confirm that the
      correct response is sent over the mocked socket connection.


      Follow the existing test patterns that mock the socket server and
      permission request handler. The tests should verify both the
      approval/denial response and the appropriate log messages. Use the
      existing test structure from the tracked file deletion tests as a
      reference (starting around line 1365).
    files:
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Add a new test suite in claude_code.test.ts called "allowlist-based
          auto-approval" that tests the pre-configured allowlist functionality.

          Create a test that verifies a simple tool like "Edit" is auto-approved
          when it's in the allowedTools configuration.
        done: false
      - prompt: >
          Add a test that verifies Bash commands matching an allowed prefix
          pattern are auto-approved.

          Test both exact matches (like "jj commit -m 'test'") and prefix
          matches with additional arguments.
        done: false
      - prompt: >
          Add a test that verifies tools and commands NOT in the allowlist still
          trigger the normal permission prompt.

          Mock the select prompt to return a response and verify the prompt was
          called.
        done: false
      - prompt: >
          Add a test that verifies the correct log messages are generated when
          auto-approving based on the configuration.

          Use a spy on the log function to capture and verify the message
          indicates configuration-based approval.
        done: false
rmfilter:
  - src/rmplan/executors/claude_code.ts
  - src/rmplan/executors/claude_code
---

# Original Plan Details

Seems like sometimes Claude Code will ask for permissions on commands that should be allowed. This particularly comes up
on log `jj commit` commands. Permissions MCP code should be aware of the existing allowlist and match up allowed tool
calls to automatically respond, if appropriate, instead of prompting.

# Processed Plan Details

The current permission Master Control Program (MCP) for the Claude Code executor prompts for every tool use that has not been explicitly allowed during the current session via the "Always Allow" option. However, the executor is configured with a static `allowedTools` list (e.g., in `.rmplan.json` or via defaults) which the `claude` process itself respects. The interactive permission handler does not currently consult this list, leading to redundant prompts.

This project will modify the permission request handler within the `ClaudeCodeExecutor` to consult this pre-configured allowlist. If an incoming tool request matches a rule in the allowlist, it will be automatically approved without user interaction.

### Acceptance Criteria
- Tool calls matching rules in the `allowedTools` configuration (e.g., `Edit`, `Bash(jj commit:*)`) are automatically approved without prompting the user.
- A log message indicates when a tool has been auto-approved based on the allowlist.
- Tool calls that do not match any rule in the allowlist continue to trigger the user permission prompt as they do currently.
- The feature correctly handles both simple tool names (e.g., `Write`) and patterned `Bash` commands (e.g., `Bash(jj log:*)`).
- Existing auto-approval features, such as "Always Allow" selected during a session and the automatic approval for deleting tracked files, continue to function correctly.
- The new functionality is thoroughly covered by unit tests in `claude_code.test.ts`.

### Technical Considerations and Approach
The core logic will be implemented within the `createPermissionSocketServer` method in `src/rmplan/executors/claude_code.ts`. The `allowedTools` array, which is already available in the executor, will be parsed into a more efficient lookup structure (e.g., a `Map<string, true | string[]>`) at the start of the execution. This structure will map tool names to either `true` (for simple tools) or an array of allowed command prefixes (for `Bash`).

When a permission request is received from the MCP process, the handler will first check it against this new structure. If a match is found, it will send an approval response and bypass the user prompt. This new check will be integrated with the existing auto-approval logic.

This phase will deliver the complete functionality. We will first create a mechanism to parse the `allowedTools` array into an efficient data structure. Then, we will update the permission request handler to use this structure for auto-approving tool calls. Finally, we will add robust unit tests to ensure the new logic is correct and does not interfere with existing functionality.
