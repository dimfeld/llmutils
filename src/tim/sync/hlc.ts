import type { Database } from 'bun:sqlite';
import { getOrCreateClockRow } from '../db/sync_schema.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';

export interface Hlc {
  physicalMs: number;
  logical: number;
}

export interface ParsedOpId {
  hlc: Hlc;
  nodeId: string;
  localCounter: number;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physicalMs !== b.physicalMs) {
    return a.physicalMs - b.physicalMs;
  }
  return a.logical - b.logical;
}

export function formatHlc(hlc: Hlc): string {
  return `${hlc.physicalMs.toString().padStart(16, '0')}.${hlc.logical
    .toString()
    .padStart(8, '0')}`;
}

export function parseHlc(value: string): Hlc {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid HLC value: ${value}`);
  }

  return {
    physicalMs: Number.parseInt(match[1], 10),
    logical: Number.parseInt(match[2], 10),
  };
}

export function formatOpId(hlc: Hlc, nodeId: string, localCounter: number): string {
  return `${formatHlc(hlc)}/${nodeId}/${localCounter}`;
}

export function parseOpId(opId: string): ParsedOpId {
  const parts = opId.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid sync op id: ${opId}`);
  }

  const localCounter = Number.parseInt(parts[2], 10);
  if (!Number.isSafeInteger(localCounter) || localCounter < 0) {
    throw new Error(`Invalid sync op local counter: ${opId}`);
  }

  return {
    hlc: parseHlc(parts[0]),
    nodeId: parts[1],
    localCounter,
  };
}

export class HlcGenerator {
  constructor(
    private readonly db: Database,
    private readonly nodeId: string
  ) {}

  tick(now = Date.now(), db: Database = this.db): { hlc: Hlc; localCounter: number; opId: string } {
    const row = getOrCreateClockRow(db);
    const physicalMs = Math.max(row.physical_ms, Math.floor(now));
    const logical = physicalMs === row.physical_ms ? row.logical + 1 : 0;
    const localCounter = row.local_counter + 1;

    this.persist(db, physicalMs, logical, localCounter);

    const hlc = { physicalMs, logical };
    return {
      hlc,
      localCounter,
      opId: formatOpId(hlc, this.nodeId, localCounter),
    };
  }

  observe(remote: Hlc, now = Date.now(), db: Database = this.db): void {
    const row = getOrCreateClockRow(db);
    const nowMs = Math.floor(now);
    const physicalMs = Math.max(row.physical_ms, remote.physicalMs, nowMs);

    let logical: number;
    if (physicalMs === row.physical_ms && physicalMs === remote.physicalMs) {
      logical = Math.max(row.logical, remote.logical) + 1;
    } else if (physicalMs === row.physical_ms) {
      logical = row.logical + 1;
    } else if (physicalMs === remote.physicalMs) {
      logical = remote.logical + 1;
    } else {
      logical = 0;
    }

    this.persist(db, physicalMs, logical, row.local_counter);
  }

  private persist(db: Database, physicalMs: number, logical: number, localCounter: number): void {
    db.prepare(
      `
        UPDATE sync_clock
        SET
          physical_ms = ?,
          logical = ?,
          local_counter = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
        WHERE id = 1
      `
    ).run(physicalMs, logical, localCounter);
  }
}
