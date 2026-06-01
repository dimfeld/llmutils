# Project Environment Foundation

Contributor guidance for the project-level environment system. The
user-facing config reference lives in `README.md` (the "Project Environment
Variables" section); this doc captures the design conventions and gotchas that
the foundation and its integration across command/executor surfaces must
respect.

Relevant code:

- `src/tim/environment_templates.ts` — pure template renderer, context types,
  built-in/placeholder parity mapping, config-entry normalization.
- `src/tim/environment.ts` — runtime context construction and registered
  workspace detection (re-exports the templates module).
- `src/tim/environment_options.ts` — the shared integration helper. Surfaces
  call `buildTimWorkspaceCommandEnvironmentOptions()` (or the `…ForPath`
  variant) to build the `TimWorkspaceCommandEnvironmentOptions` passed to the
  process helpers. It normalizes `WorkspaceInfo`/`PlanSchema` inputs into the
  template context inputs and detects the workspace from the cwd when one is
  not supplied.
- `src/tim/configSchema.ts` / `src/tim/configLoader.ts` — `environment` schema
  and cross-layer merge.
- `src/common/env.ts` — shared env composition / precedence and the
  `TimWorkspaceCommandEnvironmentOptions` type.
- `src/common/process.ts` — `spawnWithStreamingIO()` and `spawnAndLogOutput()`
  accept and forward the project env options while keeping explicit `env`
  overrides as the final layer.

## Integrating a new surface

Every tim-launched user process should receive the project env layer through
the shared helper rather than rendering or composing env itself:

1. Build options with `buildTimWorkspaceCommandEnvironmentOptions()` from
   `environment_options.ts`, passing the config, the cwd, and the selected
   **execution** workspace and plan context (not the original checkout).
2. Forward those options to `spawnWithStreamingIO()` /
   `spawnAndLogOutput()`, or thread them through the executor common options in
   `src/tim/executors/types.ts`.
3. Keep any executor- or command-specific `env` (e.g. `TIM_EXECUTOR`, tunnel /
   socket values, `LLMUTILS_TASK_ID`, `LLMUTILS_PLAN_FILE_PATH`) as explicit
   overrides — they remain the final precedence layer.

Always build the options object, even when `config.environment` is undefined.
The `timEnvironment` layer is what enables the built-in baseline `TIM_*`
variables and keeps the reserved built-ins tim-owned over inherited shell env
and workspace `.env`. Skipping it when there are no user-defined variables would
silently surrender those names.

When several subprocesses launch within one workflow (e.g. lifecycle plus an
executor), build **one** env context object and share it. Constructing context
separately at each call site invites subtle branch/workspace drift between the
processes that should agree.

When building context, derive the branch from the **plan branch semantics**
established by the foundation (see `docs/parent-child-relationships.md` and the
foundation context construction). Live branch/bookmark values are only fallbacks
to use where no plan branch is available — do not read the current checkout's
branch as the primary source.

### Command surfaces without a workspace DB

Some surfaces (for example `finish`) can run without an open workspace
database. Guard workspace DB access with an explicit availability check rather
than catching an error and matching its message string — error-string matching
is brittle and breaks fallback behavior when wording changes.

Surfaces already wired: lifecycle (`src/tim/lifecycle.ts`), post-apply
(`executePostApplyCommand()` in `src/tim/actions.ts`), workspace post-clone /
update (`src/tim/workspace/workspace_manager.ts`), the Claude and Codex
executors (`src/tim/executors/claude_code*`, `src/tim/executors/codex_cli/*`),
and the subagent, proof, review, run-prompt, and `agent_multi` flows. Internal
git/jj plumbing is intentionally out of scope.

When auditing post-apply (and similar shared-helper) coverage, include the
**non-agent** command surfaces — `finish` is the easy one to miss. A change to
the shared helper can otherwise leave a user-visible command path silently
without project env.

### Gotchas

- **Lifecycle `workingDirectory`** changes only the shell cwd. `.env` loading
  and the template workspace context stay anchored to the selected workspace
  root / lifecycle `baseDir` — do not derive context from `workingDirectory`.
- **`agent_multi`** must not reuse parent-rendered plan/workspace template
  values across child `tim agent` processes. Let each child resolve its own
  context after its workspace selection (`src/tim/commands/agent_multi/command.ts`).
  - When scrubbing inherited env for a child, **distinguish rendered
    plan/workspace template values from low-level process-control variables**.
    Strip the rendered context values (so the child re-derives them), but do
    **not** strip every unknown `TIM_*` name — some are process-control
    variables the child needs before it loads config, and removing them breaks
    child process coordination.
  - Treat an async child spawn-setup failure (e.g. env rendering throwing for
    one child) as a spawn failure for that child only. One child's env error
    must not abort the other independent agent-multi children.
- **No global `process.env` mutation** — compose env per process through the
  options object.

## Testing env integration

Prefer running real filesystem/git command flows through the actual env builder
over mocking env composition. Workspace-command tests that exercise the real
`buildTimWorkspaceCommandEnvironmentOptions()` path catch precedence and
context-construction regressions that a mocked env would hide. Verify behavior
by capturing what a launched command actually sees (e.g. write `$TIM_*` to a
file from the command and assert on it) rather than asserting on the composed
object in isolation.

## Reserved built-ins vs. process-control variables

The schema only rejects the **eight context built-ins** in
`TIM_ENVIRONMENT_CONTEXT_DEFINITIONS` (`TIM_WORKSPACE_ID`, `TIM_WORKSPACE_NAME`,
`TIM_WORKSPACE_PATH`, `TIM_REPO_PATH`, `TIM_PLAN_ID`, `TIM_PLAN_UUID`,
`TIM_PLAN_FILE_PATH`, `TIM_BRANCH`). These are the only names the
`environment` config block forbids users from redefining.

The schema does not require project-defined variables to use a `TIM_` prefix.
It accepts shell-friendly uppercase names such as `DATABASE_URL` and
`APP_INSTANCE`, while continuing to reserve the built-in `TIM_*` context names.

Other `TIM_*` names that tim reads for its own process control — for example
`TIM_EXECUTOR` and the `TIM_GITHUB_APP_*` / `TIM_WEBHOOK_*` family — are **not**
reserved at the schema level, and they should not be added to the schema's
rejection set. Protect those variables later through **env composition and
explicit override precedence** (the layering in `src/common/env.ts`), not by
rejecting them in config validation. Schema rejection is reserved strictly for
the context built-ins that have one-to-one placeholder parity; widening it to
process-control vars would conflate two separate concerns and block legitimate
config.

When wiring a surface, ensure any process-control variable tim depends on is
placed correctly in the precedence stack (as an explicit `env` override) rather
than blacklisted at load time.

## Renderer error messages include the variable name

The template renderer threads the owning environment variable name into every
error it can. Keep this convention when adding or changing error paths: messages
should name the offending variable so a bad template points the user
straight at the config entry to fix. This matters most for the fallback /
literal parse failures, where the raw expression alone is ambiguous about which
config entry produced it.

When extending the renderer, pass `variableName` through new helpers and include
it in any new `throw` so the foundation's diagnostics stay consistent.
