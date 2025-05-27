# LLMUtils Bot Architecture Guide

## Overview

The LLMUtils Bot is a unified service that bridges GitHub and Discord to enable AI-powered development workflows. It leverages the existing llmutils capabilities (rmplan, rmfilter, rmpr) to generate plans from issues, implement those plans automatically, and respond to pull request review comments.

## Core Architecture

### Single Service Design

The bot runs as a single Node.js service using Bun as the runtime. Key design principles:

- **Unified Service**: One service handles both GitHub webhooks and Discord slash commands
- **SQLite Database**: All state is stored in a local SQLite database for persistence
- **Background Processing**: Commands trigger asynchronous tasks that run in the background
- **Cross-Platform Synchronization**: Actions initiated on one platform are mirrored to the other

### Entry Points

The bot has three main entry points:

1. **`src/bot/main.ts`**: The main entry point that orchestrates startup
   - Loads configuration from environment variables
   - Initializes logging with a console adapter
   - Starts the HTTP server for GitHub webhooks
   - Starts the Discord bot client
   - Schedules automatic cleanup tasks
   - Handles graceful shutdown

2. **`src/bot/server.ts`**: HTTP server for GitHub webhooks
   - Listens on the configured port (default 3000)
   - Routes `/webhooks/github` to the GitHub handler
   - Provides a `/health` endpoint for monitoring

3. **`src/bot/discord_bot.ts`**: Discord bot client
   - Registers slash commands with Discord
   - Handles user interactions
   - Manages command routing

## Database Schema

The bot uses SQLite with Drizzle ORM. The schema includes:

### Core Tables

- **`tasks`**: Central table tracking all bot tasks
  - Stores task metadata (type, status, issue/PR info)
  - Links to workspaces, plans, and PRs
  - Tracks who initiated the task and from which platform

- **`threads`**: Synchronizes conversations across platforms
  - Maps task IDs to Discord threads and GitHub comments
  - Stores URLs for cross-linking

- **`user_mappings`**: Links GitHub usernames to Discord user IDs
  - Supports both admin mapping and self-registration
  - Includes verification system for self-registration

- **`workspaces`**: Tracks git workspaces used for implementation
  - One workspace per task
  - Includes locking mechanism to prevent conflicts
  - Tracks last access time for cleanup

### Supporting Tables

- **`task_logs`**: Detailed execution logs for each task
- **`command_history`**: Audit trail of all commands received
- **`task_artifacts`**: File paths for generated plans and other outputs
- **`task_checkpoints`**: Enables crash recovery by saving task state

## Core Components

### Task Manager (`src/bot/core/task_manager.ts`)

The heart of the bot's task orchestration:

- **Task Creation**: Creates and manages task records in the database
- **Plan Generation**: Orchestrates the plan generation workflow
  1. Fetches issue content from GitHub
  2. Runs rmfilter to gather code context
  3. Calls LLM to generate structured plan
  4. Converts markdown plan to YAML
  5. Saves plan artifacts
  
- **Implementation**: Manages the implementation workflow
  1. Finds existing plan for the issue
  2. Sets up isolated workspace
  3. Invokes rmplan agent to execute the plan
  4. Creates pull request upon completion
  5. Real-time progress tracking with GitHub comment updates

### Thread Manager (`src/bot/core/thread_manager.ts`)

Handles cross-platform communication:

- **Notification System**: Posts updates to both GitHub and Discord
- **Thread Creation**: Creates Discord threads for GitHub issues
- **Comment Synchronization**: Updates GitHub comments with task progress
- **User Mapping**: Resolves Discord users to GitHub usernames and vice versa

### Auth Manager (`src/bot/core/auth_manager.ts`)

Enforces security:

- **Permission Checks**: Verifies GitHub users have write access before processing commands
- **Token Validation**: Uses GitHub API to check collaborator permissions
- **Graceful Fallbacks**: Allows permissive mode when tokens are missing (development)

### Plan Generator (`src/bot/core/plan_generator.ts`)

Orchestrates AI-powered planning:

1. **Issue Parsing**: Extracts instructions and file context hints from issues
2. **Context Gathering**: Uses rmfilter to collect relevant code files
3. **LLM Integration**: Sends context to AI model for plan generation
4. **Format Conversion**: Transforms markdown plans to structured YAML

## Service Layer

### PR Response Service (`src/bot/pr_response_service.ts`)

Handles the `@bot respond` command:

- **Comment Processing**: Fetches and analyzes PR review comments
- **Context Building**: Gathers relevant code changes and discussions
- **Response Generation**: Uses AI to generate helpful responses
- **Checkpoint Support**: Saves progress for crash recovery

### Cleanup Service (`src/bot/cleanup_service.ts`)

Automated maintenance:

- **Workspace Cleanup**: Removes workspaces inactive for >1 week
- **Log Cleanup**: Deletes logs older than configured retention period
- **Scheduled Execution**: Runs every 24 hours by default

### Crash Recovery Service (`src/bot/crash_recovery_service.ts`)

Resilience mechanism:

- **Checkpoint System**: Tasks save progress at key points
- **Startup Recovery**: Checks for interrupted tasks on bot restart
- **Resume Logic**: Continues tasks from last checkpoint
- **Failure Handling**: Marks unrecoverable tasks as failed

## Command Processing Flow

### GitHub Commands

1. **Webhook Receipt**: GitHub sends webhook to `/webhooks/github`
2. **Signature Verification**: Validates webhook authenticity
3. **Command Parsing**: Extracts bot commands from issue/PR comments
4. **Permission Check**: Verifies user has repository write access
5. **Task Creation**: Creates task record and starts async processing
6. **Background Execution**: Task runs independently of webhook response

Supported GitHub commands:
- `@bot plan` - Generate a plan from an issue
- `@bot implement` - Implement an existing plan
- `@bot respond` - Address PR review comments
- `@bot verify <code>` - Part of self-registration flow

### Discord Commands

1. **Slash Command**: User invokes command in Discord
2. **Authentication**: Checks user mapping (GitHub ↔ Discord)
3. **Repository Validation**: Ensures target repository is configured
4. **Task Creation**: Creates task and provides immediate feedback
5. **Thread Creation**: Spawns Discord thread for ongoing updates

Supported Discord commands:
- `/rm-plan <issue-url>` - Generate a plan
- `/rm-implement <issue-url>` - Implement a plan
- `/rm-status [task-id]` - Check task status
- `/rm-logs <task-id>` - Retrieve execution logs
- `/rm-register <github-username>` - Start self-registration
- `/rm-verify <code>` - Complete registration
- `/rm-verify-gist <gist-url>` - Verify via GitHub Gist

Admin commands:
- `/rm-link-user <github> <discord>` - Manual user mapping
- `/rm-cleanup` - Trigger manual cleanup
- `/rm-status-all` - View all active tasks

## Workspace Management

The bot integrates with the existing rmplan workspace system:

### Workspace Strategy

- **Isolation**: One workspace per task prevents conflicts
- **Location**: Stored under `WORKSPACE_BASE_DIR/workspaces/`
- **Locking**: Database-level locks prevent concurrent access
- **Cleanup**: Automatic removal after 1 week of inactivity

### Workspace Lifecycle

1. **Selection**: Tries to reuse existing workspace or creates new
2. **Locking**: Sets `lockedByTaskId` in database
3. **Usage**: Workspace is exclusive to the task
4. **Release**: Lock cleared on task completion
5. **Cleanup**: Removed by cleanup service when stale

## User Registration System

### Self-Registration Flow

1. **Initiation**: User runs `/rm-register <github-username>`
2. **Code Generation**: Bot creates unique verification code
3. **Verification Options**:
   - Create GitHub Gist with code
   - Comment on issue with `@bot verify <code>`
4. **Completion**: User confirms with `/rm-verify` or `/rm-verify-gist`
5. **Validation**: Bot verifies ownership and links accounts

### Security Measures

- Verification codes expire after 10 minutes
- Codes are cryptographically random
- One verified mapping per GitHub/Discord account
- Admin override available for manual mapping

## Progress Tracking

The bot provides detailed progress tracking:

### Implementation Progress

- **Step Counter**: Tracks completed vs total steps
- **Progress Bar**: Visual representation in GitHub comments
- **Time Tracking**: Shows elapsed time
- **Current Step**: Displays active operation
- **Real-time Updates**: GitHub comment updated in-place

### Logging System

- **Database Adapter**: Captures all rmplan agent output
- **Log Levels**: Supports debug, info, warn, error
- **Retrieval**: Available via `/rm-logs` command
- **Retention**: Configurable cleanup period

## Error Handling

### Graceful Degradation

- **Permission Failures**: Clear error messages, no action taken
- **Missing Repositories**: Guides users to contact admin
- **LLM Failures**: Captured in task logs, user notified
- **Network Issues**: Retries with exponential backoff

### Recovery Mechanisms

- **Checkpoints**: Tasks save state at critical points
- **Idempotency**: Operations designed to be safely retried
- **Status Tracking**: Clear indication of failure points
- **Manual Intervention**: Admin commands for recovery

## Configuration

### Environment Variables

Required:
- `GITHUB_TOKEN`: GitHub API access token
- `DISCORD_TOKEN`: Discord bot token
- `DATABASE_PATH`: SQLite database location
- `WORKSPACE_BASE_DIR`: Root directory for workspaces

Optional:
- `BOT_SERVER_PORT`: HTTP server port (default: 3000)
- `LOG_RETENTION_DAYS`: Log retention period (default: 30)
- `LOG_LEVEL`: Logging verbosity (default: info)
- `GITHUB_WEBHOOK_SECRET`: Webhook signature validation
- `PLANNING_MODEL`: AI model for plan generation
- `DISCORD_DEFAULT_CHANNEL_ID`: Fallback Discord channel
- `ADMIN_DISCORD_USER_IDS`: Comma-separated admin list

### Repository Configuration

The bot respects existing rmplan configuration:
- `.rmfilter/config/rmplan.yml`: Model selection, executor settings
- Plan locations follow repository conventions
- Inherits autofind and other rmplan features

## Deployment Considerations

### Docker Deployment

The bot is designed for containerized deployment:
- Single container with mounted volumes
- Persistent storage for database and workspaces
- Environment-based configuration
- Health check endpoint for monitoring

### Resource Requirements

- **CPU**: Moderate usage during LLM calls
- **Memory**: ~500MB baseline, spikes during implementation
- **Storage**: Depends on workspace retention and log volume
- **Network**: Requires outbound HTTPS to GitHub, Discord, and AI providers

### Security Best Practices

1. **Token Security**: Never commit tokens to repository
2. **Webhook Validation**: Always verify GitHub signatures in production
3. **Permission Model**: Restrict commands to repository collaborators
4. **Audit Logging**: Command history provides accountability
5. **Workspace Isolation**: Each task gets isolated filesystem access

## Integration Points

### With Existing LLMUtils Tools

- **rmfilter**: Gathers code context for planning
- **rmplan**: Executes implementation plans
- **rmpr**: Handles PR review responses
- **apply-llm-edits**: Applies AI-generated code changes

### External Services

- **GitHub API**: Issue/PR data, permissions, comments
- **Discord API**: Slash commands, threads, messages
- **AI Providers**: Plan generation and code suggestions
- **Git**: Repository operations within workspaces

## Future Enhancements

The architecture supports several planned improvements:

1. **Web Dashboard**: SQLite schema enables web-based monitoring
2. **Rate Limiting**: Command history enables throttling
3. **Multiple Executors**: Task manager can support various executors
4. **Automatic PR Reviews**: Thread system can handle review events
5. **Metrics & Analytics**: Database provides rich operational data

## Summary

The LLMUtils Bot demonstrates a well-architected approach to AI-powered development automation:

- **Unified Design**: Single service simplifies deployment and maintenance
- **Robust State Management**: SQLite provides reliable persistence
- **Cross-Platform Integration**: Seamless GitHub-Discord synchronization
- **Resilient Operation**: Checkpoint-based crash recovery
- **Security-First**: Permission checks and audit trails
- **User-Friendly**: Clear progress tracking and error messages

The modular architecture makes it easy to extend with new commands, platforms, or AI capabilities while maintaining reliability and security.