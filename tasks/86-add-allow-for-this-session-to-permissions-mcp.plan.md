---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add "Allow for this session" to permissions MCP
goal: Add the "Allow for this session" option to the permissions prompt and
  implement session-based approval logic without persistence.
id: 86
status: pending
priority: medium
dependencies: []
planGeneratedAt: 2025-08-11T08:01:30.287Z
createdAt: 2025-08-01T19:09:16.510Z
updatedAt: 2025-08-11T08:01:30.287Z
tasks:
  - title: Add "Allow for Session" choice to permissions prompt
    description: Modify the select prompt in `src/rmplan/executors/claude_code.ts`
      (around line 465-469) to include the new option between "Allow" and
      "Always Allow". The choice value should be `'session_allow'` to maintain
      consistency with existing naming patterns.
    steps: []
  - title: Implement session_allow handler logic
    description: >-
      Add handling for the `'session_allow'` choice in the permission request
      handler (around line 484-522). The logic should:

      - Set `approved = true` when `userChoice === 'session_allow'`

      - For Bash tools, use the existing `prefixPrompt` to select command prefix

      - Add the tool/prefix to `alwaysAllowedTools` Map (same as "Always Allow")

      - Skip the `addPermissionToFile()` call to prevent persistence

      - Log an appropriate message indicating session-based approval
    steps: []
  - title: Update logging for session vs persistent approvals
    description: Enhance the auto-approval logging (around lines 374-383) to
      differentiate between session-based and configuration-based approvals by
      checking if the tool exists in `configAllowedTools` Set. Session approvals
      should log messages like "Tool X automatically approved (session
      allowlist)" vs "Tool X automatically approved (configured in allowlist)".
    steps: []
  - title: Add comprehensive test coverage
    description: >-
      Create test cases in `src/rmplan/executors/claude_code.test.ts` to verify:

      - The new "Allow for Session" option appears in the prompt

      - Selecting "session_allow" adds to `alwaysAllowedTools` but not to
      settings file

      - Session approvals work for both simple tools and Bash commands with
      prefixes

      - Auto-approval works for session-approved tools during the same session

      - Session approvals are properly differentiated in log messages

      - The settings file is not modified when using session approvals
    steps: []
  - title: Test edge cases and integration
    description: |-
      Verify edge cases including:
      - Session approval followed by "Always Allow" for the same tool
      - Multiple session approvals for different Bash prefixes
      - Session approvals work correctly with the permissions MCP server
      - Existing "Always Allow" functionality remains unchanged
      - Configuration-based approvals continue to work as before
    steps: []
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
