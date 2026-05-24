# tim

`tim` is an AI development assistant for turning issues into plans, running agents in isolated workspaces, tracking active sessions in a web UI, and preparing review/PR follow-up work.

## Requirements

`tim` depends on Bun features, including Bun's native SQLite client. It is not a plain Node.js application.

Install the expected local tools:

```bash
brew install oven-sh/bun/bun
bun --version
```

For global CLI installation from this repo, `bun run dev-install` currently uses `pnpm add -g file://...`, so make sure `pnpm` is also available.

Long-running `tim` workflows call an executor such as Claude Code or Codex CLI. Install and authenticate whichever executor your project config uses.

## Install the CLI

Clone this repository, install dependencies, then build and register the command:

```bash
git clone <this-repo-url> llmutils
cd llmutils
bun install
bun run dev-install
tim --help
```

During development you can also run the CLI without global installation:

```bash
bun run tim -- --help
bun run tim -- list
```

## Configure a Project

Run these commands inside the repository you want `tim` to manage, not necessarily inside the `llmutils` repository:

```bash
tim init
tim show-config
```

The default project config lives at:

```text
.tim/config/tim.yml
```

Local, per-developer overrides can live next to it:

```text
.tim/config/tim.local.yml
```

You can also place a global configuration in `~/.config/tim/config.yml`.

Common project settings:

```yaml
issueTracker: linear
branchPrefix: di/
requireBranchPrefix: true
githubUsername: your-github-username
```

Use environment variables for secrets. For Linear imports, set `LINEAR_API_KEY` in the shell or in the project workspace environment. For GitHub PR status and review thread operations, set `GITHUB_TOKEN` or have an authenticated `gh` GitHub CLI installed.

```bash
export LINEAR_API_KEY="lin_api_..."
export GITHUB_TOKEN="ghp_..."
```

If you use the webhook receiver for PR updates, configure these in the environment where the web app runs:

```bash
export TIM_WEBHOOK_SERVER_URL="http://localhost:8080"
export WEBHOOK_INTERNAL_API_TOKEN="..."
export TIM_WEBHOOK_POLL_INTERVAL="30"
```

## Workspaces

`tim` is designed to run AI work outside your main checkout. A project should have one primary workspace and any number of execution workspaces.

The primary workspace is a normal Git checkout that anchors the project in `tim`'s database. The web UI launches `generate`, `agent`, `chat`, `update-docs`, and `rebase` commands from the primary workspace, and new workspaces are created as siblings of it.

Register the primary workspace from the checkout you want to use as the anchor:

```bash
cd /path/to/your-project-primary
tim workspace register --primary
tim workspace list
```

Create or register execution workspaces as needed:

```bash
tim workspace add --auto
tim workspace add 123 --auto --create-branch
tim workspace register /path/to/existing-checkout --auto --name agent-a
```

Workspace types:

- `primary` - anchor checkout for the project; not selected for agent execution
- `auto` - preferred pool for `--auto-workspace` and web-launched agent runs
- `standard` - eligible for auto-selection only when no `auto` workspaces exist

When an agent runs, `tim` locks the selected workspace, materializes the plan into `.tim/plans/`, checks out or creates the plan branch, syncs edited plan data back into SQLite, and pushes actual code changes through the remote. Plan files are temporary working material; the SQLite database is the source of truth.

For the full multi-workspace model, see [`docs/multi-workspace-workflow.md`](docs/multi-workspace-workflow.md).

## Run the Web UI

The web app is the preferred way to drive `tim` day to day.

Start it from this repository:

```bash
cd /path/to/llmutils
bun run dev
```

Open the Vite URL printed by the command. The app groups data by project and provides these main tabs:

- **Active** - dashboard for plans needing attention, running sessions, and ready work
- **Sessions** - live transcripts for `generate`, `agent`, `chat`, `update-docs`, and review sessions
- **Plans** - searchable plan browser and plan detail pages
- **Settings** - per-project settings such as branch prefix, project color, and sidebar visibility

The web UI discovers running agent processes through session files in `~/.cache/tim/sessions/` and connects to each process over its embedded local WebSocket server. It also uses SSE to update the browser as sessions and PR status change.

For production-style local serving:

```bash
bun run web-prod
```

## Core Web UI Workflow

The main workflow is:

1. **Create or Import an issue**

   Open the project, go to **Plans**, and click **Import Issue**. Paste a Linear issue ID such as `TEAM-123`, a Linear URL, a GitHub issue URL, or another identifier supported by the configured tracker.

   You can also create an issue using `tim add` in the CLI.

2. **Select issue content**

   The import wizard fetches the issue and lets you choose the issue body, comments, and, for Linear, subissues. Import creates a stub plan with the issue context but no detailed implementation tasks yet.

3. **Generate the plan**

   On the plan detail page, click **Generate**. This starts an interactive planning session. The agent asks clarifying questions, researches context, and updates the plan. Answer prompts in the **Sessions** tab.

   For Linear-linked plans, generation can include native Linear Documents attached to the issue or its project. tim lists the available documents with all selected by default, downloads the selected markdown into the transient, git-excluded `.tim/issue-docs/<planId>/` cache, and references those files in the generate prompt. Non-interactive generation includes all discovered documents automatically. Only Linear Documents with markdown content are included; external-link attachments are not downloaded.

   Click **End Session** when the plan has the right structure and tasks.

4. **Run the agent**

   Click **Run Agent**. The agent executes tasks in a locked workspace, runs verification and review steps, marks completed tasks, and may add follow-up tasks if review finds issues. The live transcript appears in **Sessions**, and the plan pane updates as tasks change.

5. **Review the result**

   Completed implementation work usually lands in `needs_review`. Review the generated summary, review issues, linked PR status, and any unresolved PR review threads. Convert review issues or PR threads into plan tasks when more work is needed.

6. **Finish**

   Use **Finish** on a `needs_review` plan to run any configured documentation or lessons-learned finalization and then move the plan to `done`. Under the hood this launches `tim update-docs` when executor work is needed; if no executor work is needed, the web UI can mark it done immediately.

The **Active** tab is the fastest place to work once a project is set up. It surfaces plans waiting for input, completed agents that need review, actionable PRs, running sessions, and ready plans with inline **Run Agent** controls.

## PR and Review Workflows

`tim` can cache PR status, show CI/review state in the web UI, and help process review feedback.

Useful web actions:

- Link or view PR status from a plan detail page.
- Use **Full Refresh from GitHub API** when webhook data is missing or stale.
- Expand unresolved PR review threads and reply, resolve, or convert them to plan tasks.
- Use **Fix Unresolved** to spawn `tim pr fix` for review thread cleanup.
- Open stored PR review guides from project PR pages when standalone review has been run.
- **Generate review guide** from the plan detail page to run a plan-only review (no PR required); past review guides for the plan are listed with status badges and link to a viewer route.

Useful CLI commands:

```bash
tim pr status 123
tim pr link 123 https://github.com/owner/repo/pull/456
tim pr review-guide https://github.com/owner/repo/pull/456
tim review-guide generate 123                       # Plan-only review guide (no PR required)
tim review-guide generate 123 --auto-workspace
tim review-guide list-issues 123                    # Latest guide for plan, plus linked PR guides
tim review-guide list-issues feature/my-branch      # Resolve by plan or PR branch
tim review-guide resolve-issue 42 123
tim pr fix 123 --all --auto-workspace
tim rebase 123 --auto-workspace
```

`tim review-guide generate <planId>` generates a review guide for a plan that does not yet have an associated PR. It reuses the same pipeline as `tim pr review-guide` and stores results in the `review` table, keyed by the plan's UUID instead of a PR URL. With `--auto-workspace`, it routes through the managed workspace and reviews the latest committed state; without it, it runs in the current working tree and includes uncommitted changes in the diff.

`tim review-guide list-issues <planId|branch|prUrl>` finds the latest stored review guide for the resolved plan or PR and includes linked guides from the other object when a plan is linked to a PR or a PR is linked to a plan. By default it shows unresolved actionable issues; use `--all` to include resolved issues. `tim review-guide resolve-issue <issueId> [planId|branch|prUrl]` marks an issue resolved, and the optional target validates that the issue belongs to the latest review guide.

Review guides can include non-actionable `<annotation file="..." line="...">...</annotation>` callouts. These render as Notes in the guide viewer sidebar and inline diff overlay, but are not submitted to GitHub or converted into cleanup work.

See the PR status and web interface notes in [`docs/web-interface.md`](docs/web-interface.md) for implementation details and edge cases.

## Slack Review Notifications

tim can post debounced Slack channel messages for GitHub review requests. Named Slack workspaces, per-repo opt-in settings, and GitHub-to-Slack user mappings control which repos notify and how reviewers are rendered.

Slack workspace tokens are machine-local and must be configured in your global tim config, not committed repo config or `tim.local.yml`:

```yaml
slack:
  workspaces:
    work: { token: '${SLACK_WORK_TOKEN}' }
    personal: { token: '${SLACK_PERSONAL_TOKEN}' }
```

The token value supports `${ENV_VAR}` expansion at read time. The Slack app bot token needs `chat:write` access for the target channel, and the bot must be invited to that channel.

Per-repo opt-in is stored in the local database as a `project_setting` named `slack`, so most repos stay silent until explicitly enabled:

```bash
tim slack enable --workspace work --channel "#code-reviews"
tim slack test --workspace work --channel "#code-reviews"
tim slack map your-github-login U123456789 --workspace work --display "Your Name"
tim slack list
```

Command reference:

```bash
tim slack enable --workspace <name> --channel <#channel>
tim slack disable
tim slack test --workspace <name> --channel <#channel> [--message <text>]
tim slack mark-closed-notified [--dry-run]
tim slack map <github-login> <slack-user-id> --workspace <name> [--display <name>]
tim slack unmap <github-login> --workspace <name>
tim slack list [--workspace <name>]
```

Workspace names must exist in `slack.workspaces`. User mappings are keyed by `(workspace, github_login)` and shared across repos in that Slack workspace; mapped reviewers render as Slack mentions, while unmapped reviewers are named by GitHub login without a ping.
Use `tim slack mark-closed-notified` to suppress pending historical review-request notifications for cached closed or merged PRs.

The notifier runs in the SvelteKit web server when at least one Slack workspace is configured. It is kicked by GitHub webhook ingestion and also checks about every 15 seconds. Review requests on the same PR are batched with a fixed 30-second debounce, then marked notified in the DB after Slack confirms the post.

See [`docs/slack-integration.md`](docs/slack-integration.md) for setup details and current scope.

## CLI Plan Management

The web UI covers the normal workflow, but the CLI is useful for quick creation, edits, dependency management, and scripting.

Create plans:

```bash
tim add "Implement user profile settings" --priority high
tim add "Database migration" --parent 120 --depends-on 119
tim add "Stacked followup" --base-plan 123          # New branch stacks on plan 123's branch (stacked PR)
tim import TEAM-123
tim import https://linear.app/acme/issue/TEAM-123/example-title
```

Generate and execute:

```bash
tim generate 123
tim generate 123 --auto-workspace
tim agent 123 --auto-workspace
tim agent --next
tim agent --next-ready 120 --auto-workspace
```

Inspect and edit:

```bash
tim list
tim ready
tim show 123
tim edit 123
tim materialize 123
tim sync 123
```

Update metadata and tasks:

```bash
tim set 123 --status in_progress
tim set 123 --priority urgent
tim set 123 --parent 120
tim set 123 --depends-on 119 121
tim set 123 --base-plan 122                          # Stack this plan's branch on plan 122's branch
tim set 123 --no-base-plan                           # Clear stacking pointer
tim add-task 123 --title "Add tests" --description "Cover the new validation path"
tim set-task-done 123 --title "Add tests"
tim remove-task 123
```

Complete and finalize:

```bash
tim set 123 --status needs_review
tim update-docs 123 --auto-workspace
tim set 123 --status done
```

`needs_review` means implementation work is complete enough to unblock dependent plans, but the workspace assignment and lock remain until final completion. `done`, `cancelled`, and `deferred` are terminal lifecycle states.

## Plan Artifacts

Agents and humans can attach files (screenshots, logs, generated outputs) to a plan. Artifacts are tracked by UUID in the database, stored under `tim`'s durable user data directory (`$XDG_DATA_HOME/tim/artifacts/...`; defaults to `~/.local/share/tim/artifacts/` on Linux/macOS and `%APPDATA%/tim/artifacts/` on Windows), and survive cache cleaners. Each file is capped at 25 MB.

CLI commands:

```bash
tim artifact add 123 ./screenshot.png -m "before fix"
tim artifact list 123
tim artifact list 123 --include-deleted --json
tim artifact show <artifactUuid>
tim artifact delete <artifactUuid>
tim artifact restore <artifactUuid>
tim artifact purge --older-than 30 --dry-run
```

`tim artifact add` prints the new artifact UUID so agents can reference it in subsequent messages.

### JSON output

`tim artifact add --json`, `tim artifact list --json`, and `tim artifact show --json` use the same artifact shape:

```json
{
  "uuid": "artifact UUID",
  "planUuid": "owning plan UUID",
  "projectUuid": "owning project UUID",
  "filename": "original-name.png",
  "mimeType": "image/png",
  "size": 12345,
  "sha256": "hex digest",
  "message": "optional note or null",
  "storagePath": "/absolute/local/path",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "deletedAt": null,
  "revision": 1,
  "transferState": "synced | pending | in_progress | failed | file-missing | null",
  "fileExists": true
}
```

`transferState` is `null` when the command did not load transfer state; `fileExists` is `null` when the command did not check the filesystem.

Deletion has two tiers:

- **Soft-delete** (`tim artifact delete`) sets `deleted_at`, hides the row from default listings, but keeps the file on disk. Reversible via `tim artifact restore`.
- **Hard-delete** is performed by `tim artifact purge`, which removes files and rows for soft-deleted artifacts older than the retention threshold, artifacts on completed plans (`done`/`cancelled`/`deferred`) older than the threshold, and orphan files no longer linked to any row. The default retention is 30 days (configurable via `artifactRetentionDays`). A 60-second mtime cushion protects in-flight uploads from being purged. `--include-active` extends purge to active artifacts on non-terminal plans, and `--dry-run` reports counts without mutating.

`tim cleanup` runs an artifact purge alongside other cleanup steps, and agent shutdown triggers a best-effort opportunistic purge using the configured retention.

MCP tool `attach_plan_artifact` (input `{ planId, filePath, message? }`) exposes the add operation to agents running under the MCP server and returns `{ uuid, filename, mimeType, size }`.

Web UI: the plan detail page shows an **Artifacts** section beneath review issues with mime-type icons, inline thumbnails for images, filename, message, size, transfer state, and Delete/Restore actions. A drag-drop uploader and file picker post to `POST /api/artifacts`; downloads stream via `GET /api/artifacts/[artifactUuid]`. A toggle reveals soft-deleted artifacts.

Sync between nodes uses two channels: metadata flows through the standard sync operation engine (attach/soft-delete/restore/hard-delete operations are routed through `write_router`); binaries transfer via sidecar HTTP endpoints (`PUT`/`GET /internal/sync/artifacts/:uuid`) on the sync server. Per-node, per-artifact transfer state is tracked locally in `artifact_transfer` with bounded exponential-backoff retry (default max 5 attempts). Until bytes have transferred, list views surface a distinct `file-missing` state and the web download endpoint returns 409 with `file_missing` (and triggers a non-blocking download attempt) so missing binaries never look like a silent bug. Hard-deletes emit durable tombstones so a deleted artifact UUID cannot be resurrected by a stale attach.

## Configuration Reference Points

Start with:

```bash
tim init
tim show-config
```

Important config areas:

- `issueTracker` - `linear` or GitHub-backed import behavior
- `branchPrefix` - prefix for generated branches, such as `di/`
- `requireBranchPrefix` - fail branch-creating flows if no prefix is configured
- `githubUsername` - avoids an API call when classifying PRs
- `lifecycle.commands` - start/stop dev servers or services around agent runs
- `subprocessMonitor` - opt-in timeouts for stuck Claude/Codex tool subprocesses
- `updateDocs` and `applyLessons` - control finalization behavior
- `artifactRetentionDays` - days before soft-deleted artifacts and artifacts on completed plans are eligible for purge (default 30)

The `simplify` block controls the optional code-simplification pass that runs after an agent finishes implementation and before final review. `simplify.mode` accepts `after-completion` (default) or `never`; `simplify.model` and `simplify.executor` (`claude-code` or `codex-cli`) override the executor used for the pass; `simplify.include` and `simplify.exclude` add free-form scoping guidance. The standalone `tim simplify <planId>` command always runs regardless of `simplify.mode`.

```yaml
simplify:
  mode: after-completion
  executor: claude-code
  model: opus
  include:
    - Source and test files touched by the plan
  exclude:
    - Generated files
```

The web UI **Settings** tab stores per-project settings in SQLite. The project-level branch prefix there takes precedence over the config file value.

## Proof Generation

The optional `proofGeneration` block opts a project into a phase that captures demo evidence (screenshots, videos, written walkthroughs, …) of a completed plan and attaches it to the plan as artifacts. It is most useful for plans with user-facing changes; for purely backend plans the phase is omitted by not configuring it.

The `instructions` field is **prompt material, not a command**. The configured LLM executor reads the plan goal, task list, the changed-file list for the current branch, and your `instructions`, then drives whatever tooling makes sense (Playwright, curl, scripts, dev server, …) on its own to produce evidence files under `.tim/proofs`. The runner only sets up the directory, runs the executor, and attaches every file it finds underneath when the executor is done. The executor finishes by writing a `report.md` that summarizes what was demonstrated.

```yaml
proofGeneration:
  mode: after-completion # or 'never' to disable the automatic agent phase
  executor: claude-code
  model: opus
  instructions: |
    To demo this SvelteKit app:
    1. Start the dev server with `bun run dev` (it listens on localhost:5173).
    2. Use Playwright (already installed) to drive the browser. A helper lives at tests/proof_helpers.ts.
    3. For each user-facing feature added in the plan, capture at least one screenshot and one short video.
    4. Save screenshots as PNG and videos as WebM. Keep file sizes small.
    5. Do not modify source files outside the artifacts directory.
```

Three entry points trigger proof generation:

- **Agent batch mode** – when `proofGeneration.mode` is `after-completion`, the agent runs the proof phase after the final review (and lessons/docs updates) and before parent-cascade and the final commit. Failures here never block the rest of the post-completion pipeline.
- **CLI** – `tim proof <planId>` runs the phase manually. Pass `--auto-workspace` to use the plan's assigned workspace, `--executor <name>` and `--model <model>` to override the configured defaults.
- **Web UI** – the **Generate Proof** action on the plan detail page launches `tim proof` as a detached session that streams output through the normal session-discovery infrastructure. The button is shown only when the project has `proofGeneration.instructions` configured and the plan has at least one completed task or status in `needs_review`/`done`.

Reruns are idempotent: prior proof artifacts (marked with a `tim-proof:` prefix) are soft-deleted before the new run begins, and `.tim/proofs` is cleared so leftover files from a previous run are not re-attached. If the executor errors mid-run, whatever files it has already written are still attached and the failure is surfaced to the caller. Files exceeding the 100 MB artifact size cap are skipped with a warning. `.tim/proofs` is added to the tim-managed `.tim/.gitignore`.

See [`docs/proof-generation.md`](docs/proof-generation.md) for more detail.

## Subprocess Monitor

Agent sessions can get stuck when Claude Code or Codex starts a long-running tool command, such as `pnpm test`, and that command hangs. `subprocessMonitor` lets the main tim process watch descendants of the Claude/Codex executor and kill matching commands that exceed a configured timeout, returning control to the coding agent.

The monitor is opt-in. If `subprocessMonitor.rules` is empty or unset, no monitor runs.

```yaml
subprocessMonitor:
  pollIntervalSeconds: 5
  rules:
    - match: ['pnpm test', 'bun run test']
      timeoutSeconds: 600
      description: Test commands
    - match:
        - vitest run
        - regex: 'pnpm\s+.*test'
          flags: i
      timeoutSeconds: 300
      description: Vitest and pnpm tests
```

String matchers are case-sensitive checks against the full command line that require word boundaries on both sides of the matched string. Regex matchers use `{ regex: string, flags?: string }`; allowed flags are `i`, `s`, `m`, `u`, and `v`. Stateful flags `g` and `y` are rejected when the monitor rules are normalized before an executor starts, and empty string or regex matchers are rejected.

If a process matches multiple rules, the shortest `timeoutSeconds` wins. Rule arrays concatenate across global, repo, and local config files; `pollIntervalSeconds` is a scalar and follows the usual local override behavior.

When a timeout is exceeded, tim sends `SIGTERM`, waits 5 seconds, then sends `SIGKILL` if the process is still alive. Each kill logs a structured warning with the PID, rule label, elapsed time, timeout, and command line.

Target leaf commands, such as `vitest run` or `pnpm test`, rather than broad process names like `node` or `bash`. The root executor PID is excluded automatically, but descendant shells are not. The monitor only runs during agent sessions that spawn Claude Code or Codex executors.

## Known Issues and Workarounds

**Missing branch prefix**

Projects with `requireBranchPrefix: true` cannot create branches until a prefix is configured. Set one for the project in the web UI **Settings** tab or in `.tim/config/tim.local.yml`:

```yaml
branchPrefix: di/
```

Use a unique prefix per developer to prevent accidental PR-to-plan matching from branch names.

## More Documentation

- [`docs/import_command.md`](docs/import_command.md) - CLI and web issue import behavior
- [`docs/linear-integration.md`](docs/linear-integration.md) - Linear setup and supported issue formats
- [`docs/slack-integration.md`](docs/slack-integration.md) - Slack review notification setup and CLI reference
- [`docs/multi-workspace-workflow.md`](docs/multi-workspace-workflow.md) - workspace assignment, locking, and sync behavior
- [`docs/sync-between-nodes.md`](docs/sync-between-nodes.md) - setup guide for syncing plans between machines
- [`docs/web-interface.md`](docs/web-interface.md) - web architecture and UI workflow details
- [`docs/database.md`](docs/database.md) - SQLite-backed plan storage and materialization
- [`docs/proof-generation.md`](docs/proof-generation.md) - capturing demo artifacts for completed plans
