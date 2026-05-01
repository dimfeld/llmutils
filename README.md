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

Useful CLI commands:

```bash
tim pr status 123
tim pr link 123 https://github.com/owner/repo/pull/456
tim pr review-guide https://github.com/owner/repo/pull/456
tim pr fix 123 --all --auto-workspace
tim rebase 123 --auto-workspace
```

See the PR status and web interface notes in [`docs/web-interface.md`](docs/web-interface.md) for implementation details and edge cases.

## CLI Plan Management

The web UI covers the normal workflow, but the CLI is useful for quick creation, edits, dependency management, and scripting.

Create plans:

```bash
tim add "Implement user profile settings" --priority high
tim add "Database migration" --parent 120 --depends-on 119
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

The web UI **Settings** tab stores per-project settings in SQLite. The project-level branch prefix there takes precedence over the config file value.

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

String matchers are case-sensitive `String.includes()` checks against the full command line. Regex matchers use `{ regex: string, flags?: string }`; allowed flags are `i`, `s`, `m`, `u`, and `v`. Stateful flags `g` and `y` are rejected when the monitor rules are normalized before an executor starts, and empty string or regex matchers are rejected.

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
- [`docs/multi-workspace-workflow.md`](docs/multi-workspace-workflow.md) - workspace assignment, locking, and sync behavior
- [`docs/web-interface.md`](docs/web-interface.md) - web architecture and UI workflow details
- [`docs/database.md`](docs/database.md) - SQLite-backed plan storage and materialization
