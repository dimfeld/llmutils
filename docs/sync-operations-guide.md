# Sync Operations Guide

This guide describes the expected path for adding or changing synced `tim` mutations. Synced state must flow through the operation engine. Do not add a direct SQL code path in a command handler for state that should sync.

## Operation Flow

The normal write path is:

1. CLI, web, or MCP code calls a `write*` or batch helper in `src/tim/sync/write_router.ts`.
2. The router uses `resolveWriteMode()`:
   - `local-operation` and `sync-main` apply immediately through `applyOperation()` or `applyBatch()`.
   - `sync-persistent` queues operations with `enqueueOperation()` or `enqueueBatch()` and rebuilds local projection state optimistically.
3. Main/local apply writes canonical state and projection state together.
4. Persistent nodes keep canonical tables separate from user-visible projection tables. Queue/projection code folds active local operations over canonical state.
5. Main-node sync results and catch-up invalidations return canonical snapshots. Persistent nodes merge those snapshots, transition queued operations, and rebuild projection state.

## Add A New Operation

Add the payload shape in `src/tim/sync/types.ts`:

- Define a `Sync...PayloadSchema` and exported type.
- Add it to `SyncOperationPayloadSchema`.
- Add the operation string to `SyncOperationTypeSchema`.
- Update `deriveTargetKey()`. Use the narrowest target type that represents the mutation: `project`, `plan`, `task`, or `project_setting`.
- If the payload carries `projectUuid`, add envelope consistency validation.

Add a constructor in `src/tim/sync/operations.ts`:

- Use `buildEnvelope()` so operation UUIDs, origin node IDs, target keys, and schema validation stay consistent.
- Generate entity UUIDs in the constructor when the operation creates entities.

Route writes through `src/tim/sync/write_router.ts`:

- Prefer `defineProjectOperationRoutes()` for plan-scoped operations that fit the existing shape.
- Use a custom `write*` wrapper only when the payload does not have the standard `(projectUuid, input)` signature.
- Commands should call router helpers, not `applyOperation()` or DB helpers directly.

Update metadata in `src/tim/sync/operation_metadata.ts`:

- Add `SYNC_OPERATION_METADATA` with the entity kind and base-revision target.
- Add semantic plan refs in `getSyncOperationPlanRefs()` if projection rebuilds need related plans.
- Keep project/project-setting operations out of plan-ref indexing unless they truly affect plan projection.

## Apply And Project

Main/local apply lives in `src/tim/sync/apply_operation.ts` and shared plan semantics live in `src/tim/sync/operation_fold.ts`.

- Plan and task mutations should usually be implemented in `operation_fold.ts` against the adapter interface.
- Project or project-setting mutations may be implemented directly in `apply_operation.ts` when they are outside plan state.
- Return `Mutation[]` entries for every canonical target whose sequence/invalidation should be visible to other nodes.
- Use existing conflict helpers for stale revisions and tombstoned targets.

Persistent-node optimistic projection is driven by `src/tim/sync/projection_targets.ts` and `src/tim/sync/projection.ts`.

- Add target collection for new non-plan entities.
- For plan operations, make sure `getAffectedProjectionPlanUuids()` includes inbound owners when dependencies or parent links can change.
- Keep projection rebuilds deterministic from canonical tables plus active queued operations.

## Snapshots And Catch-Up

If an operation invalidates a target key that other nodes need to merge, update `src/tim/sync/server.ts` and `src/tim/sync/snapshots.ts`.

- `loadCanonicalSnapshot()` must return a snapshot for target keys emitted in `Mutation[]`.
- `CanonicalSnapshotSchema` must validate the new snapshot type.
- `mergeCanonicalRefresh()` must apply the snapshot to canonical tables and rebuild projection state.
- Deletion operations need a deleted/never-existed snapshot path; otherwise catch-up nodes can see an invalidation but receive no state change.

## Tests To Add

At minimum, add focused tests in:

- `src/tim/sync/types.test.ts` for schema and target-key behavior.
- `src/tim/sync/operations.test.ts` for constructor round trips.
- `src/tim/sync/apply.test.ts` for main/local apply and emitted invalidations.
- `src/tim/sync/queue.test.ts` for persistent optimistic projection if the operation affects visible state before flush.
- `src/tim/sync/server.test.ts` or an apply/snapshot test for catch-up snapshots.
- Command tests when adding CLI or web entry points.

When testing failure of an atomic sync batch, **assert on the rejected operation status, not on the absence of operation rows.** A batch that fails validation rolls back the user-visible plan/projection state, but it can still leave the `sync_operation` row(s) behind in a rejected status — that is expected bookkeeping, not a leak. A test that asserts "no `sync_operation` rows exist after a failed batch" will be wrong; assert that the operation exists with a rejected status instead.

Run targeted tests first, then `bun run check` and the relevant broader test suite.
