## LLMUtils Bot System Specification

### Overview
A unified bot service that enables AI-powered development workflows through GitHub and Discord, leveraging the existing llmutils capabilities for plan generation, implementation, and PR response.

### Core Features

#### 1. Command Interface

**GitHub Commands** (in issue/PR comments):
- `@bot plan` - Generate a plan from the issue
- `@bot implement` - Create workspace and implement the plan
- `@bot respond` - Address PR review comments (PR only)

**Discord Commands**:
- `/rm-plan <issue-url>` - Generate a plan for an issue
- `/rm-implement <issue-url>` - Implement an existing plan
- `/rm-status [task-id]` - Check task status
- `/rm-link <github-username>` - Self-register GitHub account
- `/rm-cancel <task-id>` - Cancel a running task
- `/rm-logs <task-id>` - Retrieve task logs

**Admin Discord Commands**:
- `/rm-link-user <github-username> <discord-id>` - Manual user mapping
- `/rm-cleanup` - Manual workspace cleanup
- `/rm-status-all` - View all active tasks

#### 2. Architecture

**Single Service Design**:
- Unified service handling both GitHub and Discord
- SQLite database for all state management
- Docker container deployment
- Automatic crash recovery with task resumption

**Database Schema**:
```sql
-- Core task tracking
tasks (
  id PRIMARY KEY,
  issue_number,
  repository,
  branch,
  status, -- planning, implementing, pr_created, responding, completed, failed
  workspace_path,
  plan_file_path,
  pr_number,
  created_at,
  updated_at,
  created_by_platform, -- github/discord
  created_by_user
)

-- Thread synchronization
threads (
  id PRIMARY KEY,
  task_id,
  platform, -- github/discord
  external_id, -- issue comment thread ID or Discord thread ID
  thread_url,
  created_at
)

-- User identity mapping
user_mappings (
  github_username PRIMARY KEY,
  discord_user_id,
  verified,
  mapped_at,
  mapped_by -- self/admin
)

-- Workspace tracking (migrated from YAML)
workspaces (
  id PRIMARY KEY,
  task_id,
  repository_url,
  workspace_path,
  branch,
  original_plan_file,
  created_at,
  last_accessed_at,
  locked_by_task_id
)

-- Task execution logs
task_logs (
  id PRIMARY KEY,
  task_id,
  timestamp,
  log_level, -- info/warning/error
  message,
  full_content -- for large outputs
)

-- Command audit trail
command_history (
  id PRIMARY KEY,
  command,
  task_id,
  user_platform,
  user_id,
  timestamp,
  status -- success/failed
)

-- Task checkpoints for resumption
task_checkpoints (
  task_id PRIMARY KEY,
  checkpoint_data, -- JSON blob
  step_index,
  updated_at
)

-- Task artifacts
task_artifacts (
  id PRIMARY KEY,
  task_id,
  artifact_type, -- plan/pr/log_file
  artifact_path,
  created_at
)
```

#### 3. Workflow Synchronization

**Cross-Platform Threading**:
- GitHub issue/PR triggers create Discord threads: "Issue #123: [title]"
- Discord commands create GitHub comment threads
- All updates posted to both platforms
- Progress updates in Discord as steps complete
- GitHub comments updated in-place with status

**Progress Tracking**:
- Capture and post `TodoWrite` tool invocations from Claude Code
- Post step completion updates
- Store full logs with retrieval commands
- Error details appropriate to each platform

#### 4. Workspace Management

**Workspace Strategy**:
- One workspace per task
- Dedicated bot workspace directory
- Automatic cleanup after 1 week of inactivity
- Workspace locking per issue/PR (one active task at a time)
- Integration with existing workspace manager

**Execution Environment**:
- Direct repository access (branch creation, PRs)
- Claude Code executor as default
- Concurrent task execution (except per-issue serialization)
- Resource limits configurable per deployment

#### 5. Authentication & Permissions

**GitHub**:
- Verify write access to repository
- Bot requires: repo (full), issues, pull requests permissions
- Ignore commands from users without write access

**Discord**:
- Self-registration via `/rm-link <github-username>`
- Admin mapping override capability  
- Unmapped users receive error message

**User Mapping Verification** (for self-registration):
- User runs `/rm-link <github-username>`
- Bot creates a unique code
- User creates gist/comment with code
- Bot verifies and completes mapping

#### 6. Configuration

**Environment Variables**:
- `GITHUB_TOKEN` - GitHub App/PAT token
- `DISCORD_TOKEN` - Discord bot token
- `DATABASE_PATH` - SQLite database location
- `WORKSPACE_BASE_DIR` - Root directory for workspaces
- `LOG_RETENTION_DAYS` - How long to keep logs

**Repository Configuration**:
- Use existing `.rmfilter/config/rmplan.yml`
- Default plan save location from config
- Claude Code executor configuration
- Model selection (from rmplan config)

#### 7. Automation Defaults

**Plan Generation**:
- Save to configured path with issue-based filename
- No interactive prompts - use defaults

**Implementation**:
- Always use Claude Code executor
- Auto-create PR on completion
- PR title from issue title
- PR body includes Discord thread link

**Error Handling**:
- Full errors to Discord
- Summary errors to GitHub
- Admin notification for critical failures

#### 8. Implementation Priority

**Phase 1 (MVP)** (already implemented):
1. Basic GitHub webhook handling
2. Discord slash commands
3. SQLite schema and migrations
4. Plan generation workflow
5. Thread synchronization
6. User permission checking

**Phase 2**:
1. Implementation workflow
2. PR creation
3. Workspace management
4. Progress tracking
5. Log storage/retrieval

**Phase 3**:
1. PR response handling
2. Self-registration system
3. Admin commands
4. Automatic cleanup
5. Crash recovery

**Future Enhancements**:
- Web dashboard
- Rate limiting
- Multiple executor support
- Automatic PR review response

### Security Considerations

- Validate all webhook signatures
- Sanitize user inputs
- No arbitrary command execution outside Claude Code
- Workspace isolation per task
- Regular cleanup of sensitive data
- Audit logging for all commands

### Deployment

- Docker container with health checks
- Persistent volume for SQLite and workspaces
- Environment-based configuration
- Graceful shutdown handling
- Automatic restart on failure
- Task resumption on startup

This specification provides a complete blueprint for implementing the bot system with all the features and behaviors we've discussed. The phased approach allows for iterative development while maintaining a clear vision of the complete system.

Phase 1 has been implemented. Please create the plan for phase 2.
