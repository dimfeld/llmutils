import type {
  SessionProcessNode,
  SessionProcessState,
  SessionExecutorTerminationStatus,
} from '$lib/types/session.js';

export interface ProcessTreeNode {
  process: SessionProcessNode;
  children: ProcessTreeNode[];
  depth: number;
}

export function buildProcessTree(flat: SessionProcessNode[]): ProcessTreeNode[] {
  const nodeMap = new Map<string, ProcessTreeNode>();
  const roots: ProcessTreeNode[] = [];

  for (const process of flat) {
    nodeMap.set(process.processId, { process, children: [], depth: 0 });
  }

  for (const treeNode of nodeMap.values()) {
    const parentId = treeNode.process.parentProcessId;
    const parent = parentId ? nodeMap.get(parentId) : undefined;
    if (parent) {
      parent.children.push(treeNode);
      treeNode.depth = parent.depth + 1;
    } else {
      roots.push(treeNode);
    }
  }

  return roots;
}

export function flattenTree(roots: ProcessTreeNode[]): ProcessTreeNode[] {
  const result: ProcessTreeNode[] = [];
  function walk(nodes: ProcessTreeNode[]): void {
    for (const node of nodes) {
      result.push(node);
      walk(node.children);
    }
  }
  walk(roots);
  return result;
}

export function formatElapsedTime(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '';
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (Number.isNaN(end)) return '';

  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function processStateLabel(state: SessionProcessState): string {
  switch (state) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'exited':
      return 'Exited';
    case 'orphaned':
      return 'Orphaned';
    default:
      return state;
  }
}

export function processKindLabel(kind: string): string {
  switch (kind) {
    case 'tim':
      return 'tim';
    case 'executor':
      return 'Executor';
    default:
      return kind;
  }
}

export function isLiveProcess(state: SessionProcessState): boolean {
  return state === 'starting' || state === 'running';
}

export function canTerminate(node: SessionProcessNode): boolean {
  return node.kind === 'executor' && isLiveProcess(node.state);
}

export type TerminationOutcome = 'success' | 'stale' | 'error';

export function classifyTerminationStatus(
  status: SessionExecutorTerminationStatus
): TerminationOutcome {
  switch (status) {
    case 'terminated':
    case 'requested':
    case 'already_exited':
      return 'success';
    case 'stale_target':
    case 'unknown_process_state':
      return 'stale';
    default:
      return 'error';
  }
}

export function terminationStatusMessage(status: SessionExecutorTerminationStatus): string {
  switch (status) {
    case 'terminated':
      return 'Process terminated';
    case 'requested':
      return 'Termination requested';
    case 'already_exited':
      return 'Process already exited';
    case 'not_owned':
      return 'Process not owned by this session';
    case 'not_executor':
      return 'Not an executor process';
    case 'stale_target':
      return 'Process identity changed (stale target)';
    case 'unknown_process_state':
      return 'Process state could not be verified';
    case 'signal_failed':
      return 'Failed to send signal';
    case 'unknown_executor':
      return 'Executor not found';
    case 'owner_not_registered':
      return 'Owner process not registered';
    case 'owner_not_connected':
      return 'Owner process not connected';
    case 'send_failed':
      return 'Failed to send termination request';
    case 'request_timeout':
      return 'Termination request timed out';
    case 'offline':
      return 'Session is offline';
    case 'session_not_found':
      return 'Session not found';
    case 'request_failed':
      return 'Request failed';
    default:
      return `Unknown status: ${status as string}`;
  }
}
