# Workflow Engine

## Overview
Build a robust workflow engine that orchestrates complex multi-step operations like implementing issues or responding to PR reviews.

## Requirements
- Define workflows as state machines
- Support async operations with retries
- Enable workflow composition (sub-workflows)
- Provide hooks for progress updates
- Handle failures gracefully

## Implementation Steps

### Step 1: Extend State Machine System
Enhance existing state machine in `src/state_machine/` for workflows:
- Add persistence integration
- Support long-running operations
- Add workflow-specific node types
- Enable dynamic state machine creation

### Step 2: Define Core Workflows
Create workflow definitions in `src/rmapp/workflows/`:

**IssueImplementationWorkflow**:
```
[Analyzing] → [Planning] → [Implementing] → [Testing] → [CreatingPR] → [Complete]
     ↓             ↓              ↓              ↓            ↓
  [Failed]     [Failed]       [Failed]      [Failed]     [Failed]
```

**PRReviewWorkflow**:
```
[ParsingComment] → [LocatingCode] → [GeneratingFix] → [ApplyingChanges] → [Responding] → [Complete]
         ↓                ↓                 ↓                  ↓                  ↓
     [Failed]         [Failed]          [Failed]           [Failed]          [Failed]
```

### Step 3: Implement Workflow Nodes
Create specialized nodes for each workflow step:

```typescript
class AnalyzeIssueNode extends WorkflowNode {
  async execute(context: IssueContext): Promise<AnalysisResult> {
    // Extract requirements
    // Identify affected areas
    // Determine complexity
    // Return structured analysis
  }
}

class GeneratePlanNode extends WorkflowNode {
  async execute(context: IssueContext): Promise<string> {
    // Use analysis to create rmplan
    // Include relevant files
    // Set appropriate instructions
    // Return plan path
  }
}
```

### Step 4: Create Workflow Context
Design context objects that flow through workflows:
```typescript
interface WorkflowContext {
  id: string;
  githubEvent: WebhookEvent;
  workspace?: Workspace;
  artifacts: Map<string, any>;
  
  // Methods
  saveArtifact(key: string, value: any): void;
  getArtifact<T>(key: string): T | undefined;
  updateProgress(message: string): Promise<void>;
}
```

### Step 5: Add Workflow Executor
Create `src/rmapp/workflows/executor.ts`:
```typescript
class WorkflowExecutor {
  constructor(
    private store: StateStore,
    private github: GitHubClient
  ) {}
  
  async execute(workflow: Workflow, context: WorkflowContext): Promise<void> {
    // Load workflow state
    // Execute current node
    // Handle transitions
    // Update persistence
    // Post progress updates
  }
  
  async resume(workflowId: string): Promise<void> {
    // Load interrupted workflow
    // Restore context
    // Continue execution
  }
}
```

### Step 6: Implement Retry Logic
Add intelligent retry mechanisms:
- Exponential backoff for API calls
- Different strategies per node type
- Max retry limits
- Retry state persistence

### Step 7: Add Workflow Monitoring
Create telemetry and monitoring:
- OpenTelemetry spans for each node
- Metrics for success/failure rates
- Timing information
- Error categorization

### Step 8: Create Workflow Templates
Build reusable workflow patterns:
- Simple issue implementation
- Complex feature implementation
- Bug fix workflow
- Documentation update workflow
- Review response workflow

## Testing Strategy
1. Unit test each workflow node
2. Integration test complete workflows
3. Test failure scenarios and recovery
4. Test concurrent workflow execution
5. Load test with multiple workflows

## Success Criteria
- [ ] Workflows execute reliably end-to-end
- [ ] Failed workflows can be resumed
- [ ] Progress is visible throughout execution
- [ ] Workflows complete within reasonable time
- [ ] System handles multiple concurrent workflows