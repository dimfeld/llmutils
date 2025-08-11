---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add "Allow for this session" to permissions MCP
goal: Add the "Allow for this session" option to the permissions prompt and
  implement session-based approval logic without persistence.
id: 86
status: in_progress
priority: medium
dependencies: []
planGeneratedAt: 2025-08-11T08:01:30.287Z
promptsGeneratedAt: 2025-08-11T08:04:09.303Z
createdAt: 2025-08-01T19:09:16.510Z
updatedAt: 2025-08-11T08:04:09.652Z
tasks:
  - title: Add "Allow for Session" choice to permissions prompt
    description: >
      Modify the select prompt in src/rmplan/executors/claude_code.ts (around
      line 465-469) to include the new "Allow for Session" option between
      "Allow" and "Always Allow". The choice value should be 'session_allow' to
      maintain consistency with existing naming patterns. The prompt currently
      shows three options: Allow, Disallow, and Always Allow. The new option
      should be inserted as the second choice to provide a logical progression
      from one-time approval to session approval to permanent approval.
    files:
      - src/rmplan/executors/claude_code.ts
    done: true
    steps:
      - prompt: >
          Locate the select prompt in the createPermissionSocketServer method
          that displays tool permission choices.

          Add a new choice with name "Allow for Session" and value
          "session_allow" between the existing "Allow" and "Always Allow"
          options.
        done: true
      - prompt: >
          Ensure the new choice follows the existing format and maintains the
          same styling as other choices.

          The order should be: Allow, Allow for Session, Always Allow, Disallow.
        done: true
  - title: Implement session_allow handler logic
    description: >
      Add handling for the 'session_allow' choice in the permission request
      handler (around line 484-522). The logic should set approved = true when
      userChoice === 'session_allow', and for Bash tools, use the existing
      prefixPrompt to select command prefix just like "Always Allow" does. The
      tool/prefix should be added to alwaysAllowedTools Map exactly as "Always
      Allow" does, but critically must skip the addPermissionToFile() call to
      prevent persistence. The session approval should log an appropriate
      message indicating it's for the current session only. The existing
      infrastructure where tools in alwaysAllowedTools but not in
      configAllowedTools are treated as session-only will automatically handle
      the rest.
    files:
      - src/rmplan/executors/claude_code.ts
    done: true
    steps:
      - prompt: >
          In the permission handler after retrieving userChoice, add a condition
          to check if userChoice === 'session_allow'.

          Set approved = true for this case, similar to how it's done for
          'always_allow'.
        done: true
      - prompt: >
          Add an if block to handle session_allow that mirrors the always_allow
          logic but without persistence.

          For Bash tools, use prefixPrompt to get the prefix selection and add
          it to alwaysAllowedTools.
        done: true
      - prompt: >
          For non-Bash tools in session_allow, add the tool to
          alwaysAllowedTools with value true.

          Add appropriate logging using chalk.blue to indicate the tool was
          added for the current session only.
        done: true
      - prompt: >
          Ensure the session_allow handler does NOT call addPermissionToFile()
          method.

          The tool should only exist in alwaysAllowedTools, not in the settings
          file.
        done: true
  - title: Update logging for session vs persistent approvals
    description: >
      Verify and enhance the auto-approval logging (around lines 374-383) to
      ensure it correctly differentiates between session-based and
      configuration-based approvals. The existing code already checks if the
      tool exists in configAllowedTools Set to determine the approval source.
      Session approvals should log messages like "Tool X automatically approved
      (always allowed (session))" while configuration-based approvals should log
      "Tool X automatically approved (configured in allowlist)". This
      differentiation helps users understand why a tool was auto-approved and
      whether the approval will persist.
    files:
      - src/rmplan/executors/claude_code.ts
    done: true
    steps:
      - prompt: >
          Review the existing auto-approval logging code to confirm it properly
          differentiates between session and config approvals.

          Verify that tools not in configAllowedTools are logged as "(always
          allowed (session))".
        done: true
      - prompt: >
          If needed, adjust the log messages to make the distinction between
          session and persistent approvals clearer.

          Ensure consistency in the message format for both Bash commands and
          regular tools.
        done: true
  - title: Add comprehensive test coverage
    description: >
      Create test cases in src/rmplan/executors/claude_code.test.ts to verify
      the new "Allow for Session" functionality. Tests should verify that the
      new option appears in the prompt, that selecting 'session_allow' adds to
      alwaysAllowedTools but not to the settings file, that session approvals
      work for both simple tools and Bash commands with prefixes, that
      auto-approval works for session-approved tools during the same session,
      that session approvals are properly differentiated in log messages, and
      that the settings file is not modified when using session approvals. Build
      on the existing test patterns that already test session vs config-based
      approvals.
    files:
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Add a test that verifies the permissions prompt now includes four
          choices with "Allow for Session" as the second option.

          Mock the select prompt and verify it's called with the correct choices
          array.
        done: false
      - prompt: >
          Create a test that simulates selecting "Allow for Session" for a
          regular tool.

          Verify the tool is added to alwaysAllowedTools but addPermissionToFile
          is not called.
        done: false
      - prompt: >
          Add a test for "Allow for Session" with Bash commands that verifies
          prefixPrompt is called.

          Ensure the selected prefix is added to alwaysAllowedTools but not
          persisted to settings.
        done: false
      - prompt: >
          Create a test that verifies auto-approval works for session-approved
          tools on subsequent requests.

          Check that the log message indicates session-based approval.
        done: false
      - prompt: >
          Add a test that verifies the settings file remains unchanged when
          using session approvals.

          Mock file operations to ensure addPermissionToFile is never called for
          session approvals.
        done: false
  - title: Test edge cases and integration
    description: >
      Verify edge cases including session approval followed by "Always Allow"
      for the same tool (should upgrade to persistent), multiple session
      approvals for different Bash prefixes, session approvals working correctly
      with the permissions MCP server, existing "Always Allow" functionality
      remaining unchanged, and configuration-based approvals continuing to work
      as before. These tests ensure the new feature integrates seamlessly with
      existing functionality without breaking backward compatibility or
      introducing unexpected behavior.
    files:
      - src/rmplan/executors/claude_code.test.ts
    steps:
      - prompt: >
          Create a test where a tool is first approved for session, then later
          approved with "Always Allow".

          Verify the tool transitions from session-only to persistent approval
          correctly.
        done: false
      - prompt: >
          Add a test for multiple session approvals of different Bash command
          prefixes.

          Ensure each prefix is tracked separately in the alwaysAllowedTools
          array.
        done: false
      - prompt: >
          Test that existing "Always Allow" functionality still works exactly as
          before.

          Verify it adds to both alwaysAllowedTools and calls
          addPermissionToFile.
        done: false
      - prompt: >
          Create an integration test that simulates a full session with mixed
          approval types.

          Verify session approvals don't persist after the executor is
          recreated.
        done: false
      - prompt: >
          Add a test for the MCP server integration to ensure session approvals
          work correctly through the socket.

          Verify the permission response is sent with approved=true for session
          approvals.
        done: false
---

# Original Plan Details

Update the Claude Code permissions MCP to have an option for "allow for this session".

This should work like Always Allow, but not persist the rule to the configuration and instead just add it to the
in-memory allowlist.

It should include the same prefix matching selection code as Always Allow.

# Processed Plan Details

Update the Claude Code permissions MCP to add an "Allow for this session" option alongside the existing "Allow", "Disallow", and "Always Allow" choices. This option will add tools to the in-memory allowlist using the same prefix matching logic as "Always Allow" but without persisting the rules to `.claude/settings.local.json`. The implementation leverages the existing session-based approval infrastructure where tools in `alwaysAllowedTools` Map but not in `configAllowedTools` Set are treated as session-only approvals.

**Constraints:**
- Must maintain backward compatibility with existing permission configurations
- Session approvals should not persist across Claude Code restarts
- Must use the same prefix selection mechanism for Bash commands
- Should provide clear user feedback about session-based vs persistent approvals

**Acceptance Criteria:**
- Users see four options when prompted for tool permissions: Allow, Allow for Session, Always Allow, and Disallow
- Selecting "Allow for Session" adds the tool to the allowlist for the current session only
- Session approvals work with the same prefix matching logic as persistent approvals for Bash commands
- Session approvals are not written to `.claude/settings.local.json`
- Appropriate log messages distinguish between session and persistent approvals
- All existing tests pass and new tests verify the session-only behavior

Modify the Claude Code executor to add a new "Allow for Session" choice to the permissions prompt. When selected, this option will add tools to the in-memory `alwaysAllowedTools` Map using the existing prefix matching selection for Bash commands, but skip the persistence step that writes to the settings file. The implementation will reuse the existing session-based approval infrastructure where the `configAllowedTools` Set is used to differentiate configuration-based approvals from session-based ones for logging purposes.

**Acceptance Criteria:**
- The permissions prompt displays "Allow for Session" as the second option (between "Allow" and "Always Allow")
- Selecting "Allow for Session" adds the tool to `alwaysAllowedTools` without calling `addPermissionToFile()`
- For Bash commands, the same prefix selection UI is presented for session approvals
- Log messages clearly indicate when a tool is approved for the session vs permanently
- Session approvals auto-approve subsequent uses of the same tool/command during the session
- Session approvals are lost when the Claude Code process ends
