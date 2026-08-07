# CI Check Classification and Actions Logs

Library modules in `src/common/github/` that find the failing checks of a pull request and
download the related GitHub Actions job logs, plus the `tim pr fix-ci` command that consumes them.
The `src/common/github/` modules contain no CLI code and no web UI code; the command layer lives in
`src/tim/commands/ci_fix.ts`.

## Modules

| Module                                       | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `src/common/github/required_check_rollup.ts` | Classification of check runs and the required-check rollup state |
| `src/common/github/select_failing_checks.ts` | Selection of the failing checks, with a `required` annotation    |
| `src/common/github/workflow_logs.ts`         | GitHub Actions URL parsing, job listing, and log download        |

`src/lib/server/required_check_rollup.ts` stays as a re-export shim. The rollup module was moved
into `src/common/` because the CLI must not import from `src/lib`. Web code can continue to import
from `$lib/server/required_check_rollup`; new code should import from `src/common/github/`.

## Check classification

`required_check_rollup.ts` supplies:

- `FAILURE_CHECK_CONCLUSIONS` — the set of conclusions that count as a failure: `failure`,
  `error`, `timed_out`, `startup_failure`, and `action_required`.
- `classifyCheckRun(check)` — classifies one check row as failing, passing, or pending.
- `getRequiredCheckNames(...)` — the names of the checks that branch protection or rulesets
  require.
- `getEffectiveCheckRollupState(...)` — the rollup state of a PR after the required checks are
  applied.

Check rows come from `normalizeChecks` in `src/common/github/pr_status.ts`. Each row has `name`,
`status`, `conclusion`, `detailsUrl`, `startedAt`, `completedAt`, and a `source` of `check_run` or
`status_context`.

## Failing-check selection

```ts
const { checks, noRequiredConfig } = selectFailingChecks(checkRows, requiredCheckNames);
```

`selectFailingChecks` returns **every** check that `classifyCheckRun` reports as failing, not only
the required ones. Each returned check carries `required: boolean`, derived from the supplied
required-check names. Get those names from
`ensureBranchMergeRequirementsFresh` in `src/common/github/branch_merge_requirements_service.ts`,
which caches branch protection and ruleset data in the database.

If the required set is empty — no branch protection and no rulesets — the result has
`noRequiredConfig: true`. Callers can then treat all failing checks as in scope. The `required`
flag only marks which checks are in scope by default; logs are collected for all failing checks.

## GitHub Actions logs

All API access uses an `Octokit` instance from `getOctokit()` (`src/common/github/octokit.ts`).
There is no retry or throttle layer, so `collectFailingCheckLogs` bounds its concurrency instead.

### `parseActionsDetailsUrl(url)`

Returns `{ owner, repo, runId, jobId? }` or `null`. It accepts `https://github.com` URLs of these
shapes:

- `/{owner}/{repo}/actions/runs/{runId}`
- `/{owner}/{repo}/actions/runs/{runId}/job/{jobId}`
- `/{owner}/{repo}/actions/runs/{runId}/attempts/{n}`
- `/{owner}/{repo}/actions/runs/{runId}/attempts/{n}/job/{jobId}`
- `/{owner}/{repo}/actions/runs/{runId}/job/{jobId}/attempts/{n}`

Anything else returns `null`. This is deliberate: a `details_url` frequently points at a
third-party app such as Vercel, and the caller must fail soft in that case. Path segments are
percent-decoded, and a URL with credentials, a port, a different host, or surrounding whitespace is
rejected.

### `listRunJobs(octokit, owner, repo, runId)`

Paginates `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` with `filter=latest`, so a re-run
resolves to the jobs of the latest attempt. Each returned job has a `steps` array that is never
`undefined`.

### `downloadJobLog(octokit, owner, repo, jobId)`

Calls `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`. Octokit follows the redirect and the
body is plaintext. The per-job endpoint is preferred over the per-run logs zip: no unzip is needed,
and only failing jobs are downloaded.

The result is `{ ok: true, content }` or `{ ok: false, error }`. A 404 (expired logs) becomes an
`ok: false` result instead of a throw. Other statuses throw.

### `collectFailingCheckLogs(options)`

```ts
const manifest = await collectFailingCheckLogs({
  octokit,
  owner,
  repo,
  headSha,
  failingChecks, // from selectFailingChecks
  destDir,
  concurrency, // optional, defaults to 4 and is capped at 4
});
```

For each failing check it:

1. Parses `detailsUrl`. If the URL parses and points at the same repository, it lists the jobs of
   that run and matches by job ID, then by job name.
2. If the URL does not parse, it lists the workflow runs for `headSha`
   (`GET /repos/{owner}/{repo}/actions/runs?head_sha=...`) and matches a failing job by name.
3. If no job matches — a status context or a third-party app — the manifest entry keeps
   `logPath: null` and records an `error` that includes the `detailsUrl`, so the caller can point
   the agent at the link.
4. Downloads the log and writes it with `secureWrite` (see `docs/path-safety.md`) to
   `destDir/<sanitized-check-name>.log`.

Each manifest entry is
`{ checkName, source, conclusion, detailsUrl, logPath, failedSteps, required, error? }`.
`failedSteps` holds the names of the job steps whose conclusion is in
`FAILURE_CHECK_CONCLUSIONS`.

Behavior worth knowing:

- Jobs per run and fallback lookups per check name are cached, so a run is listed only once even
  when several checks belong to it.
- Downloads run through a bounded worker pool. Concurrency must be a positive safe integer and is
  clamped to `MAX_LOG_DOWNLOAD_CONCURRENCY` (4).
- Per-check failures are recorded in the entry's `error` field and do not stop the collection. A
  systemic HTTP error (401, 403, or 429) throws instead, because continuing would only burn rate
  limit.
- Check names are sanitized to a safe file name: NFKC-normalized, restricted to
  `[A-Za-z0-9_-]`, truncated to 100 characters, with Windows device names such as `CON` prefixed.
  Collisions get a `-2`, `-3`, … suffix, compared case-insensitively.
- `destDir` is created only when at least one job resolved, so an unresolvable check set leaves no
  empty directory behind.

Full logs can be tens of megabytes. This layer only stores them on disk; excerpting them for a
prompt is the job of the caller.

## The `tim pr fix-ci` command

`src/tim/commands/ci_fix.ts` holds the command. The internal and headless command name is
`ci-fix`; the CLI name is `tim pr fix-ci`. It is registered in `src/tim/tim.ts` under `pr` with the
same option block as `pr fix` (`--pr`, `--plan`, `-x/--executor`, `-m/--model`, `--effort`,
`--aw/--auto-workspace`, `-w/--workspace`, `--nw/--new-workspace`, `--no-workspace-sync`,
`--non-interactive`, `--no-terminal-input`).

### Flow

1. `resolvePrFixTargetIntent` / `resolvePrFixTarget` (re-used from `pr.ts`) give the same target
   semantics as `pr fix`. A plan target must resolve to exactly one linked PR, otherwise the
   command errors and asks for `--pr`. `GITHUB_TOKEN` (or `gh` auth) is required.
2. `refreshPrCheckStatus` force-refreshes the check status, then `getRequiredCheckNames` and
   `selectFailingChecks` pick the failing checks. **With no failing check the command logs
   `No failing checks for PR #n` and returns** — before any workspace or lock is taken, per the
   repo rule that validation runs before resource allocation.
3. `ensurePrFixHeadBranchPushableOnOrigin` rejects fork PRs whose head branch is missing on
   `origin`.
4. Executor, model, and effort resolve as: command option → `config.ciFix.*` →
   `config.defaultExecutor` / `config.models.execution` → `DEFAULT_EXECUTOR` /
   `defaultModelForExecutor`. `buildCiFixExecutorOptions` maps `--effort` to
   `reasoningEffort` for claude-code and to `reasoning.default` for codex-cli, merged over any
   existing codex `reasoning` config.
5. A managed workspace is always used, on the PR head branch with `createBranch: false`. Without
   `-w` the workspace is auto-selected. Then `prepareWorkspaceRoundTrip` and
   `runPreExecutionWorkspaceSync` run, and lifecycle commands start with the context `ci-fix`
   (`runIn: [ci-fix]`).
6. Logs are downloaded **after** checkout, into the selected workspace at
   `<workspace>/.tim/tmp/ci-fix/pr-<number>-<first-12-of-head-sha>/` (`TMP_DIR` comes from
   `src/tim/plan_materialize.ts`). Stale directories of the same PR — any earlier head SHA — are
   removed first through `clearManagedDirectoryContentsSafely` (see `docs/path-safety.md`).
7. `buildCiFixPrompt` builds the prompt and the executor runs it with
   `planId: 'pr-<n>-ci'` and `executionMode: 'planning'`.
8. The `finally` block shuts down lifecycle commands, deletes the log directory, runs
   `runPostExecutionWorkspaceSync(ctx, 'CI fixes')`, and touches the workspace info. A
   `CleanupRegistry` handler deletes the log directory synchronously on Ctrl-C; it is unregistered
   after the normal deletion.

### The prompt

`buildCiFixPrompt(target, manifest, options)` is an inline string, like the prompt builders in
`pr.ts`. It never inlines log content — logs are tens of megabytes — and refers to each log by
absolute path only.

- **Pull Request Context** — the same fields as the `pr fix` prompt, plus an instruction not to
  edit plan files or plan state.
- **Failing Checks** — one numbered subsection per manifest entry with the check name, a
  `REQUIRED` or `not-required` scope marker, the conclusion, the failed step names, and either
  `Log file: <absolute path>` or "No logs available" with the details URL. With
  `noRequiredConfig: true` (no branch protection and no rulesets) the prompt states that all
  failing checks are in scope and every entry is marked required.
- **Responsibilities** — diagnose every failure; present a numbered summary with a proposed fix
  and **wait for the user's direction**; fix the required failures only, and others only on
  request; propose a re-run instead of a code change for environmental or flaky failures; run the
  local checks; commit and push (with jj bookmark guidance); do not edit plan files.

### Configuration

`ciFix: {executor, model, effort}` in `configSchema.ts`, the same shape as `prFix`. No zod
defaults — fallbacks are applied at the read site. `configLoader.ts` merges the key with
`mergeConfigKey('ciFix')`, so a local config overlay merges per field instead of replacing the
block. `schema/tim-config-schema.json` carries the generated JSON schema.

### Command-name registry

`ci-fix` is registered alongside `pr-fix` in the `HeadlessCommand` union
(`src/tim/headless.ts`, which also records it as a job), the lifecycle command-context enum
(`configSchema.ts`), the `MEDIUM_COMMANDS` retention tier
(`src/lib/server/session_retention.ts`), `AGENT_FINISHED_COMMANDS` and
`RUNNING_NOW_INCLUDED_NONINTERACTIVE_COMMANDS` (`src/lib/utils/dashboard_attention.ts`), and the
activity page's `PR_JOB_TYPES` and label map, where it is shown as "Fix CI". `SessionRow.svelte` and
`RunningNowRow.svelte` show the same "Fix CI" label instead of the raw command name.

## Web UI launch

The web UI starts the command from two plain **"Fix CI"** buttons:

- `PrDetail.svelte` — in the Check Runs section header. Calls the `startPrCiFix` remote command,
  which spawns the no-plan form `tim pr fix-ci --pr <url> --auto-workspace --no-terminal-input`.
- `PrStatusSection.svelte` — next to the plan section's "Fix Unresolved" button. Calls `startCiFix`,
  which spawns the plan-scoped form `tim pr fix-ci <planId> --auto-workspace --no-terminal-input`.

Both buttons are gated on `canFixCi()` (`src/lib/utils/ci_fix_eligibility.ts`): the viewer must be
the PR author, and the check rollup must be failing. The gate reads the rollup state instead of the
individual `pr_check_run` rows, because webhook ingest can drop `check_run` events that arrive
before the PR row exists, while refresh always fills in the rollup. The rollup used is the
_effective_ one from `withRequiredCheckRollupState()`, so a failing optional check does not offer
the button. The server re-checks the same rule with `isCiFixEligibleForUsername()`
(`src/lib/server/ci_fix_eligibility.ts`) and returns HTTP 400 when it does not hold.

Duplicate launches are blocked at three layers: the client hides or disables the button while a
session is active, the remote command checks `SessionManager.hasActiveSessionForPr` /
`hasActiveSessionForPlan`, and the launch lock (`src/lib/server/launch_lock.ts`) covers the gap
before the spawned session registers. See `docs/web-interface.md` for the component and remote
function details.

## Tests

`src/common/github/workflow_logs.test.ts`, `select_failing_checks.test.ts`, and
`required_check_rollup.test.ts`. The Actions tests use a mocked Octokit — this is API-shape code,
and the mock matches the pattern of the other GitHub module tests. Run them with
`bun run test src/common/github`.

The command tests are `src/tim/commands/ci_fix.test.ts` (module mocks in the style of
`pr.test.ts`: no-failing-checks early exit, executor precedence, prompt content, headless
wrapping, log-directory lifecycle) and `src/tim/tim.ci_fix_options.test.ts` for the CLI option
block.
