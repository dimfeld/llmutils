# CI Check Classification and Actions Logs

Library modules in `src/common/github/` that find the failing checks of a pull request and
download the related GitHub Actions job logs. These are the building blocks for the CI fix
command; they contain no CLI code and no web UI code.

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

## Tests

`src/common/github/workflow_logs.test.ts`, `select_failing_checks.test.ts`, and
`required_check_rollup.test.ts`. The Actions tests use a mocked Octokit — this is API-shape code,
and the mock matches the pattern of the other GitHub module tests. Run them with
`bun run test src/common/github`.
