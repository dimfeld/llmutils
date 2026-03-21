---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: PR Status Monitoring
goal: Fetch PR status from GitHub, cache in DB, display in web UI and CLI via
  new tim pr subcommand namespace
id: 248
uuid: f92da2f3-c73f-4b89-83c8-03b509d58d1d
generatedBy: agent
status: in_progress
priority: medium
parent: 245
references:
  "245": 50487743-93a6-45c0-bda9-ce9e19100c92
planGeneratedAt: 2026-03-21T02:28:58.262Z
promptsGeneratedAt: 2026-03-21T02:28:58.262Z
createdAt: 2026-03-21T02:24:53.498Z
updatedAt: 2026-03-21T08:59:06.185Z
tasks:
  - title: Create GitHub GraphQL queries for PR status
    done: true
    description: "Create src/common/github/pr_status.ts with two GraphQL queries:
      fetchPrFullStatus() (state, mergeable, checks, reviews, labels, title) and
      fetchPrCheckStatus() (lightweight checks-only for polling). Define
      TypeScript types for responses. Handle CheckRun vs StatusContext union
      type normalization. Use existing Octokit graphql client pattern from
      pull_requests.ts. Add unit tests with mock GraphQL responses."
  - title: Add database migration and CRUD for PR status tables
    done: true
    description: "Add migration 8 to src/tim/db/migrations.ts creating pr_status,
      pr_check_run, pr_review, pr_label, and plan_pr tables. pr_status keyed by
      pr_url (UNIQUE) so same PR can link to multiple plans. plan_pr junction
      table connects plans to PRs. Create src/tim/db/pr_status.ts with CRUD:
      upsertPrStatus (with child rows), getPrStatusByUrl, getPrStatusForPlan
      (via plan_pr join), linkPlanToPr, unlinkPlanFromPr, getPlansWithPrs
      (active plans with PRs), cleanOrphanedPrStatus. All synchronous, writes
      use db.transaction().immediate(). Add tests."
  - title: Implement PR status fetch and cache service
    done: true
    description: "Create src/common/github/pr_status_service.ts: refreshPrStatus(db,
      prUrl) fetches full status and upserts to DB. refreshPrCheckStatus(db,
      prUrl) fetches checks only and updates check_run rows.
      ensurePrStatusFresh(db, prUrl, maxAgeMs) implements stale-while-revalidate
      (return cached if fresh, refresh otherwise). syncPlanPrLinks(db, planUuid,
      prUrls) ensures plan_pr junction matches plan pullRequest URLs. Uses
      parsePrOrIssueNumber() from identifiers.ts. Add tests for cache freshness
      logic."
  - title: Surface PR data in web UI data layer
    done: true
    description: "Update src/lib/server/db_queries.ts: Add pullRequests: string[]
      and issues: string[] to EnrichedPlan interface. Parse JSON arrays from
      PlanRow.pull_request and PlanRow.issue in enrichPlansWithContext(). Add
      prStatuses: PrStatusDetail[] to PlanDetail interface. Update
      getPlanDetail() to join with pr_status + child tables via plan_pr. Define
      PrStatusDetail type with nested check runs, reviews, labels. Add computed
      prSummaryStatus to EnrichedPlan for list view indicators
      (passing/failing/pending/none)."
  - title: Create web UI API endpoint for PR status refresh
    done: true
    description: Create src/routes/api/plans/[planUuid]/pr-status/+server.ts. GET
      returns cached PR status for the plan. POST triggers refresh from GitHub
      and returns updated data. PlanDetail page calls POST on mount if data is
      stale. Handle missing GITHUB_TOKEN gracefully (return PR URLs without
      status data). Return appropriate error responses.
  - title: Build PlanDetail PR status section in web UI
    done: true
    description: "Create PrStatusSection.svelte component showing PR status on
      PlanDetail. For each linked PR: PR number + title as link to GitHub,
      overall status badge (checks passing/failing/pending), merge state badge
      (open/merged/closed/draft), expandable section with individual check runs
      (PrCheckRunList.svelte) showing name, status, conclusion, link to details,
      expandable reviewer list (PrReviewList.svelte) with state, labels as
      colored chips. Loading state while fetching fresh data. Add to
      PlanDetail.svelte after existing sections."
  - title: Add PR status indicators to plan list views
    done: true
    description: Create PrStatusIndicator.svelte compact badge showing overall PR
      health (green=passing, red=failing, yellow=pending, gray=no status).
      Update PlanRow.svelte to show indicator when pullRequests.length > 0.
      Update ActivePlanRow.svelte similarly. Status comes from
      EnrichedPlan.prSummaryStatus computed during enrichment. Shows in both
      Plans tab and Active Work tab.
  - title: Create tim pr subcommand namespace with status command
    done: true
    description: "In src/tim/tim.ts, create prCommand =
      program.command(pr).description(GitHub PR commands). Add
      prCommand.command(status [planId]): resolves plan (positional arg or
      current workspace plan), fetches fresh PR status from GitHub for each
      linked PR, writes to DB cache as side effect, displays PR state,
      individual check runs (name + status/conclusion), review summary, merge
      readiness with color-coded terminal output. Add prCommand.command(link
      <planId> <prUrl>) and prCommand.command(unlink <planId> <prUrl>) for
      manual PR linking."
  - title: Migrate pr-description to tim pr description
    done: true
    description: Move the existing pr-description command registration from
      program.command(pr-description) to prCommand.command(description
      <planFile>). Keep pr-description as a hidden alias for backwards
      compatibility. Implementation in src/tim/commands/description.ts stays the
      same - only the command registration in tim.ts changes.
  - title: "Address Review Feedback: `PrStatusSection` leaks loading/error state
      across plan changes."
    done: true
    description: >-
      `PrStatusSection` leaks loading/error state across plan changes. The
      effect resets `fetchedStatuses`, but `refreshing` and `refreshError` are
      only updated when a new fetch starts. If a refresh is aborted during
      navigation and the next plan does not need a refresh, the old
      `(refreshing...)` indicator or stale error message remains visible
      indefinitely on the new plan.


      Suggestion: Reset `refreshing = false` and `refreshError = null` at the
      start of the effect before the `needsRefresh()` early return, and add a
      rerender/navigation regression test.


      Related file: src/lib/components/PrStatusSection.svelte:38-46
  - title: "Address Review Feedback: The no-token path in the POST endpoint calls
      `syncPlanPrLinks(db, plan.uuid, cachedUrls)` without a try/catch."
    done: true
    description: >-
      The no-token path in the POST endpoint calls `syncPlanPrLinks(db,
      plan.uuid, cachedUrls)` without a try/catch. While the input should only
      contain cached URLs, a TOCTOU race (cache deleted between the filter on
      line 55 and the sync call on line 57) would cause syncPlanPrLinks to
      attempt a GitHub fetch, which fails without a token and propagates as an
      unhandled 500 error.


      Suggestion: Wrap the `syncPlanPrLinks` call in the no-token path in a
      try/catch, falling back to returning cached data without junction updates
      if the sync fails.


      Related file: src/routes/api/plans/[planUuid]/pr-status/+server.ts:53-63
  - title: "Address Review Feedback: The POST endpoint uses `Promise.all` for
      `ensurePrStatusFresh` across all PR URLs."
    done: true
    description: >-
      The POST endpoint uses `Promise.all` for `ensurePrStatusFresh` across all
      PR URLs. If one PR refresh fails (e.g., PR deleted from GitHub, transient
      API error), the entire Promise.all rejects. The catch block then returns
      entirely cached data, discarding fresh results that were successfully
      fetched for other PRs.


      Suggestion: Use `Promise.allSettled` instead of `Promise.all`. For
      fulfilled results, use the fresh data. For rejected results, fall back to
      cached data from `getPrStatusByUrl()` per URL. Optionally include the
      partial error in the response.


      Related file: src/routes/api/plans/[planUuid]/pr-status/+server.ts:66-82
  - title: "Address Review Feedback: `tim pr status` only auto-resolves the current
      workspace plan when `process.cwd()` is the exact workspace root."
    done: true
    description: >-
      `tim pr status` only auto-resolves the current workspace plan when
      `process.cwd()` is the exact workspace root. `getWorkspacePlanReference()`
      calls `getWorkspaceInfoByPath(cwd)`, and that lookup is exact-path only,
      so running the command from `workspace/src` or any nested directory throws
      "Please provide a plan ID/path…" even though the user is still inside the
      active workspace. The plan requirement was to resolve the current
      workspace plan when no positional arg is provided.


      Suggestion: Resolve the workspace by walking parent directories (or via
      git root / workspace root detection) instead of requiring an exact path
      match. Add a test that runs `tim pr status` from a nested workspace
      subdirectory.


      Related file: src/tim/commands/pr.ts:37-55
  - title: "Address Review Feedback: The new PR-linking/status flow accepts issue
      URLs as if they were pull-request URLs."
    done: true
    description: >-
      The new PR-linking/status flow accepts issue URLs as if they were
      pull-request URLs. `handlePrLinkCommand()` and `refreshPrStatus()` both
      trust `parsePrOrIssueNumber()`, which extracts `{owner, repo, number}`
      from any GitHub URL path and then canonicalizes it to `/pull/{number}`.
      Passing `https://github.com/org/repo/issues/123` will silently attempt to
      link PR 123 instead of rejecting the non-PR URL.


      Suggestion: Use a PR-specific parser or explicitly validate that URL path
      segments contain `/pull/` before accepting the identifier. Add tests for
      issue URLs and other non-PR GitHub URLs.


      Related file: src/tim/commands/pr.ts:428-439
  - title: "Address Review Feedback: The web check-run list misrenders `error`
      conclusions."
    done: true
    description: >-
      The web check-run list misrenders `error` conclusions. Backend
      normalization emits `error`, and the CLI treats it as a failed check, but
      `PrCheckRunList` falls through to the default gray `?`/neutral styling
      because `error` is missing from both switch statements. That makes a real
      failing check look unknown in the UI.


      Suggestion: Handle `error` in the same failure branch as
      `failure`/`timed_out`/`startup_failure`, and add component coverage for
      that conclusion.


      Related file: src/lib/components/PrCheckRunList.svelte:16-31
  - title: "Address Review Feedback: `prSummaryStatus` returns 'none' for PRs where
      all check rollup states are 'neutral', 'cancelled', or 'skipped'."
    done: true
    description: >-
      `prSummaryStatus` returns 'none' for PRs where all check rollup states are
      'neutral', 'cancelled', or 'skipped'. The UI then shows a gray dot
      identical to plans with no PRs, which could confuse users who expect some
      indication that checks ran.


      Suggestion: Consider adding a 'neutral' or 'skipped' summary status, or at
      minimum map these states to 'passing' since the checks didn't fail.


      Related file: src/lib/server/db_queries.ts:269-284
  - title: "Address Review Feedback: Cached PR status is not reliably shown on
      initial page load because all read paths depend on lazy `plan_pr`
      junctions."
    done: true
    description: >-
      Cached PR status is not reliably shown on initial page load because all
      read paths depend on lazy `plan_pr` junctions. `syncPlanPrLinks()`
      explicitly leaves `plan_pr` population lazy, but
      `getPrSummaryStatusByPlanUuid()` queries only `plan_pr`, `getPlanDetail()`
      loads PR status only via `getPrStatusForPlan()`, and the GET route does
      the same. If a plan's `pull_request` list changes through normal plan-file
      sync or the same cached PR is linked to another plan, the `pr_status` row
      can exist while `plan_pr` does not. In that state SSR and list views
      render no cached PR status until the client POST runs, which violates the
      stated stale-while-revalidate requirement to show cached data immediately
      on page load.


      Suggestion: Stop treating `plan_pr` as the sole source for reads. Either
      derive cached PR status directly from `plan.pull_request` URLs at read
      time, or reconcile `plan_pr` synchronously from existing cached rows
      during plan sync. Add an integration test for: cached `pr_status` exists,
      `plan_pr` missing, plan has `pull_request` URL.


      Related file: src/lib/server/db_queries.ts:224-241,653
  - title: "Address Review Feedback: PR URLs are validated but not normalized
      consistently, so equivalent URLs for the same PR can be stored as
      different records and cannot be reliably unlinked."
    done: true
    description: >-
      PR URLs are validated but not normalized consistently, so equivalent URLs
      for the same PR can be stored as different records and cannot be reliably
      unlinked. `validatePrIdentifier()` accepts both `/pull/123` and
      `/pulls/123`, but `refreshPrStatus()` and `syncPlanPrLinks()` persist the
      raw input string as `pr_url`. The CLI link/unlink commands then compare
      exact strings against canonical `/pull/{number}` URLs. A plan containing
      `https://github.com/org/repo/pulls/123` is therefore treated as different
      from `.../pull/123`: linking can add a semantic duplicate, cache rows
      split across two `pr_url` keys, and unlinking the canonical form leaves
      the original entry behind.


      Suggestion: Canonicalize every explicit PR URL to a single form before
      persistence, cache lookup, and plan-file comparison. The CLI and service
      layer should share one normalization helper, and tests should cover
      `/pulls/` and other equivalent URL forms.


      Related file: src/common/github/pr_status_service.ts:20-30,124-156
  - title: "Address Review Feedback: `refreshPrCheckStatus()` calls
      `parsePrOrIssueNumber()` without calling `validatePrIdentifier()` first,
      unlike `refreshPrStatus()` (line 21)."
    done: true
    description: >-
      `refreshPrCheckStatus()` calls `parsePrOrIssueNumber()` without calling
      `validatePrIdentifier()` first, unlike `refreshPrStatus()` (line 21).
      Currently this function is only reachable through validated paths
      (existing cached entries that went through `refreshPrStatus` initially),
      but it's a defense-in-depth gap. If a future caller uses
      `refreshPrCheckStatus` directly with an issue URL, it would attempt a
      GitHub API call for a non-existent PR instead of failing fast with a clear
      validation error.


      Suggestion: Add `validatePrIdentifier(prUrl)` call at the start of
      `refreshPrCheckStatus()` to match the pattern in `refreshPrStatus()`.


      Related file: src/common/github/pr_status_service.ts:68-95
  - title: "Address Review Feedback: GraphQL enum normalization functions
      (`normalizePrState`, `normalizeCheckStatus`, etc.) throw on unknown
      values."
    done: false
    description: >-
      GraphQL enum normalization functions (`normalizePrState`,
      `normalizeCheckStatus`, etc.) throw on unknown values. If GitHub adds a
      new enum value, the entire status fetch will fail rather than gracefully
      degrading. This is a deliberate design choice and acceptable for a CLI
      tool, but worth considering for the future background polling feature
      where silent partial failure might be preferred.


      Suggestion: When implementing background polling (child plan 2), consider
      adding fallback/default branches to normalization functions instead of
      throwing, or catching normalization errors at the polling layer.


      Related file: src/common/github/pr_status.ts:261-342
changedFiles:
  - CLAUDE.md
  - README.md
  - claude-plugin/skills/using-tim/references/cli-commands.md
  - docs/database.md
  - docs/web-interface.md
  - src/common/github/identifiers.test.ts
  - src/common/github/identifiers.ts
  - src/common/github/pr_status.test.ts
  - src/common/github/pr_status.ts
  - src/common/github/pr_status_service.test.ts
  - src/common/github/pr_status_service.ts
  - src/lib/components/ActivePlanRow.svelte
  - src/lib/components/PlanDetail.svelte
  - src/lib/components/PlanRow.svelte
  - src/lib/components/PrCheckRunList.svelte
  - src/lib/components/PrReviewList.svelte
  - src/lib/components/PrStatusIndicator.svelte
  - src/lib/components/PrStatusIndicator.test.ts
  - src/lib/components/PrStatusSection.svelte
  - src/lib/components/PrStatusSection.test.ts
  - src/lib/components/pr_status_section_state.ts
  - src/lib/server/db_queries.test.ts
  - src/lib/server/db_queries.ts
  - src/routes/api/plans/[planUuid]/pr-status/+server.ts
  - src/routes/api/plans/[planUuid]/pr-status/pr-status.server.test.ts
  - src/tim/commands/pr.test.ts
  - src/tim/commands/pr.ts
  - src/tim/db/database.test.ts
  - src/tim/db/migrations.ts
  - src/tim/db/pr_status.test.ts
  - src/tim/db/pr_status.ts
  - src/tim/tim.ts
tags: []
---

Fetch PR status (checks, reviews, merge state) from GitHub, cache in DB, and display in both web UI and CLI.

Key deliverables:
- GitHub GraphQL queries: fetchPrFullStatus() for complete data, fetchPrCheckStatus() for lightweight checks-only
- New DB tables: pr_status, pr_check_run, pr_review for cached PR data
- Web UI: PR status section in PlanDetail, compact PR indicators in plan list views (Plans tab + Active Work tab)
- Stale-while-revalidate: show cached data immediately, refresh in background if stale
- CLI: New `tim pr` subcommand namespace with `tim pr status [planId]`
- Migration: Move `tim pr-description` to `tim pr description`
- Surface existing pullRequest/issue fields from DB in EnrichedPlan for web UI

## Research

### Existing Infrastructure

#### GitHub API Layer (`src/common/github/`)
- **`pull_requests.ts`**: Octokit REST + GraphQL. `fetchOpenPullRequests()` (REST), `fetchPullRequestAndComments()` (GraphQL for review threads/comments). Uses `GITHUB_TOKEN` env var.
- **`identifiers.ts`**: `parsePrOrIssueNumber(identifier)` parses URLs, `owner/repo#123`, plain numbers. Returns `{owner, repo, number}`.
- **`issues.ts`**: Issue fetching with Octokit REST.
- The existing GraphQL query for PRs fetches review threads with comments and file changes, but does NOT fetch check runs, mergeable state, or review decision summaries.

#### Plan PR Fields
- `planSchema.ts`: `pullRequest: z.array(z.url()).optional()`
- `src/tim/db/plan.ts`: `pull_request TEXT` column (JSON array), added in migration 5
- `src/tim/db/plan_sync.ts`: Maps `pullRequest` between plan files and DB
- **Not surfaced**: `EnrichedPlan` in `src/lib/server/db_queries.ts` does not include `pullRequest` or `issue`

#### Web UI Plan Detail
- `src/lib/components/PlanDetail.svelte`: Displays plan metadata, tasks, deps, assignment, branch, tags. Uses `PlanDetail` type from `db_queries.ts`.
- `EnrichedPlan` interface (line 69-92 of db_queries.ts): has uuid, projectId, planId, title, goal, details, status, displayStatus, priority, branch, parentUuid, epic, filename, createdAt, updatedAt, tags, dependencyUuids, tasks, taskCounts
- `PlanDetail extends EnrichedPlan` adding dependencies, assignment, parent
- Plan enrichment function (`enrichPlansWithContext`, line 230-283) maps PlanRow fields to EnrichedPlan

#### Existing `pr-description` Command
- Registered at `src/tim/tim.ts:1208-1238` as `program.command('pr-description <planFile>')`
- Implementation in `src/tim/commands/description.ts`: `handleDescriptionCommand()`
- Options: --executor, --model, --dry-run, --instructions, --instructions-file, --base, --output-file, --copy, --create-pr
- Uses `gatherPlanContext()` from `src/tim/utils/context_gathering.ts`

#### Database Migration Pattern
- `src/tim/db/migrations.ts`: Array of `{version, up}` objects. Currently at version 7.
- `up` is a SQL string executed via `db.exec()`
- New tables follow: CREATE TABLE with foreign keys, DEFAULT values, UNIQUE constraints

#### Web UI Data Loading Pattern
- Server loads: `+page.server.ts` → calls `db_queries.ts` functions → returns typed data
- `getPlansForProject()` returns `EnrichedPlan[]`
- `getPlanDetail()` returns `PlanDetail` (with deps, assignment, parent)
- Plan list views: `PlanRow.svelte` and `ActivePlanRow.svelte` receive `EnrichedPlan`
- Stale-while-revalidate: Load from DB cache on page load, trigger async refresh from GitHub if `last_fetched_at` is older than threshold. The refresh can use a SvelteKit API endpoint that fetches, updates DB, and returns fresh data. Client can call this endpoint and reactively update.

#### Commander.js Subcommand Pattern
- Example: `workspaceCommand = program.command('workspace').description(...)` then `workspaceCommand.command('list')...`
- Used for workspace, tools subcommands

### GraphQL Query Design

Two new queries needed:

**Full Status Query** (`fetchPrFullStatus`):
```graphql
query GetPrFullStatus($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      number
      title
      state          # OPEN, CLOSED, MERGED
      isDraft
      mergeable      # MERGEABLE, CONFLICTING, UNKNOWN
      mergedAt
      headRefOid     # head SHA
      baseRefName
      headRefName
      labels(first: 20) { nodes { name, color } }
      reviewDecision # APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null
      reviews(last: 50) {
        nodes {
          author { login }
          state  # APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING, DISMISSED
          submittedAt
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state    # SUCCESS, FAILURE, PENDING, ERROR, EXPECTED
              contexts(first: 100) {
                nodes {
                  ... on CheckRun {
                    name
                    status       # QUEUED, IN_PROGRESS, COMPLETED, WAITING, PENDING, REQUESTED
                    conclusion   # SUCCESS, FAILURE, NEUTRAL, CANCELLED, SKIPPED, TIMED_OUT, ACTION_REQUIRED, STALE, STARTUP_FAILURE, null
                    detailsUrl
                    startedAt
                    completedAt
                  }
                  ... on StatusContext {
                    context
                    state        # SUCCESS, FAILURE, PENDING, ERROR, EXPECTED
                    targetUrl
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

**Lightweight Checks Query** (`fetchPrCheckStatus`):
```graphql
query GetPrCheckStatus($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                    completedAt
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### Database Schema Design

**Migration 8** adds three tables:

```sql
-- Parent PR status record
CREATE TABLE pr_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT,
  state TEXT NOT NULL,              -- open, closed, merged
  draft INTEGER NOT NULL DEFAULT 0,
  mergeable TEXT,                   -- MERGEABLE, CONFLICTING, UNKNOWN
  head_sha TEXT,
  base_branch TEXT,
  head_branch TEXT,
  review_decision TEXT,             -- APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null
  merged_at TEXT,
  last_fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(pr_url)
);

-- Individual check runs
CREATE TABLE pr_check_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued, in_progress, completed, waiting, pending, requested
  conclusion TEXT,                  -- success, failure, neutral, cancelled, skipped, timed_out, action_required, stale, null
  details_url TEXT,
  started_at TEXT,
  completed_at TEXT
);

-- Individual reviews
CREATE TABLE pr_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  state TEXT NOT NULL,              -- APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING, DISMISSED
  submitted_at TEXT
);

-- Labels
CREATE TABLE pr_label (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT
);

-- Junction table linking plans to PR status
CREATE TABLE plan_pr (
  plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
  pr_status_id INTEGER NOT NULL REFERENCES pr_status(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_uuid, pr_status_id)
);
```

Note: `pr_status` is keyed by `pr_url` (not by plan_uuid) so the same PR can be linked to multiple plans. The `plan_pr` junction table connects them.

## Implementation Guide

### Step 1: GitHub GraphQL Queries

Create `src/common/github/pr_status.ts`:

1. Define TypeScript types for the full status response and check-only response
2. Implement `fetchPrFullStatus(owner, repo, prNumber)` using the full GraphQL query
3. Implement `fetchPrCheckStatus(owner, repo, prNumber)` using the lightweight query
4. Both functions use the existing Octokit graphql client pattern from `pull_requests.ts`
5. Normalize the response into clean TypeScript types (handle the union type for CheckRun vs StatusContext)
6. Add tests using mock GraphQL responses

### Step 2: Database Migration and CRUD

1. Add migration 8 to `src/tim/db/migrations.ts` creating `pr_status`, `pr_check_run`, `pr_review`, `pr_label`, and `plan_pr` tables
2. Create `src/tim/db/pr_status.ts` with CRUD functions:
   - `upsertPrStatus(db, data)` - Insert or update PR status record + child rows (check runs, reviews, labels)
   - `getPrStatusByUrl(db, prUrl)` - Get PR status with check runs and reviews
   - `getPrStatusForPlan(db, planUuid)` - Get all PR statuses linked to a plan
   - `linkPlanToPr(db, planUuid, prStatusId)` - Create plan_pr junction
   - `unlinkPlanFromPr(db, planUuid, prStatusId)` - Remove junction
   - `getPlansWithPrs(db, projectId?)` - Get plans that have linked PRs in active states
   - `cleanOrphanedPrStatus(db)` - Remove pr_status records with no plan_pr links
3. All functions synchronous, writes use `db.transaction().immediate()`
4. Add tests for all CRUD operations

### Step 3: PR Status Fetch + Cache Service

Create `src/common/github/pr_status_service.ts` (or similar shared location):

1. `refreshPrStatus(db, prUrl)` - Fetch full status from GitHub, upsert into DB, return updated data
2. `refreshPrCheckStatus(db, prUrl)` - Fetch checks only, update check_run rows
3. `ensurePrStatusFresh(db, prUrl, maxAgeMs)` - Stale-while-revalidate: return cached if fresh, otherwise refresh
4. `syncPlanPrLinks(db, planUuid, prUrls)` - Ensure plan_pr junction matches plan's pullRequest URLs (add/remove links, fetch status for new PRs)
5. Use `parsePrOrIssueNumber()` from `identifiers.ts` to extract owner/repo/number from PR URLs

### Step 4: Surface PR Data in Web UI Data Layer

1. Add `pullRequests: string[]` and `issues: string[]` to `EnrichedPlan` interface in `src/lib/server/db_queries.ts`
2. Update `enrichPlansWithContext()` to parse `plan.pull_request` and `plan.issue` JSON fields
3. Add `prStatuses: PrStatusDetail[]` to `PlanDetail` interface
4. Update `getPlanDetail()` to join with `pr_status` + child tables via `plan_pr`
5. Define `PrStatusDetail` type with nested check runs, reviews, labels
6. For plan list views, add a computed `prSummaryStatus` field to `EnrichedPlan` (overall indicator: passing/failing/pending/none) derived from linked PR statuses

### Step 5: Web UI API Endpoint for Refresh

Create `src/routes/api/plans/[planUuid]/pr-status/+server.ts`:

1. GET: Return cached PR status for the plan
2. POST: Trigger refresh from GitHub, return updated data
3. The PlanDetail page calls POST on mount if data is stale (older than configurable threshold)
4. Handle missing GITHUB_TOKEN gracefully (return PR URLs without status data)

### Step 6: PlanDetail PR Section

Update `src/lib/components/PlanDetail.svelte`:

1. Add a "Pull Requests" section after the existing sections
2. For each linked PR, show:
   - PR number + title as a link to GitHub
   - Overall status badge (checks passing/failing/pending)
   - Merge state badge (open/merged/closed/draft)
   - Expandable section: individual check runs with name, status, conclusion, link to details
   - Expandable section: reviewer list with state (approved/changes requested/commented)
   - Labels as colored chips
3. Loading state while fetching fresh data
4. Create `PrStatusSection.svelte` component for the PR detail section
5. Create `PrCheckRunList.svelte` for the expandable check runs
6. Create `PrReviewList.svelte` for the expandable reviewer list

### Step 7: Plan List PR Indicators

1. Create `PrStatusIndicator.svelte` - compact badge showing overall PR health (small colored dot or icon)
2. Update `PlanRow.svelte` to show the indicator when `pullRequests.length > 0`
3. Update `ActivePlanRow.svelte` similarly
4. The indicator shows: green (all passing), red (failing), yellow (pending), gray (no status/no PRs)
5. PR status for list views comes from `EnrichedPlan.prSummaryStatus` computed during enrichment

### Step 8: CLI `tim pr` Subcommand Namespace

1. In `src/tim/tim.ts`, create `const prCommand = program.command('pr').description('GitHub PR commands')`
2. Add `prCommand.command('status [planId]')` that:
   - Resolves plan (positional arg or current workspace plan)
   - Fetches fresh PR status from GitHub for each linked PR
   - Writes to DB cache as side effect
   - Displays: PR state, check runs (name + status/conclusion), review summary, merge readiness
   - Color-coded terminal output using chalk
3. Migrate `pr-description` to `prCommand.command('description <planFile>')`:
   - Move the existing command registration under the `pr` subcommand
   - Keep `pr-description` as a hidden alias for backwards compatibility
4. Add `prCommand.command('link <planId> <prUrl>')` to manually link a PR to a plan
5. Add `prCommand.command('unlink <planId> <prUrl>')` to remove a link

### Step 9: Tests

1. Unit tests for GraphQL query functions (mock Octokit responses)
2. Unit tests for DB CRUD operations (use test database)
3. Unit tests for the status service (stale-while-revalidate logic)
4. Integration test: link PR to plan → fetch status → verify DB state → verify enrichment
5. Test the CLI pr status command output formatting
6. Test the web API endpoint
7. Test graceful degradation when GITHUB_TOKEN is missing

## Changes Made During Implementation

- Added `check_rollup_state` column to `pr_status` and `source` column to `pr_check_run` in migration 8 (not in original schema design). These were identified during review as needed to avoid a future migration.
- `syncPlanPrLinks()` does not call `cleanOrphanedPrStatus()` internally. Orphan cleanup is the caller's responsibility to avoid race conditions in concurrent scenarios.
- `plan_pr` junction is populated lazily by the service layer (web UI endpoints, CLI commands), not during synchronous plan file sync. This is because GitHub API calls are async.
- `getPlansWithPrs()` filters on active plan statuses (pending, in_progress, needs_review), not just open PR state.
- All GitHub enum normalizers use exhaustive switch statements that throw on unknown values, rather than unsafe `as` casts.

## Current Progress
### Current State
- All 19 tasks complete (tasks 1-19). Task 20 is deferred to background polling child plan.
### Completed (So Far)
- Tasks 1-16: Core PR status monitoring implementation (GraphQL queries, DB, cache service, web UI, CLI)
- Task 17: Fixed cached PR status not shown on initial page load — read paths now derive PR status from `plan.pull_request` URLs directly against `pr_status.pr_url`, not solely via `plan_pr` junctions. Stale `plan_pr` links are filtered out when current plan URLs are available.
- Task 18: Consistent PR URL canonicalization — `canonicalizePrUrl()` and `tryCanonicalizePrUrl()` in `identifiers.ts` normalize `/pulls/` to `/pull/`, strip query params/fragments, reject partially numeric PR numbers. Applied at all entry points (service layer, CLI, DB reads, orphan cleanup, getPlansWithPrs).
- Task 19: `refreshPrCheckStatus()` now validates identifiers via `canonicalizePrUrl()` before any cache lookup or API call.
### Remaining
- Task 20: GraphQL enum normalization throws on unknown values — deferred to background polling child plan
### Next Iteration Guidance
- None
### Decisions / Changes
- `syncPlanPrLinks` is fully atomic: all GitHub fetches complete before any DB writes, and all upserts + link changes happen in one transaction
- `cleanOrphanedPrStatus` called after sync in POST endpoint and CLI `tim pr status` to clean up unlinked PR cache rows
- `cleanOrphanedPrStatus` canonicalizes plan `pull_request` URLs in TypeScript before comparing against `pr_status.pr_url`, preventing incorrect deletion of cached rows for non-canonical plan URLs
- `refreshPrCheckStatus` is documented as lightweight (checks only, no PR state update) - callers needing state changes should use `refreshPrStatus`
- `plan_pr` junction is populated lazily by POST endpoint / CLI commands, not on page load GET — GET only reads existing cached data
- Read paths (`getPrStatusForPlan`, `getPrSummaryStatusByPlanUuid`) use `plan.pull_request` URLs as source of truth when available, falling back to `plan_pr` only when URLs aren't provided. This ensures cached data is shown even before `plan_pr` is populated.
- POST endpoint gracefully handles GitHub API failures by falling back to cached data with an error message
- POST endpoint wraps `syncPlanPrLinks` in try/catch with cached-URL fallback, so `Promise.allSettled` is always reachable
- No-token path always calls `syncPlanPrLinks` (even with empty cachedUrls) to prune stale links
- CLI `tim pr status` always force-refreshes from GitHub (never uses cached data), but syncs `plan_pr` junctions afterward for web UI
- `tim pr link`/`unlink` modify the plan file (source of truth) and update DB cache best-effort. Link validates with GitHub before modifying the plan file.
- URL canonicalization: all PR URL entry points normalize to `https://github.com/{owner}/{repo}/pull/{number}` format. `canonicalizePrUrl()` (throwing) for write paths, `tryCanonicalizePrUrl()` (returns null) for read paths.
- `validatePrIdentifier()` enforces GitHub host + `/pull/` path + numeric PR number for URL-form identifiers
- `persistPlanPullRequests` normalizes existing plan-file PR URLs during link/unlink, deduplicating equivalent URL forms
- CLI partial failures: tries syncing all prUrls first, falls back to just successful URLs if uncached PRs can't be fetched
- Reviews are deduplicated to latest per author at the normalization layer
- PrStatusSection uses stale-while-revalidate: shows initialStatuses immediately, only POSTs if any PR is missing or stale (>5 min)
- PrStatusSection uses AbortController to prevent stale fetch responses from overwriting fresh data on plan navigation
- `prSummaryStatus` filters null/empty `check_rollup_state` values — PRs without checks don't poison the aggregate; neutral/cancelled/skipped map to 'passing'
- `getPlansWithPrs()` fallback branch canonicalizes plan URLs in TypeScript before matching against `pr_status`, correctly filtering closed PRs and deduplicating
### Lessons Learned
- GitHub GraphQL connection nodes can be null - always filter before mapping
- Separating fetch phase from DB write phase enables true atomicity for operations that mix async API calls with sync DB transactions
- For bulk computed fields like `prSummaryStatus`, a single efficient query joining all plans to their PR statuses is much better than N+1 queries per plan
- When CLI commands modify both a plan file (source of truth) and DB cache, validate external API calls before modifying the plan file, and treat DB updates as best-effort
- `writePlanFile()` already calls `syncPlanToDb()` internally — don't add a redundant sync call afterward
- URL canonicalization must be symmetric between link and unlink commands, otherwise unlink silently fails for non-URL identifiers
- When an atomic sync function (syncPlanPrLinks) is used after partial failures, passing the full URL list can cause the sync to fail for uncached URLs — need fallback to a reduced set
- Svelte 5 `$state(initialProp)` captures the initial value only; use `$derived(fetchedData ?? initialProp)` pattern instead of a separate sync effect to avoid race conditions between prop updates and async fetch results
- `new Date(invalidString).getTime()` returns NaN; comparisons with NaN always return false, silently skipping staleness checks
- When wrapping an all-or-nothing sync in try/catch, make sure the partial-failure path (Promise.allSettled) is still reachable — otherwise the resilience pattern is dead code
- PR URL validation should be centralized in a shared utility and enforced at all entry points (CLI, service layer, API routes), not just the CLI
- When mixing SQL queries with TypeScript canonicalization, do the canonicalization in TypeScript rather than trying to do it in SQL. Raw `json_each` values from plan files may not be canonical, causing SQL string comparisons to fail.
- Read paths should use the plan's current state (e.g., `plan.pull_request` URLs) as source of truth, not lazy junction tables that may be stale or missing. Union with junction data only when the source of truth isn't available.
- `canonicalizePrUrl` in read paths must not throw — use `tryCanonicalizePrUrl` (returns null for non-PR URLs) to avoid crashing page loads on malformed plan data.
### Risks / Blockers
- None
