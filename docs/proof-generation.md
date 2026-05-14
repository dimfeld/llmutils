# Proof Generation

Proof generation is an optional phase that captures demo evidence of a completed plan — screenshots, short videos, written walkthroughs, anything else the project can produce — and attaches the captured files to the plan as artifacts that show up in the tim web UI. It is useful for plans with user-facing changes; for purely backend plans you simply leave it unconfigured and the phase is skipped silently.

## How it works

A single LLM executor session is the orchestrator. The runner does **not** drive Playwright, run shell commands, or otherwise script the demo itself. Instead it:

1. Reads the plan from the database (goal, details, task list with completion state).
2. Lists changed files on the current branch via the same helper that powers the summary phase.
3. Splices your project-specific `instructions` verbatim into a prompt that also includes the plan context and changed-file list.
4. Resolves and prepares the artifacts directory (defaults to `.tim/proofs` inside the workspace). If the directory already exists, its contents are cleared so stale files from a previous run are not re-attached.
5. Soft-deletes any prior proof artifacts on the plan (matched by a `tim-proof:` message marker) so reruns do not leave duplicates behind.
6. Runs the configured executor end-to-end. The executor has full Bash, Write, and Read access — it decides which features to demonstrate, drives whatever tooling makes sense, writes media files into the artifacts directory, and finishes by writing a `report.md` summarizing what it did.
7. Walks the artifacts directory and attaches every file as a plan artifact, marking each with a `tim-proof:{runId}` message. Files exceeding the 100 MB artifact size cap are skipped with a warning logged to stderr.

If the executor errors mid-session, whatever files it has already written are still attached on a best-effort basis and the failure is surfaced to the caller.

## Configuration

Add a `proofGeneration` block to `.tim/config/tim.yml` (or `.tim/config/tim.local.yml`):

```yaml
proofGeneration:
  mode: after-completion # or 'never' to disable the automatic agent phase
  executor: claude-code # optional override; falls back to defaultExecutor
  model: opus # optional model override
  artifactsDir: .tim/proofs # optional; defaults to .tim/proofs (workspace-relative)
  instructions: |
    To demo this SvelteKit app:
    1. Start the dev server with `bun run dev` (it will be on localhost:5173).
    2. Use Playwright (already installed) to drive the browser. A helper lives at tests/proof_helpers.ts.
    3. For each user-facing feature added in the plan, capture at least one screenshot and one short video.
    4. Save screenshots as PNG and videos as WebM. Keep file sizes small.
    5. Do not modify source files outside the artifacts directory.
```

Field notes:

- `mode` controls the automatic agent batch-mode trigger only. `after-completion` runs the phase after final review / lessons updates and before parent cascade. `never` (or omitting `mode`) disables the automatic trigger; the manual CLI and web UI entry points still work as long as `instructions` is present.
- `instructions` is **prompt material, not a command**. Write it as if you were briefing a new contributor on how proofs work in this repo: what to start, what tooling is available, what conventions to follow, what to demonstrate.
- `artifactsDir` must be a workspace-relative path **inside `.tim/`** (e.g. `.tim/proofs`, `.tim/screenshots`). Absolute paths, paths that escape the workspace via `..`, the workspace root itself, `.tim` alone, any path whose first segment is not `.tim`, and reserved tim-managed children (`.tim/config`, `.tim/plans`, `.tim/logs`, `.tim/tmp`, `.tim/reviews`, `.tim/workspaces`, `.tim/cache`, `.tim/sessions`, `.tim/artifacts`; case-insensitive) are rejected. The runner also refuses to traverse symlinked path components when clearing the directory. The restriction exists because the runner recursively clears the configured directory on every run; confining it to non-reserved `.tim/` children prevents typos or bad config from deleting source files, repository metadata, or tim's own state.
- The default `.tim/proofs` directory is added to the tim-managed `.tim/.gitignore`. If you point `artifactsDir` somewhere else, add that path to your own `.gitignore` so generated media never sneak into commits.

## Entry points

There are three ways to trigger the phase:

- **Agent batch mode.** When `proofGeneration.mode` is `after-completion`, `tim agent` runs the proof phase as a post-completion step. Failures never block parent cascade or the final commit; they are logged as warnings.
- **CLI.** `tim proof <planId>` runs the phase manually. Useful flags:
  - `--auto-workspace` — use the plan's assigned workspace (mirrors `tim chat` / `tim review`).
  - `--executor <name>` and `--model <model>` — override the configured executor/model.
  - `--no-terminal-input` — non-interactive mode used by detached web-UI launches.
- **Web UI.** Plans whose project has `proofGeneration.instructions` configured show a **Generate Proof** action on the plan detail page when the plan has at least one completed task or status in `needs_review`/`done`. Clicking it detaches a `tim proof` process whose output streams back through the normal session-discovery infrastructure.

If you run `tim proof` against a project that does not have `proofGeneration` configured, the command exits non-zero with a message pointing at this README. Agent batch mode treats the missing config as a clean skip rather than an error.

## Trust model and cost

The proof executor has the same tool access as other post-completion phases (`simplify`, `update-docs`). The provided prompt explicitly scopes it to "only generate proofs; do not modify source files outside the artifacts directory," but you should not configure proof generation for projects whose executor session you would not otherwise trust with Bash.

Proof generation can be more expensive than the implementation phase itself when Playwright iteration takes many tool calls. Setting `executor` / `model` to a cheaper combination is the usual escape hatch.

## Lifecycle services

Proof runs do not implicitly start dev servers, databases, or other long-running dependencies. Either rely on your `lifecycle.commands` to bring those up around agent sessions, or describe the necessary `bun run dev` / `docker compose up` invocations directly in your `instructions` so the executor can start them itself.
