# Slack Integration

This document describes tim's Slack review-request notifications: workspace configuration, per-repo opt-in settings, GitHub-to-Slack user mappings, the `tim slack` CLI, and the web-server notifier that sends debounced channel messages.

## Status and Scope

Slack review-request notifications provide:

- machine-local Slack workspace configuration
- a workspace-scoped user mapping store
- per-repo Slack settings managed by CLI
- an outbound Slack `chat.postMessage` client for review-request messages
- a web-server notifier that batches pending individual review requests and posts one Slack channel message per PR

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

Token placeholders are expanded from `process.env` at read time. tim fails loudly if a referenced workspace does not exist, if its token is missing or empty, if a referenced environment variable is unset or empty, or if the expanded token is empty.

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
  "channel": "#code-reviews"
}
```

These settings are written by the `tim slack` CLI and stored in the local database, not in committed config. One repo targets one workspace and one channel. Repos without an enabled Slack setting do not send notifications.

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

Shows the current repo's Slack project setting and lists user mappings. With `--workspace`, the mapping table is filtered to that workspace.

## Posted Message Shape

The notifier posts one Slack channel message per PR once the debounce window has elapsed. The outbound client builds one Slack Block Kit section for that review-request message. The message includes:

- a linked PR title
- the PR author
- requested reviewers, with mapped reviewers as Slack mentions and unmapped reviewers as GitHub logins

The fallback text also includes the PR title, author, and reviewer GitHub logins. Slack API failures are logged and returned to the caller as `{ ok: false, error }`; token misconfiguration throws so the caller can fail loudly.

## Notifier Behavior

The notifier runs inside the SvelteKit web server, next to the GitHub webhook poller. It starts from `src/hooks.server.ts` when webhook polling is active and at least one Slack workspace is configured. It is kicked after webhook ingestion reports PR updates through the poller's `onPrUpdated` callback, and it also runs on a low-frequency internal interval of about 15 seconds so a PR can send after its debounce window even if no later webhook arrives.

On each tick, the notifier reads pending review requests from `pr_review_request` joined to `pr_status`, using `removed_at IS NULL AND notified_at IS NULL` and `pr_status.state = 'open'`. It groups rows by PR, resolves the PR repo to a tim project, reads that project's `slack` setting, and skips repos that are not enabled. If an enabled repo references an undefined workspace or a workspace with no usable token, the notifier logs a loud error and leaves those rows pending.

Debounce is fixed at 30 seconds per PR. A PR is eligible only after `now - max(requested_at)` across its pending reviewers is at least 30 seconds. Because the notifier re-queries pending rows each tick, reviewers added within the window join the same message.

Mapped reviewers are sent as Slack user mentions like `<@U123456789>`. Unmapped reviewers are still included by GitHub login without a ping. Team review requests are out of scope for v1; the webhook ingest path only inserts individual `requested_reviewer` logins into `pr_review_request`.

Notification state is durable in the database. After Slack confirms a successful post, the notifier sets `notified_at` for exactly the rows included in the message. If posting fails, `notified_at` stays null and the rows are retried on a later tick. This is at-least-once delivery: a crash between Slack success and the DB update can duplicate a message, but the normal retry path avoids silently dropping notifications.

Marking is guarded by a per-row `request_version`. The notifier records each pending row's version when it reads the batch, and marks `notified_at` only where the version still matches. If a reviewer is removed and re-requested while a Slack send is in flight, the re-request bumps `request_version` (and resets `notified_at` to null), so the stale mark does not apply and the fresh request is picked up on a later tick. A reviewer re-requested after a prior notification is therefore notified again, since the re-request clears `notified_at`.

When Slack is first enabled for a repo that already has outstanding unremoved review requests, those historical pending rows still have `notified_at` set to null. The notifier will post them once after the debounce window passes. This one-time first-enable burst is intentional in v1; there is no historical backfill suppression.

If those historical rows include closed or merged PRs, run `tim slack mark-closed-notified` to suppress them.

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
```

With the web server running and webhook polling configured, review requests in enabled repos use these settings and mappings automatically.
