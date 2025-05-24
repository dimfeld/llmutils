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
Create specialized nodes for each workflow step that leverage Claude Code:

```typescript
class AnalyzeIssueNode extends WorkflowNode {
  async execute(context: IssueContext): Promise<AnalysisResult> {
    // Use Claude Code to analyze the issue
    const executor = new ClaudeCodeExecutor(
      {
        allowedTools: ['Read', 'Glob', 'Grep'],
        includeDefaultTools: false
      },
      { model: 'sonnet' },
      context.rmplanConfig
    );
    
    const prompt = `Analyze this GitHub issue and extract:
- Key requirements
- Affected files and areas
- Suggested implementation approach

Issue: ${context.issue.title}
${context.issue.body}`;
    
    const result = await executor.execute(prompt);
    return parseAnalysisResult(result);
  }
}

class ImplementStepNode extends WorkflowNode {
  async execute(context: WorkflowContext): Promise<void> {
    // Use Claude Code with full capabilities for implementation
    const executor = new ClaudeCodeExecutor(
      {
        includeDefaultTools: true,
        allowedTools: ['TodoWrite', 'TodoRead']
      },
      { model: 'sonnet' },
      context.rmplanConfig
    );
    
    await executor.execute(context.stepInstructions);
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

### Step 6: Implement Failure Handling
For v1, implement manual intervention for failures:
- Post failure details as GitHub comment
- Include error message and context
- Provide instructions for manual resolution
- Allow workflow cancellation via comment

Future enhancement options:
1. **Automatic retry with backoff**:
   - Exponential backoff for transient failures
   - Different retry strategies per node type
   - Configurable retry limits
   - State persistence between retries

2. **Smart recovery**:
   - Analyze failure type
   - Attempt automatic fixes for known issues
   - Rollback to last known good state
   - Resume from specific workflow step

3. **Failure categorization**:
   - Transient (network, rate limits) → auto-retry
   - Configuration (missing permissions) → notify and wait
   - Logic errors → require manual intervention
   - Infrastructure (out of disk) → escalate

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