---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Claude Permissions MCP should read existing allowlist
goal: To add the core logic for checking permission requests against the
  configured `allowedTools` list and to add comprehensive tests verifying the
  new behavior.
id: 95
uuid: 9a3f104f-6c69-4378-98c1-b2741e22bc9e
status: done
priority: high
dependencies: []
planGeneratedAt: 2025-08-11T07:03:16.500Z
promptsGeneratedAt: 2025-08-11T07:07:40.456Z
createdAt: 2025-08-11T07:00:46.652Z
updatedAt: 2025-10-27T08:39:04.248Z
tasks:
  - title: "Task 1: Pre-process `allowedTools` into an efficient lookup structure"
    done: true
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
  - title: "Task 2: Update the permission handler to use the allowlist for
      auto-approval"
    done: true
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
  - title: "Task 3: Add unit tests for allowlist-based auto-approval"
    done: true
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
