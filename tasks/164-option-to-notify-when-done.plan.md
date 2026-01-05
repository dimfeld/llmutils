---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: option to notify when done
goal: ""
id: 164
uuid: 08281202-6508-47da-b589-951b6f5fd3de
generatedBy: agent
status: in_progress
priority: medium
planGeneratedAt: 2026-01-05T07:30:29.485Z
promptsGeneratedAt: 2026-01-05T07:30:29.485Z
createdAt: 2026-01-05T06:42:25.241Z
updatedAt: 2026-01-05T07:31:29.358Z
tasks:
  - title: Add notifications config to schema
    done: true
    description: Update src/rmplan/configSchema.ts with an optional notifications
      block (command, workingDirectory, env, enabled). Avoid zod defaults.
      Regenerate schema/rmplan-config-schema.json via
      scripts/update-json-schemas.ts and add/update any schema tests as needed.
  - title: Load global config with precedence and tests
    done: true
    description: Extend src/rmplan/configLoader.ts to load
      ~/.config/rmplan/config.yml when present and merge with existing repo
      config (default -> global -> repo/external -> local). Add configLoader
      tests covering presence/absence and precedence of global config.
  - title: Implement notification helper with suppression env
    done: true
    description: Create src/rmplan/notifications.ts to build and send Notification
      payloads (event + message required). Execute configured command with JSON
      on stdin and warn-only failures. Suppress notifications when
      RMPLAN_NOTIFY_SUPPRESS=1. Add unit tests for payload construction and
      suppression.
  - title: Integrate notifications into rmplan agent
    done: true
    description: Wire notification helper into src/rmplan/commands/agent/agent.ts so
      a single notification fires on exit for all paths (stub, batch, serial,
      error). Include correct cwd, plan info, event=agent_done, and message
      reflecting success/failure. Add tests covering success, error, and
      suppression env.
  - title: Integrate notifications into rmplan review
    done: true
    description: Wire notification helper into src/rmplan/commands/review.ts to emit
      review_input before interactive prompts and review_done after full review
      completion (including error exits but excluding early no-changes return).
      Ensure suppression env is honored. Add tests for prompt timing, error
      notification, and no-changes skip.
  - title: Propagate suppression env from Claude executor
    done: true
    description: Add RMPLAN_NOTIFY_SUPPRESS=1 to environment passed in
      src/rmplan/executors/claude_code.ts (and claude_code_orchestrator.ts if
      used for spawning) so nested rmplan runs do not notify. Add tests
      verifying env propagation.
  - title: Document notifications and global config
    done: true
    description: Update README.md to document notifications config and global config
      path/precedence. Ensure any new behavior is reflected in docs as required
      by project guidance.
tags: []
---

Config option to run a script that can notify or something whenever exiting an "agent" command or when a "review" command is done or ready for input.

This should work similarly to how Claude Code does its notify scripts, passing JSON on stdin.


Something like this:

interface Notification {
  source: 'rmplan';
  command: 'agent'|'review';
  cwd: string;
  planId: string;
  planFile: string;
  planSummary: string;
  planDescription: string;
  message: string;
}


This should be globally configurable so we may need a new config file inside ~/.config/rmplan/config.yml. This
config should share a lot of values with the per-project config file.

## Research

Overview of the opportunity
- Add a configurable notification hook that runs a user script whenever `rmplan agent` exits and when `rmplan review` either completes or reaches an interactive prompt. The script should receive a JSON payload on stdin, similar to Claude Code’s notify scripts.
- The config should be global-friendly (in `~/.config/rmplan/config.yml`) while still allowing per-repo overrides, using the same schema as the existing repository config.

Key files and patterns inspected
- src/rmplan/configSchema.ts defines the rmplan config schema (zod). It already models `postApplyCommands`, `review`, `agents`, `executors`, etc. Notes: avoid zod defaults for new fields to preserve merge behavior; defaults are applied at read time. `getDefaultConfig()` provides minimal defaults for missing config.
- src/rmplan/configLoader.ts loads repo config `.rmfilter/config/rmplan.yml`, applies optional local override `rmplan.local.yml`, and merges a subset of keys with special handling for arrays and executor settings. It caches config by overridePath/gitRoot. There is no global config loading yet.
- src/rmplan/repository_config_resolver.ts and src/rmplan/external_storage_utils.ts handle the “external storage” path under `~/.config/rmplan/repositories/<repo-id>/.rmfilter/config/rmplan.yml` when a repo has no local config. This is distinct from a global config.
- src/rmplan/commands/agent/agent.ts is the main entry for `rmplan agent` and `rmplan run`. It has multiple exit paths: stub plans (early return), batch mode (early return), and serial mode with a final `finally`. It already collects execution summaries via SummaryCollector.
- src/rmplan/commands/agent/batch_mode.ts executes batch iterations; errors are collected in SummaryCollector. It returns to `rmplanAgent`.
- src/rmplan/commands/review.ts runs review with optional interactive prompts (`select` and `checkbox`). It has early return when no changes are detected and many branches that can prompt for user input.
- src/rmplan/summary/collector.ts + src/rmplan/summary/display.ts show how execution summaries are collected and formatted; useful for building “done” messages.
- src/rmplan/display_utils.ts provides `getCombinedTitleFromSummary`, `getCombinedGoalFromSummary`, and `buildDescriptionFromPlan`, which are good candidates to populate `planSummary` / `planDescription`.
- src/common/process.ts includes `spawnAndLogOutput` with stdin support, and src/rmplan/actions.ts shows a pattern for shell execution with `sh -c` / `cmd /c`.
- scripts/update-json-schemas.ts generates schema/rmplan-config-schema.json from zod; new config fields must be reflected here.
- README.md contains the config docs for `.rmfilter/config/rmplan.yml`. It should be updated after adding a new config section and explaining global config precedence.

Current configuration behavior (important for global config)
- Only repo-level config is resolved by default. If absent, an external repo config is created under `~/.config/rmplan/repositories/...` and used as the “main” config.
- Local overrides are supported via `rmplan.local.yml` in the same directory as the main config, merged via `mergeConfigs`.
- `mergeConfigs` concatenates arrays and shallow-merges objects for specific top-level keys (including `paths`, `models`, `postApplyCommands`, `tags`, `planning`, `updateDocs`, etc). Executors are merged by executor key.
- Tests in src/rmplan/configLoader.test.ts already talk about “global” in comments but do not implement global config; this is a good place to add coverage.

Notification payload considerations
- The proposed Notification interface includes `source`, `command`, `cwd`, `planId`, `planFile`, `planSummary`, `planDescription`, `message`.
- Plan data is available in agent/review flows; utilities exist to compute a short title and description (buildDescriptionFromPlan, getCombinedTitleFromSummary, getCombinedGoalFromSummary). `plan.details` could be large; likely use `goal` or short title for summary.
- Review has multiple “ready for input” points (select action; select issues). These are the correct places to emit an “input needed” notification.

Architectural hazards and edge cases
- Agent has multiple exit paths (stub plan, batch mode, serial loop) so a single notification hook must be placed to run exactly once across all returns and exceptions.
- Review has early returns (no changes) and may throw errors during execution or file IO. Notifications should fire only after full review runs; early “no changes” exits should skip notifications.
- Non-interactive mode (`RMPLAN_INTERACTIVE=0` or `--print`) should not trigger “ready for input” notifications because no prompt occurs.
- Notifications must be suppressed for nested runs flagged by an env var injected into Claude executor subprocesses.
- Command execution for notifications must be best-effort: failures should warn but never crash the agent or review command.

Dependencies and prerequisites
- A new global config path requires `node:os` and integration into configLoader’s merge order.
- Schema updates require running scripts/update-json-schemas.ts and updating README docs.

Notable surprises
- External storage already uses `~/.config/rmplan/repositories/<repo-id>`, so the new global config must not collide with this path.
- Config merging uses array concatenation for some keys, so global + repo arrays will combine unless overridden by objects.

## Implementation Guide

Expected Behavior/Outcome
- A user can configure a notification script once (globally) and optionally override it per repository. The script runs with a JSON payload on stdin.
- `rmplan agent` always triggers a “done” notification on exit, regardless of success or failure, including stub, batch, and serial paths.
- `rmplan review` triggers a “done” notification after a full review run, including error exits (not on early “no changes” exit), and a “ready for input” notification right before an interactive prompt is shown.
- Notifications are suppressed for nested runs invoked from the Claude executor via an environment flag.
- States to model explicitly: agent done (success), agent done (error), review done (success), review done (error), review awaiting input (interactive prompt).
- The JSON payload always includes a human-friendly `message` plus an explicit `event` field to distinguish event types.

Key Findings
- Product & User Story: Users want out-of-band alerts when long-running commands finish or when a review needs attention. This mirrors Claude Code’s notify scripts and should be scriptable and automatable.
- Design & UX Approach: No new CLI flags are necessary; config-driven behavior is sufficient. Notifications should be silent on failure (warn only) so the CLI remains predictable.
- Technical Plan & Risks: Add a `notifications` config block, add global config loading with merge precedence, and inject notification hooks in agent/review flows. The main risks are missing an early return path or firing multiple notifications.
- Pragmatic Effort Estimate: Medium. Touches config loader, schema, agent/review commands, tests, and README/schema updates.

Acceptance Criteria
- [ ] Functional Criterion: A configured notification script receives JSON on stdin when `rmplan agent` exits and when `rmplan review` completes or prompts for input, but not when review exits early for “no changes”.
- [ ] Functional Criterion: `rmplan review` error exits still emit a “review_done” notification with an error message.
- [ ] UX Criterion: Interactive prompts in `rmplan review` are preceded by a notification only when prompts are actually shown (not in print/non-interactive modes).
- [ ] Technical Criterion: Global config at `~/.config/rmplan/config.yml` is loaded and merged with repo config using a clear precedence order, and notifications are suppressed for nested runs flagged by an env var from the Claude executor.
- [ ] All new code paths are covered by tests.

Dependencies & Constraints
- Dependencies: Uses existing config loader/merging logic in src/rmplan/configLoader.ts and plan metadata utilities in src/rmplan/display_utils.ts.
- Technical Constraints: Do not add zod defaults in src/rmplan/configSchema.ts; apply defaults after merge. Notification failures must not abort agent/review execution.

Implementation Notes

Recommended Approach
1) Define notification configuration in the shared rmplan config schema.
   - Add a `notifications` block in src/rmplan/configSchema.ts (no zod defaults).
   - Keep it generic (command string + optional workingDirectory/env) to match `postApplyCommands` patterns and allow global/per-repo reuse.
2) Load and merge global config.
   - Add a helper in src/rmplan/configLoader.ts to locate `~/.config/rmplan/config.yml` (via os.homedir) if it exists.
   - Merge order: default config → global config → repo/external config → local override. This preserves existing repo behavior while letting globals act as defaults.
   - Extend tests in src/rmplan/configLoader.test.ts to validate precedence and merging with global config present and absent.
3) Implement notification execution helper.
   - Create src/rmplan/notifications.ts with a `sendNotification` helper that:
     - Builds payload with `source: 'rmplan'`, `command`, `cwd`, `planId`, `planFile`, `planSummary`, `planDescription`, `event`, `message`.
     - Suppresses notifications when `RMPLAN_NOTIFY_SUPPRESS=1` is detected (applies to all commands).
     - Executes the configured command via `sh -c` / `cmd /c` (like executePostApplyCommand), writing JSON to stdin.
     - Logs warnings on failure but never throws.
3.5) Propagate nested-run env var from Claude executor spawns.
   - In src/rmplan/executors/claude_code.ts (and claude_code_orchestrator.ts if needed), add `RMPLAN_NOTIFY_SUPPRESS=1` to the `spawnAndLogOutput` env so any `rmplan` subprocess inherits it.
   - Reuse spawnAndLogOutput or Bun.spawn with stdin pipe; keep output quiet by default.
4) Wire into `rmplan agent`.
   - Capture plan metadata early and refresh it on exit (re-read plan file).
   - Wrap `rmplanAgent` body so a single notification call runs in a finalizer for all paths (stub, batch, serial, exceptions).
   - Message should indicate success vs error and optionally summarize failures using SummaryCollector (e.g., “failed steps: N”).
5) Wire into `rmplan review`.
   - Add notification before each interactive prompt (`select` for action and `checkbox` for issue selection), only when interactive mode is enabled.
   - Add a completion notification after review output is handled and before returning. For early returns (“no changes”), send a completion notification with a “nothing to review” message.
   - Ensure errors propagate but still trigger a “review failed” notification in a catch/finally block.
6) Update schema and docs.
   - Regenerate schema/rmplan-config-schema.json via scripts/update-json-schemas.ts.
   - Update README.md configuration section to document the new notifications config and the new global config file location and precedence.

Potential Gotchas
- Avoid double notifications in agent: there are multiple early `return` statements. Use a single top-level `try/finally` or a shared `notifyOnce` guard.
- Review prompts happen in multiple branches (autofix, cleanup plan, append tasks). Ensure each interactive prompt emits “ready for input” and that non-interactive modes do not.
- Plan description fields can be large; prefer a concise summary (title/goal) and use details only if explicitly desired.
- Global config should not interfere with external repo configs under `~/.config/rmplan/repositories/...`.

Conflicting, Unclear, or Impossible Requirements
- None noted; single command will be used for all events with the JSON payload distinguishing event type.

Step-by-step Implementation Guide
1) Add notification config types in src/rmplan/configSchema.ts.
   - Example shape: notifications: { command: string; workingDirectory?: string; env?: Record<string,string>; enabled?: boolean }
   - Keep the schema optional and no default values.
2) Add global config loading in src/rmplan/configLoader.ts.
   - Add a `findGlobalConfigPath()` helper (os.homedir + `.config/rmplan/config.yml`).
   - Load global config if present and merge it into the effective config before repo + local overrides.
   - Update configLoader tests to cover precedence and absence cases.
3) Implement src/rmplan/notifications.ts.
   - Define Notification payload type and helper to build summary/description from plan data.
   - Include required fields: `event` (e.g., `agent_done`, `review_done`, `review_input`) and `message` (always present for simple printing).
   - Execute command with stdin JSON, return boolean success, and log warnings on failure.
4) Integrate notifications in src/rmplan/commands/agent/agent.ts.
   - Build message based on final outcome (success vs failure).
   - Ensure notification runs once at the end for all exit paths (use a single finalizer).
   - Include `cwd` as the base directory actually used (workspace path if applicable).
5) Integrate notifications in src/rmplan/commands/review.ts.
   - Trigger “ready for input” before each interactive prompt (select/checkbox).
   - Trigger “done” notifications only after full review completion (skip early “no changes” returns).
   - Ensure errors still surface and notification is best-effort.
6) Add/adjust tests.
   - configLoader: new tests for global config merging.
   - agent: mock notifications helper to assert payload for success/failure; test stub and batch paths.
   - review: mock notifications helper and prompt functions to assert “ready for input” notification timing.
7) Update schema and README.

Manual Testing (for implementer later)
- Create a simple notify script that writes stdin JSON to a temp file, configure it in `~/.config/rmplan/config.yml`, and run `rmplan agent <plan>` to verify payload and timing.
- Run `rmplan review <plan>` with and without `RMPLAN_INTERACTIVE=0` to confirm “ready for input” fires only in interactive mode and “done” fires only after a full review run.
- Run `rmplan review` via the Claude executor and confirm notifications are suppressed due to the nested-run env var.

Rationale
- A small, config-driven notification hook gives users automation without changing CLI behavior.
- Using the existing config schema and merge system keeps behavior consistent across global and repo configurations.
- Centralizing notification execution avoids repeated shell-spawn boilerplate and makes testing straightforward.

## Current Progress
### Current State
- Regenerated rmplan JSON schemas after notification updates and validated formatting/tests.
### Completed (So Far)
- Notifications config, global config merge logic, helper, and command integrations are implemented with tests.
- Notification fallback uses global config when `loadEffectiveConfig` fails; regression tests cover error paths.
- Claude executor propagation for `RMPLAN_NOTIFY_SUPPRESS=1` is in place with coverage.
### Remaining
- Reconcile plan task completion statuses (Tasks 1–6) with the implemented code.
### Next Iteration Guidance
- If any tasks remain incomplete, update schema/docs/tests as needed and re-run `bun test`.
### Decisions / Changes
- Ran `scripts/update-json-schemas.ts`; schema output now reflects generated defaults.
- Full `bun test` run completed without timeouts.
### Risks / Blockers
- None
