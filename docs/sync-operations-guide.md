# Sync Operations Guide

This guide describes the expected path for adding or changing synced `tim` mutations. Synced state must flow through the operation engine. Do not add a direct SQL code path in a command handler for state that should sync.

## Operation Flow

The normal write path is:

1. CLI, web, or MCP code calls a `write*` or batch helper in `src/tim/sync/write_router.ts`.
2. The router uses `resolveWriteMode()`:
   - `local-operation` and `sync-main` apply immediately through `applyOperation()` or `applyBatch()`. In `sync-main` mode only, the router first applies a bootstrap `project.upsert` for any referenced project with `project.sync_announced_at` unset, so the project gains a sequence entry and connected peers receive an invalidation; `local-operation` mode does not announce.
   - `sync-persistent` queues operations with `enqueueOperation()` or `enqueueBatch()` and rebuilds local projection state optimistically. Before queueing, the router announces any referenced project the main node has never been told about (`project.sync_announced_at` unset) by enqueueing a bootstrap `project.upsert` ahead of the operations, so the main node can accept operations for projects created locally on the persistent node.
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

## Add A New Synced Plan Scalar

Most new plan state is a new field on `plan.set_scalar`, not a new operation.
`structuralReviewAt` (migration v50) and `lessonsAppliedAt` are the worked
examples — follow either end to end. The touch points:

1. `PlanSchema` in `src/tim/planSchema.ts`, plus the regenerated public JSON
   schema (`schema/tim-plan-schema.json`, via `scripts/update-json-schemas.ts`).
2. Migration adding the column to **both** `plan` and `plan_canonical`, using the
   guarded `afterUp` `ALTER TABLE` pattern.
3. `PlanRow`, the upsert SQL, and `planWriteValues()` in `src/tim/db/plan.ts`;
   `planRowToSchemaInput` in `src/tim/plans_db.ts`.
4. `EDITABLE_PLAN_FIELDS` and `diffPlanFields()` in `src/tim/plan_materialize.ts`.
   A field missing here is **silently dropped** from plan-file edits, so cover it
   with a materialize round-trip test for both a set value and null.
5. The `plan.set_scalar` field enum and `validatePlanSetScalarFieldValue()` in
   `src/tim/sync/types.ts`, the snapshot schema in `src/tim/sync/snapshots.ts`,
   `operation_metadata.ts`, and `apply_operation.ts` / `operation_fold.ts`. The
   exhaustive `never` switch in the validator surfaces the enum sites at compile
   time — use `bun run check` as the completeness check for those, and this list
   for the rest.
6. Any code that snapshots a plan row for rollback, such as the renumber
   rollback in `src/tim/commands/renumber.ts`. A field missed there is silently
   cleared by a rollback instead of restored.

Adding a scalar field is backward compatible: older nodes strip unknown scalar
fields instead of erroring.

**Validate sync ingress with the same schema plan validation uses.** For
timestamps that means `planTimestampSchema` from `src/tim/planSchema.ts`, not the
looser `SyncIsoTimestampSchema`, which also accepts a UTC offset. Every ingress
path for a column — the `plan.set_scalar` validator, the plan payload schema, and
the canonical snapshot schema — must enforce the same contract. If sync accepts a
value that local plan validation later rejects, every subsequent write to that
plan fails, and the plan is wedged on that node.

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

### Conflict Semantics

Do not treat every revision mismatch as a conflict. A plan revision advances for
changes to any field, list, or task, so the revision alone does not prove that
two operations overlap.

- `plan.set_scalar` uses last-writer-wins ordering on the main node. The main
  node's accepted operation order is the deterministic order.
- `plan.patch_text` and `plan.update_task_text` use their `base` and `new`
  values for a three-way merge. A stale revision is allowed when the patch
  applies cleanly to the current value. Create a conflict only when the text
  changes overlap and the patch cannot apply.
- `plan.set_parent` may proceed across an unrelated revision change when the
  current parent still matches `previousParentUuid`.
- Destructive or identity-sensitive operations, such as task removal and plan
  deletion, keep strict revision checks where the payload has no semantic
  pre-state that can prove the operation is safe.

Atomic batch rejection records must retain the underlying conflict reason.
Sibling records must state that they were rolled back and include the cause so
`tim sync show-rejected` can distinguish the conflict-causing operation from
batch fallout.

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
