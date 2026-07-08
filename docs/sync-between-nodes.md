# Syncing Between Nodes

`tim` can sync project, plan, and project-setting data between machines through a main node and one or more persistent nodes. This is separate from workspace Git sync: Git still moves code branches, while the node sync transport moves `tim`'s SQLite-backed planning data.

The usual topology is:

- One `main` node: owns canonical plan state and runs the sync server.
- One or more `persistent` nodes: queue local plan writes and exchange them with the main node.
- Optional `ephemeral` nodes: short-lived workers that do not start their own sync transport.

Sync configuration is machine-local. Put it in `~/.config/tim/config.yml`; repository `.tim/config/tim.yml` and `.tim/config/tim.local.yml` files cannot enable sync.

## Project Registration And Matching

The main node owns the shared project list. Sync carries the non-local project fields that identify a repository across machines: project UUID, repository ID, remote URL, remote label, and highest allocated plan ID. Machine-local fields such as workspace paths, `last_git_root`, and external storage paths remain local.

Persistent nodes announce projects to the main node automatically. The first time a persistent node queues any sync operation for a project the main node has never been told about — including a project that was just created implicitly by creating a plan in a new repository — the write router queues a bootstrap `project.upsert` ahead of that operation. The main node creates the project on arrival (or matches it to an existing row by repository ID), so new projects created on a persistent node reach the main node without manual setup. Each node tracks this with a machine-local `project.sync_announced_at` marker; projects adopted from the main node during catch-up are marked announced and are never re-announced.

You can also register a repository workspace on a persistent node explicitly:

```bash
tim workspace register
```

Registration creates the local workspace/project row and, when sync is configured, sends the project registration to the main node. If the main node already knows that repository, a full catch-up will adopt the main node's project UUID locally while preserving local path fields.

Then run:

```bash
tim sync catch-up --full
```

Use `--full` when a project was registered after this node's cursor had already advanced; normal catch-up is cursor-based and does not replay older project bootstrap entries.

## What Syncs

Node sync covers canonical `tim` data such as projects, plans, plan tasks, tags, dependencies, review issues, and project settings. Review-guide notes (`review_issue.severity = 'note'`) are local-only annotations and are filtered out at the sync boundary.

It does not replace:

- Git remotes for source code changes.
- Workspace branch push/pull behavior.
- Webhook or GitHub API configuration for PR status.
- Materialized plan files in `.tim/plans/`; those remain temporary working files.

## Choose Node IDs and Tokens

Pick stable node IDs and a unique token per persistent node:

```bash
uuidgen
openssl rand -hex 32
```

If you want to store a token hash in the main-node config instead of reading the token from an environment variable:

```bash
printf %s "$TIM_SYNC_NODE_TOKEN" | shasum -a 256 | awk '{print $1}'
```

The persistent node must send the raw token. The main node can validate either `tokenHash` or `tokenEnv` for each allowed node.

## Configure the Main Node

On the machine that should own canonical state, edit `~/.config/tim/config.yml`:

```yaml
sync:
  role: main
  nodeId: main-laptop
  serverHost: 127.0.0.1
  serverPort: 8122
  allowedNodes:
    - nodeId: work-laptop
      label: Work laptop
      tokenEnv: TIM_SYNC_WORK_LAPTOP_TOKEN
```

Then export the token in the environment that starts the web UI:

```bash
export TIM_SYNC_WORK_LAPTOP_TOKEN="the-raw-token-for-work-laptop"
```

For another machine to connect directly, the main server must listen on an address reachable from that machine:

```yaml
sync:
  role: main
  nodeId: main-laptop
  serverHost: 0.0.0.0
  serverPort: 8122
  requireSecureTransport: false
  allowedNodes:
    - nodeId: work-laptop
      tokenHash: '64-character-sha256-token-hash'
```

By default, non-loopback main servers require secure transport. Keep that default when running behind HTTPS. Set `requireSecureTransport: false` only on a trusted private network or through another secure tunnel.

Start the web UI on the main node:

```bash
cd /path/to/llmutils
bun run dev
```

The web server lifecycle starts the main sync server. Check it from the main machine:

```bash
curl http://127.0.0.1:8122/healthz
tim sync status
```

If the main node already had plans before sync was enabled, the server bootstraps catch-up metadata when it starts. You can also run this explicitly on the main node:

```bash
tim sync bootstrap
```

## Configure a Persistent Node

On each peer machine, edit that machine's `~/.config/tim/config.yml`:

```yaml
sync:
  role: persistent
  nodeId: work-laptop
  mainUrl: http://main-hostname-or-ip:8122
  nodeTokenEnv: TIM_SYNC_NODE_TOKEN
```

Then export the matching raw token:

```bash
export TIM_SYNC_NODE_TOKEN="the-raw-token-for-work-laptop"
```

Start the web UI on the persistent node:

```bash
cd /path/to/llmutils
bun run dev
```

The persistent web process starts a sync runner. It connects to the main node, flushes queued local operations, and applies canonical changes from the main node.

For one-shot CLI sync without leaving the web UI running:

```bash
tim sync run
```

Use separate push and catch-up commands when needed:

```bash
tim sync push
tim sync catch-up
tim sync catch-up --full
```

## Offline Mode

Persistent nodes can keep accepting local writes while disconnected:

```yaml
sync:
  role: persistent
  nodeId: work-laptop
  mainUrl: http://main-hostname-or-ip:8122
  nodeTokenEnv: TIM_SYNC_NODE_TOKEN
  offline: true
```

With `offline: true`, local writes are still recorded as sync operations, but the persistent transport does not start. Remove or set `offline: false`, then run `tim sync run` or start the web UI to reconnect.

## Changing the Main Node

The safest way to switch the main node is to move the current main node's `tim` database to the new main machine, then update sync config. This preserves canonical state, sync history, peer cursors, and conflict records.

Do not promote an existing persistent node by only changing its role unless you are intentionally resetting sync. Persistent nodes keep canonical snapshots, but they are not the authoritative source for the main node's full sync sequence history that other peers use for catch-up.

1. Stop writes everywhere.

   Stop the web UI on all machines and avoid `tim` commands that edit plans or project settings during the cutover.

2. Flush each persistent node to the old main:

   ```bash
   tim sync run
   tim sync status
   ```

   Continue only when each persistent node has no queued, sending, or failed retryable operations.

3. Stop the old main web UI.

4. Copy the old main database to the new main:

   ```bash
   rsync -a ~/.config/tim/tim.db* new-main:~/.config/tim/
   ```

   Include `tim.db-wal` and `tim.db-shm` if they exist. If all `tim` processes are stopped cleanly first, SQLite should already have checkpointed into `tim.db`, but copying all `tim.db*` files is the safer habit.

5. Configure the new main in `~/.config/tim/config.yml`:

   ```yaml
   sync:
     role: main
     nodeId: new-main
     serverHost: 0.0.0.0
     serverPort: 8122
     allowedNodes:
       - nodeId: old-main
         tokenEnv: TIM_SYNC_OLD_MAIN_TOKEN
       - nodeId: work-laptop
         tokenEnv: TIM_SYNC_WORK_LAPTOP_TOKEN
   ```

6. Update every persistent node to point at the new main:

   ```yaml
   sync:
     role: persistent
     nodeId: work-laptop
     mainUrl: http://new-main-host:8122
     nodeTokenEnv: TIM_SYNC_NODE_TOKEN
   ```

7. If the old main should become a peer, change its config to `role: persistent`, set `mainUrl` to the new main, and give it a token accepted by the new main's `allowedNodes`.

8. Start the new main web UI, then start the persistent-node web UIs. Verify on each machine:

   ```bash
   tim sync status
   ```

## Status and Conflicts

On any node:

```bash
tim sync status
```

On persistent nodes, failed retryable operations usually mean the main node is unavailable or credentials are wrong. After fixing the cause:

```bash
tim sync run
```

If operations are stuck in `sending` after a crashed sync process and no other sync process is running:

```bash
tim sync run --recover-stranded
```

Conflicts are resolved on the main node:

```bash
tim sync conflicts
tim sync resolve <conflictId> --apply-incoming
tim sync resolve <conflictId> --apply-current
tim sync resolve <conflictId> --manual '"operator supplied value"'
```

Use `--apply-incoming` to accept the peer's value, `--apply-current` to keep the current main-node value, or `--manual` with a JSON value for explicit resolution.

## Troubleshooting

Check these first:

- `tim sync status` shows the expected `Role`, `Node ID`, and endpoint.
- The main node's `allowedNodes[].nodeId` exactly matches the persistent node's `sync.nodeId`.
- The persistent node sends the raw token through `nodeToken` or `nodeTokenEnv`; the main node validates it with `tokenHash` or `tokenEnv`.
- The main node is reachable at `sync.mainUrl`, including port and protocol.
- If `serverHost` is not loopback, either terminate HTTPS in front of the sync server or knowingly set `requireSecureTransport: false` for trusted private transport.
- The web UI is running on both machines for continuous sync, or `tim sync run` is being run manually on persistent nodes.
