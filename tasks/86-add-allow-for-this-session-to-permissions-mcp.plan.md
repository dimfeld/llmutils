---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add "Allow for this session" to permissions MCP
goal: Add the "Allow for this session" option to the permissions prompt and
  implement session-based approval logic without persistence.
id: 86
uuid: 4bfb4674-3e4e-4bf3-b7ad-a9745ddc1ee5
status: done
priority: medium
dependencies: []
planGeneratedAt: 2025-08-11T08:01:30.287Z
promptsGeneratedAt: 2025-08-11T08:04:09.303Z
createdAt: 2025-08-01T19:09:16.510Z
updatedAt: 2025-10-27T08:39:04.212Z
tasks:
  - title: Add "Allow for Session" choice to permissions prompt
    done: true
    description: >
      Modify the select prompt in src/rmplan/executors/claude_code.ts (around
      line 465-469) to include the new "Allow for Session" option between
      "Allow" and "Always Allow". The choice value should be 'session_allow' to
      maintain consistency with existing naming patterns. The prompt currently
      shows three options: Allow, Disallow, and Always Allow. The new option
      should be inserted as the second choice to provide a logical progression
      from one-time approval to session approval to permanent approval.
  - title: Implement session_allow handler logic
    done: true
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
  - title: Update logging for session vs persistent approvals
    done: true
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
  - title: Add comprehensive test coverage
    done: true
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
  - title: Test edge cases and integration
    done: true
    description: >
      Verify edge cases including session approval followed by "Always Allow"
      for the same tool (should upgrade to persistent), multiple session
      approvals for different Bash prefixes, session approvals working correctly
      with the permissions MCP server, existing "Always Allow" functionality
      remaining unchanged, and configuration-based approvals continuing to work
      as before. These tests ensure the new feature integrates seamlessly with
      existing functionality without breaking backward compatibility or
      introducing unexpected behavior.
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
