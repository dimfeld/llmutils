export type ProcessInfo = {
  pid: number;
  ppid: number;
  startTime: string;
  command: string;
};

export function parsePsOutput(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }

    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 8) {
      continue;
    }

    const pid = Number.parseInt(tokens[0], 10);
    const ppid = Number.parseInt(tokens[1], 10);
    if (Number.isNaN(pid) || Number.isNaN(ppid)) {
      continue;
    }

    processes.push({
      pid,
      ppid,
      startTime: tokens.slice(2, 7).join(' '),
      command: tokens.slice(7).join(' '),
    });
  }

  return processes;
}

export function buildChildrenByParent(processes: ProcessInfo[]): Map<number, ProcessInfo[]> {
  const childrenByParent = new Map<number, ProcessInfo[]>();

  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid);
    if (children) {
      children.push(processInfo);
    } else {
      childrenByParent.set(processInfo.ppid, [processInfo]);
    }
  }

  return childrenByParent;
}

export function findDescendantProcesses(rootPid: number, processes: ProcessInfo[]): ProcessInfo[] {
  const childrenByParent = buildChildrenByParent(processes);
  const descendants: ProcessInfo[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [...(childrenByParent.get(rootPid) ?? [])];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.pid)) {
      continue;
    }

    visited.add(current.pid);
    descendants.push(current);

    for (const child of childrenByParent.get(current.pid) ?? []) {
      if (!visited.has(child.pid)) {
        queue.push(child);
      }
    }
  }

  return descendants;
}

export function listProcesses(): ProcessInfo[] {
  const result = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=,ppid=,lstart=,command='], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`ps failed with exit code ${result.exitCode}: ${stderr.trim()}`);
  }

  return parsePsOutput(new TextDecoder().decode(result.stdout));
}
