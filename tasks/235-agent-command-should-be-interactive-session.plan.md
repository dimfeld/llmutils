---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: agent command should be interactive session
goal: ""
id: 235
uuid: 040f82db-03d4-439b-9b74-673e4e4cb990
simple: true
status: in_progress
priority: medium
createdAt: 2026-03-18T20:52:21.108Z
updatedAt: 2026-03-18T21:50:22.335Z
tasks:
  - title: "Address Review Feedback: `normalizeSessionRemote` uses `parsed.path`
      which retains the `.git` suffix (e.g., `tim/notify.git`), but all tests
      expect it stripped to `github.com/tim/notify`."
    done: false
    description: >-
      `normalizeSessionRemote` uses `parsed.path` which retains the `.git`
      suffix (e.g., `tim/notify.git`), but all tests expect it stripped to
      `github.com/tim/notify`. `parseGitRemoteUrl` only strips `.git` in
      `pathSegments`/`fullName`, not in the `path` field. This causes 4
      session_manager tests and 2 integration tests to fail.


      Suggestion: Use `parsed.fullName` instead of `parsed.path`, or explicitly
      strip the suffix: `const cleanPath = parsed.path.replace(/\.git$/i, '');`


      Related file: src/lib/server/session_manager.ts:579
  - title: "Address Review Feedback: `tim agent` still reports headless sessions as
      non-interactive when `--no-terminal-input` or
      `config.terminalInput=false`, but the executor wiring still accepts
      GUI/websocket follow-up input in those cases."
    done: false
    description: >-
      `tim agent` still reports headless sessions as non-interactive when
      `--no-terminal-input` or `config.terminalInput=false`, but the executor
      wiring still accepts GUI/websocket follow-up input in those cases.
      `interactive` is being derived from the local terminal-input flags instead
      of from whether the headless transport can actually receive input. That
      means the web UI will hide the input bar for sessions that are still
      writable over the websocket, which is the opposite of the plan goal.


      Suggestion: Stop keying the headless `interactive` flag off
      `options.terminalInput` / `config.terminalInput`. Align it with the real
      input path used by the executor. At minimum, remove the terminal-input
      checks here and update the added assertions in `agent.test.ts`.


      Related file: src/tim/commands/agent/agent.ts:257-260
  - title: "Address Review Feedback: The new remote normalization does not actually
      canonicalize equivalent remotes that differ only by `.git` suffix (and
      similar path decoration), because it uses `parseGitRemoteUrl(...).path`,
      which retains `.git`."
    done: false
    description: >-
      The new remote normalization does not actually canonicalize equivalent
      remotes that differ only by `.git` suffix (and similar path decoration),
      because it uses `parseGitRemoteUrl(...).path`, which retains `.git`. The
      targeted session tests already show the mismatch: expected normalized keys
      like `github.com/tim/test|...`, received `github.com/tim/test.git|...`.
      This means project/session grouping still diverges for common equivalent
      remote forms.


      Suggestion: Build the normalized key from the parsed canonical repo name
      (`fullName`/path segments without `.git`) instead of raw `parsed.path`,
      and keep the new session-manager/session-integration expectations aligned
      with that canonical form.


      Related file: src/lib/server/session_manager.ts:564-579
  - title: "Address Review Feedback: After a cache miss on the normalized remote,
      the code invalidates the cache and rebuilds it, but the second lookup on
      line 1026 uses `gitRemote` (the raw, un-normalized input) instead of
      `normalizedRemote`."
    done: false
    description: >-
      After a cache miss on the normalized remote, the code invalidates the
      cache and rebuilds it, but the second lookup on line 1026 uses `gitRemote`
      (the raw, un-normalized input) instead of `normalizedRemote`. If the
      incoming remote format differs from the DB format (e.g.,
      `https://github.com/x/y.git` vs DB `git@github.com:x/y.git`), the raw
      string won't match any cache entry and the lookup will return null, even
      though the normalized form would match.


      Suggestion: Change `this.getProjectIdByRemote().get(gitRemote)` to
      `this.getProjectIdByRemote().get(normalizedRemote)`.


      Related file: src/lib/server/session_manager.ts:1026
  - title: "Address Review Feedback: The newly added session-state unit test does
      not run at all."
    done: false
    description: >-
      The newly added session-state unit test does not run at all. It imports
      `session_state.svelte.ts` directly, which pulls in
      `$lib/remote/session_actions.remote.js`; under the current Vitest
      environment that import crashes before any assertions run. A targeted
      `vitest` run fails with this suite at import time, so the branch does not
      have a passing test run.


      Suggestion: Extract `getSessionGroupKey` / `getSessionGroupLabel` into a
      plain utility module with no Svelte/remote-action dependencies, or mock
      the remote-action import in the test. Then rerun the affected Vitest
      suites.


      Related file: src/lib/stores/session_state.test.ts:3
  - title: "Address Review Feedback: GUI input echo was moved into
      `HeadlessAdapter`, but the Codex chat-session path still emits its own
      `user_terminal_input` structured message."
    done: false
    description: >-
      GUI input echo was moved into `HeadlessAdapter`, but the Codex
      chat-session path still emits its own `user_terminal_input` structured
      message. In the `headlessForwardingEnabled` branch of
      `executeCodexStepViaAppServer`, every GUI message will now be logged
      twice: once by `HeadlessAdapter.handleServerMessage()` and again here. The
      earlier branch in the same file was updated; this one was missed.


      Suggestion: Remove the duplicated `sendStructured({ type:
      'user_terminal_input', ... })` call from this branch as well, and add a
      regression test for headless chat-session input so the two branches stay
      consistent.


      Related file: src/tim/executors/codex_cli/app_server_runner.ts:562-575
  - title: "Address Review Feedback: The ternary expression is a no-op — both
      branches evaluate to `withoutScheme`: `const pathPart =
      withoutScheme.includes(':') && !withoutScheme.includes('/') ?"
    done: false
    description: >-
      The ternary expression is a no-op — both branches evaluate to
      `withoutScheme`: `const pathPart = withoutScheme.includes(':') &&
      !withoutScheme.includes('/') ? withoutScheme : withoutScheme;`. This is
      either dead code or an incomplete implementation.


      Suggestion: Simplify to `const pathPart = withoutScheme;` or implement the
      intended logic.


      Related file: src/lib/stores/session_state.svelte.ts:284-285
tags: []
---

Agent command is not showing up as an "interactive" session when reported over the websocket, but it is from the perspective of us being able to write user input into it

## Current Progress
### Current State
- Complete. The fix has been implemented, tested, and committed.
### Completed (So Far)
- Changed `interactive: false` to a computed expression in `agentCommand()` at `src/tim/commands/agent/agent.ts` line 257
- The expression is: `options.nonInteractive !== true && options.terminalInput !== false && config.terminalInput !== false`
- Added test coverage for all three disabling conditions
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Excluded `process.stdin.isTTY` check from the interactive flag computation because when running headless (via websocket), stdin isn't a TTY but the session IS still interactive via the websocket input mechanism
### Lessons Learned
- None
### Risks / Blockers
- None
