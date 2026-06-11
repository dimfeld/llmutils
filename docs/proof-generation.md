# Proof Generation

Proof generation is an optional phase that captures demo evidence of a completed plan — screenshots, short videos, written walkthroughs, anything else the project can produce — and attaches the captured files to the plan as artifacts that show up in the tim web UI. It is useful for plans with user-facing changes; for purely backend plans you simply leave it unconfigured and the phase is skipped silently.

## How it works

A single LLM executor session is the orchestrator. The runner does **not** drive Playwright, run shell commands, or otherwise script the demo itself. Instead it:

1. Reads the plan from the database (goal, details, task list with completion state).
2. Lists changed files on the current branch via the same helper that powers the summary phase.
3. Splices your project-specific `instructions` verbatim into a prompt that also includes the plan context and changed-file list. If the plan details include `Manual Testing Runbooks`, the executor is directed to use those runbooks as the primary demo checklist and produce proof for each runbook.
4. Prepares `.tim/proofs` inside the workspace. If the directory already exists, its contents are cleared so stale files from a previous run are not re-attached.
5. Soft-deletes any prior proof artifacts on the plan (matched by a `tim-proof:` message marker) so reruns do not leave duplicates behind.
6. Runs the configured executor end-to-end. The executor has full Bash, Write, and Read access — it decides which features to demonstrate, drives whatever tooling makes sense, writes media files into the artifacts directory, copies in any scripts used to generate seed data for the proof run, and finishes by writing a `report.md` summarizing what it did.
7. Walks the artifacts directory and attaches every file as a plan artifact, marking each with a `tim-proof:{runId}` message. Files exceeding the 100 MB artifact size cap are skipped with a warning logged to stderr.

If the executor errors mid-session, whatever files it has already written are still attached on a best-effort basis and the failure is surfaced to the caller.

## Configuration

Add a `proofGeneration` block to `.tim/config/tim.yml` (or `.tim/config/tim.local.yml`):

```yaml
proofGeneration:
  mode: after-completion # or 'never' to disable the automatic agent phase
  executor: claude-code # optional override; falls back to defaultExecutor
  model: opus # optional model override
  artifactsDir: .tim/proofs # optional; must be a strict descendant of .tim/
  instructions: |
    To demo this SvelteKit app:
    1. Start the dev server with `bun run dev` (it will be on localhost:5173).
    2. Use Playwright (already installed) to drive the browser. A helper lives at tests/proof_helpers.ts.
    3. For each user-facing feature added in the plan, capture at least one screenshot and one short video.
    4. Save screenshots as PNG and videos as WebM. Keep file sizes small.
    5. Copy any seed-data scripts used for the proof run into the artifacts directory.
    6. Do not modify source files outside the artifacts directory.
```

Field notes:

- `mode` controls the automatic agent batch-mode trigger only. `after-completion` runs the phase after final review and documentation updates, and before parent cascade. `never` (or omitting `mode`) disables the automatic trigger; the manual CLI and web UI entry points still work as long as `instructions` is present.
- `instructions` is **prompt material, not a command**. Write it as if you were briefing a new contributor on how proofs work in this repo: what to start, what tooling is available, what conventions to follow, what to demonstrate.
- Generated plans should include small `Manual Testing Runbooks` in their details. Proof generation will follow those runbooks first, including per-subplan runbook sections, then add any extra proof it finds valuable from the tasks or changed files.
- If proof setup uses generated seed data, copy any scripts used to create that data into the proof artifacts directory so reviewers can reproduce the setup.
- `artifactsDir` defaults to `.tim/proofs`. If overridden it must be a workspace-relative path that is a strict descendant of `.tim/`, and must not be one of the reserved tim-managed children (`config`, `plans`, `logs`, `tmp`, `reviews`, `workspaces`, `workspace`, `cache`, `sessions`, `artifacts`). The runner refuses absolute paths, paths that escape the workspace, and symlinked path components when clearing the directory.
- `.tim/proofs` is added to the tim-managed `.tim/.gitignore` so generated media do not sneak into commits. Custom `artifactsDir` values must still live under `.tim/`, so they inherit the same gitignore.

To publish artifacts to GitHub PR comments, also configure a media host:

```yaml
mediaHost:
  baseUrl: https://media.example.com
```

`mediaHost.baseUrl` must be an origin-only `http` or `https` URL: no path prefix, query string, fragment, or credentials. Config loading rejects other forms, so `https://media.example.com/assets`, `https://user@example.com`, and `https://media.example.com?bucket=x` are invalid.

The upload bearer token is read from `MEDIA_HOST_API_KEY` in the environment that runs `tim`; it is not stored in YAML config:

```bash
export MEDIA_HOST_API_KEY=...
```

Artifact upload commands require both `mediaHost.baseUrl` and `MEDIA_HOST_API_KEY`. The media host returns signed download URLs after upload, so `tim` does not need the media-host signing secret.

## Entry points

There are three ways to trigger the phase:

- **Agent batch mode.** When `proofGeneration.mode` is `after-completion`, `tim agent` runs the proof phase as a post-completion step. Failures never block parent cascade or the final commit; they are logged as warnings.
- **CLI.** `tim proof <planId>` runs the phase manually. Useful flags:
  - `--auto-workspace` — use the plan's assigned workspace (mirrors `tim chat` / `tim review`).
  - `--executor <name>` and `--model <model>` — override the configured executor/model.
  - `--no-terminal-input` — non-interactive mode used by detached web-UI launches.
- **PR artifact upload.** `tim pr upload-artifacts <planId>` uploads the plan's current non-deleted artifacts to the configured media host and posts or updates a PR comment with links and embeds. It does not run proof generation; run `tim proof` first when you want fresh generated proof artifacts.
- **Web UI.** Plans whose project has `proofGeneration.instructions` configured show a **Generate Proof** action on the plan detail page when the plan has at least one completed task or status in `needs_review`/`reviewed`/`done`. Clicking it detaches a `tim proof` process whose output streams back through the normal session-discovery infrastructure. A separate **Upload artifacts to PR** action on the same page detaches a `tim pr upload-artifacts` process; it is shown only when the project has a configured media host, the plan has at least one non-deleted artifact, and the plan has a linked PR. See [Web Interface](web-interface.md#upload-artifacts-to-pr-action) for the gating details.

If you run `tim proof` against a project that does not have `proofGeneration` configured, the command exits non-zero with a message pointing at this README. Agent batch mode treats the missing config as a clean skip rather than an error.

## Trust model and cost

The proof executor has the same tool access as other post-completion phases (`simplify`, `update-docs`). The provided prompt explicitly scopes it to "only generate proofs; do not modify source files outside the artifacts directory," but you should not configure proof generation for projects whose executor session you would not otherwise trust with Bash.

Proof generation can be more expensive than the implementation phase itself when Playwright iteration takes many tool calls. Setting `executor` / `model` to a cheaper combination is the usual escape hatch.

## Uploading artifacts to a PR comment

`tim pr upload-artifacts <planId>` is a mechanical publishing command for evidence that is already attached to a plan. It reads artifact metadata and files from tim storage, uploads every non-deleted artifact whose file still exists on disk, and posts or updates a single GitHub PR comment that embeds or links those signed media-host URLs. It does not start an LLM executor, regenerate proofs, or check out the PR branch.

By default, the command targets every open PR linked to the plan. Use `--pr <urlOrNumber>` to publish to one PR instead. It requires a GitHub token through the normal personal-token resolver (`gh auth token` or `GITHUB_TOKEN`). Unlike `tim pr review-guide-comment`, it does not use the GitHub App installation token.

```bash
tim pr upload-artifacts 123
tim pr upload-artifacts 123 --pr 456
tim pr upload-artifacts 123 --pr https://github.com/owner/repo/pull/456
```

The PR comment carries a hidden per-plan marker (`<!-- tim:plan-artifacts:<planUuid> -->`). Rerunning the command finds that marker and updates the same comment instead of creating another one. Media-host paths are deterministic by plan UUID, artifact UUID, and filename, so reuploads overwrite the same hosted object and the signed URLs stay stable.

If a proof artifact named `report.md` exists, its markdown becomes the main comment body. `report.md` itself is not uploaded and is not listed as a downloadable artifact. Relative markdown image and link references in the report, such as `![screenshot](screenshot.png)` or `[log](run.log)`, are rewritten to the signed URLs for matching uploaded artifacts. Plain backtick mentions are left as text, so an artifact mentioned only as `` `screenshot.png` `` is still listed after the report.

Artifacts not already shown by rewritten report links are rendered after the report body:

- Images are embedded with markdown image syntax.
- Videos use an HTML `<video>` embed where GitHub supports it, with the signed URL available as the source.
- Other files, including PDFs, zips, logs, and text files, are listed as download links with sizes.

Guard rails:

- Missing `mediaHost.baseUrl` or `MEDIA_HOST_API_KEY` logs a clear "media host not configured" message and does not post.
- Plans with no uploadable artifacts log "nothing to upload" and do not post.
- Plans with no resolvable open PR fail non-zero.

## Lifecycle services

Proof runs start configured `lifecycle.commands` using the `proof` command context after workspace setup and before the proof executor runs. Use `runIn: [proof]` for proof-only setup, omit `runIn` for shared setup, or describe any extra `bun run dev` / `docker compose up` invocations directly in your `instructions` so the executor can start them itself.
