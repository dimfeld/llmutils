---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: github integration
goal: ""
id: 245
uuid: 50487743-93a6-45c0-bda9-ce9e19100c92
status: pending
priority: medium
createdAt: 2026-03-20T23:21:58.727Z
updatedAt: 2026-03-20T23:21:58.728Z
tasks: []
tags: []
---

Add GitHub PR awareness to tim so we can monitor checks, review comments, and so on for a PR. This should integrate
with both the CLI and the web interface.

## Research

### Overview

This plan adds GitHub PR monitoring to tim - the ability to track PR status (CI checks, review comments, merge state) and surface that information in both the CLI and web interface. Currently, plans can store PR URLs in their `pullRequest` field, but there is no mechanism to fetch, cache, or display the status of those PRs.

### Key Findings

#### Existing GitHub Infrastructure

The codebase already has substantial GitHub integration:

1. **`src/common/github/pull_requests.ts`** - Octokit-based PR fetching via REST and GraphQL:
   - `fetchOpenPullRequests(owner, repo)` - Lists open PRs (REST)
   - `fetchPullRequestAndComments(owner, repo, prNumber)` - Full PR data with review threads (GraphQL)
   - `detectPullRequest(prIdentifierArg)` - Auto-detect PR from current branch
   - `addReplyToReviewThread()` - Post replies to review threads (GraphQL mutation)
   - Types: `OpenPullRequest`, `PullRequest`, `ReviewThreadNode`, `CommentNode`, `FileNode`

2. **`src/common/github/identifiers.ts`** - Parses PR/issue identifiers in formats: URLs, `owner/repo#123`, plain numbers

3. **`src/common/github/issues.ts`** - Issue fetching and import

4. **`src/common/issue_tracker/`** - Generic interface (`IssueTrackerClient`) supporting GitHub and Linear, with factory function

5. **Authentication** - Uses `GITHUB_TOKEN` environment variable for Octokit client

#### Existing PR Fields in Plans

Plans already support PR URLs in both the file format and database:

- **Plan schema** (`src/tim/planSchema.ts`): `pullRequest: z.array(z.url()).optional()`
- **Database** (`src/tim/db/plan.ts`): `pull_request TEXT` column storing JSON array of URLs (added in migration 5)
- **Plan sync** (`src/tim/db/plan_sync.ts`): Maps `pullRequest` field between files and DB

However, the web interface's `EnrichedPlan` type (in `src/lib/server/db_queries.ts`) does **not** currently include `pullRequest` or `issue` fields - they're in the DB but never surfaced to the UI.

#### Existing PR-Related Commands

- **`tim pr-description`** (`src/tim/commands/description.ts`) - Generates PR descriptions from plan context, can create PRs via `gh pr create`
- **`tim review`** (`src/tim/commands/review.ts`) - Code review against plan requirements
- **`tim answer-pr`** (`src/tim/commands/answer-pr.ts`) - Processes GitHub PR review comments

#### Web Interface Architecture

The web UI uses SvelteKit with Svelte 5 runes:

- **Real-time updates**: WebSocket server (port 8123) for agent connections, SSE for browser clients
- **Session manager** (`src/lib/server/session_manager.ts`): Central session state, message categorization, event emission
- **Session store** (`src/lib/stores/session_state.svelte.ts`): Reactive Svelte 5 store with SvelteMap, SSE auto-reconnect
- **Plan detail** (`src/lib/components/PlanDetail.svelte`): Displays plan metadata, tasks, dependencies, assignments, branch, tags
- **Active Work** tab: Split-pane with workspaces and active plans
- **Data loading**: Server-side via `+page.server.ts` → `db_queries.ts` → database

Key component patterns: `$props()`, `$derived`, `$derived.by()`, `$effect()`, `$state`

#### Database Patterns

- SQLite via bun:sqlite (synchronous API)
- Migrations in `src/tim/db/migrations.ts` with version tracking
- All writes use `db.transaction().immediate()`
- JSON arrays stored as TEXT columns (e.g., `pull_request`, `issue`)
- Adding new fields: migration → PlanRow type → upsertPlan → plan_sync mapping

#### What Doesn't Exist Yet

1. **No PR status fetching** - No way to get CI check status, review approval state, or merge status
2. **No PR status storage** - No table or cache for PR status data
3. **No background polling** - No mechanism to periodically refresh PR status
4. **No web UI for PRs** - PlanDetail doesn't show PR links or status
5. **No CLI command for PR status** - No `tim pr-status` or similar

### GitHub API Capabilities for PR Status

The GitHub API provides (via `gh` CLI or Octokit):

1. **Check runs/status checks**: `gh pr checks <number>` or REST API `/repos/{owner}/{repo}/commits/{ref}/check-runs`
   - Status: queued, in_progress, completed
   - Conclusion: success, failure, neutral, cancelled, skipped, timed_out, action_required
   - Name, URL, started_at, completed_at

2. **Review status**: Already fetched via GraphQL in `fetchPullRequestAndComments()`
   - Review threads: resolved/unresolved, outdated
   - Individual reviews: APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING

3. **PR merge state**: Available from PR object
   - merged, mergeable, draft, state (open/closed)

4. **Review comments count**: Available from PR object

### Architecture Considerations

1. **Polling vs. Webhooks**: For a CLI tool, polling is more practical than webhooks. A background polling loop in the web server makes sense, triggered when plans have linked PRs.

2. **Data freshness**: PR status changes frequently during active development. A 2-5 minute polling interval is reasonable for the web UI. CLI can fetch on-demand.

3. **Storage**: A new `pr_status` table is cleaner than extending the plan table, since one plan can have multiple PRs and status data is ephemeral/cached.

4. **`gh` CLI vs. Octokit**: The `gh` CLI is simpler for checks (`gh pr checks`), but Octokit gives more structured data. Since Octokit is already set up, extending it is the natural choice.

5. **SSE integration**: The existing SSE system can be extended with `pr:status-update` events to push status changes to the browser in real-time.

## Implementation Guide

### Expected Behavior/Outcome

Users can link PRs to plans and see live PR status (CI checks, review state, merge status) in both the CLI and web interface. The web UI auto-refreshes PR status and highlights plans needing attention (failing checks, review requested).

**States:**
- PR linked but not yet fetched (loading)
- PR status fetched and all checks passing / reviews approved
- PR with failing checks (red indicator)
- PR with pending reviews or changes requested (yellow/orange indicator)
- PR merged (green, complete)
- PR closed without merge
- PR draft status

### Key Findings Summary

- **Product & User Story**: As a developer managing multiple plans/PRs, I want to see PR status at a glance without leaving my workflow. I want to know when checks fail, reviews come in, or PRs are ready to merge.
- **Design & UX Approach**: Add PR status indicators to the existing PlanDetail component and plan list views. Use color-coded badges consistent with existing StatusBadge/PriorityBadge patterns. Add a dedicated PR section to PlanDetail showing checks, reviews, and merge status.
- **Technical Plan & Risks**: Extend GitHub API layer to fetch check/review status, add a new DB table for cached PR status, add background polling in the web server, extend SSE events. Risk: GitHub API rate limits (5000/hour authenticated) - mitigate with smart polling intervals.
- **Pragmatic Effort Estimate**: Medium-large. Core data layer + CLI is moderate. Web UI integration adds complexity. Background polling is the most novel piece.

### Acceptance Criteria

- [ ] Plans with linked PRs display PR status (checks, reviews, merge state) in the web UI PlanDetail view
- [ ] PR status is visible in plan list views as compact indicators
- [ ] CLI can display PR status for a plan (`tim pr-status` or integrated into existing commands)
- [ ] Background polling keeps PR status current in the web UI (configurable interval)
- [ ] SSE events push PR status updates to connected browsers
- [ ] PR links already stored in plan `pullRequest` field are surfaced in the web UI
- [ ] GitHub API rate limiting is handled gracefully
- [ ] All new code paths are covered by tests

### Dependencies & Constraints

- **Dependencies**: Existing Octokit setup in `src/common/github/pull_requests.ts`, existing `pullRequest` field in plans, existing SSE infrastructure
- **Technical Constraints**: GitHub API rate limit (5000 requests/hour for authenticated users), bun:sqlite synchronous API (DB ops must be in server code), `GITHUB_TOKEN` must be available

### Implementation Notes

#### Recommended Approach

##### Step 1: Extend GitHub API Layer

Add new functions to `src/common/github/pull_requests.ts` (or a new `pr_status.ts` file):

- `fetchPrStatus(owner, repo, prNumber)` - Fetch PR state (open/closed/merged, draft, mergeable)
- `fetchPrCheckRuns(owner, repo, prNumber)` - Fetch CI check statuses for the PR's head commit
- `fetchPrReviewSummary(owner, repo, prNumber)` - Fetch review summary (approved count, changes requested, pending)
- Combine into a single `fetchPrFullStatus()` that returns a unified status object
- Parse PR URLs from the plan's `pullRequest` array using existing `parsePrOrIssueNumber()`

Consider using a single GraphQL query that fetches PR state + latest commit status checks + reviews in one call to minimize API usage.

##### Step 2: PR Status Database Table

Add a new migration (version 8) creating a `pr_status` table:

```sql
CREATE TABLE pr_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_uuid TEXT NOT NULL REFERENCES plan(uuid) ON DELETE CASCADE,
  pr_url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  -- PR state
  state TEXT NOT NULL, -- open, closed, merged
  draft INTEGER NOT NULL DEFAULT 0,
  mergeable TEXT, -- MERGEABLE, CONFLICTING, UNKNOWN
  -- Check summary
  checks_status TEXT, -- all_passing, some_failing, pending, none
  checks_passed INTEGER NOT NULL DEFAULT 0,
  checks_failed INTEGER NOT NULL DEFAULT 0,
  checks_pending INTEGER NOT NULL DEFAULT 0,
  checks_total INTEGER NOT NULL DEFAULT 0,
  -- Review summary
  review_status TEXT, -- approved, changes_requested, pending, none
  reviews_approved INTEGER NOT NULL DEFAULT 0,
  reviews_changes_requested INTEGER NOT NULL DEFAULT 0,
  reviews_pending INTEGER NOT NULL DEFAULT 0,
  -- Metadata
  head_sha TEXT,
  last_fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(plan_uuid, pr_url)
);
```

Add CRUD functions in a new `src/tim/db/pr_status.ts` module following existing patterns.

##### Step 3: Surface PR URLs in EnrichedPlan

Update `src/lib/server/db_queries.ts`:
- Add `pullRequests: string[]` and `issues: string[]` to `EnrichedPlan` interface
- Parse the JSON arrays from `PlanRow.pull_request` and `PlanRow.issue` in the enrichment function
- Add `prStatus` to `PlanDetail` interface (join with `pr_status` table in `getPlanDetail`)

##### Step 4: PR Status Display in Web UI

Update `src/lib/components/PlanDetail.svelte`:
- Add a "Pull Requests" section showing each linked PR
- For each PR: show PR number, title (if available), status badges for checks/reviews/merge state
- Use color-coded indicators: green (passing/approved/merged), red (failing/changes requested), yellow (pending), gray (draft/unknown)

Add a `PrStatusBadge.svelte` component for compact status display in list views.

Update `PlanRow.svelte` to show a small PR status indicator when a plan has linked PRs.

##### Step 5: Background Polling

Add a polling service in the web server (`src/lib/server/pr_polling.ts`):
- On server init (in `hooks.server.ts`), start a polling loop
- Query the database for all plans with linked PRs that are in active states (in_progress, needs_review)
- Fetch status for each unique PR URL (deduplicate across plans)
- Update `pr_status` table with fresh data
- Emit SSE events when status changes (new check failures, review updates, etc.)
- Configurable interval (default: 5 minutes), exponential backoff on errors
- Respect GitHub rate limits

##### Step 6: SSE Events for PR Status

Extend the SSE event system:
- New event type `pr:status-update` with plan UUID and updated status
- Client store handles the event and updates reactive state
- PlanDetail and list views reactively update when status changes

##### Step 7: CLI PR Status Command

Add a `tim pr-status` command (or extend `tim status`) that:
- Shows PR status for the current plan or a specified plan
- Fetches fresh status from GitHub API (not from cache)
- Displays: PR state, check results (name + status), review summary, merge readiness
- Color-coded terminal output

#### Potential Gotchas

1. **Rate limiting**: With many active PRs, polling can consume GitHub API quota quickly. Need per-interval request budgeting. A single GraphQL query per PR is more efficient than multiple REST calls.
2. **Token availability**: The web server needs `GITHUB_TOKEN` to poll. Need graceful degradation if token is missing.
3. **Multiple PRs per plan**: Plans can have multiple PRs. The UI needs to handle this (e.g., collapsed list or summary).
4. **Cross-repo PRs**: PRs can be from different repos than the main project. The owner/repo must be parsed from each PR URL individually.
5. **Stale data cleanup**: When PRs are removed from plans or plans are deleted, orphaned `pr_status` rows should be cleaned up (CASCADE handles plan deletion; PR URL removal needs explicit cleanup).
