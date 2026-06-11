# Web Interface (Plans Browser)

## SvelteKit Conventions

### Data Loading

- Child layouts should use `await parent()` to access data already loaded by parent layouts instead of re-querying the database. This avoids duplicate work and keeps data consistent.
- All DB imports must be in `$lib/server/` or `+page.server.ts` files — `bun:sqlite` cannot be imported client-side.
- The server context (`src/lib/server/init.ts`) is lazily initialized because SvelteKit may import server modules during `svelte-kit sync` or type checking without a running server.

### HMR-Safe Server State

Module-scoped state in SvelteKit server modules is **not** HMR-safe — dev-server reloads re-execute the module and reset the state. For any server-side state that must survive HMR (singletons, locks, caches), store it on `globalThis` using `Symbol.for()` keys. See `src/lib/server/session_context.ts` and `src/lib/server/launch_lock.ts` for the canonical pattern.

### Long-Running Background Services

Multiple background services (webhook poller, Slack notifier) run inside the single SvelteKit web-server process, started from `hooks.server.ts`. When adding another, follow the `start*` → handle-with-`stop()` pattern (see `webhook_poller.ts` / `slack_notifier.ts`) and watch for these process-shared-state hazards:

- **Keep env gates out of config-pure predicates.** A predicate like "is this service configured?" should be a pure function of config/DB so it stays unit-testable. Compose the env-dependent gate (e.g. `isWebhookPollingEnabled()` reading `process.env`) in a separate `shouldStart*` helper, and test the env gate on its own. Mixing the two forces tests to mutate `process.env` just to exercise config logic.
- **A "mark after an awaited side effect" optimistic-lock token must strictly change on every state transition.** Do not use a GitHub `updated_at`-derived timestamp (e.g. `last_event_at`) as the token: rapid transitions can share a timestamp, so a stale write can match and clobber a newer state. Use a locally-incremented counter (`pr_review_request.request_version`) that bumps on every applied change — that is the only durable identity that's guaranteed unique per transition. (See `database.md` / `slack-integration.md` for the concrete `request_version` mechanism.)
- **Sibling services can mutate shared DB rows while you `await`.** When a service loop reads rows, then `await`s a network call (Slack, GitHub), another service in the same process (e.g. the poller ingesting a webhook) can change those exact rows before the write completes. Snapshot the identity you read (the `request_version`, not just the row id) and re-check it at write time; mark only rows whose snapshot still matches. Trusting row ids alone silently overwrites concurrent updates.

### Server/Client Consistency

When broadening server-side behavior (e.g. making a check command-agnostic instead of filtering to specific commands), update all corresponding client-side logic to match. Otherwise the UI will be inconsistent with what the server enforces — for example, a client filtering sessions to `['generate', 'agent']` while the server blocks launches for any command type.

### CLI Code Reuse in Server Context

When reusing code originally written for CLI (same `process.cwd()` as the project), check for implicit cwd dependencies like `getGitRepository()`. These functions silently resolve to the wrong directory in the web server process. Always pass an explicit `cwd` or `gitRoot` (typically from the project's `last_git_root` in the DB) to any function that might resolve paths relative to the working directory.

### Reactivity Gotchas (Svelte 5)

- `$derived(() => { ... })` wraps the **function object itself**, not the return value. For multi-statement derivations, use `$derived.by(() => { ... })`.
- SvelteKit **reuses page components** across param-only navigations — local `$state` persists across route changes. Use `afterNavigate` to reset `$state` when needed, though best is to use a "writable derived" when possible.
- Setting a reactive variable that controls a `disabled` attribute doesn't immediately update the DOM. You must `await tick()` before interacting with the element if the interaction depends on the updated DOM state (e.g., focusing a previously-disabled textarea after setting `sending = false`).
- **Hidden items with tracked selection state**: When hiding empty content items in the UI but tracking selection by index (e.g., checkbox arrays), ensure the default checked state matches visibility. An item that is hidden but defaults to checked creates an invisible selection that can block form submission or produce unexpected import results. Default `checked` to `true` only when the item has visible content.
- **`state_referenced_locally` + intentional capture-once**: Svelte 5 warns on the `let x = $state(props.y)` pattern. When capture-once is intentional (e.g. an editor form that should not reset on prop refresh mid-edit), wrap the initializer in `untrack(() => ...)` to make intent explicit and silence the warning.
- **`$derived` is not a drop-in for `$state` when mutating in place**: Writable `$derived` arrays/objects do not re-run dependent derives when you mutate nested properties (`arr[i].prop = x`, `Object.assign(row, patch)`). Before switching a `$state` value to `$derived`, audit all write sites and convert them to immutable reassignment (`arr = arr.map(row => row.id === x.id ? { ...row, ...patch } : row)`).
- **Editor unmounts inside `{#if expanded}`**: If an inline editor lives inside a collapsible `{#if}` region, a separate collapse button can silently unmount the editor and discard unsaved state. Disable the collapse affordance while editing — don't rely on users to remember to Save/Cancel first.
- **Use the remote-query resource (`.current`/`.loading`/`.error`) for always-rendered, SSR-compatible components, not a top-level `await`**: A component that is always mounted (e.g. an always-visible picker or form field) and must render under SSR should read a remote query via its resource shape — `query.current`, `query.loading`, `query.error` — instead of a top-level `await getX()` in a `$derived`/markup position. Top-level async derived values can make SSR tests fail with `await_invalid`. Reserve `{#await}` / top-level `await` for content rendered lazily behind a boundary.

### HTML & Component Gotchas

- **No nested `<a>` tags**: When wrapping a component in an `<a>` tag (e.g., making a row clickable), check for nested `<a>` tags inside — browsers handle nested anchors unpredictably (the inner link may not work, or clicking behavior differs across browsers). Render inner links as plain text when the outer element is already a link.
- **`<ul>` must contain `<li>` directly**: Don't wrap each row in a `<div>` to attach a scroll id or highlight ring — it breaks list semantics. Push the id/styling down into the list-item component via props, or make the outer wrapper the `<li>` itself.

### CLI Code Reuse (Client-Side)

- Client modules under `src/routes/` **cannot** import from `src/tim/commands/*` — those pull in `bun:sqlite`, `node:fs/promises`, workspace helpers, etc. Extract shared pure helpers to `src/common/` (or `src/lib/utils/`) and re-export from the command module for back-compat. Always check the transitive import chain when reusing a CLI helper on the client.

### Remote Function Error Shapes

- SvelteKit's `error(status, body)` accepts a structured body. Use it to tag distinct failure modes (e.g. `{ kind: 'persistence-failed', message, githubReviewUrl }`) and surface enough context for the UI to render a safe recovery path. Generic string errors force the UI to regex-match the message, and "Retry" on an already-completed remote side-effect causes duplicates. Augment `App.Error` in `src/app.d.ts` to type the extra fields.
- In the client, unwrap remote-function errors with a shared helper (`extractRemoteErrorMessage`) that reads `err.body.message` → string body → `err.message` → `String(err)`. Raw `String(err)` at DOM error sites renders `[object Object]`.
- Separate remote side-effects from local DB persistence in catch blocks with nested try/catches. Conflating them either (a) records a synthetic failure row for a remote call that actually succeeded or (b) masks the real error when persistence also throws.
- Validate user-supplied ids at the remote boundary **before** making external API calls. Silently filtering unknown/duplicate/cross-entity ids inside the pipeline turns "invalid selection" into "partial success" — the worst kind of bug to debug. Share the validation between any preview/partition query and the commit command so they can't drift.
- **Do not collapse a picker/search remote error into empty results.** "No matches found" and "the search failed" are distinct UX states — keep the query's error (`.error`) separate from an empty `.current` and render each differently (empty state vs. error state with retry). Swallowing the error into an empty list hides failures from the user and will be flagged in review.

### UI Affordance Gating

- Gate an affordance on the conditions that actually determine success, not on the data that feeds the success path. Example: a "Jump to diff" button gated on `issue.file && issue.line` answers "is the issue anchored?" — not "is there a rendered annotation on the page?" — so the button stays visible for files the guide never renders. Derive the gate from whatever produced the DOM (e.g. parse the same markdown the page renders and collect surfaced filenames).
- When gating create/edit/delete affordances behind a feature flag, check **all** entry points: visible buttons, supporting hooks (line selection, gutter utility callbacks), and modal mounts. Hiding only the buttons can leave a back-channel (e.g. the diff-gutter "add issue" handler) that still creates rows the user can no longer manage. Drive the entire surface from a single prop and audit every consumer of that prop together.

### Routing Gotchas

- SvelteKit's `resolve()` from `$app/paths` enforces typed route parameters — it won't accept dynamic/computed path segments. Use `base` from `$app/paths` + template literals for dynamic paths.
- SvelteKit reserves filenames starting with `+` in route directories (e.g., `+page.svelte`, `+server.ts`). Test files must not use the `+` prefix — name them without it (e.g., `page.server.test.ts` instead of `+page.server.test.ts`).
- **Handle parent layout null fallbacks in child routes**: When a parent layout has a documented fallback path (e.g., DB lookup returning `currentProject = null`), child routes that depend on that data must handle the null case with their own DB lookup rather than assuming the parent always provides it. This commonly arises with `currentProject` in project-scoped routes.

## Architecture

- Route structure: `/projects/[projectId]/{tab}` where `projectId` is a numeric ID or `all`
- Tabs: `sessions`, `active`, `prs`, `reviews`, `plans`, `settings` (settings tab hidden for `all` pseudo-project)
- `src/lib/server/plans_browser.ts` is the abstraction layer between route handlers and `db_queries.ts`
- Display statuses (`blocked`, `recently_done`) are computed server-side in `db_queries.ts`, not stored in DB
- Cookie-based project persistence: `src/lib/stores/project.svelte.ts` manages the last-selected project ID (httpOnly cookie, server-read only)

## Review Guide Viewer Pages

Two routes render stored review guides, both backed by the shared `src/lib/components/ReviewGuideView.svelte` presentational component:

- PR review: `/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]`
- Plan review (no PR required): `/projects/[projectId]/plans/[planId]/reviews/[reviewId]` — loader asserts `review.plan_uuid === plan.uuid` (404 on mismatch), resolves any single linked PR through the shared review-detail loader, and renders `<ReviewGuideView ... />` with a back link to the plan detail page.

The top-level `/projects/[projectId]/reviews` page lists review guides generated in the past week with their plan or PR target, project, issue count, status, and generated time. It shows only the most recent guide per target, grouping by `plan_uuid` when present and otherwise by `pr_url`; `/projects/all/reviews` includes every project.

`ReviewGuideView` accepts `{ review, issues, linkedPlans?, reviewThreads?, submissionPrUrl?, allowGithubSubmission }`. PR-only features are gated by the single `allowGithubSubmission` prop: linked-plans display, Submit Review dialog, existing GitHub review threads attached under matching guide diffs, the diff-gutter `+` utility / `NewReviewIssueModal` mount, and per-issue resolve/edit/delete controls. The header shows View in GitHub and View in Linear buttons whenever the guide has a direct `review.pr_url` or an indirect `submissionPrUrl` from a linked PR. Diff-override gating logic lives in `src/lib/components/review_guide_view_utils.ts` so it can be unit-tested independently.

Shared rendering behavior:

- **Inline diffs**: Markdown review guide ` ```unified-diff ` fenced blocks are rendered as Pierre `Diff.svelte` instances. `MarkdownContent.svelte` uses per-filename `diffOverrides` to pass annotation and interaction props to each diff segment.
- **Issue annotations**: Existing review issues render as clickable diff annotations via `lineAnnotations` + `renderAnnotation` (mounting `ReviewIssueAnnotation.svelte`). Annotation click scrolls to/highlights the matching issue card. The issue card "Jump to diff" action scrolls to/highlights the matching annotation node.
- **Notes**: Review-guide `<annotation file="..." line="...">...</annotation>` tags are extracted into `review_issue` rows with severity `note`. Notes render in the sidebar's bottom group with Copy and Jump-to-diff actions, and they can still be deleted locally even though they remain non-actionable for resolution or plan conversion. Inline diff notes use muted neutral styling, preserve whitespace, and are excluded from GitHub submission.

PR-only (gated by `allowGithubSubmission`):

- **Inline edit**: Each `ReviewIssueCard` supports an Edit mode backed by `ReviewIssueEditor.svelte` (severity, category, file, `start_line`, `line`, side, content, suggestion). Save sends only changed fields in the patch payload.
- **Existing review threads**: The PR review-guide loader fetches cached PR review threads with `includeReviewThreads: true`. `ReviewGuideView` matches each thread by path, side, and line overlap with a guide diff hunk, then renders `PrReviewThreadList` under that diff with `showDiff={false}` so the thread comments are visible without repeating the hunk. Matched threads also appear in a compact "PR Threads" group at the bottom of the issue sidebar, with status badges, first-comment summaries, and a "Jump to diff" action that targets the same rendered guide diff.
- **Gutter-add issues**: The diff gutter `+` utility (`onGutterUtilityClick`) opens `NewReviewIssueModal.svelte` with content + optional suggestion fields. File/line/side are prefilled from the selected range. Save calls the `createReviewIssue` remote command.
- **GitHub submission**: The page includes a Submit Review dialog for choosing event, body, and issue subset, with partition preview and GitHub posting. See `README.md` for the full submission flow details.

### Plan Review Guides on the Plan Detail Page

`PlanDetail.svelte` has a "Review Guides" section with **Generate Full Guide** and **Generate Guide Only** buttons that call the `startPlanReviewGuide` remote command in `src/lib/remote/plan_actions.remote.ts`. That command validates the plan belongs to the project (404 otherwise), rejects with 409 if a `pending`/`in_progress` plan review already exists, and spawns `tim review-guide generate <planId> --auto-workspace` via `spawnPlanReviewGuideProcess` (`src/lib/server/plan_actions.ts`). The guide-only button passes `--guide-only`, which skips issue extraction and only runs the guide generation prompt.

Concurrency is layered: a per-plan launch lock is acquired BEFORE the DB pending/in-progress check (race-safe across simultaneous requests), and the lock is released on spawn failure and on `spawnTimProcess`'s `earlyExit: true` callback. The button is disabled while `reviewGuideRunning` (local optimistic flag) is set or any review for the plan is still `pending`/`in_progress`.

Review history is rendered below the button: `#{review.id} - relative time`, status label, unresolved/total issue counts for complete reviews, with the latest first and a "No review guides yet" empty state. Each entry links to the plan review viewer route above.

Optimistic UI lifecycle: after the remote command succeeds, the page calls `invalidateAll()` and a 15s safety-net timer unconditionally clears `reviewGuideRunning` — do not gate that reset on `hasInProgressReview`, since the row may have already transitioned to `complete`/`error` and would leave the button stuck.

### Upload Artifacts to PR Action

`PlanDetail.svelte` exposes an **Upload artifacts to PR** action that detaches a `tim pr upload-artifacts <planId> --auto-workspace --no-terminal-input` process. The process is spawned by `spawnUploadArtifactsProcess` (`src/lib/server/plan_actions.ts`) via the shared `launchTimCommand` helper, mirroring **Generate Proof**. The CLI command itself (config, upload client, comment builder) is described in [Proof Generation](proof-generation.md#uploading-artifacts-to-a-pr-comment).

Gating follows the affordance-equals-eligibility rule: the action is shown **only** when `mediaHostConfigured && hasUploadableArtifacts(plan) && hasLinkedPr`, and the `startUploadArtifacts` remote command (`src/lib/remote/plan_actions.remote.ts`) re-checks the same conditions server-side so the button and the action gate on identical real success conditions.

- `mediaHostConfigured` is a server-computed boolean passed into `PlanDetail` (computed from `isMediaHostConfigured` in the plan page `+page.server.ts` / `db_queries.ts`, the same way `proofConfigured` is surfaced).
- `hasUploadableArtifacts(plan)` lives in `src/lib/utils/artifact_upload_eligibility.ts` — a pure helper returning true when the plan has any non-deleted artifact (`deletedAt === null`). It is the single source of truth shared by client button visibility and the remote eligibility check.
- `hasLinkedPr` is derived from the plan's linked PRs (`plan.pullRequests.length > 0`).

After a successful launch the handler shows a success toast and calls `invalidateAll()`; structured remote errors surface as an error toast.

## Active Work Tab

The Active Work tab (`/projects/[projectId]/active`) is a single-page scrollable dashboard with three sections: Needs Attention, Running Now, and Ready to Start. Each section is collapsible with a count badge and hidden when empty. An "All clear" message appears when all sections are empty.

### Route Structure

```
src/routes/projects/[projectId]/active/
├── +layout.server.ts       # Loads plans via getDashboardData()
└── +layout.svelte          # Scrollable dashboard with three stacked sections
```

### Data Loading

`getDashboardData(db, projectId)` in `plans_browser.ts` returns `{ plans: EnrichedPlan[], planNumberToUuid }` — all non-terminal plans for the project. Does not load workspaces since the dashboard doesn't have a workspace section.

Actionable PR data is loaded client-side via `getActionablePrs` query in `src/lib/remote/dashboard.remote.ts`. Returns `ActionablePr[]` covering user's own PRs (ready to merge, checks failing, changes requested) and others' PRs where user has a pending review request. Each PR includes linked plan context when available. Classification logic is in `src/lib/utils/pr_actionability.ts` as pure functions. The query reads from cached DB data (does not require `GITHUB_TOKEN` at query time).

### Attention Derivation

`src/lib/utils/dashboard_attention.ts` provides pure functions to derive dashboard items from plans, sessions, and PR data:

- `deriveAttentionItems(plans, sessions, actionablePrs)` — assembles plan + PR attention items
- `deriveRunningNowSessions(sessions, projectId)` — filters active agent/generate/chat sessions, sorted by `connectedAt` most recent first
- `deriveReadyToStartPlans(plans, sessions)` — filters ready non-epic plans with no active session, sorted by priority (urgent > high > medium > low > maybe)

Key types:

- `PlanAttentionItem` — groups multiple reasons per plan: `waiting_for_input`, `needs_review`, `reviewed`, `agent_finished`. Agent finished = offline session linked to `in_progress` plan still in session manager memory (restricted to agent/generate/chat commands). Includes `docsUpdatedAt`, `lessonsAppliedAt`, and `needsFinishExecutor` fields for determining Finish button behavior.
- `PrAttentionItem` — per-PR: `ready_to_merge`, `checks_failing`, `changes_requested`, `review_requested`.
- `ActionablePr` — type for PR actionability data (defined here for the remote query to import).

### Dashboard Layout

The layout (`+layout.svelte`) combines server-loaded plan data with client-side session state from `useSessionManager()`. Sections are derived reactively using `$derived`:

- **Needs Attention**: Plan items (waiting for input, needs review, reviewed, agent finished) and PR items (ready to merge, checks failing, changes requested, review requested) in separate subsections with a divider
- **Running Now**: Active agent/generate/chat sessions with plan title, workspace, elapsed time, command badge. Clicking selects the session and navigates to Sessions tab
- **Ready to Start**: Ready plans sorted by priority with inline "Run Agent" button (handles `already_running`, tracks launched plan UUID)

Server data renders immediately. A subtle "Connecting to sessions..." indicator shows while SSE initializes (`initialized` flag). Subscribes to `pr:updated` SSE events for PR data refresh.

### Components

- `DashboardSection.svelte` — collapsible section with count badge, `▶`/`▼` toggle, Svelte 5 snippet-based content area. `defaultCollapsed` is a one-time initializer, not a live prop. Callers are responsible for not rendering when the section is empty
- `NeedsAttentionCard.svelte` — plan attention card with plan ID, title, reason badges (Waiting for input, Needs review, Agent finished), and action buttons. Uses `<a>` for plan navigation + separate `<button>` for actions (no nested interactive elements). Shows project name when `projectId = 'all'`. For `needs_review` plans, shows a Finish button that calls `startFinish` (spawning a process) or `finishPlanQuick` (instant status transition) depending on whether executor work is needed
- `PrAttentionCard.svelte` — PR attention card with PR title/repo as primary identity, action reason badge, check status, compact diff stats (+A / -D with green/red coloring), linked plan as secondary context. Opens GitHub URL on click
- `RunningNowRow.svelte` — compact row with command type badge, plan title, workspace name, elapsed time. Selects session before navigating to Sessions tab
- `ReadyToStartRow.svelte` — plan row with priority badge and inline "Run Agent" button using `startAgent()` from `plan_actions.remote.ts`. Handles launch lock with loading/launched state (30-second success timeout pattern). Tracks launched plan UUID so state resets when list reorders
- `src/lib/utils/time.ts` — `formatRelativeTime()` helper for human-readable relative timestamps

## PR Status

### Design Guidelines

- **Escape-hatch buttons must be reachable from ALL states**: When adding a manual fallback action (e.g., "Full Refresh from GitHub API"), ensure it's visible in initial/empty/error states — not just the populated state. Users most need the escape hatch when the normal path has failed or hasn't populated data yet.
- **Distinguish fatal errors from non-fatal warnings**: API responses that conflate errors and warnings degrade UX by blocking state transitions (like `fetchedOnce`) on non-fatal issues. Return errors and warnings in separate fields so UI can show warnings without preventing the page from rendering cached data.

### Plan-Level PR Status

PR status data for individual plans is fetched and refreshed via remote functions in `src/lib/remote/pr_status.remote.ts`:

- **`getPrStatus`** (`query`): Returns cached PR status for the plan from the DB. Response: `{ prUrls: string[], invalidPrUrls: string[], prStatuses: PrStatusDetail[], tokenConfigured: boolean }`. `prStatuses` includes the union of explicit PR URLs and auto-linked (webhook branch-matched) PRs from the `plan_pr` junction table, with nested review threads (`includeReviewThreads: true`). Non-URL entries and non-PR URLs from the plan's `pull_request` field are returned in `invalidPrUrls` rather than silently dropped. `tokenConfigured` gates the Full Refresh button visibility.
- **`refreshPrStatus`** (`command`): Webhook-first when `TIM_WEBHOOK_SERVER_URL` is set — ingests webhook events, then pre-filters explicit PR URLs to only those already cached in the DB before syncing junction links, preventing any GitHub API fetches. PRs not yet seen via webhooks are reported as "not yet available from webhooks". When webhooks are not configured, syncs `plan_pr` explicit junction links and refreshes each PR from GitHub using `Promise.allSettled` for per-PR partial failure tolerance. Handles missing `GITHUB_TOKEN` gracefully (syncs links from cached URLs only). Returns `{ error?: string }` — the actual data is delivered by calling `getPrStatus({ planUuid }).refresh()` before returning, which causes subscribed clients to re-fetch the query automatically. When a plan has no PR URLs, always calls `syncPlanPrLinks(db, uuid, [])` to prune stale explicit rows (even in webhook mode); auto-linked rows are preserved. Refresh paths build the effective PR URL set from the union of explicit URLs and auto-linked junction rows.
- **`fullRefreshPrStatus`** (`command`): Escape hatch that bypasses webhook ingestion and refreshes plan PR status directly from the GitHub API. Mirrors the pattern used by `fullRefreshProjectPrs`. Triggered by the "Full Refresh" button in `PrStatusSection`, which is visible in both the populated state and the initial empty/error CTA state.

GitHub App installation tokens are intentionally separate from these PR status refresh paths. PR status, issue import, and review-thread user actions use the personal-token resolver (`GITHUB_TOKEN`, then `gh auth token`). App tokens are used only by explicit app-authenticated workflows such as `tim pr review-guide-comment` and `tim github-app ...`.

### Project-Level PR View

Project-wide PR data is managed via remote functions in `src/lib/remote/project_prs.remote.ts`:

- **`getProjectPrs`** (`query`): Returns cached PR statuses for the project's GitHub repository, partitioned into `authored` and `reviewing` groups by the authenticated GitHub user. Response includes `tokenConfigured` and `webhookConfigured` flags used to gate UI elements.
- **`refreshProjectPrs`** (`command`): Webhook-first when `TIM_WEBHOOK_SERVER_URL` is set — calls `ingestWebhookEvents(db)` then refreshes the query from cache. When webhooks are not configured, falls back to `refreshProjectPrsService()` which fetches all open PRs from the GitHub API directly.
- **`fullRefreshProjectPrs`** (`command`): Escape hatch that always calls `refreshProjectPrsService()` (direct GitHub API) regardless of webhook configuration. Triggered by the "Full Refresh from GitHub API" button in the web UI, which is only shown when `tokenConfigured` is true.

### Data Flow

- `EnrichedPlan` (list views) includes `pullRequests: string[]`, `invalidPrUrls: string[]`, `issues: string[]`, and `prSummaryStatus: 'passing' | 'failing' | 'pending' | 'none'` — computed by canonicalizing plan `pull_request` URLs and matching directly against `pr_status.pr_url`, not via `plan_pr` junctions, ensuring cached data is shown even before junction links are populated. `invalidPrUrls` contains non-URL strings and non-PR URLs from the plan's `pull_request` field (categorized via `categorizePrUrls()`).
- `PlanDetail` (detail view) includes `prStatuses: PrStatusDetail[]` with nested check runs, reviews, labels, and review threads (loaded with `includeReviewThreads: true`).
- `PrStatusSection` uses `$derived(await getPrStatus({ planUuid }))` as its primary data source. An `$effect` calls `refreshPrStatus` on mount/plan change, which updates the DB and refreshes the query — the `$derived` expression automatically picks up the new data.

### Components

- **`PrStatusSection.svelte`** — PR detail section rendered inside `PlanDetail`. Takes only `planUuid` as a prop and fetches its own data via the `getPrStatus` query. For each linked PR: title as GitHub link, state badge (open/merged/closed/draft), checks summary badge (passing/failing/pending), review decision, diff stats in full format ("N files changed, +A / -D" with green/red coloring), labels as colored chips. Expandable sub-sections for individual check runs, reviews, and review threads (with thread count and unresolved count in summary). Review threads section hidden when no threads exist. Renders warning banners for invalid PR entries (non-URL strings, issue URLs). Triggers `refreshPrStatus` command on mount which refreshes data (via webhooks or GitHub API depending on configuration) and updates the query automatically. Subscribes to `pr:updated` SSE events via `useSessionManager().onEvent()` in `onMount`; auto-refreshes when the event's `prUrls` overlap with the component's explicit PR URLs or auto-linked PR URLs from `prStatuses`. Includes a "Full Refresh from GitHub API" button (visible when `tokenConfigured` is true) that calls `fullRefreshPrStatus` to bypass webhooks — shown in both the populated header and the initial empty/error CTA state. **"Fix Unresolved" button** at the section level (visible when unresolved review threads exist) spawns `tim pr fix` via `startFixThreads` command; disabled when a session is already active for the plan. The spawned fixer refreshes linked PR data before launching the agent, injects unresolved review threads with PRRT IDs and grouped comments, and replies/comments without resolving threads.
- **`PrCheckRunList.svelte`** — Expandable list of individual CI check runs within a PR. Shows name, status/conclusion with color coding, link to details URL. Handles both CheckRun and StatusContext source types.
- **`PrReviewList.svelte`** — Expandable list of PR reviews. Shows reviewer name, review state (approved/changes requested/commented/pending/dismissed) with appropriate styling.
- **`PrReviewThreadList.svelte`** — Flat list of PR review comment threads ordered by file path and line number. Each thread shows: file path + line number linked to GitHub comment (`#discussion_r{databaseId}`), resolved/outdated badges, diff hunk in `<pre>` block, and all comments with author, body (plain text), and timestamp. Resolved threads are collapsed by default (`<details>` element); unresolved threads are expanded. Copy button on individual comments formats structured text with file:line context via `formatReviewCommentForClipboard()` from `src/lib/utils/pr_display.ts`. Line number display uses fallback chain (`line ?? original_line ?? start_line ?? original_start_line`) since outdated threads often have null `line`. Comment permalink and diff hunk use first non-null value across all comments in the thread. **Action buttons on unresolved threads**: "Convert to Task" creates a plan task from the thread (title from file:line, description from comment bodies + diff context, with `[source:review-thread:{threadId}]` duplicate guard); "Resolve" calls the GitHub GraphQL `resolveReviewThread` mutation and updates local cache; "Reply" expands an inline textarea for posting a reply. All actions use submission guards keyed by thread_id. Takes `planUuid` prop (plumbed from `PrStatusSection`).
- **`PrStatusIndicator.svelte`** — Compact colored dot badge for plan list views showing overall PR health. Green = all checks passing, red = any failing, yellow = pending, gray = no status data. Used in `PlanRow.svelte` and `ActivePlanRow.svelte` when `pullRequests.length > 0`. Status derived from `EnrichedPlan.prSummaryStatus`.

### Push-Based PR Updates via SSE

PR data is automatically pushed to connected browsers via `pr:updated` SSE events, eliminating the need for manual refresh in most cases.

**Server-side flow**: After webhook ingestion (both periodic polling and manual refresh), `emitPrUpdatesForIngestResult()` from `src/lib/server/pr_event_utils.ts` derives affected project IDs from PR URLs (via `getProjectIdsForPrUrls()`, which parses owner/repo, constructs repository IDs, and queries the project table) and calls `sessionManager.emitPrUpdate(prUrls, projectIds)`. The emission is guarded by `eventEmitter.listenerCount('pr:updated')` to skip DB lookups when no SSE clients are connected. SSE emission failures are logged with `console.warn` but don't fail the parent operation.

**Client-side handling**: Components subscribe via `useSessionManager().onEvent()` in `onMount` and check for relevant overlap:

- **`PrStatusSection`** checks if the event's `prUrls` overlap with its explicit PR URLs or auto-linked PR URLs from `prStatuses`, then calls `getPrStatus({ planUuid }).refresh()`.
- **`/prs/+layout.svelte`** checks if `event.projectIds` includes the current `projectId` (or always refreshes for "all" projects), then calls `getProjectPrs({ projectId }).refresh()`.

Shared overlap utilities live in `src/lib/utils/pr_update_events.ts`: `hasRelevantPrUpdate()` for URL set intersection and `shouldRefreshProjectPrs()` for project ID matching.

**Design note**: `eventEmitter.listenerCount('pr:updated')` is used instead of `sseSubscriberCount` to guard DB lookups, because `sseSubscriberCount` is incremented after event subscriptions are attached in `createSessionEventsResponse()`, creating a race window where events could be dropped during SSE setup.

## Plan Task Counts

Task completion counts are fetched via a remote query in `src/lib/remote/plan_task_counts.remote.ts`:

- **`getPlanTaskCounts`** (`query`): Returns `{ done, total }` task counts for a plan by UUID. Used by `SessionDetail` to display task progress (e.g. "3/5 completed") in the session header.

## Project Settings

The Settings tab (`/projects/[projectId]/settings`) allows configuring per-project settings stored in the database. The tab is hidden for the `all` pseudo-project since settings are per-project.

### Route Structure

- `+page.server.ts`: Loads current settings via `getProjectSettings()`. Redirects to `/projects/all/sessions` if projectId is `all`.
- `+page.svelte`: Form with toggle controls for each known setting. Tracks dirty state and submits changed settings via the `updateProjectSetting` remote command.

### Remote Command

`src/lib/remote/project_settings.remote.ts` provides `updateProjectSetting`, which validates setting names against a `settingValueSchemas` registry and rejects unknown settings. Takes `{ projectId, setting, value }`.

### Available Settings

- **Featured** (boolean, default `true`): Controls whether the project appears in the main sidebar list or is grouped in a collapsed "Other Projects" section at the bottom. The `ProjectSidebar` component splits projects into featured and non-featured groups using `$derived`. The "Other Projects" section auto-opens when the selected project is non-featured.
- **Abbreviation** (string, max 4 chars): Custom abbreviation for the project avatar in collapsed sidebar mode. Overrides the auto-generated abbreviation from `getProjectAbbreviation()`. Setting to empty string clears the override.
- **Color** (enum from `PROJECT_COLOR_PALETTE`): Custom avatar background color for collapsed sidebar mode. Overrides the auto-generated color from `getProjectColor()`. Setting to empty string clears the override.
- **Branch Prefix** (string, max 20 chars): Prefix for auto-generated branch names (e.g. `di/`). Overrides the config file `branchPrefix` value for this project. If the prefix doesn't end with `/`, `-`, or `_`, a `/` is automatically appended.

### Sidebar Integration

`getProjectsWithMetadata()` in `db_queries.ts` loads the `featured`, `abbreviation`, and `color` settings for each project, adding them as fields on `ProjectWithMetadata` (`featured: boolean` defaults to `true`; `abbreviation?: string` and `color?: string` are optional). The sidebar's "All Projects" link falls back to the `sessions` tab when the current tab is `settings`, since the `all` pseudo-project has no settings route.

### Collapsible Sidebar

The `ProjectSidebar` component supports two modes controlled by `sidebarCollapsed` from `UIStateStore` (default: collapsed):

- **Collapsed mode** (~48px wide): Column of colored rounded-square avatar buttons with 2-letter abbreviation text. "All Projects" shows "ALL". Each project uses custom abbreviation/color from settings if set, otherwise auto-generates via `getProjectAbbreviation()` / `getProjectColor()` from `src/lib/stores/project.svelte.ts`. Selected project has blue highlight. Featured and unfeatured projects separated by a thin divider. Toggle button (chevron) at top expands.
- **Expanded mode** (w-56): Full sidebar with project names, plan counts, and attention indicators. Collapse toggle in the "Projects" header row.

Auto-generation utilities in `src/lib/stores/project.svelte.ts`:

- **`getProjectAbbreviation(displayName)`**: Splits on spaces, dashes, underscores, dots; takes first letter of first two words (uppercase). For `owner/repo` format, owner is first word. Single word → first two letters.
- **`getProjectColor(displayName)`**: Hashes display name to an index into `PROJECT_COLOR_PALETTE` (predefined hex colors that work on light and dark backgrounds). Deterministic.

## Sessions Tab

The Sessions tab (`/projects/[projectId]/sessions`) provides real-time monitoring of tim agent processes via a WebSocket + SSE architecture.

### Server Infrastructure

The sessions system uses a discovery-based architecture where the web GUI discovers and connects to agent processes:

1. **Agent-side embedded servers**: Each tim long-running command (`agent`, `generate`, `chat`, `finish`, `review`, `run-prompt`, `shell`) starts its own embedded WebSocket server via `HeadlessAdapter`. The server broadcasts output messages, supports replay for late-connecting clients, and routes incoming prompt responses and user input. Session discovery is via PID info files in `~/.cache/tim/sessions/`. See the README "Embedded Session Server" section for environment variable configuration.

   **PTY sessions** (`tim shell`): When a session is marked `pty` in its `session_info`, it streams raw terminal bytes instead of structured output messages. See [PTY Sessions](#pty-sessions) below for the distinct protocol and replay behavior.

2. **Session discovery client** (`src/lib/server/session_discovery.ts`): The web interface discovers agent processes by scanning `~/.cache/tim/sessions/` for session info files and connects to each agent's embedded WebSocket server as a client. Uses `fs.watch()` with debounced re-scan (500ms) for real-time discovery of new/removed processes, plus periodic reconciliation polling (30s) for PID liveness checks and stale file cleanup. Handles connection retry with exponential backoff (100ms to 5s) for cases where the PID file appears before the server is ready. Enforces loopback-only connections: non-loopback hostnames in session info files are rejected with a warning (full `127.0.0.0/8` range and `::1` accepted; wildcard binds like `0.0.0.0` and `::` are mapped to `127.0.0.1` and `[::1]` respectively). Processes with `token: true` are skipped (bearer token auth deferred to remote workspace plans). Survives HMR via the session context singleton pattern.

3. **Tim-gui WebSocket server**: The web interface also runs a WebSocket server on port 8123 for the HTTP notification endpoint and the browser-facing PTY relay (`/pty`, see [PTY Sessions](#pty-sessions)).

- **WebSocket server** (`src/lib/server/ws_server.ts`): Listens on port 8123 (configurable via `TIM_WS_PORT` env var or `headless.url` config). Accepts HTTP POST notifications at `/messages` and browser PTY websocket upgrades at `/pty`. It is not used for agent session connections (those go through the discovery client). Message parsing uses shared utilities from `src/logging/headless_message_utils.ts`.
- **Session discovery client** (`src/lib/server/session_discovery.ts`): Watches the session directory, manages WebSocket client connections to discovered agent processes, and feeds messages into SessionManager via `handleWebSocketConnect/Message/Disconnect`. Uses the session info file's `sessionId` as the `connectionId` for SessionManager. Session registration is gated on validated `session_info` (sessionId must match PID file); reconnections to existing offline sessions buffer messages until `replay_end` to protect existing session history.
- **Session manager** (`src/lib/server/session_manager.ts`): Central state management singleton. Tracks active/offline/notification sessions, passes structured messages through to the client as-is (category set to `'structured'`), handles replay buffering, prompt tracking, and project resolution from DB. Display category computation (lifecycle, llmOutput, toolUse, etc.) is done client-side via `src/lib/utils/message_formatting.ts`. Also tracks SSE subscriber count via `registerSSESubscriber()`/`unregisterSSESubscriber()` and broadcasts `notification_subscribers_changed` messages to all connected agents when the count crosses the 0↔1 boundary, enabling agents to suppress duplicate command-based notifications when the web UI is open. Newly connected agents receive the current subscriber status immediately on WebSocket connect.
- **Session context** (`src/lib/server/session_context.ts`): HMR-safe singleton (uses `Symbol.for`) exposing `getSessionManager()`, `getWsConnections()`, `getSessionDiscoveryClient()` / `setSessionDiscoveryClient()`, and `getWebhookPoller()` / `setWebhookPoller()` for use by SSE and API routes.
- **Server init** (`src/hooks.server.ts`): Starts the WebSocket server, session discovery client, webhook poller, and Slack review-request notifier on SvelteKit boot via the `init` export.

### Message Processing

- Incoming agent messages follow the headless protocol: `session_info` → `replay_start` → historical messages → `replay_end` → live messages
- **Dynamic session info updates**: The headless adapter can re-send `session_info` after initial handshake (e.g., after workspace switching in `setupWorkspace()`). The server handler is idempotent — it replaces `session.sessionInfo`, recomputes `groupKey` and `projectId`, and emits `session:update`. The web UI re-groups the session automatically via reactive `sessionGroups`.
- Messages during replay (`replay_start`..`replay_end`) are added to the session's message list but NOT emitted as SSE events
- **Replay prompt suppression**: Prompts received during replay are deferred to internal state (`deferredPromptEvents` array in `SessionInternals`) rather than stored in `session.activePrompts`. On `replay_end`, all deferred prompts are promoted to active prompts and emitted individually. `getSessionSnapshot()` and `cloneSession()` strip `activePrompts` while `isReplaying` is true. `sendPromptResponse()` rejects during replay as a safety guard.
- Each message becomes a `DisplayMessage`. Structured messages are passed through with `body: { type: 'structured', message: StructuredMessagePayload }` and `category: 'structured'`. The client computes display categories and formatting via `src/lib/utils/message_formatting.ts`. Non-structured TunnelMessages (log/error/warn/stdout/stderr) retain server-side formatting into text/monospaced body types with `category: 'log' | 'error'`.
- Debug tunnel messages are suppressed
- Non-tunnel `agent_session_end` structured messages set `triggersNotification` when the session's `session_info.interactive` flag is true, except for explicitly opted-out session commands such as `agent` and `review-guide`. The client uses this for browser notifications and the blue attention dot, so new interactive commands should set `interactive: true` in headless session metadata rather than adding command names to a web UI allowlist.
- `MessageCategory` on the wire is simplified to `'log' | 'error' | 'structured'`. The richer display categories (lifecycle, llmOutput, toolUse, fileChange, command, progress, error, userInput) are computed client-side from the structured message's `type` field via `getDisplayCategory()`.

### PTY Sessions

The `tim shell` command (`src/tim/commands/pty.ts`) runs an interactive login shell (`zsh -l` by default, overridable via `--shell` / `$SHELL`) inside a `Bun.Terminal` PTY in a prepared workspace, and exposes it as a `pty` session over the same embedded-server / discovery transport as other sessions. PTY sessions use a **distinct, raw-byte protocol** that bypasses the structured-message and replay machinery:

- **`session_info.pty: true`** marks the session as a PTY. The handshake also carries the initial `cols`/`rows`. PTY sessions never run the structured replay sequence — no `replay_start` / `replay_end` is emitted.
- **`pty_output`** (agent→client): raw terminal bytes from the PTY `data` callback, base64-encoded inside a JSON frame (`{ type: 'pty_output', data }`). Broadcast live to all connected clients via `HeadlessAdapter.broadcastPtyOutput()`.
- **`pty_input`** (client→agent): raw keystroke bytes, base64-encoded (`{ type: 'pty_input', data }`). Decoded and written to `terminal.write()`.
- **`pty_resize`** (client→agent): `{ type: 'pty_resize', cols, rows }`, forwarded to `terminal.resize()`.

These message types are defined in `src/logging/headless_protocol.ts` (`HeadlessPtyOutputMessage`, `HeadlessPtyInputServerMessage`, `HeadlessPtyResizeServerMessage`) and validated by the parsers in `src/logging/headless_message_utils.ts`.

**Agent-side raw scrollback buffer.** Instead of structured replay, the `HeadlessAdapter` keeps a bounded raw-byte buffer of recent PTY output (`maxPtyBufferBytes`, default 512 KB — roughly one screenful plus modest scrollback), evicting oldest bytes when over the cap. On each new client connection the entire buffer is resent as `pty_output` frames, so a late-joining or reconnecting client (e.g. after a web-server restart) renders a populated screen. The buffer lives on the agent because it survives web-server restarts and discovery re-fetches `session_info` on every reconnect.

**Lifecycle.** `end_session` closes the PTY/shell gracefully (`terminal.close()`); `force_end_session` sends `SIGTERM` to the shell process. When the shell process exits, the PTY closes, the adapter is torn down, and the session-info file is removed.

**Token-less embedded server.** `SessionDiscoveryClient` skips token-authenticated sessions, so `tim shell` starts its embedded server without a bearer token (`createHeadlessAdapterForCommand({ ..., disableBearerToken: true })` in `src/tim/commands/pty.ts`, threaded through `src/tim/headless.ts`). This forces the token off even when `TIM_WS_BEARER_TOKEN` is set, so the web server can discover and connect to the PTY agent.

#### Web-server relay (agent ↔ browser)

The web server is the middle hop: it relays raw PTY bytes between the agent (via `SessionDiscoveryClient`) and browser clients. The agent→server hop reuses the discovery-client transport (the web server is a client of the agent's embedded server), so a web-server restart reconnects to still-running PTY agents and re-fetches `session_info`. PTY frames ride opaquely as base64 over both JSON-text hops — the relay never decodes them.

- **`SessionManager` threading** (`src/lib/server/session_manager.ts`): `session.pty` is set from `session_info.pty` and mirrored onto `SessionData` (both the server type and its client mirror in `src/lib/types/session.ts`, which also carries `cols`/`rows`). For PTY sessions, incoming `pty_output` frames are forwarded **raw** to subscribers via `broadcastPtyOutput()` — they are **not** turned into `DisplayMessage`s and never pushed onto `session.messages`. Browser→agent traffic routes agent-ward through `trySend`: `sendPtyInput()` (raw base64 keystrokes) and `sendPtyResize({ cols, rows })`.
- **PTY subscribers**: browser sockets register per `connectionId` (= the discovery `sessionId`) via `registerPtySubscriber()`, which returns an unsubscribe function. `pty_output` is **broadcast** to all subscribers, so **multiple viewers** per PTY session are supported: input from any viewer interleaves into the one agent shell, and resize is **last-resize-wins**. A subscriber whose `send` throws is dropped (logged via `debugLog`); the subscriber set is cleared on dismiss/disconnect.
- **Browser `/pty` websocket** (`src/lib/server/ws_server.ts`): the browser-facing socket is a dedicated path on the standalone `Bun.serve` :8123 server, **not** an adapter-node `+server.ts` endpoint (those are SSE-only and cannot upgrade websockets). Clients connect to `ws://<host>:8123/pty?connectionId=<id>`. The upgrade requires `GET`, a non-empty `connectionId`, and a passing **Origin check** (`isAllowedPtyOrigin` — missing Origin allowed, otherwise loopback origins or same-host accepted, foreign sites rejected with 403). On open, the socket registers a PTY subscriber that forwards each frame via `ws.send`. Incoming browser frames are dispatched by shape: a `{ type: "resize", cols, rows }` JSON control frame (validated by `isPtyResizeFrame`) calls `sendPtyResize`; any other text frame is treated as an opaque base64 keystroke payload and passed to `sendPtyInput`. `WebSocketData` is now a discriminated union (`kind: 'agent' | 'pty'`) so the shared `open`/`message`/`close` handlers route by socket kind.
- **Exposing the port to the client**: `src/routes/+layout.server.ts` surfaces `ptyWebSocketPort` (from `resolveHeadlessServerConfig`) in layout load data so the browser can build the `/pty` URL. Only the port is exposed — the host is derived client-side from `window.location` (the server's bind host may be a non-browser-reachable wildcard/loopback address), and the `/pty` path is fixed.

**Browser terminal component** (`src/lib/components/Terminal.svelte`): wraps the framework-agnostic `@wterm/dom` `WTerm` class in a Svelte 5 component. Props: `connectionId: string`, `wsPort: number`, optional `cols`/`rows`. In `onMount`, creates a `WTerm` instance in a container `div`, calls `await term.init()`, then opens a `WebSocket` to `${ws|wss}://${window.location.hostname}:${wsPort}/pty?connectionId=<id>` (the scheme follows `window.location.protocol`; the port comes from `ptyWebSocketPort` in layout load data). Incoming text frames are decoded from base64 and written into the terminal via `term.write(bytes)`; binary frames are passed directly. Keystrokes captured by `onData` are UTF-8-encoded, base64-encoded, and sent as raw text frames. Terminal resize events (`onResize`) send a `{ type: 'resize', cols, rows }` JSON control frame. Teardown (`term.destroy()`, `ws.close()`) runs in `onDestroy`. Note the usual `afterNavigate` teardown rule does **not** apply here: the session detail page wraps `SessionDetail` (and thus `Terminal`) in `{#key session.connectionId}`, so a session switch fully remounts the component and `onDestroy` covers every teardown case. `afterNavigate` must **not** be used for teardown here because it fires on _arrival_ (the navigation that mounted the component), which would tear the terminal down immediately on mount before it connects. `SessionDetail.svelte` branches its `messagesPane` snippet on `session.pty`: when true, renders `Terminal` instead of the structured message list and suppresses `MessageInput` (all input goes through the terminal); when false, the existing message-list + input behavior is unchanged.

### Message Limits

- **WS sessions**: Capped at `MAX_SESSION_MESSAGES` (5000). When exceeded, oldest messages are trimmed via `trimSessionMessages()`.
- **Notification sessions**: Capped at 200 messages.
- **SSE snapshots**: `getSessionSnapshot()` caps messages per session at `MAX_SNAPSHOT_MESSAGES` (500) to limit CPU/memory on new SSE client connections. Full message history is still available via incremental SSE events.
- **Notification message IDs**: Use a monotonic per-session counter (`nextNotificationId` in `SessionInternals`) instead of `messages.length + Date.now()`, preventing duplicate IDs after the 200-message cap trims old messages.

### Defensive Message Handling

- `formatTunnelMessage()` wraps structured message processing in try/catch with a fallback text body for malformed payloads, preventing crashes from unexpected agent protocol additions. Validates structured payloads are plain objects with a string `type` before passing through; rejects malformed payloads to a text log fallback.
- `handleStructuredSideEffects()` validates structured payloads before acting on them: `prompt_request` requires `requestId`, `promptConfig`, and valid `choices` (array or absent); `prompt_answered` requires `requestId`. Malformed payloads are silently skipped rather than installing invalid prompt state.
- WebSocket message dispatch in `ws_server.ts` wraps `sessionManager.handleWebSocketMessage()` in try/catch so malformed client frames cannot crash message processing for that socket.
- Client-side `formatStructuredMessage()` in `src/lib/utils/message_formatting.ts` has a default case returning a generic text fallback for unknown structured message types. `SessionMessage.svelte` wraps `formatStructuredMessage()` calls in try/catch for graceful degradation on malformed payloads. `ReviewResultDisplay.svelte` validates input arrays and issue entries independently.
- Browser notifications (`session_notifications.ts`): `extractMessageText()` handles structured message bodies via `formatStructuredMessage()`, so events like `agent_session_end` trigger notifications correctly even though they arrive as structured bodies rather than text.

### Notification Suppression

When the web UI has active SSE subscribers (i.e., a browser tab is open), agent-side command-based notifications (`sendNotification()` in `src/tim/notifications.ts`) are automatically suppressed to prevent duplicate notifications. The mechanism works as follows:

1. **SSE subscriber tracking**: `SessionManager` tracks the number of active SSE connections. When the count crosses the 0↔1 boundary, it broadcasts a `notification_subscribers_changed` message (with `hasSubscribers: boolean`) to all connected agents via their WebSocket connections.
2. **Agent-side handling**: `HeadlessAdapter` receives the message and updates its `_hasNotificationSubscribers` flag. On WebSocket disconnect, the flag resets to `false`.
3. **Suppression check**: `sendNotification()` checks `hasNotificationSubscribers()` on the current `HeadlessAdapter` (via `getLoggerAdapter()`) and skips the notification command when the web UI is actively listening.

This is distinct from `hasConnectedClients()`, which counts raw WebSocket connections (including the server-side session discovery client) and is still used for `session_ended` broadcast in `destroy()`.

### Notification Sessions

HTTP POST to `/messages` on port 8123 creates lightweight "notification" sessions (capped at 200 messages). When a WebSocket session later connects with the same group key (normalized gitRemote + workspacePath), the notification session is reconciled into the full session. Remote URLs are normalized via `parseGitRemoteUrl().fullName` to canonicalize equivalent remote formats (HTTPS vs SSH, with/without `.git` suffix) into the same group key.

### SSE Endpoint & API Routes

Browser clients receive real-time updates via SSE and interact with sessions through remote `command()` functions:

- **SSE endpoint** (`src/routes/api/sessions/events/+server.ts`): `GET` returns a `ReadableStream` with SSE headers. On connect, calls `registerSSESubscriber()` and sends `session:list` snapshot, replays any buffered events, then sends `session:sync-complete` to signal that initial state is fully loaded. After sync, streams live events (`session:new`, `session:update`, `session:disconnect`, `session:message`, `session:prompt`, `session:prompt-cleared`, `session:dismissed`, `session:plan-content`, `pr:updated`). Uses subscribe-before-snapshot pattern with buffering to avoid lost-event race conditions. On stream teardown, calls `unregisterSSESubscriber()` to update agent notification suppression state.

#### SSE Implementation Gotchas

- **ReadableStream cancel() must not call controller.close()**: When an SSE client disconnects, the `cancel()` callback fires, but the stream is already being torn down by the consumer. Calling `controller.close()` inside `cancel()` throws. Only use `cancel()` for cleanup (unsubscribing listeners, etc.).
- **Subscribe before snapshot**: If you take the snapshot first and subscribe second, events emitted between those two calls are lost. Subscribe first, buffer events during snapshot delivery, then flush and stream normally.
- **EventEmitter listeners must not throw**: An exception thrown from an EventEmitter listener propagates through `emit()` and aborts delivery to remaining listeners. Always wrap SSE `controller.enqueue()` calls (and any other potentially-failing operations) in try/catch inside listener callbacks.
- **Session actions** (`src/lib/remote/session_actions.remote.ts`): remote `command(...)` functions for session interactions:
  - `sendSessionPromptResponse`: validates `{ connectionId, requestId, value }` and forwards prompt responses. Throws 400 for wrong requestId, 404 for missing session.
  - `sendSessionUserInput`: validates `{ connectionId, content }` and sends free-form text to interactive sessions.
  - `dismissSession`: validates `{ connectionId }` and removes offline/notification sessions.
  - `endSession`: validates `{ connectionId }` and sends an `end_session` message to the agent process. For interactive sessions, this gracefully closes subprocess stdin (equivalent to Ctrl-D); for non-interactive sessions, it sends SIGTERM. Throws 404 for missing session.
  - `dismissInactiveSessions`: bulk-dismisses all inactive sessions, returns `{ dismissed: number }`.
  - `activateSessionTerminalPane`: resolves the WezTerm pane from session metadata, switches to the pane's workspace, activates the pane, and brings WezTerm to the foreground on macOS.
  - `openTerminal`: opens a new terminal window in the specified directory. Reads `terminalApp` from config (defaults to WezTerm). Uses `wezterm start --cwd` for WezTerm or `open -a <app>` for other macOS terminal apps. macOS only.
- **Shared helpers** (`src/lib/server/session_routes.ts`): `formatSseEvent()`, `createSessionEventsResponse()` used by the SSE endpoint.

### Key Design Decisions

- Each WebSocket connection creates a new session (no reconnection merging)
- Vite HMR may restart the discovery client during dev; it reconnects to discovered agents on restart
- SSE subscribes before taking snapshot to avoid lost-event race window, with event buffering during snapshot delivery
- `sendPromptResponse` validates requestId against the `activePrompts` array and removes the matched prompt on success — prevents duplicate responses from multiple browser tabs. Multiple prompts can be active simultaneously (e.g., from concurrent subagents); the UI shows the oldest first
- SSE enqueue calls are wrapped in try/catch for resilience against closed streams
- **Webhook poller** (`src/lib/server/webhook_poller.ts`): Periodic ingestion of webhook events via `ingestWebhookEvents(db)`. Enabled by `TIM_WEBHOOK_POLL_INTERVAL` env var (seconds, minimum 5, clamped to max 86400). First poll is delayed 15 seconds after startup to avoid churn during HMR reloads. Uses an in-flight guard to skip overlapping ticks. Requires `TIM_WEBHOOK_SERVER_URL` and `WEBHOOK_INTERNAL_API_TOKEN` to also be set. Returns `null` (no-op) when not configured. Accepts an `onPrUpdated` callback invoked after successful ingestion with non-empty `prsUpdated`; wired in `hooks.server.ts` to emit `pr:updated` SSE events via `emitPrUpdatesForIngestResult()` from `src/lib/server/pr_event_utils.ts`.
- **Slack notifier** (`src/lib/server/slack_notifier.ts`): Background review-request notification loop. Starts when at least one Slack workspace has `reviewNotifier.enabled: true`, reads pending `pr_review_request` rows with `notified_at IS NULL`, groups them by PR, applies a fixed 30-second debounce, posts one Slack channel message per enabled repo/PR targeting an opted-in workspace, and marks rows notified after a confirmed send. When machine-local `githubWebhooks.ignoreSideEffectsBefore` is set, pending rows before that timestamp are marked notified without posting. It is kicked by the webhook poller's `onPrUpdated` callback and also runs about every 15 seconds so debounced requests can fire without another webhook.
- **Shutdown**: `hooks.server.ts` registers SIGTERM/SIGINT handlers that stop the Slack notifier, webhook poller, discovery client, and WebSocket server, then call `process.exit(0)` for clean production shutdown. HMR-safe cleanup uses `Symbol.for` singleton pattern. Custom signal handlers suppress default Node.js termination, so explicit `process.exit()` is required.

### Client-Side Session Store

`src/lib/stores/session_state.svelte.ts` is a Svelte 5 runes-based reactive store managing all session state:

- **SSE connection**: Established from root `+layout.svelte` so it stays open across all tab switches. Auto-reconnects on disconnect.
- **SSE event handling**: Event application logic is extracted into `src/lib/stores/session_state_events.ts` as pure functions for testability without Svelte runtime. Uses `push()` instead of spread for O(1) message append.
- **Session grouping utilities**: `getSessionGroupKey()` and `getSessionGroupLabel()` are extracted into `src/lib/stores/session_group_utils.ts` as a plain TypeScript module (no Svelte/remote-action dependencies) for testability. Re-exported from `session_state.svelte.ts` for backward compatibility.
- **Client-side message cap**: `MAX_CLIENT_MESSAGES` (5000) mirrors the server-side cap to prevent unbounded browser memory growth. Messages are trimmed after push.
- **Initialization tracking**: The `initialized` flag is set to `true` only when the `session:sync-complete` event is received, indicating that the snapshot and all buffered catch-up events have been processed. It resets to `false` on SSE reconnect. Pages that need to distinguish "not yet loaded" from "not found" should gate on this flag.
- **State**: `sessions` (SvelteMap for reactivity), `selectedSessionId`, `lastSelectedSessionIds` (SvelteMap keyed by route projectId — remembers last-viewed session per project), `connectionStatus` (connected/reconnecting/disconnected), `initialized`
- **Derived**: `sessionGroups` — sessions grouped by `groupKey`, with the current project's group sorted to top. Group labels resolved from project display name (when `projectId` matches a known project) or workspace path (last 2 components).
- **Actions**: `sendPromptResponse(connectionId, requestId, value)`, `sendUserInput(connectionId, content)`, `dismissSession(connectionId)`, `endSession(connectionId)` — all call remote `command()` functions from `src/lib/remote/session_actions.remote.ts`. `activateTerminalPane(session)` and `openTerminalInDirectory(directory)` also call remote commands from the same module.
- **SvelteMap reactivity**: SvelteMap only tracks `.set()`/`.delete()`/`.clear()` — after mutating nested properties on stored objects, the entry must be re-set to trigger reactivity.
- **Per-project session memory**: `lastSelectedSessionIds` tracks the last-viewed session per project route. When the user navigates away from a session detail and returns to the Sessions tab, the empty-state page (`sessions/+page.svelte`) redirects to the remembered session if it still exists. Uses `replaceState: true` to avoid back-button loops. On session dismissal or SSE reconnect, falls back to the most recently connected remaining session via `findMostRecentSessionId()`. Stale entries (sessions no longer in the sessions map) are pruned during fallback.

### UI State Store

`src/lib/stores/ui_state.svelte.ts` is a client-side store managing transient UI preferences that persist across route navigation but reset on page refresh. Initialized in root `+layout.svelte` alongside SessionManager, accessed via Svelte context (`setUIState()` / `useUIState()`).

- **Session-scoped state** (keyed by `connectionId`): `planPaneCollapsed` (boolean), `messageDraft` (string). Accessed via `getSessionState(connectionId)` / `setSessionState(connectionId, patch)`.
- **Global state**: `sidebarCollapsed` (boolean, default true) — persisted via cookie for SSR-safe hydration. Read server-side in `+layout.server.ts` via `getSidebarCollapsed(cookies)`, written client-side via `document.cookie`. Toggled via `toggleSidebar()`.
- **Cleanup**: `clearSessionState(connectionId)` removes all state for a session. Wired to `session:dismissed` SSE events via an `onEvent` callback in root layout. Cleanup logic extracted to `src/lib/stores/ui_state_cleanup.ts` for testability.

### UI Components

- **`SessionList.svelte`** — Grouped session sidebar (left pane, w-96). Groups are collapsible by project. Shows all sessions regardless of selected project.
- **`SessionRow.svelte`** — Individual session entry with status indicator dot (green=active, gray=offline, blue=notification), command name, plan title/ID, dismiss button for offline/notification sessions, a terminal icon when the session includes WezTerm pane metadata, and an "Open Terminal" button (AppWindow icon) that opens a new terminal window in the session's workspace directory (visible on hover when `workspacePath` exists).
- **`SessionDetail.svelte`** — Message transcript view with session header (command, plan, workspace, status), optional terminal activation button for WezTerm-backed sessions, "Open Terminal" button (AppWindow icon, always visible when `workspacePath` exists) that opens a new terminal in the workspace directory, End Session button with inline confirmation for active sessions, export buttons (copy to clipboard, download as markdown), scrollable message list, fixed-position prompt area above messages, conditional message input bar. Plan title in the header is a clickable link to the plan detail page. When the plan has tasks, shows task completion counts (X/Y done) fetched via the `getPlanTaskCounts` remote query. Uses `{#key connectionId}` for remount on session switch. Auto-scroll is scroll-position-based: active when at bottom, disabled when user scrolls up, resumes on scroll to bottom. When the session has an associated plan (`sessionInfo.planId != null`), the view splits into two panes below the header: left pane shows the message stream, right pane shows live plan content via `PlanContentPane`. The split is side-by-side on `lg+` screens and stacked vertically on smaller screens. A toggle button (PanelRightOpen/PanelRightClose icon) in the header collapses/expands the plan content pane — when collapsed, the messages pane takes full width. Collapse state persists across session navigation via `UIStateStore`. Toggle logic extracted to `src/lib/components/session_detail_state.ts` for testability.
- **`PlanContentPane.svelte`** — Renders live plan file content for plan-associated sessions. Accepts `content: string | null` prop. Shows "Waiting for plan content..." placeholder when null. When present, renders the markdown body (YAML frontmatter already stripped agent-side) as preformatted text in a scrollable `<pre>` container with line-by-line span-based colorizing for markdown elements (headers, code blocks, bold, inline code, list markers). No auto-scroll — user controls scroll position. Content updates arrive via `session:plan-content` SSE events and persist in session snapshots across reconnects.
- **`SessionMessage.svelte`** — Renders messages by body type: text (colored by category), monospaced (preformatted code blocks), todoList (items with status icons), fileChanges (paths with +/~/- indicators), keyValuePairs (structured metadata table), structured (raw structured message data formatted client-side via `formatStructuredMessage()`, with dedicated components for specific types like `ReviewResultDisplay`). Long content truncated with expandable reveal.
- **`PromptRenderer.svelte`** — Renders by prompt type: confirm (Yes/No buttons with default highlighted), input (text field with submit), select (radio group), checkbox (checkbox group), prefix_select (clickable word segments for bash command prefix authorization — selected words highlighted in accent color, remaining dimmed; "Submit Prefix" and "Allow Exact Command" buttons). Uses `{#key requestId}` for state reset. Shows header/question fields from promptConfig when present. Falls back to raw JSON display for unsupported types.
- **`MessageInput.svelte`** — Text input with Enter to send, Shift+Enter for newlines. Hidden (not disabled) when session is offline or non-interactive. Saves unsent text per-session via `UIStateStore` on every keystroke (`oninput` handler, not `$effect`). Restores draft when returning to a session. Draft cleared on successful send. Draft logic extracted to `src/lib/components/message_input.ts` for testability.
- **`Terminal.svelte`** — `@wterm/dom` terminal for PTY sessions (`session.pty === true`). Renders instead of the message list in `SessionDetail.svelte`; `MessageInput` is hidden. See [PTY Sessions](#pty-sessions) for the relay protocol and teardown (via `onDestroy` + the page-level `{#key session.connectionId}` remount; not `afterNavigate`).
- **Category colors** (`src/lib/utils/session_colors.ts`): Maps `DisplayCategory` values to Tailwind color classes — lifecycle=green, llmOutput=green, toolUse=cyan, fileChange=cyan, command=cyan, progress=blue, error=red, log=gray, userInput=orange. For structured messages, the display category is computed client-side via `getDisplayCategory()` from `src/lib/utils/message_formatting.ts`.

### Session Export

Session transcripts can be exported as markdown via two buttons in the `SessionDetail` header (ClipboardCopy and Download icons from lucide-svelte). Both buttons are disabled when the session has no messages.

- **Copy to clipboard**: Calls `exportSessionAsMarkdown()`, writes to clipboard via `navigator.clipboard.writeText()`, shows toast confirmation.
- **Download as file**: Calls `exportSessionAsMarkdown()`, creates a Blob download with filename from `generateExportFilename()` (format: `session-{command}-{planId}-{timestamp}.md`).

Export utilities live in `src/lib/utils/session_export.ts`:

- **`formatMessageAsMarkdown(message)`**: Converts a `DisplayMessage` to markdown. Resolves structured messages via `formatStructuredMessage()`. Handles all body types: text as-is, monospaced in fenced code blocks (dynamic fence length via `computeFence()` to handle content containing backticks), todoList as markdown checkboxes, fileChanges as bullet list with diff markers, keyValuePairs as bold-key lines (multiline values in fenced code blocks), review_result with verdict/issues/recommendations/action items.
- **`formatSessionHeader(session)`**: Markdown header with command, plan, workspace, git remote, and timestamps (UTC). Only includes fields that have values.
- **`exportSessionAsMarkdown(session)`**: Composes header + all messages.
- **`generateExportFilename(session)`**: Filesystem-safe filename with sanitized command and planId.

## Keyboard Navigation

All three tabs (Sessions, Plans, Active Work) support **Alt+ArrowDown** / **Alt+ArrowUp** (Option+Down/Up on macOS) to navigate to the next/previous item in the list. The shortcut fires regardless of focus state, including when in text inputs.

### Behavior

- Navigation respects collapsed groups and active filters — only visible items are navigable
- When no item is selected, Alt+Down selects the first visible item; Alt+Up selects the last
- At list boundaries, the shortcut does nothing (no wrap)
- The navigated-to item is scrolled into view via `scrollIntoView({ block: 'nearest' })`
- Events with Ctrl, Meta, or Shift modifiers are ignored to avoid shortcut conflicts

### Implementation

Each list component (`SessionList.svelte`, `PlansList.svelte`, active work `+layout.svelte`) adds its own `<svelte:window onkeydown>` handler. Since only one tab is mounted at a time, there's no conflict. Shared logic lives in `src/lib/utils/keyboard_nav.ts`:

- **`isListNavEvent(event)`** — Returns `'up'` or `'down'` for Alt+Arrow events, `null` otherwise
- **`getAdjacentItem(items, currentId, direction)`** — Computes the adjacent item ID with boundary clamping
- **`scrollListItemIntoView(itemId)`** — Finds `[data-list-item-id]` element and scrolls it into view

Row components (`SessionRow`, `PlanRow`, `ActivePlanRow`) have `data-list-item-id` attributes for scroll targeting.

### Global Keyboard Shortcuts

The root layout (`+layout.svelte`) registers a `<svelte:window onkeydown>` handler for global keyboard shortcuts:

| Shortcut                       | Action                                     | Context                                                                                |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Cmd+K / Ctrl+K**             | Open command bar scoped to current project | Always active, even in text inputs                                                     |
| **Cmd+Shift+K / Ctrl+Shift+K** | Open command bar searching all projects    | Always active; when on "All Projects", behaves same as Cmd+K                           |
| **Ctrl+/**                     | Focus the search input on the Plans tab    | Suppressed when focus is in a text input, textarea, select, or contenteditable element |
| **Ctrl+1**                     | Navigate to Sessions tab                   | Always active, even in text inputs                                                     |
| **Ctrl+2**                     | Navigate to Active Work tab                | Always active                                                                          |
| **Ctrl+3**                     | Navigate to Plans tab                      | Always active                                                                          |

Tab navigation uses `goto()` with `projectUrl()` to build the correct route for the current project context.

The shortcut logic lives in `src/lib/utils/keyboard_shortcuts.ts`:

- **`isTypingTarget(event)`** — Returns `true` if the event target is an `<input>`, `<textarea>`, `<select>`, or `[contenteditable]` element
- **`handleGlobalShortcuts(event, callbacks)`** — Matches key combinations using `event.code` (physical key codes like `Slash`, `Digit1`) for locale independence, and calls the appropriate callback

The search input in `PlansList.svelte` has a `data-search-input` attribute for targeting by the Ctrl+/ shortcut.

## Command Bar

A global command bar (`Cmd+K` / `Ctrl+K`) provides quick navigation to any destination in the app. The user types a search query and sees matching results organized by category.

### Shortcuts

- **Cmd+K / Ctrl+K**: Open command bar scoped to current project
- **Cmd+Shift+K / Ctrl+Shift+K**: Open command bar searching all projects
- When on "All Projects", both shortcuts force all-projects mode

### Component

`src/lib/components/CommandBar.svelte` uses `Command.Dialog` from the existing `bits-ui` command component (`src/lib/components/ui/command/`). Props: `bind:open`, `projectId`, `allProjects`.

Result groups:

- **Navigation**: Static tab items (Sessions, Active Work, Pull Requests, Plans) filtered client-side. Shown when query is empty or matches.
- **Plans**: Server-side search results via `searchCommandBar` remote query. Shows plan ID, title, status badge. In all-projects mode, shows project name. Only shown when query is non-empty.
- **Pull Requests**: Server-side search results. Shows PR number, title, repo. In all-projects mode, shows project name. Only shown when query is non-empty.
- **Sessions**: Client-side filtered from `SessionManager` (active sessions only). Shows plan title and command. Only shown when query is non-empty.

### Hybrid Filtering

Navigation items use the built-in Command component client-side filtering (instant). Plans and PRs use a debounced (~200ms) server-side search via `src/lib/remote/command_bar_search.remote.ts`. Sessions are filtered client-side from the in-memory session store. The Command component's `shouldFilter` is set to `false` to allow server-controlled results for plans/PRs; navigation items are filtered manually in `src/lib/components/command_bar_utils.ts`.

### Server Search

`src/lib/remote/command_bar_search.remote.ts` provides the `searchCommandBar` query. Accepts `query` string and optional `projectId`. DB query helpers in `src/lib/server/command_bar_queries.ts`:

- **`searchPlans(db, query, projectId?, limit?)`**: Searches by title (LIKE) and exact planId match. Terminal-status plans (done/cancelled/deferred) only returned on exact planId match. Results ordered with exact ID matches first.
- **`searchPrs(db, query, projectId?, limit?)`**: Searches by title (LIKE) and exact pr_number match. Joins through `plan_pr` and `project` tables to resolve `projectId`. Results limited to PRs with a resolvable project.

Both functions limit to 10 results per category by default.

### Item Selection

On selecting an item, the command bar calls `goto(targetUrl)` and closes. Plans and PRs always navigate to their owning project context (e.g., `/projects/5/plans/42`), regardless of the current project. Sessions navigate to `/projects/{projectId}/sessions?session={connectionId}`.

## Accessibility (ARIA)

Components use ARIA attributes to support screen readers and assistive technology:

- **`PrStatusIndicator`**: The colored dot has `role="img"` and `aria-label` set to the status description (e.g. "PR checks passing") so screen readers announce status without relying on color alone.
- **`FilterChips`**: Toggle buttons use `aria-pressed` to communicate active/inactive filter state.
- **`SessionList` / `PlansList`**: Group collapse buttons have `aria-expanded` and descriptive `aria-label` (e.g. "Toggle Running group"). Decorative triangle indicators use `aria-hidden="true"`. The plans search input has `aria-label="Search plans"`.
- **`TabNav`**: The `<nav>` element has `aria-label="Main navigation"`. Active tab links use `aria-current="page"`.
- **`ProjectSidebar`**: The `<nav>` element has `aria-label="Project navigation"`. Selected project links use `aria-current="page"`. Sidebar toggle buttons have `aria-label` descriptions.
- **`SessionDetail`**: The header status dot has `role="img"` and `aria-label` set to the status text.
- **`MessageInput`**: The textarea has `aria-label="Send input to session"`.
- **`PrStatusSection`**: The icon-only refresh button has a dynamic `aria-label` that reflects the current state ("Refreshing PR status..." while loading, "Refresh PR status" otherwise).
- **Skip-to-content link**: The root layout (`+layout.svelte`) includes a visually-hidden skip link as the first child, targeting `id="main-content"` on the content wrapper in the project layout (`projects/[projectId]/+layout.svelte`). Uses `sr-only focus:not-sr-only` Tailwind classes so it appears only on focus. The target element has `tabindex="-1"` for programmatic focusability.
- **End-session confirmation** (`SessionDetail`): The inline confirmation bar has `role="alertdialog"` and `aria-label="Confirm end session"`. When opened, focus moves to the confirm button via `$effect` + `tick()`. Pressing Escape cancels the confirmation. On cancel, focus returns to the original "End Session" trigger button.

### Guidelines for new components

- Icon-only buttons must have `aria-label`.
- Color-only indicators need `role="img"` and `aria-label` (or a `sr-only` text span).
- Toggle buttons should use `aria-pressed`.
- Collapse/expand controls should use `aria-expanded`.
- Navigation landmarks (`<nav>`) should have `aria-label` to distinguish them. Active links use `aria-current="page"`.
- Inline confirmation dialogs should use `role="alertdialog"`, move focus to the confirm button on open (via `$effect` + `tick()`), handle Escape to cancel, and return focus to the trigger element on dismissal.

## Plan Actions

The plan detail view supports triggering CLI commands directly from the web UI. Four actions are available:

### Open Terminal Button (`PlanDetail.svelte`)

An "Open Terminal" button (AppWindow icon) appears next to each workspace path in the "Assigned Workspace" section. Clicking it opens a new terminal window in that workspace directory via the `openTerminal` remote command. All workspace terminal buttons are disabled while any launch is in progress. Error feedback is shown via toast notifications.

- **Generate**: For stub plans (no tasks) — spawns `tim generate` to flesh out the plan
- **Run Agent**: For plans with incomplete tasks — spawns `tim agent` to execute the plan
- **Chat**: For any plan regardless of status — spawns `tim chat` with an executor selection dialog
- **Rebase**: For plans with a branch — spawns `tim rebase` to update the branch onto the latest trunk

### Eligibility

- **Generate** (`isPlanEligibleForGenerate`): Plan has no tasks and `displayStatus` is not `done`, `needs_review`, `reviewed`, `cancelled`, or `recently_done`.
- **Agent** (`isPlanEligibleForAgent`): Plan is not `done`, `needs_review`, `reviewed`, or `cancelled`. If the plan has tasks, at least one must be incomplete (not all done). Plans without tasks are also eligible (simple/stub plans).
- **Chat** (`isPlanEligibleForChat`): Any existing plan is eligible, including plans in terminal statuses (done, cancelled, deferred).
- **Rebase** (`isPlanEligibleForRebase`): Plan status must be `in_progress`, `needs_review`, `reviewed`, or `done` (states where a branch is expected to exist).

### Executor Selection Dialog

When launching a Chat session, a dialog opens to choose the executor:

- **Claude** (claude_code executor) — blue themed button
- **Codex** (codex_cli executor) — green themed button

The dialog stays open with per-button spinners during launch. Dismissal is prevented while a launch is in flight.

### Button States

- **Hidden**: Plan is ineligible for any action
- **Generate / Run Agent / Chat**: Eligible, no active session → clickable
- **Running...**: Active session exists for this plan (any command) → links to the session. Chat sessions use violet theming, generate uses blue, agent uses green.
- **Starting**: Remote command call in flight → disabled with spinner
- **Error**: Spawn failed → error message shown briefly

### Button Layout by Plan State

- **No tasks (stub plan, non-terminal)**: Generate is primary button; dropdown contains "Run Agent" and "Chat"
- **No tasks, `plan.simple === true` (non-terminal)**: Run Agent is primary (emerald); Generate is omitted entirely — not as primary, not in the dropdown. Simple plans skip the generation step.
- **Incomplete tasks (non-terminal)**: Run Agent is primary button; dropdown contains "Chat"
- **All tasks complete OR terminal status**: Standalone "Chat" button (violet themed)

**Duplicate prevention**: Both actions share command-agnostic duplicate detection — only one plan-scoped session (generate, agent, chat, review, or any other command publishing a `planUuid` in session info) can be active per plan at a time. All identity checks use the plan UUID (not numeric planId) for cross-project safety. Three layers of protection:

1. **Client-side session check**: Session store filters for any active session with a matching `planUuid` for immediate UI feedback.
2. **Server-side session check**: `SessionManager.hasActiveSessionForPlan(planUuid)` (no command filter) rejects launches when a session is already active.
3. **Launch lock** (`src/lib/server/launch_lock.ts`): After a successful spawn, a per-target lock prevents duplicate launches in the gap before the spawned process connects via WebSocket and registers as a session. Locks are keyed by an opaque target string — `plan:<planUuid>` for plan-scoped launches and `pr:<canonicalPrUrl>` for no-plan PR fix launches (see `planTargetKey()` / `prTargetKey()`). The lock is cleared when `session:update` fires with the matching plan UUID or `linkedPrUrl`, or after a 30-second timeout fallback. Lock state is stored on `globalThis` via `Symbol.for()` for HMR safety. On the client side, `startedSuccessfully` state keeps the action button disabled until an active session appears (also with a 30-second fallback timeout).

### Server-Side Infrastructure

- **Remote commands** (`src/lib/remote/plan_actions.remote.ts`): `startGenerate`, `startAgent`, `startChat`, and `startRebase` are thin wrappers around `launchTimCommand()`, a shared helper that validates plan eligibility, checks for duplicate sessions (command-agnostic via UUID), resolves the primary workspace path, and calls the spawn handler. All follow the same `command()` pattern as `session_actions.remote.ts`. `startChat` accepts an `executor` field (`'claude' | 'codex'`) which is passed through to the spawn function.
- **Spawn handler** (`src/lib/server/plan_actions.ts`): `spawnTimProcess()` (internal) uses `Bun.spawn` with `{ detached: true }` to create a process that survives web server restarts (including HMR). It writes stdout/stderr to a log file, waits ~2000ms to detect early failures, then calls `.unref()`. The executable defaults to `tim`; set `TIM_PATH` in the web server environment to run a specific `tim` binary instead. Public wrappers `spawnGenerateProcess()`, `spawnAgentProcess()`, `spawnChatProcess()`, and `spawnRebaseProcess()` pass the appropriate CLI args. `spawnChatProcess` takes an additional `executor` parameter and uses `--plan <id>` (named option) rather than a positional argument. The spawned process starts an embedded WebSocket server and writes a session info file; the discovery client detects and connects to it, making it appear as a new session.
- **Session lookup** (`SessionManager.hasActiveSessionForPlan(planUuid, command?)`): Checks whether an active session exists for a given plan UUID. The `command` parameter is optional — when omitted, matches any active session regardless of command type. Used without a command filter for duplicate prevention across all plan-scoped commands.
- **Launch lock** (`src/lib/server/launch_lock.ts`): In-memory per-target lock (stored on `globalThis` for HMR safety) bridging the gap between process spawn and WebSocket session registration. The generic primitives (`setLaunchLockForTarget()` / `clearLaunchLockForTarget()` / `isTargetLaunching()`) take an opaque target key; thin wrappers (`setLaunchLock`/`isPlanLaunching` for plans, `setPrLaunchLock`/`isPrLaunching` for PRs) build the `plan:<planUuid>` and `pr:<canonicalPrUrl>` keys. Exported as a separate module because SvelteKit remote function files can only export `command()` results. Subscribes to `SessionManager.subscribe('session:update')` to clear locks when sessions register (by plan UUID and by `linkedPrUrl`).
- **PR session lookup** (`SessionManager.hasActiveSessionForPr(canonicalPrUrl, command?)`): Mirrors `hasActiveSessionForPlan` for no-plan PR fix launches. Sessions are indexed by `sessionInfo.linkedPrUrl` (`sessionsByPrUrl`), letting the PR detail page detect active/starting/running fix sessions without a linked plan.
- **PR-scoped launch remote** (`src/lib/remote/review_thread_actions.remote.ts`): Launches no-plan `tim pr fix --pr` from the PR detail page. Verifies the PR belongs to the project, confirms unresolved review threads exist, checks active sessions and launch locks by canonical PR URL, resolves the primary workspace, and spawns `tim pr fix --pr <pr-url-or-number> --auto-workspace --no-terminal-input`. Plan-detail PR status fix flows stay plan-scoped.
- **Primary workspace query** (`getPrimaryWorkspacePath()` in `db_queries.ts`): Resolves the primary workspace path for a project, used as the cwd for spawned processes.

## Plan Metadata Writes (Create / Edit)

The sync-aware backend for web plan creation and metadata editing. This is the server foundation that create/edit UI plans call — no Svelte routes or forms live here, only the service and remote-function layer. Writes never touch SQLite directly; they flow through the sync write router (`src/tim/sync/write_router.ts`), operation folding, and the DB-first/materialization semantics in `docs/sync-operations-guide.md`. The backend reuses the _semantics_ of `tim add` and `tim set` but does not call the CLI handlers, which depend on CLI process context, terminal/editor behavior, and cwd-based project resolution.

Writable metadata fields are `title`, `goal`, `details`, `priority`, `status`, `simple`, `tags`, `parent`, `basePlan`, and `dependencies`. Referenced plans are always identified by **UUID** in payloads — numeric plan IDs are display/search affordances only and are not globally unique.

### Server Service (`src/lib/server/plan_metadata.ts`)

- **`createPlanFromWeb(db, input)`**: Rejects non-concrete project IDs (`all` or non-positive), loads the project row and its preferred git root, loads repo-effective config from that git root, normalizes all fields, validates references, allocates the next numeric plan ID (`reserveNextPlanId`/`previewNextPlanId` depending on write mode), builds a single `plan.create` operation in an atomic sync batch, rematerializes affected parent files, and returns `{ planUuid, projectId, planId }`.
- **`updatePlanMetadataFromWeb(db, input)`**: Loads the target plan by UUID, validates route project ownership (route `all` is allowed for existing-plan edits, but the plan's _actual_ project controls validation/config/writes), normalizes submitted fields, computes diffs against current DB state, and adds only changed text/scalar/parent/dependency/tag operations to one atomic sync batch. Returns `{ planUuid }`.
- **Tag validation** loads the effective config from the **target project's preferred git root** (`getPreferredProjectGitRoot`), not `getServerContext().config`, then calls `validateTags()`.
- **Reference validation** (`resolvePlanMetadataReferences`) enforces same-project references, missing-reference errors, self-reference rejection; parent/dependency cycle rejection and graph consistency are enforced downstream by `operation_fold.ts`.
- **Status normalization** (`normalizePlanStatus`): Only persisted raw statuses are accepted (`pending`, `in_progress`, `needs_review`, `reviewed`, `done`, `cancelled`, `deferred`). Display-only statuses (`ready`, `blocked`, `recently_done`, exported as `displayOnlyPlanStatuses`) are rejected at this boundary.
- **Status side effects** (`applyWebStatusUpdateSideEffects`): Mirrors `tim set --status`. For terminal/review statuses (`done`, `needs_review`, `reviewed`, `cancelled`) it runs assignment cleanup (`removeAssignment`) and the parent-completion cascade (`checkAndMarkParentDone`). Plans touched by the cascade are added to the rematerialization set.
- **Materialized-file consistency**: Primary materialized files under `.tim/plans` are kept in sync. Before writing, existing primary files for the edited plan and its ancestors are synced (`syncMaterializedPlan` with `skipRematerialize`); after the batch commits, only files that already existed are rematerialized (`rematerializeExistingPrimaryPlans`) — web writes don't create materialized files that weren't already present.

### Plan Picker Search (`src/lib/server/plan_picker_queries.ts`)

`searchPlanPickerOptions(db, input)` is a narrow, purpose-built query for relationship pickers (parent / dependency / base-plan autocomplete) — it deliberately does **not** reuse `getPlansForProject()` or `EnrichedPlan`, which are too heavy per keystroke. It:

- Scopes to one concrete `projectId` and searches by title (`LIKE`, escaped) and exact numeric `plan_id`, ordered with exact-ID matches first.
- Excludes the current plan in edit flows (`currentPlanUuid`).
- Applies relation-specific eligibility: `basePlan` accepts any other plan; `dependency` excludes plans that already (transitively) depend on the current plan; `parent` excludes ancestors of the current plan and plans the current plan depends on (cycle prevention).
- Returns only the projection `{ uuid, projectId, planId, title, status, priority, parentUuid, basePlanUuid }`.
- Bounds work with paging caps (`MAX_FILTERED_CANDIDATE_PAGE_SIZE`, `MAX_FILTERED_CANDIDATE_SCAN`) — filtered search past the cap is best-effort and may omit later matches.

**Picker gotchas (learned the hard way):**

- **Don't apply the SQL `LIMIT` before graph-eligibility filtering.** When a relation type filters candidates by graph eligibility (parent/dependency cycle checks), applying the result `limit` at the SQL level first can truncate the candidate set before any ineligible rows are dropped — valid options then silently disappear from autocomplete. Filtered searches must either push eligibility into SQL or scan in bounded pages (`MAX_FILTERED_CANDIDATE_PAGE_SIZE`/`MAX_FILTERED_CANDIDATE_SCAN`) and apply the limit only after eligibility, never before.
- **Base-plan eligibility is intentionally lighter than parent/dependency.** A `basePlan` reference is a soft pointer and has no cycle constraints, so it accepts any other plan. Do **not** load the full relationship/ancestry graph for base-plan searches — that graph load is pure cost the base-plan path doesn't need. Only the parent/dependency relation types pay for graph traversal.

### Remote Functions

- **`src/lib/remote/plan_metadata.remote.ts`**: `createPlan` and `updatePlanMetadata` commands. Both call the service and pass any thrown error through `throwStructuredPlanMetadataError`.
- **`src/lib/remote/plan_picker.remote.ts`**: `searchPlanPicker` query wrapping `searchPlanPickerOptions`.

### Structured Remote Errors (`src/lib/server/plan_metadata_errors.ts`)

Errors are surfaced as structured `error(status, body)` bodies so the UI can render predictable field- and form-level messages. The `PlanMetadataValidationError` class carries a `kind`, `message`, and optional `field`. `toPlanMetadataRemoteError()` maps both `PlanMetadataValidationError` and sync-layer errors (`SyncWriteConflictError`, `SyncConflictError`, `SyncValidationError`, `SyncWriteRejectedError`, `ApplyOperationToPreconditionError`) into the same shape. Error kinds and their HTTP statuses:

| Kind                 | Status | Meaning                             |
| -------------------- | ------ | ----------------------------------- |
| `validation_failed`  | 400    | Field/normalization failure         |
| `invalid_reference`  | 400    | Unknown referenced plan UUID        |
| `project_mismatch`   | 400    | Reference or route project mismatch |
| `not_found`          | 404    | Project or plan not found           |
| `cycle_detected`     | 409    | Parent/dependency cycle             |
| `sync_conflict`      | 409    | Stale revision / text-merge failure |
| `persistence_failed` | 500    | Other sync write failure            |

`App.Error` in `src/app.d.ts` is augmented with these `kind` values plus the optional `field`, so the client can read `err.body.field` to attach messages to form inputs.

## Create Plan Route

The web UI for creating a plan. It is the client slice that consumes the "Plan Metadata Writes" backend above — the shared metadata form, relationship pickers, route, and sidebar entry point. The same form is reused in edit mode by the "Edit Plan Route" below (via the `mode` prop).

### Route Structure

```
src/routes/projects/[projectId]/plans/new/
├── +page.server.ts   # parent()-based load; redirects when project is not concrete
└── +page.svelte      # Mounts PlanMetadataForm and calls the createPlan remote command
```

The server load calls `await parent()` and **redirects to `/projects/all/plans`** when `projectId === 'all'` or the id isn't finite — plan creation requires a concrete project/repository context (the backend rejects all-project creation as defense in depth). For concrete projects it returns `{ numericProjectId }`. Route code stays thin: `+page.svelte` owns only `submitting` / `errorMessage` state and the submit handler, while the form owns all field state.

On submit, `+page.svelte` normalizes the form value into the `createPlan` payload (referenced plans by UUID; empty optionals dropped), then on success calls `invalidateAll()` and `goto('/projects/{projectId}/plans/{result.planUuid}')`. On failure it keeps the form mounted, preserves input, and renders the structured remote error via a local `extractErrorMessage` helper (`err.body.message` → string body → `err.message` → `String(err)`).

### Shared Metadata Form (`src/lib/components/PlanMetadataForm.svelte`)

A mode-aware (`'create' | 'edit'`) form that owns local state for `title`, `goal`, `details`, `priority`, `status`, `simple`, a comma-separated `tags` input, and parent / base-plan / dependency selections. Props: `projectId`, `mode`, `initialValue`, `submitLabel`, `submitting`, `error`, `currentPlanUuid`, `cancelHref`, and an `onsubmit(value)` callback.

- **Defaults**: empty title/optionals, `status: 'pending'`, `priority: 'medium'`, `simple: false`, no relationships.
- **Initial-value capture is once**: each field initializer is wrapped in `untrack(() => initialValue.x ?? default)` so a prop refresh mid-edit doesn't reset the form (see the `state_referenced_locally` note above).
- **Status options are persisted raw statuses only** (`pending`, `in_progress`, `needs_review`, `reviewed`, `done`, `cancelled`, `deferred`) — display-only statuses are never offered, matching the backend's `normalizePlanStatus` boundary.
- **Client validation is minimal**: submit is gated only on a non-empty trimmed title (`canSubmit`); server/domain validation remains authoritative.
- **Cancel link** resolves to the plan detail page in edit mode (when `currentPlanUuid` is set) or the plans list otherwise, overridable via `cancelHref`.

Payload normalization lives in `src/lib/components/plan_metadata_form_utils.ts` (`normalizePlanMetadataFormPayload`, `parsePlanMetadataTags`) as pure functions so it's unit-testable without the Svelte runtime. Tags are split on commas, trimmed, lowercased, and emptied entries dropped; relationship selections are reduced to their UUIDs.

### Relationship Pickers

Two presentational autocomplete components wrap the `searchPlanPicker` remote query (200ms debounce; searches only while focused with a non-empty query):

- **`PlanPicker.svelte`** — single-select, clearable. Used for parent and base plan. Binds `selected: PlanPickerOption | null`.
- **`PlanPickerMulti.svelte`** — multi-select, removable chips. Used for dependencies. Binds `selected: PlanPickerOption[]` and filters already-selected UUIDs out of the dropdown.

Both take `relation` (`'parent' | 'basePlan' | 'dependency'`) and an optional `currentPlanUuid` (passed through to the query for edit-flow exclusion / cycle filtering), display `#{planId}: {title}` with the status, store **UUID** selections, and render distinct loading (`Searching...`), error, and empty (`No matching plans`) states in the dropdown.

### Sidebar Entry Point

`PlansList.svelte` takes a `newPlanHref?: string | null` prop and renders a **New Plan** action beside the existing **Import Issue** action when present. `plans/+layout.svelte` derives `newPlanHref` as `/projects/{projectId}/plans/new` only for concrete projects (`null` for `all`), so creation is hidden in `/projects/all/plans`.

### Tests

Component/browser tests cover form defaults, required-title gating, payload normalization, relationship selection, picker loading/empty/selected states, submitting/error states, concrete-project sidebar visibility vs. all-project hiding, remote submission, and success navigation — see `PlanMetadataForm.test.ts`, `plan_metadata_form_utils.test.ts`, `PlanPicker.svelte.e2e.test.ts`, `PlanPickerMulti.svelte.e2e.test.ts`, `PlansList.test.ts`, and `plans/new/page.{server,svelte.e2e,}.test.ts`.

## Edit Plan Route

The web UI for editing an existing plan's metadata. It reuses the shared `PlanMetadataForm` (in `mode="edit"`) and the `updatePlanMetadata` remote command from the "Plan Metadata Writes" backend above. The route lives under the existing plans route tree so the split-view layout (left `PlansList`, right detail pane) stays intact — editing just swaps the right pane from read detail to the form.

### Route Structure

```
src/routes/projects/[projectId]/plans/[planId]/edit/
├── +page.server.ts   # Loads the plan via the shared detail path, projects it into the form's initial value
└── +page.svelte      # Mounts PlanMetadataForm in edit mode and calls the updatePlanMetadata remote command
```

The server load resolves the target plan with the same UUID-aware path as the plan detail route (`getPlanDetailRouteData(db, planId, projectId, 'plans')`), 404s when the plan is missing, and honors the loader's `redirectTo` (appending `/edit`) so canonicalizing redirects still land on the edit subroute. It maps the loaded plan into a `PlanMetadataFormInitialValue` — `title`, `goal`, `details`, `priority`, `status`, `simple`, `tags`, and `parent`/`basePlan`/`dependencies` projected to `PlanPickerOption`s — and returns the plan UUID, `planId`, `title`, the route project id, the plan's **actual** owning project id, and a `cancelHref` pointing back to `/projects/{routeProjectId}/plans/{planUuid}`.

### All-Project Scoping

The edit route renders under `/projects/all/plans/[planId]/edit` because the plan already identifies its owning project. The form's `projectId` and the `updatePlanMetadata` payload's `projectId` are both set to the plan's **actual** project id (`actualProjectId` from the load), not the synthetic `all` route id — so picker queries and the write scope to the real project. Cancel/back navigation keeps the current route's project id (`all` stays `all`) for coherent in-context browsing.

### Submit & Navigation

`+page.svelte` owns only `submitting` / `errorMessage` state. On submit it calls `updatePlanMetadata` with the plan UUID and the normalized field values (referenced plans by UUID; empty optionals sent as `null`), then on success calls `invalidateAll()` and `goto(cancelHref)` to return to the plan detail page. On failure it keeps the form mounted with the user's current values and renders the structured remote error via `extractPlanMetadataErrorMessage`. The form is wrapped in `{#key data.planUuid}` so navigating between plans remounts it with fresh initial values.

### Detail-Page Edit Affordance

`PlanDetail.svelte` exposes the edit entry point as an **Edit** button (pencil icon) in the header action area linking to `/projects/{projectId}/plans/{plan.uuid}/edit`, using the current route project id so all-project browsing stays coherent. The detail component only navigates — it holds no inline editing state.

### Tests

Component/browser and loader tests cover initial value population from the loaded plan, submitting changed metadata through the `updatePlanMetadata` remote path, navigation/invalidation after success, validation error rendering without losing input, the detail-page edit affordance, and all-project mode scoping to the edited plan's actual project — see `plans/[planId]/edit/page.{server,svelte.e2e}.test.ts`.

## Issue Import

The web interface provides a two-step wizard for importing issues from configured issue trackers (GitHub or Linear) into tim plans. This mirrors the CLI `tim import` command but with a visual content selection UI.

### Route Structure

```
src/routes/projects/[projectId]/import/
├── +page.server.ts       # Loads tracker config, validates project, checks capabilities
└── +page.svelte          # Two-step wizard: identifier input → content selection
```

The import route is only accessible for specific projects (not the `all` pseudo-project). The server load function reads the effective config from the project's `last_git_root` to determine tracker availability and capabilities.

### Entry Point

An "Import Issue" link button appears in the plans layout sidebar (`+layout.svelte`) when `issueTrackerAvailable` is true and the project is not `all`. The `issueTrackerAvailable` flag is computed in `plans/+layout.server.ts` using `getIssueTrackerStatus()` from `src/lib/server/issue_import.ts`.

### Wizard Flow

**Step 1 — Issue Identifier:**

- Text input for issue ID, URL, or branch name
- Radio group for import mode: "Single issue", "With subissues (separate plans)", "With subissues (merged into one plan)"
- Subissue modes are hidden when the tracker doesn't support hierarchical fetching (e.g. GitHub)
- "Simple plan (skip generation)" checkbox: when checked, every plan created by the import (parent and any subissue children, regardless of mode) is persisted with `simple: true`. Re-importing into an existing plan with the box checked sets `simple: true` on that plan; leaving it unchecked never clears an existing `simple: true` (opt-in only). State persists across Step 1 ↔ Step 2 navigation.
- "Fetch Issue" button calls the `fetchIssueForImport` query with loading spinner and error display

**Step 2 — Content Selection:**

- Displays fetched issue title and metadata
- For single mode: checkboxes for issue body (checked by default when non-empty) + each comment (unchecked by default)
- For separate/merged mode: combined tree view with parent content, then each subissue as a top-level checkbox (checked by default) with nested body + comment checkboxes. Unchecking a subissue hides its content
- Optional base plan selector: lists eligible plans ordered by `updatedAt` descending. Eligible plans are any plan whose status is not `done`, plus `done` plans updated within the past week. The selected plan is stored as `basePlan`, not as a resolved `baseBranch`.
- "Import" button calls the `importIssue` command
- On success: redirects to `/projects/[projectId]/plans/[newPlanUuid]`

### Design Principle: Delegate Parsing to the Tracker

Don't enumerate tracker-specific identifier formats (e.g., `owner/repo#123`, `TEAM-123`) in the web layer — let the tracker's own parser handle them. Adding special-case validation creates a maintenance burden and risks the web being narrower than what the tracker actually accepts.

### Duplicate Detection

The web import reuses the CLI's duplicate-detection behavior. When importing an issue whose URL already exists as a plan, the existing plan is updated instead of creating a duplicate. This uses `getImportedIssueUrlsFromPlans()` from `src/tim/commands/import/import_helpers.ts`.

### Remote Functions

`src/lib/remote/issue_import.remote.ts` provides:

- **`checkIssueTrackerStatus`** (`query`): Returns tracker availability, type, display name, and hierarchical support for a project
- **`fetchIssueForImport`** (`query`): Takes identifier string, mode, and projectId. Fetches issue data from the configured tracker API. Returns `IssueWithComments` data for the selection UI
- **`importIssue`** (`command`): Takes already-fetched issue data, selected content indices, import mode, an optional `simple` flag, and an optional `basePlan` id. Creates plans transactionally and returns the parent plan UUID for redirect. When `simple: true`, the flag is propagated to all newly-created stubs and applied as an opt-in update to existing plans matched by issue URL.

### Server-Side Logic

`src/lib/server/issue_import.ts` contains:

- **`getIssueTrackerStatus(gitRoot)`**: Checks tracker configuration and capabilities
- **`fetchIssueForImport(identifier, mode, gitRoot)`**: Parses identifier, creates tracker client via factory, fetches issue (with or without children)
- **`createPlansFromIssue(projectId, issueData, mode, selectedContent, options?)`**: Reserves plan IDs, builds plans via `createStubPlanFromIssue()`, writes to DB via `writeImportedPlansToDbTransactionally()`. Handles all three modes (single, separate, merged) with proper parent-child relationships and dependencies. Accepts `options.simple` which is forwarded to every `createStubPlanFromIssue()` call and, for existing-plan update branches in all three modes, sets `simple: true` on the existing plan when not already set (treated as a content change so the no-op early-return doesn't skip the write). The flag is opt-in only — never set back to `false`. Accepts `options.basePlan` to store a soft base-plan reference on imported or updated plans after validating that the selected base plan is still eligible.

### Shared Import Helpers

Core import logic is extracted into `src/tim/commands/import/import_helpers.ts` for reuse by both CLI and web:

- `writeImportedPlansToDbTransactionally()` — Atomic DB write for imported plans
- `reserveImportedPlanStartId()` — Plan ID reservation
- `getImportedIssueUrlsFromPlans()` — Duplicate detection via issue URL lookup
- `applyCommandOptions()` — CLI option application
- `PendingImportedPlanWrite` type

## Review Issue Management

When the agent runs its final review in non-interactive mode (e.g. launched from the web UI with `--no-terminal-input`), any found issues are saved as `reviewIssues` on the plan and the plan status is set to `needs_review`. The agent exits automatically without prompting.

The `PlanDetail` component displays review issues with per-issue action buttons and a bulk action:

- **Fix Issues**: Starts `tim review-issues fix <planId> --auto-workspace` through the normal session manager, so the prompt-driven fixer appears in the Sessions view as an interactive `review-issues` session for the plan. The command asks which saved issues to act on and marks only completed selected issues resolved.
- **Dismiss** (X button): Removes a single review issue by index via `removeReviewIssue`
- **Convert to Task** (arrow button): Converts the issue into a plan task (using `createTaskFromIssue` from review.ts) and removes it from `reviewIssues`, setting plan status to `in_progress` via `convertReviewIssueToTask`
- **Clear All** (header button): Removes all review issues via `clearReviewIssues`, with a confirmation dialog

All mutations use `invalidateAll()` to refresh the page after completion.

- **Remote commands** (`src/lib/remote/review_issue_actions.remote.ts`): `removeReviewIssue`, `convertReviewIssueToTask`, and `clearReviewIssues` are `command()` exports. Each reads the plan by UUID, parses `reviewIssues` JSON, applies the mutation within `db.transaction().immediate()`, and writes back. `convertReviewIssueToTask` also appends a new task and sets `status = 'in_progress'`.

## Rate Limit Indicator

The header bar includes a rate limit indicator (`RateLimitIndicator.svelte`) that shows current Claude and Codex API usage at a glance.

### Data Flow

1. **Executor formatters** emit structured messages containing rate limit data:
   - Claude Code: `rate_limit_event` → `LlmStatusMessage` with `rateLimitInfo` field (utilization, rateLimitType, resetsAt, isUsingOverage, surpassedThreshold)
   - Codex CLI: `turn.completed` → `TokenUsageMessage` with `rateLimits` field (primary/secondary with used_percent, window_minutes, resets_in_seconds)
2. **`handleStructuredSideEffects()`** in `SessionManager` intercepts these messages:
   - `llm_status` with `source === 'claude'` and status starting with `'Rate limit'` → `extractClaudeRateLimit()`
   - `token_usage` with `rateLimits` present → `extractCodexRateLimit()`
3. **`RateLimitStore`** (`src/lib/server/rate_limit_store.ts`) holds entries in a `Map<string, RateLimitEntry>` keyed by `'provider:label'`. Auto-prunes expired entries (based on `resetsAtMs`).
4. **`rate-limit:updated` SSE event** pushed to browsers when data changes. Initial state included in SSE snapshot for new connections.
5. **Client store** (`session_state.svelte.ts`) holds `rateLimitState` as reactive `$state`, updated via `applySessionEvent()`.

### UI Behavior

- **Hidden** when no rate limit data has been received
- **Gauge icon** color based on worst-case `usedPercent` across all entries (ignoring `belowThreshold` entries):
  - Neutral (gray): usage ≤ 80% or no numeric data
  - Yellow: 80-90% used
  - Red: ≥ 90% used
- **Click popover** shows per-entry rows with: provider + window label, usage percentage (or "< 75%" for Claude when under threshold), reset countdown, and staleness indicator

### Claude-Specific Behavior

Claude reports rate limits in two modes: when over 75% utilization, an exact percentage is provided; when under 75%, no utilization number is given. The store handles this by setting `usedPercent: null` with `belowThreshold: true`, displayed as "< 75%" in the popover.

## Dark Mode

The web interface supports light, dark, and system-preference color modes using the `mode-watcher` package.

### How It Works

- `ModeWatcher` component in `src/routes/+layout.svelte` manages the `.dark` class on `<html>`, persists the user's preference to localStorage, and injects a `<head>` script to prevent FOUC (flash of unstyled content) on page load.
- CSS variables for dark mode are defined in `src/routes/layout.css` under the `.dark` class (lines 42-74). The Tailwind `@custom-variant dark (&:is(.dark *))` directive enables `dark:` utility classes.
- A cycling toggle button in the header (right of TabNav) switches between light → dark → system modes using Sun/Moon/Monitor icons from `@lucide/svelte`. Uses `setMode()` and `userPrefersMode` from `mode-watcher`.
- The `themeColors` prop on `ModeWatcher` dynamically updates the `<meta name="theme-color">` tag to match the current mode. A static fallback meta tag in `src/app.html` covers the pre-JS state.

### Color Strategy

A hybrid approach is used for dark mode colors:

- **Semantic tokens** (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`) where they map well to existing CSS variables
- **`dark:` variant classes** for colored states that don't have semantic equivalents (badges, selected states, hover effects) — e.g., `bg-blue-100 dark:bg-blue-900/30`
- **shadcn/ui components** (`src/lib/components/ui/`) already include `dark:` variants and need no changes
- **Session message area** (SessionMessage, PromptRenderer, MessageInput) is always rendered on a dark background (`bg-gray-900`) and doesn't use `dark:` variants

### When Modifying Components

- Use semantic tokens over hardcoded grays where possible
- For colored badges/pills, follow the existing `bg-{color}-100 text-{color}-800 dark:bg-{color}-900/30 dark:text-{color}-300` pattern
- Ensure sufficient contrast in dark mode — `text-gray-400` is the minimum for readable secondary text on `bg-gray-900` (avoid `text-gray-600` which has ~2.35:1 contrast ratio)

## PWA Support

The web interface is installable as a Progressive Web App, allowing it to run as a standalone desktop/mobile app without browser chrome.

### Key Files

- `static/manifest.webmanifest` — App metadata (name, icons, display mode, theme color). Uses relative URLs and `start_url: "."` for base-path compatibility.
- `src/service-worker.ts` — SvelteKit built-in service worker using `$service-worker` module (`build`, `files`, `version`)
- `src/app.html` — PWA meta tags (manifest link, theme-color, apple-mobile-web-app-capable, apple-touch-icon). Uses `%sveltekit.assets%` for base-path safety.
- `src/routes/+layout.svelte` — Service worker registration in `onMount`, badge effect reacting to `sessionManager.needsAttention`
- `src/lib/utils/pwa_badge.ts` — Feature-detecting wrappers for `navigator.setAppBadge()` / `navigator.clearAppBadge()`
- `static/icon-192.png`, `static/icon-512.png`, `static/favicon.png` — App icons

### Service Worker Caching Strategy

- **Static assets** (`build` + `files` arrays from `$service-worker`): Cache-first with versioned cache name (`cache-${version}`). These include hashed JS/CSS bundles and static directory contents.
- **API routes** (`/api/`): Network-only — never cached. SSE streams and REST endpoints must always hit the server.
- **Everything else** (navigation, external): Not intercepted — browser handles normally.

### Update Behavior

- Install event calls `self.skipWaiting()` for immediate activation of new versions
- Activate event deletes old versioned caches and calls `clients.claim()`
- Root layout listens for `controllerchange` and calls `location.reload()` to pick up new assets
- First-visit guard: `controllerchange` reload is skipped when `navigator.serviceWorker.controller` is null (first service worker install), avoiding an unnecessary reload

### App Badge (Attention Indicator)

When installed as a PWA, the app icon displays a badge dot whenever any session needs user attention. This uses the Badging API (`navigator.setAppBadge()` / `navigator.clearAppBadge()`).

- **Badge shown**: At least one session has `activePrompts.length > 0` (waiting for user input) or `status === 'notification'` (unhandled notification)
- **Badge cleared**: No sessions need attention
- `SessionManager.needsAttention` is a `$derived` property that reactively computes attention state across all sessions
- A `$effect` in the root layout calls the badge API whenever `needsAttention` changes
- Feature-detected and silently no-ops when the Badge API is unavailable (non-PWA context, unsupported browser)

### Key Behaviors

- **Workspace `plan_id` is project-scoped, not globally unique.** Any lookup from a workspace's `plan_id` (text plan number) to a plan UUID must include the project ID to avoid collisions across projects. The "All Projects" mode is the most visible case — workspace plan links use a `planNumberToUuid` map keyed by `${projectId}:${planId}`.
- "Recently Active" toggle defaults to filtered; toggle state is `$state` that persists across project switches (not wrapped in `{#key}`)
- Plan detail sub-route reuses `PlanDetail` component; `getPlanDetailRouteData()` accepts a `tab` parameter for cross-project redirect URLs
- Dependency/parent links in PlanDetail point to the Plans tab (not Active Work) since dependencies can be any status
