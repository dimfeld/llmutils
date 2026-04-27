import type { Database } from 'bun:sqlite';

export function shiftTaskIndexesForInsert(
  db: Database,
  planUuid: string,
  insertIndex: number
): void {
  db.prepare(
    'UPDATE plan_task SET task_index = -task_index - 1 WHERE plan_uuid = ? AND task_index >= ?'
  ).run(planUuid, insertIndex);
  db.prepare(
    'UPDATE plan_task SET task_index = -task_index WHERE plan_uuid = ? AND task_index < 0'
  ).run(planUuid);
}

export function shiftTaskIndexesAfterDelete(
  db: Database,
  planUuid: string,
  deletedIndex: number
): void {
  db.prepare(
    'UPDATE plan_task SET task_index = task_index - 1 WHERE plan_uuid = ? AND task_index > ?'
  ).run(planUuid, deletedIndex);
}
