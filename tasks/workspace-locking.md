# Workspace Locking Design

## Overview

This feature adds lockfile-based workspace tracking to prevent concurrent usage and enable intelligent workspace selection.

## Lockfile Design

### Location
- **Per-workspace lockfile**: `.tim.lock` in each workspace root directory
- **Central registry enhancement**: Add `lockedBy` field to workspaces.json entries

### Lockfile Format (JSON)
```json
{
  "pid": 12345,
  "command": "tim agent --workspace task-123",
  "startedAt": "2025-01-22T10:30:00Z",
  "hostname": "dev-machine",
  "version": 1
}
```

### Stale Lock Detection
A lock is considered stale if:
1. The PID doesn't exist on the system
2. The process exists but isn't an tim process
3. The lock is older than a configurable timeout (default: 24 hours)

## Implementation Approach

### 1. Lock Lifecycle

**Acquisition:**
- Create lockfile when entering a workspace (agent start, done command, etc.)
- Use atomic file operations to prevent race conditions
- Update workspace tracker with lock status

**Release:**
- Delete lockfile on normal exit
- Register signal handlers (SIGTERM, SIGINT) for cleanup
- Consider using process.on('exit') for cleanup

**Stale Handling:**
- Check if PID is alive using `process.kill(pid, 0)`
- Verify process command matches tim (via /proc/[pid]/cmdline on Linux)
- Prompt user before clearing stale locks in interactive mode

### 2. Auto-Choose Workspace Logic

```typescript
async function autoChooseWorkspace(repoUrl: string): Promise<WorkspaceInfo | null> {
  const workspaces = await tracker.getWorkspacesForRepo(repoUrl);
  
  // 1. Check for unlocked workspaces
  for (const ws of workspaces) {
    const lock = await checkLock(ws.workspacePath);
    if (!lock || isStale(lock)) {
      if (lock && isStale(lock)) {
        await promptAndClearStaleLock(ws, lock);
      }
      return ws;
    }
  }
  
  // 2. All locked - create new workspace
  return await createNewWorkspace(repoUrl);
}
```

### 3. User Experience

**Interactive Mode:**
- Show lock status when listing workspaces
- Prompt before clearing stale locks
- Suggest creating new workspace if all are locked

**Non-Interactive Mode:**
- Auto-clear stale locks older than threshold
- Create new workspace if all are locked
- Log decisions for debugging

### 4. Safety Considerations

**User Working in Workspace:**
- Check for uncommitted changes before acquiring lock
- Warn if workspace has recent git activity
- Option to force-acquire with warning

**Network/Shared Filesystems:**
- Use file creation time + hostname for better stale detection
- Consider flock() for additional safety on supported systems

## API Changes

### WorkspaceManager
```typescript
interface WorkspaceManager {
  acquireLock(workspacePath: string): Promise<LockInfo>;
  releaseLock(workspacePath: string): Promise<void>;
  isLocked(workspacePath: string): Promise<boolean>;
  getLockInfo(workspacePath: string): Promise<LockInfo | null>;
}
```

### WorkspaceTracker Enhancement
```typescript
interface WorkspaceInfo {
  // existing fields...
  lockedBy?: {
    pid: number;
    startedAt: string;
    hostname: string;
  };
}
```

## Testing Strategy

1. **Unit Tests:**
   - Lock creation/deletion
   - Stale detection logic
   - Auto-choose algorithm

2. **Integration Tests:**
   - Concurrent workspace access
   - Signal handler cleanup
   - Cross-platform PID checking

3. **Manual Testing:**
   - Kill process and verify stale detection
   - Test on shared filesystems
   - Verify user prompts and warnings