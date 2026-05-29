# Slack Integration

This document describes tim's Slack integration: workspace configuration, per-repo opt-in settings, GitHub-to-Slack user mappings, the `tim slack` CLI, the web-server notifier that sends debounced review-request channel messages, and the [daily PR digest](#daily-pr-digest) of stuck PRs.

## Status and Scope

Slack review-request notifications provide:

- machine-local Slack workspace configuration
- a workspace-scoped user mapping store
- per-repo Slack settings managed by CLI
- an outbound Slack `chat.postMessage` client for review-request messages
- a web-server notifier that batches pending individual review requests and posts one Slack channel message per PR
- a once-per-day [daily PR digest](#daily-pr-digest) of approved-but-unmerged and stale-awaiting-review PRs, per digest-enabled repo

## Workspace Configuration

Slack workspaces are named in global tim config:

```yaml
slack:
  workspaces:
    work: { token: '${SLACK_WORK_TOKEN}' }
    personal: { token: '${SLACK_PERSONAL_TOKEN}' }
```

The `slack` block is machine-local, mirroring `sync`: tim strips it from repo and local config and restores it only from the global config. Put workspace tokens in `~/.config/tim/config.yml`; do not put them in `.tim/config/tim.yml` or `tim.local.yml`.

Each workspace has:

- `token` - the Slack bot token, either literal or containing `${ENV_VAR}` placeholders
- `dailyDigest` (optional) - schedule for the [daily PR digest](#daily-pr-digest):
  - `time` - `HH:MM` 24-hour local time the digest fires (default `00:00`); rejected at load if not `HH:MM`
  - `timezone` - IANA time zone the `time` is interpreted in (default: the server's local zone); rejected at load if not a valid IANA zone
  - `staleAfterHours` - how long a review request must wait before it is "stale" (default `24`)

```yaml
slack:
  workspaces:
    work:
      token: '${SLACK_WORK_TOKEN}'
      dailyDigest: { time: '09:00', timezone: 'America/New_York', staleAfterHours: 24 }
```

Token placeholders are expanded from `process.env` at read time. tim fails loudly if a referenced workspace does not exist, if its token is missing or empty, if a referenced environment variable is unset or empty, or if the expanded token is empty. The `dailyDigest` schedule is per workspace (so different workspaces can fire at their own local time); whether a given repo participates is the per-repo `dailyDigest` opt-in below.

## Slack App Setup

Create or configure a Slack app for each workspace that should receive review-request messages.

1. Give the bot token `chat:write`.
2. Store the token in an environment variable, such as `SLACK_WORK_TOKEN`.
3. Add the workspace entry to `~/.config/tim/config.yml`.
4. Invite the bot to each channel that a repo will use.

Example shell setup:

```bash
export SLACK_WORK_TOKEN="xoxb-..."
```

Example global config:

```yaml
slack:
  workspaces:
    work: { token: '${SLACK_WORK_TOKEN}' }
```

## Per-Repo Settings

Repos opt in through a `project_setting` row named `slack`, with this shape:

```json
{
  "enabled": true,
  "workspace": "work",
  "channel": "#code-reviews",
  "dailyDigest": true
}
```

These settings are written by the `tim slack` CLI and stored in the local database, not in committed config. One repo targets one workspace and one channel. Repos without an enabled Slack setting do not send notifications. `dailyDigest` is a separate opt-in (default off) that enables the [daily PR digest](#daily-pr-digest) for the repo; it posts to the same workspace and channel as review-request notifications and requires Slack to already be enabled.

The `enable`, `disable`, and `list` commands resolve the current GitHub repository from the working directory and look up the matching tim project. Run them from a checkout that tim already knows as a project.

## User Mappings

GitHub-to-Slack mappings are keyed by `(workspace, github_login)` because Slack user IDs are scoped to a workspace. A mapping can be reused by every repo that targets that Slack workspace.

Mapped reviewers render as real Slack mentions, such as `<@U123456789>`. Unmapped reviewers are still included by GitHub login in a code span, such as `` `octocat` ``, without pinging anyone.

The optional display name is for operator readability in `tim slack list`. Re-mapping without `--display` preserves an existing display value.

## CLI Reference

All commands validate that any supplied workspace name exists in `slack.workspaces`.

### Enable a Repo

```bash
tim slack enable --workspace <name> --channel <#channel>
```

Enables Slack review notifications for the current repo's tim project. The command stores `{ enabled: true, workspace, channel }` in the repo's `slack` project setting.

Example:

```bash
tim slack enable --workspace work --channel "#code-reviews"
```

### Disable a Repo

```bash
tim slack disable
```

Disables Slack review notifications for the current repo's tim project. The previous workspace and channel are preserved in the stored setting so `tim slack list` can still show the last configured target.

### Send a Test Message

```bash
tim slack test --workspace <name> --channel <#channel> [--message <text>]
```

Sends a simple test message through the selected workspace's bot token. This validates token resolution, Slack API access, and bot membership in the target channel without requiring the current repo to be enabled for Slack notifications.

Example:

```bash
tim slack test --workspace work --channel "#code-reviews"
tim slack test --workspace work --channel "#code-reviews" --message "Review notifications are connected."
```

### Mark Closed PR Requests Notified

```bash
tim slack mark-closed-notified [--dry-run]
```

Marks pending review-request notification rows for cached closed or merged PRs as already notified. This is useful after first enabling Slack notifications in a workspace that already has historical PR review-request rows.

Use `--dry-run` first to see how many rows would be changed:

```bash
tim slack mark-closed-notified --dry-run
tim slack mark-closed-notified
```

### Map a User

```bash
tim slack map <github-login> <slack-user-id> --workspace <name> [--display <name>]
```

Creates or updates a GitHub-to-Slack mapping in the selected workspace.

Example:

```bash
tim slack map octocat U123456789 --workspace work --display "Octo Cat"
```

### Unmap a User

```bash
tim slack unmap <github-login> --workspace <name>
```

Removes a mapping from the selected workspace. If the mapping does not exist, tim reports that no mapping was found.

### List Settings and Mappings

```bash
tim slack list [--workspace <name>]
```

Shows the current repo's Slack project setting and lists user mappings. With `--workspace`, the mapping table is filtered to that workspace. The repo's `dailyDigest` status (enabled/disabled) is shown alongside the Slack setting.

### Enable / Disable the Daily Digest

```bash
tim slack digest enable
tim slack digest disable
```

Toggles the [daily PR digest](#daily-pr-digest) for the current repo. `enable` requires Slack to already be enabled for the repo (a workspace and channel must be set) and errors clearly otherwise. The digest posts to the same channel as review-request notifications.

### Run the Daily Digest Now

```bash
tim slack digest [--dry-run]
```

Runs the daily digest immediately for every configured workspace's digest-enabled repos. `--dry-run` computes and prints the two buckets for each repo without posting to Slack (and without requiring a usable token), so you can preview what the scheduled run would send. Without `--dry-run`, it posts to Slack just like the scheduled run.

## Posted Message Shape

The notifier posts one Slack channel message per PR once the debounce window has elapsed. The outbound client builds one Slack Block Kit section for that review-request message. The message includes:

- a linked PR title pointing at `linear.review/{owner}/{repo}/pull/{number}`
- the PR author
- cached PR size when available (`files changed` and `+/-` counts)
- requested reviewers, with mapped reviewers as Slack mentions and unmapped reviewers as GitHub logins

The fallback text also includes the PR title, author, cached PR size when available, and reviewer GitHub logins. Slack API failures are logged and returned to the caller as `{ ok: false, error }`; token misconfiguration throws so the caller can fail loudly.

## Notifier Behavior

The notifier runs inside the SvelteKit web server, next to the GitHub webhook poller. It starts from `src/hooks.server.ts` when webhook polling is active and at least one Slack workspace is configured. It is kicked after webhook ingestion reports PR updates through the poller's `onPrUpdated` callback, and it also runs on a low-frequency internal interval of about 15 seconds so a PR can send after its debounce window even if no later webhook arrives.

On each tick, the notifier reads pending review requests from `pr_review_request` joined to `pr_status`, using `removed_at IS NULL AND notified_at IS NULL` and `pr_status.state = 'open'`. It groups rows by PR, resolves the PR repo to a tim project, reads that project's `slack` setting, and skips repos that are not enabled. If an enabled repo references an undefined workspace or a workspace with no usable token, the notifier logs a loud error and leaves those rows pending.

Debounce is fixed at 30 seconds per PR. A PR is eligible only after `now - max(requested_at)` across its pending reviewers is at least 30 seconds. Because the notifier re-queries pending rows each tick, reviewers added within the window join the same message.

Mapped reviewers are sent as Slack user mentions like `<@U123456789>`. Unmapped reviewers are still included by GitHub login without a ping. Team review requests are out of scope for v1; the webhook ingest path only inserts individual `requested_reviewer` logins into `pr_review_request`.

Notification state is durable in the database. After Slack confirms a successful post, the notifier sets `notified_at` for exactly the rows included in the message. If posting fails, `notified_at` stays null and the rows are retried on a later tick. This is at-least-once delivery: a crash between Slack success and the DB update can duplicate a message, but the normal retry path avoids silently dropping notifications.

Marking is guarded by a per-row `request_version`. The notifier records each pending row's version when it reads the batch, and marks `notified_at` only where the version still matches. If a reviewer is removed and re-requested while a Slack send is in flight, the re-request bumps `request_version` (and resets `notified_at` to null), so the stale mark does not apply and the fresh request is picked up on a later tick. A reviewer re-requested after a prior notification is therefore notified again, since the re-request clears `notified_at`.

When Slack is first enabled for a repo that already has outstanding unremoved review requests, those historical pending rows still have `notified_at` set to null. The notifier will post them once after the debounce window passes. This one-time first-enable burst is intentional in v1; there is no historical backfill suppression.

If those historical rows include closed or merged PRs, run `tim slack mark-closed-notified` to suppress them.

## Daily PR Digest

Separate from the event-driven review-request notifier, tim can post a once-per-day digest of PRs that are stuck. It is a per-repo opt-in (default off) and posts one message per digest-enabled repo to that repo's configured channel.

The digest has two sections:

- **Approved, not yet merged** - open, non-draft PRs whose review decision is `APPROVED`.
- **Awaiting review for > 1 day** - open, non-draft PRs that are not already approved and have an assigned individual reviewer whose last review request is older than the workspace's `staleAfterHours` (default 24h) and who has not reviewed since being requested. Each entry lists the waiting reviewer(s) and how long they've waited. PR entry links point at `linear.review/{owner}/{repo}/pull/{number}`. The footer includes both the GitHub "View all PRs awaiting your review" search link and a Linear reviews link.

If **both** sections are empty for a repo, no message is sent for that repo.

What counts as "stale":

- The clock starts at `pr_review_request.requested_at` (reset when a reviewer is re-requested).
- A request is fresh while it has waited `≤ staleAfterHours` and becomes stale only once it has waited strictly longer than that.
- **Any** submitted review (`APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED`) by that reviewer after the request clears the nudge — the goal is to surface genuinely-silent reviewers. A `DISMISSED` review does not clear it, since a dismissed review means the PR needs attention again.
- Team review requests are not tracked individually (`pr_review_request` stores only individual logins), so the awaiting-review bucket covers individual reviewers only. A PR whose only request is to a team will not appear in that bucket.

The digest never uses Slack `@`-mentions: authors and reviewers are always rendered as plain GitHub logins. It is informational and must not ping people daily. A PR that is both approved and still has a stale pending reviewer appears only in the approved section.

### Enablement

The digest requires, in order:

1. A Slack workspace token in global config (same as review-request notifications).
2. The repo enabled for Slack (`tim slack enable --workspace <w> --channel <#c>`).
3. The digest opted in for the repo (`tim slack digest enable`).
4. **Webhook polling enabled** — the digest reads PR data exclusively from the local database, which is kept fresh by GitHub webhook ingestion. It does not fetch from GitHub. (Open PR status is retained until the PR closes so the digest has a durable, complete source.)

### Schedule and Scheduler

The `time`/`timezone`/`staleAfterHours` schedule is configured per workspace (see [Workspace Configuration](#workspace-configuration)), defaulting to `00:00` in the server's local zone with a 24h stale threshold.

The scheduler runs inside the SvelteKit web server (`src/hooks.server.ts`), alongside the notifier and webhook poller. It starts only when webhook polling is enabled, at least one workspace is configured, and at least one repo has the digest enabled. It uses one `setTimeout` timer per workspace (not `Bun.cron`, which is UTC-only): on each fire it runs that workspace's digest, then recomputes the next fire from the IANA `timezone` and reschedules, which naturally handles DST transitions (a configured time that does not exist on a spring-forward day rolls to the next valid day). Timers are `unref`'d so they never keep the process alive, and they stop cleanly on shutdown and HMR re-init.

A misconfigured workspace (missing or unusable token) is logged once and skipped without aborting the run or affecting other workspaces' projects. Each repo is processed in isolation, so one repo's failure does not block the others.

The digest is a stateless snapshot — unlike the review-request notifier, it has no durable per-message dedup. A process restart near the fire time or a manual `tim slack digest` run could post the same digest twice; this is acceptable for an informational daily summary.

### Manual Run

`tim slack digest` runs the digest immediately for all configured workspaces; `tim slack digest --dry-run` previews the computed buckets without posting (and without requiring a usable token). See [Run the Daily Digest Now](#run-the-daily-digest-now).

## Example Setup

```bash
export SLACK_WORK_TOKEN="xoxb-..."
```

`~/.config/tim/config.yml`:

```yaml
slack:
  workspaces:
    work: { token: '${SLACK_WORK_TOKEN}' }
```

From a repo that exists as a tim project:

```bash
tim slack enable --workspace work --channel "#code-reviews"
tim slack test --workspace work --channel "#code-reviews"
tim slack map your-github-login U123456789 --workspace work --display "Your Name"
tim slack list

# Optional: opt this repo into the daily PR digest, then preview it
tim slack digest enable
tim slack digest --dry-run
```

With the web server running and webhook polling configured, review requests in enabled repos use these settings and mappings automatically. Digest-enabled repos additionally receive the daily digest at the workspace's configured `time`/`timezone`.
