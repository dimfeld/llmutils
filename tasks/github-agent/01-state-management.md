# State Management System

## Overview
Implement a persistent state management system to track active workflows, issues, PRs, and agent actions across server restarts.

## Requirements
- Track multiple concurrent workflows
- Persist state across server restarts
- Support atomic state updates
- Enable workflow recovery after failures
- Provide audit trail of actions

## Implementation Steps

### Step 1: Design State Schema
Create TypeScript interfaces and database schema for tracking:
- Issue workflows (issue → plan → implementation → PR)
- PR review workflows (comment → changes → response)
- Workspace states (active, completed, failed)
- Command history and results

### Step 2: Implement SQLite Storage Backend
Use SQLite as the storage backend for the following reasons:
- Embedded database with no external dependencies
- Sufficient for handling concurrent workflows
- Simple deployment and maintenance
- Easy backup and migration

Implementation considerations:
- Use WAL mode for better concurrent access
- Implement proper connection pooling
- Add indexes for common query patterns
- Include database migration system from the start

### Step 3: Implement State Store
Create `src/rmapp/state/store.ts`:
```typescript
interface StateStore {
  // Workflow operations
  createWorkflow(type: 'issue' | 'pr', metadata: any): Promise<string>;
  updateWorkflow(id: string, updates: Partial<Workflow>): Promise<void>;
  getWorkflow(id: string): Promise<Workflow | null>;
  listActiveWorkflows(): Promise<Workflow[]>;
  
  // Transaction support
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  
  // Cleanup
  archiveCompletedWorkflows(olderThan: Date): Promise<number>;
}
```

### Step 4: Create Workflow Models
Implement domain models in `src/rmapp/state/models.ts`:
- `IssueWorkflow` - tracks issue implementation lifecycle
- `PRReviewWorkflow` - tracks review response lifecycle
- `WorkspaceInfo` - links workflows to workspaces
- `CommandExecution` - audit trail of commands

### Step 5: Add State Migrations
Create migration system for schema evolution:
- Version tracking
- Up/down migrations
- Automatic migration on startup

### Step 6: Implement State Recovery
Add recovery mechanisms:
- Detect interrupted workflows on startup
- Resume or cleanup based on state
- Handle zombie workspaces
- Emit telemetry for monitoring

### Step 7: Add State Observers
Implement event system for state changes:
- Workflow status updates → post to GitHub
- Failure events → cleanup and notify
- Progress events → update comments

### Step 8: Create State CLI
Add debugging commands:
```bash
rmapp state list              # List active workflows
rmapp state show <id>         # Show workflow details
rmapp state cleanup           # Clean up failed workflows
rmapp state export            # Export state for debugging
```

## Testing Strategy
1. Unit tests for state operations
2. Integration tests with real database
3. Concurrent access tests
4. Recovery scenario tests
5. Migration tests

## Success Criteria
- [ ] State persists across server restarts
- [ ] Multiple workflows can run concurrently
- [ ] Failed workflows can be recovered
- [ ] State changes are atomic and consistent
- [ ] Audit trail is complete and queryable