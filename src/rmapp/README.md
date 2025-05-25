# GitHub Agent Implementation

## Overview

This directory contains a comprehensive GitHub agent system that automates issue implementation, PR review handling, and continuous learning. The agent is designed as a modular, extensible system that can handle complex workflows while learning from interactions to improve over time.

## Architecture

### Core Components

1. **State Management** (`state/`)
   - SQLite-based persistence with migrations
   - Event sourcing for audit trail
   - Optimistic locking for concurrent updates
   - Comprehensive state tracking for issues, PRs, workflows

2. **Workflow Engine** (`workflows/`)
   - DAG-based workflow execution
   - State machine with rollback support
   - Concurrent execution with limits
   - Pause/resume capabilities
   - Event-driven architecture

3. **Command System** (`commands/`)
   - Natural language command parsing
   - Multi-format support (mentions, slash commands)
   - Permission checking
   - Batch operation support

4. **Issue Analysis** (`analysis/`)
   - Requirement extraction
   - Task breakdown
   - Reference resolution
   - Complexity scoring
   - Ambiguity detection

5. **Plan Generation** (`planning/`)
   - Strategy-based planning
   - Dependency graph creation
   - Context-aware generation
   - Risk assessment
   - Rollback planning

6. **PR Management** (`pr/`)
   - Automated PR creation
   - Change analysis
   - Description generation
   - Metadata management

7. **Review Handling** (`reviews/`)
   - Comment parsing with intent detection
   - Severity classification
   - Action request extraction
   - Suggestion parsing
   - Thread management

8. **Code Location** (`locator/`)
   - AST-based symbol indexing
   - Diff mapping for PR changes
   - Fuzzy matching with scoring
   - Smart disambiguation
   - Caching with validation

9. **Response System** (`responder/`)
   - Change application via Claude Code
   - Response generation
   - Batch processing
   - Commit management
   - Clarification handling

10. **Batch Operations** (`batch/`)
    - Dependency graph execution
    - Resource management
    - Priority scheduling
    - Progress tracking
    - Recovery handling

11. **Context Gathering** (`context/`)
    - Multi-provider architecture
    - Smart search with query expansion
    - Relevance scoring
    - Recommendation engine
    - Knowledge graph construction

12. **Learning System** (`learning/`)
    - Event collection and processing
    - Pattern detection
    - Behavior learning
    - Preference tracking
    - Decision enhancement

## Usage

### Basic Commands

```bash
# Implement a single issue
@bot implement #123

# Handle review comments
@bot address review comments

# Batch implementation
@bot implement #123, #456, #789

# With options
@bot implement #123 --priority high --assign @user
```

### Programmatic Usage

```typescript
import { GitHubAgent } from './agent.js';

// Initialize agent
const agent = new GitHubAgent({
  github: githubClient,
  llm: llmClient,
  workspacePath: './workspace'
});

await agent.initialize();

// Handle command
const result = await agent.handleCommand('@bot implement #123', {
  user: 'developer',
  source: 'issue_comment'
});

// Get insights from learning
const insights = agent.getLearningInsights();
```

## Workflows

### Issue Implementation Workflow

1. **Fetch & Analyze** - Retrieve issue, extract requirements
2. **Generate Plan** - Create step-by-step implementation plan
3. **Setup Workspace** - Create branch, prepare environment
4. **Implement** - Execute plan steps with verification
5. **Create PR** - Generate PR with full context
6. **Monitor** - Track PR status and handle reviews

### Review Response Workflow

1. **Parse Comments** - Extract actionable feedback
2. **Locate Code** - Map comments to specific locations
3. **Apply Changes** - Make requested modifications
4. **Generate Responses** - Create informative replies
5. **Commit & Push** - Update PR with changes

## Configuration

### Environment Variables

```bash
GITHUB_TOKEN=your_github_token
LLM_API_KEY=your_llm_key
DATABASE_PATH=./data/agent.db
WORKSPACE_PATH=./workspace
LOG_LEVEL=info
```

### Configuration File

```yaml
# .rmapp/config.yml
github:
  owner: your-org
  repo: your-repo
  
llm:
  model: gpt-4
  temperature: 0.7
  
workflows:
  maxConcurrent: 3
  retryAttempts: 3
  timeout: 30m
  
learning:
  enabled: true
  updateInterval: 1h
  minEventsForUpdate: 10
```

## Development

### Running Tests

```bash
# All tests
bun test

# Specific test suite
bun test src/rmapp/tests/e2e

# With coverage
bun test --coverage

# Performance benchmarks
bun test src/rmapp/tests/benchmarks
```

### Adding New Features

1. **Add State** - Extend state manager with new entities
2. **Create Workflow** - Define workflow steps and handlers
3. **Add Commands** - Extend parser with new command formats
4. **Integrate Learning** - Add event collection for new actions
5. **Write Tests** - Add unit, integration, and e2e tests

## Performance

The agent is designed for high performance:

- **Issue Analysis**: ~50ms for simple, ~100ms for complex
- **Plan Generation**: ~200ms average
- **Review Parsing**: ~30ms per review
- **Code Location**: ~10ms with cache
- **Pattern Detection**: ~500ms for 100 events
- **Concurrent Operations**: 2x+ speedup vs sequential

## Learning System

The agent continuously learns from:

- **Successful Implementations** - What approaches work
- **Failed Attempts** - What to avoid
- **User Feedback** - Explicit preferences
- **Code Patterns** - Style and structure preferences
- **Review Patterns** - Common feedback types
- **Workflow Patterns** - Optimal execution strategies

Learning insights include:
- Detected patterns with confidence scores
- Learned behaviors and exceptions
- Team preferences for code, communication, workflow
- Performance metrics and improvement rates

## Security

- **Token Management** - Secure storage, minimal permissions
- **Input Validation** - Command and data sanitization
- **Rate Limiting** - Respect API limits with backoff
- **Audit Trail** - Complete event logging
- **Error Handling** - No sensitive data in logs

## Monitoring

The agent provides comprehensive telemetry:

- **Workflow Metrics** - Success rates, duration, retries
- **API Usage** - Rate limit tracking, error rates
- **Performance** - Response times, memory usage
- **Learning** - Model accuracy, pattern confidence
- **Events** - Detailed activity logging

## Future Enhancements

- **Multi-language Support** - Beyond TypeScript/JavaScript
- **Custom Workflows** - User-defined automation
- **Plugin System** - Extensible architecture
- **Team Collaboration** - Shared learning across teams
- **Advanced Analytics** - Deeper insights and predictions
- **IDE Integration** - Direct editor support

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## License

This project is licensed under the MIT License.