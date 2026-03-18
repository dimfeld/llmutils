---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: agent command should be interactive session
goal: ""
id: 235
uuid: 040f82db-03d4-439b-9b74-673e4e4cb990
simple: true
status: done
priority: medium
createdAt: 2026-03-18T20:52:21.108Z
updatedAt: 2026-03-18T22:16:47.243Z
tasks:
  - title: "Address Review Feedback: `normalizeSessionRemote` uses `parsed.path`
      which retains the `.git` suffix (e.g., `tim/notify.git`), but all tests
      expect it stripped to `github.com/tim/notify`."
    done: true
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
    done: true
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
    done: true
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
    done: true
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
    done: true
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
    done: true
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
    done: true
    description: >-
      The ternary expression is a no-op — both branches evaluate to
      `withoutScheme`: `const pathPart = withoutScheme.includes(':') &&
      !withoutScheme.includes('/') ? withoutScheme : withoutScheme;`. This is
      either dead code or an incomplete implementation.


      Suggestion: Simplify to `const pathPart = withoutScheme;` or implement the
      intended logic.


      Related file: src/lib/stores/session_state.svelte.ts:284-285
changedFiles:
  - docs/executor-stdin-conventions.md
  - docs/web-interface.md
  - package.json
  - src/lib/components/SessionDetail.svelte
  - src/lib/server/session_integration.test.ts
  - src/lib/server/session_manager.test.ts
  - src/lib/server/session_manager.ts
  - src/lib/stores/session_group_utils.ts
  - src/lib/stores/session_state.svelte.ts
  - src/lib/stores/session_state.test.ts
  - src/logging/headless_adapter.test.ts
  - src/logging/headless_adapter.ts
  - src/routes/projects/[projectId]/active/+layout.svelte
  - src/routes/projects/[projectId]/plans/+layout.svelte
  - src/routes/projects/[projectId]/sessions/+layout.svelte
  - src/routes/projects/[projectId]/sessions/[connectionId]/+page.svelte
  - src/tim/commands/agent/agent.test.ts
  - src/tim/commands/agent/agent.ts
  - src/tim/commands/set.test.ts
  - src/tim/commands/set.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.test.ts
  - src/tim/executors/claude_code/terminal_input_lifecycle.ts
  - src/tim/executors/codex_cli/app_server_runner.test.ts
  - src/tim/executors/codex_cli/app_server_runner.ts
  - src/tim/tim.ts
tags: []
---

Agent command is not showing up as an "interactive" session when reported over the websocket, but it is from the perspective of us being able to write user input into it

## Current Progress
### Current State
- All 7 review feedback tasks completed.
### Completed (So Far)
- `normalizeSessionRemote` now uses `parsed.fullName` instead of `parsed.path`, properly stripping `.git` suffix for canonical session grouping keys
- Project-id cache retry lookup now uses `normalizedRemote` instead of raw `gitRemote`
- Interactive flag in `agentCommand()` simplified to `options.nonInteractive !== true` — terminal-input flags no longer incorrectly suppress headless interactivity
- Agent tests updated: disabling terminal input no longer expects non-interactive session
- No-op ternary in `session_state.svelte.ts` simplified
- Extracted `getSessionGroupKey`/`getSessionGroupLabel` and helpers into `src/lib/stores/session_group_utils.ts` — plain TS module with no Svelte dependencies, re-exported from `session_state.svelte.ts` for backward compat. Tests now import from the utility module and pass.
- Removed duplicate `sendStructured({ type: 'user_terminal_input' })` from the second `headlessForwardingEnabled` block in `app_server_runner.ts` (chat-session path). Added regression test.
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Excluded `process.stdin.isTTY` check from the interactive flag computation because when running headless (via websocket), stdin isn't a TTY but the session IS still interactive via the websocket input mechanism
- Removed `terminalInput` from interactive flag entirely — it controls local stdin, not websocket input capability
### Lessons Learned
- `parseGitRemoteUrl().path` retains `.git` suffix while `fullName` strips it — always use `fullName` for canonical remote normalization
- When `.svelte.ts` files pull in browser/framework imports, pure utility functions should be extracted to plain `.ts` modules so they can be tested without mocking the entire Svelte runtime
### Risks / Blockers
- None
