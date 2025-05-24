# Enhanced Command System

## Overview
Extend the command parser and executor to support new agent capabilities beyond simple tool execution.

## Requirements
- Support complex commands with subcommands
- Enable command chaining and conditions
- Provide command history and repeatability
- Add command validation and help
- Implement branch-based command queue to ensure one command per branch at a time

## Implementation Steps

### Step 1: Extend Command Parser
Enhance `src/rmapp/mention_parser.ts`:
```typescript
interface EnhancedCommand extends ParsedCommand {
  type: 'tool' | 'workflow' | 'query' | 'config';
  subcommands?: EnhancedCommand[];
  conditions?: CommandCondition[];
  branch?: string; // Branch this command will operate on
}
```

### Step 2: Define New Commands
Create command definitions in `src/rmapp/commands/definitions.ts`:

```typescript
const WORKFLOW_COMMANDS = {
  implement: {
    description: 'Implement an issue end-to-end',
    args: [{
      name: 'issue',
      type: 'number | string',
      description: 'Issue number or URL'
    }],
    options: {
      plan: 'Path to existing plan (optional)',
      branch: 'Branch name (auto-generated if not provided)',
      'no-pr': 'Skip PR creation'
    }
  },
  
  'apply-review': {
    description: 'Apply changes from a review comment',
    args: [{
      name: 'comment',
      type: 'number | string',
      description: 'Comment ID or URL'
    }],
    options: {
      'auto-commit': 'Commit immediately',
      'batch': 'Batch with other review comments'
    }
  },
  
  status: {
    description: 'Show status of active workflows',
    options: {
      verbose: 'Show detailed status',
      json: 'Output as JSON'
    }
  }
};
```

### Step 3: Implement Command Router
Create `src/rmapp/commands/router.ts`:
```typescript
class CommandRouter {
  private handlers = new Map<string, CommandHandler>();
  
  register(pattern: string, handler: CommandHandler): void {
    this.handlers.set(pattern, handler);
  }
  
  async route(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    const handler = this.findHandler(command);
    if (!handler) {
      throw new CommandError(`Unknown command: ${command.command}`);
    }
    
    await handler.execute(command, context);
  }
}
```

### Step 4: Create Command Handlers
Implement handlers in `src/rmapp/commands/handlers/`:

**ImplementIssueHandler**:
```typescript
class ImplementIssueHandler extends CommandHandler {
  async execute(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    // Parse issue reference
    // Create workflow
    // Start implementation
    // Post initial comment
  }
}
```

**ApplyReviewHandler**:
```typescript
class ApplyReviewHandler extends CommandHandler {
  async execute(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    // Fetch review comment
    // Determine code location
    // Generate changes
    // Apply and commit
    // Respond to comment
  }
}
```

### Step 5: Add Command Validation
Create validation layer:
```typescript
class CommandValidator {
  validate(command: EnhancedCommand): ValidationResult {
    // Check required args
    // Validate option types
    // Check permissions
    // Verify context requirements
  }
}
```

### Step 6: Implement Command Help
Add help system:
```typescript
@bot help                    # List all commands
@bot help implement          # Show specific command help
@bot help --examples         # Show usage examples
```

### Step 7: Add Command History
Track command execution:
```typescript
interface CommandHistory {
  id: string;
  command: EnhancedCommand;
  executedBy: string;
  executedAt: Date;
  workflowId?: string;
  result: 'success' | 'failure';
  duration: number;
  output?: string;
}
```

### Step 8: Implement Branch-Based Command Queue
Create `src/rmapp/commands/queue.ts`:
```typescript
class BranchCommandQueue {
  private activeCommands = new Map<string, CommandExecution>();
  
  async canExecute(command: EnhancedCommand, branch: string): Promise<boolean> {
    return !this.activeCommands.has(branch);
  }
  
  async enqueue(command: EnhancedCommand, branch: string): Promise<void> {
    if (this.activeCommands.has(branch)) {
      throw new Error(`Branch ${branch} already has an active command`);
    }
    
    const execution = {
      command,
      branch,
      startedAt: new Date(),
      status: 'running'
    };
    
    this.activeCommands.set(branch, execution);
  }
  
  async complete(branch: string): Promise<void> {
    this.activeCommands.delete(branch);
  }
  
  getActiveCommands(): CommandExecution[] {
    return Array.from(this.activeCommands.values());
  }
}
```

### Future Enhancement: Interactive Commands
While not implemented in v1, future chatbot mode will support:
- Multi-step conversations within GitHub comments
- Clarifying questions and user responses
- Context-aware dialogue that understands the current task
- Integration with the command system for seamless transitions

Implementation approach:
1. Create a conversation state machine
2. Store conversation context in the state database
3. Parse user responses as follow-up commands
4. Maintain context across multiple GitHub comments
5. Share core logic with future standalone chatbot mode

## Testing Strategy
1. Unit test command parsing
2. Test command validation
3. Test command routing
4. Integration test command execution
5. Test branch queue functionality
6. Test concurrent command handling

## Success Criteria
- [ ] New commands parse correctly
- [ ] Commands validate inputs properly
- [ ] Help system is comprehensive
- [ ] Command history is tracked
- [ ] Branch queue prevents concurrent commands on same branch
- [ ] Failed commands release branch lock