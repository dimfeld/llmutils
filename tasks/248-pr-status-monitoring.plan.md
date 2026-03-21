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
updatedAt: 2026-03-21T04:03:33.902Z
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
    done: false
    description: "Update src/lib/server/db_queries.ts: Add pullRequests: string[]
      and issues: string[] to EnrichedPlan interface. Parse JSON arrays from
      PlanRow.pull_request and PlanRow.issue in enrichPlansWithContext(). Add
      prStatuses: PrStatusDetail[] to PlanDetail interface. Update
      getPlanDetail() to join with pr_status + child tables via plan_pr. Define
      PrStatusDetail type with nested check runs, reviews, labels. Add computed
      prSummaryStatus to EnrichedPlan for list view indicators
      (passing/failing/pending/none)."
  - title: Create web UI API endpoint for PR status refresh
    done: false
    description: Create src/routes/api/plans/[planUuid]/pr-status/+server.ts. GET
      returns cached PR status for the plan. POST triggers refresh from GitHub
      and returns updated data. PlanDetail page calls POST on mount if data is
      stale. Handle missing GITHUB_TOKEN gracefully (return PR URLs without
      status data). Return appropriate error responses.
  - title: Build PlanDetail PR status section in web UI
    done: false
    description: "Create PrStatusSection.svelte component showing PR status on
      PlanDetail. For each linked PR: PR number + title as link to GitHub,
      overall status badge (checks passing/failing/pending), merge state badge
      (open/merged/closed/draft), expandable section with individual check runs
      (PrCheckRunList.svelte) showing name, status, conclusion, link to details,
      expandable reviewer list (PrReviewList.svelte) with state, labels as
      colored chips. Loading state while fetching fresh data. Add to
      PlanDetail.svelte after existing sections."
  - title: Add PR status indicators to plan list views
    done: false
    description: Create PrStatusIndicator.svelte compact badge showing overall PR
      health (green=passing, red=failing, yellow=pending, gray=no status).
      Update PlanRow.svelte to show indicator when pullRequests.length > 0.
      Update ActivePlanRow.svelte similarly. Status comes from
      EnrichedPlan.prSummaryStatus computed during enrichment. Shows in both
      Plans tab and Active Work tab.
  - title: Create tim pr subcommand namespace with status command
    done: false
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
    done: false
    description: Move the existing pr-description command registration from
      program.command(pr-description) to prCommand.command(description
      <planFile>). Keep pr-description as a hidden alias for backwards
      compatibility. Implementation in src/tim/commands/description.ts stays the
      same - only the command registration in tim.ts changes.
changedFiles:
  - src/common/github/pr_status.test.ts
  - src/common/github/pr_status.ts
  - src/common/github/pr_status_service.test.ts
  - src/common/github/pr_status_service.ts
  - src/tim/db/migrations.ts
  - src/tim/db/pr_status.test.ts
  - src/tim/db/pr_status.ts
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
- Tasks 1-3 (backend foundation) are complete with comprehensive test coverage
### Completed (So Far)
- Task 1: GitHub GraphQL queries (`src/common/github/pr_status.ts`) with `fetchPrFullStatus()` and `fetchPrCheckStatus()`
- Task 2: DB migration 8 and CRUD (`src/tim/db/pr_status.ts`, `src/tim/db/migrations.ts`)
- Task 3: Cache service (`src/common/github/pr_status_service.ts`) with refresh, stale-while-revalidate, and atomic sync
### Remaining
- Task 4: Surface PR data in web UI data layer (EnrichedPlan, PlanDetail types)
- Task 5: Web UI API endpoint for PR status refresh
- Task 6: PlanDetail PR status section UI
- Task 7: PR status indicators in plan list views
- Task 8: CLI `tim pr` subcommand namespace
- Task 9: Migrate pr-description to `tim pr description`
### Next Iteration Guidance
- Tasks 4+5 (web data layer + API endpoint) are a natural next pair
- The `UpsertPrStatusInput` type is already exported from `src/tim/db/pr_status.ts`
- `PrStatusDetail` type from db/pr_status.ts has: `{ status: PrStatusRow, checks: PrCheckRunRow[], reviews: PrReviewRow[], labels: PrLabelRow[] }`
### Decisions / Changes
- `syncPlanPrLinks` is fully atomic: all GitHub fetches complete before any DB writes, and all upserts + link changes happen in one transaction
- `cleanOrphanedPrStatus` is decoupled from sync - callers handle cleanup explicitly
- `refreshPrCheckStatus` is documented as lightweight (checks only, no PR state update) - callers needing state changes should use `refreshPrStatus`
### Lessons Learned
- GitHub GraphQL connection nodes can be null - always filter before mapping
- Separating fetch phase from DB write phase enables true atomicity for operations that mix async API calls with sync DB transactions
- None
### Risks / Blockers
- None
