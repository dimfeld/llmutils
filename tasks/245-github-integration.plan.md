---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: github integration
goal: Add GitHub PR awareness to tim with status monitoring, review comments,
  and actionable workflows in both CLI and web UI
id: 245
uuid: 50487743-93a6-45c0-bda9-ce9e19100c92
status: pending
priority: medium
epic: true
dependencies:
  - 248
  - 249
  - 250
  - 251
references:
  "248": f92da2f3-c73f-4b89-83c8-03b509d58d1d
  "249": 8c93ae87-992a-440a-bfaf-93898d93d21b
  "250": cb016b34-853c-4efa-893f-221d812b45e8
  "251": 9222b252-c090-4212-bcf3-2e5c050dd167
createdAt: 2026-03-20T23:21:58.727Z
updatedAt: 2026-03-21T02:25:16.065Z
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

- **`tim pr-description`** (`src/tim/commands/description.ts`) - Generates PR descriptions from plan context, can create PRs via `gh pr create`. This will be migrated to `tim pr description` as part of the new `tim pr` subcommand namespace.
- **`tim review`** (`src/tim/commands/review.ts`) - Code review against plan requirements (does not deal with GitHub PR review comments directly)
- **`answer-pr`** - Referenced in executor/config code but no command file exists; the concept is present but not implemented as a CLI command.

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

This epic is split into four sub-plans, each delivering end-to-end working functionality:

1. **PR Status Monitoring** (child plan) - GitHub API for fetching full PR status, DB cache tables, on-demand fetch with stale-while-revalidate, display in web UI (PlanDetail + plan lists + Active Work), CLI `tim pr` subcommand namespace with `tim pr status`, migration of `tim pr-description` to `tim pr description`
2. **Background PR Polling** (child plan, depends on 1) - Automatic polling for check status on active plans, SSE push updates to browsers, rate limit management
3. **PR Review Comments in Web UI** (child plan, depends on 1) - Surface individual review comment threads on plan detail page with full context
4. **Review Comment Actions** (child plan, depends on 3) - Add review comments as tasks to plans, trigger automatic fixes via executor system

### Design Decisions

- **GraphQL query strategy**: Three separate query functions:
  - `fetchPrFullStatus()` - Everything: state, mergeable, checks, reviews, labels, title, individual check runs, individual reviewer states
  - `fetchPrCheckStatus()` - Lightweight: just the latest commit's check runs (for frequent polling in plan 2)
  - Existing `fetchPullRequestAndComments()` stays untouched for review thread workflows
- **CLI namespace**: New `tim pr` subcommand group. `tim pr status [planId]` for status, `tim pr description` (migrated from `tim pr-description`)
- **CLI freshness**: CLI always fetches fresh from GitHub (no cache), but writes to DB cache as a side effect
- **Web UI freshness**: Stale-while-revalidate - show cached data immediately on page load, refresh from GitHub in background if older than N minutes
- **DB schema**: `pr_status` parent table + `pr_check_run` and `pr_review` child tables for individual details
- **Web UI scope**: PR status visible in both Plans tab (plan list) and Active Work tab
- **PR URL not tied to plan**: The `pr_status` table should allow a PR to be linked to multiple plans (same PR URL can appear on parent epic and child plan)

### Potential Gotchas

1. **Rate limiting**: With many active PRs, polling can consume GitHub API quota quickly. The lightweight checks-only query helps. Budget requests per polling interval.
2. **Token availability**: The web server needs `GITHUB_TOKEN` to fetch. Need graceful degradation if token is missing (show PR links without status).
3. **Multiple PRs per plan**: Plans can have multiple PRs. The UI needs to handle this cleanly.
4. **Cross-repo PRs**: PRs can be from different repos. The owner/repo must be parsed from each PR URL individually using existing `parsePrOrIssueNumber()`.
5. **Stale data cleanup**: When PRs are removed from plans or plans are deleted, orphaned `pr_status` rows should be cleaned up (CASCADE handles plan deletion; PR URL removal needs explicit cleanup in a periodic sweep or on plan sync).
