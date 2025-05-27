# LLMUtils Bot

The LLMUtils Bot is a unified service that enables AI-powered development workflows through GitHub and Discord integration. It leverages the existing llmutils capabilities for plan generation, implementation, and pull request response handling.

## Features

### Core Capabilities

- **GitHub Integration**: Respond to commands in issues and PRs (`@bot plan`, `@bot implement`, `@bot respond`)
- **Discord Commands**: Full task management through slash commands
- **Automated Workflows**: Plan generation, implementation, and PR creation
- **Cross-Platform Sync**: Automatic thread synchronization between GitHub and Discord

### Phase 3 Features

- **PR Response Handling**: Automatically address PR review comments
- **User Self-Registration**: Link GitHub and Discord accounts securely
- **Admin Commands**: Manage users and system maintenance
- **Automatic Cleanup**: Periodic cleanup of workspaces and logs
- **Crash Recovery**: Resume interrupted tasks automatically

## Setup

### Prerequisites

- Node.js (via Bun)
- SQLite
- GitHub App or Personal Access Token
- Discord Bot Token

### Installation

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
bun install
```

2. Copy the environment variables template:

```bash
cp .env.example .env
```

3. Configure your environment variables:

```env
# GitHub Configuration
GITHUB_TOKEN=your_github_token
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Discord Configuration
DISCORD_TOKEN=your_discord_token
DISCORD_CLIENT_ID=your_discord_client_id

# Database Configuration
DATABASE_PATH=./bot_database.sqlite

# Admin Configuration
ADMIN_DISCORD_USER_IDS=your_discord_id
```

4. Initialize the database:

```bash
bun run src/bot/db/migrate.ts
```

5. Start the bot:

```bash
bun run src/bot/main.ts
```

## GitHub Setup

### Creating a GitHub App

1. Go to Settings > Developer settings > GitHub Apps
2. Click "New GitHub App"
3. Configure the app with these permissions:

   - **Repository permissions**:
     - Contents: Read & Write
     - Issues: Read & Write
     - Pull requests: Read & Write
     - Metadata: Read
   - **Subscribe to events**:
     - Issue comment
     - Pull request
     - Pull request review comment

4. Set the webhook URL to `https://your-domain.com/webhook`
5. Generate and save the webhook secret
6. Install the app on your repositories

### Using a Personal Access Token

If you prefer using a PAT instead of a GitHub App:

1. Generate a token with `repo` scope
2. Set `GITHUB_TOKEN` in your `.env` file

## Discord Setup

### Creating a Discord Bot

1. Go to https://discord.com/developers/applications
2. Click "New Application" and name your bot
3. Go to the "Bot" section
4. Click "Reset Token" and save the token
5. Enable "Message Content Intent" if needed
6. Go to "OAuth2" > "URL Generator"
7. Select scopes: `bot`, `applications.commands`
8. Select permissions: `Send Messages`, `Create Public Threads`, `Send Messages in Threads`
9. Use the generated URL to add the bot to your server

### Registering Slash Commands

The bot automatically registers slash commands on startup. Available commands:

**User Commands:**

- `/rm-plan <issue-url>` - Generate a plan from a GitHub issue
- `/rm-implement <issue-url>` - Implement an existing plan
- `/rm-status [task-id]` - Check task status
- `/rm-cancel <task-id>` - Cancel a running task
- `/rm-logs <task-id>` - Retrieve task logs
- `/rm-link <github-username>` - Link your GitHub account
- `/rm-verify-gist <gist-url>` - Complete account verification

**Admin Commands:**

- `/rm-link-user` - Manually link users
- `/rm-cleanup` - Trigger manual cleanup
- `/rm-status-all` - View all active tasks

## Deployment

### Docker Deployment

1. Build the Docker image:

```bash
docker build -t llmutils-bot .
```

2. Create a docker-compose.yml:

```yaml
version: '3.8'
services:
  bot:
    image: llmutils-bot
    environment:
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - DISCORD_TOKEN=${DISCORD_TOKEN}
      - DATABASE_PATH=/data/bot.db
      - WORKSPACE_BASE_DIR=/data/workspaces
    volumes:
      - ./data:/data
    ports:
      - '3000:3000'
    restart: unless-stopped
```

3. Start the service:

```bash
docker-compose up -d
```

### Manual Deployment

For production deployment without Docker:

1. Set up a systemd service (Linux):

```ini
[Unit]
Description=LLMUtils Bot
After=network.target

[Service]
Type=simple
User=botuser
WorkingDirectory=/opt/llmutils
ExecStart=/usr/local/bin/bun run src/bot/main.ts
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

2. Enable and start the service:

```bash
sudo systemctl enable llmutils-bot
sudo systemctl start llmutils-bot
```

## Configuration

### Workspace Management

The bot creates isolated workspaces for each task:

- Location: `WORKSPACE_BASE_DIR`
- Retention: `WORKSPACE_RETENTION_DAYS` (default: 7 days)
- Automatic cleanup runs every `CLEANUP_INTERVAL_HOURS`

### Model Configuration

Configure the default AI model:

```env
DEFAULT_MODEL=google/gemini-2.5-pro-latest
GOOGLE_GENERATIVE_AI_API_KEY=your_api_key
```

### Admin Users

Set admin Discord user IDs:

```env
ADMIN_DISCORD_USER_IDS=123456789012345678,987654321098765432
```

## User Self-Registration

Users can link their GitHub and Discord accounts:

1. Run `/rm-link <github-username>` in Discord
2. Bot provides a unique verification code
3. Create a GitHub Gist with the code
4. Run `/rm-verify-gist <gist-url>` to complete verification

## Monitoring

### Logs

- Application logs: Controlled by `LOG_LEVEL`
- Task logs: Stored in database, retained for `LOG_RETENTION_DAYS`
- Use `/rm-logs <task-id>` to retrieve specific task logs

### Health Checks

The bot exposes a health endpoint at `GET /health` for monitoring.

### Database Maintenance

The bot automatically maintains the SQLite database:

- Cleanup of old logs based on retention settings
- Vacuum operations during cleanup cycles

## Troubleshooting

### Common Issues

1. **"User not mapped" error**:

   - User needs to run `/rm-link` command
   - Admin can manually map with `/rm-link-user`

2. **Webhook not receiving events**:

   - Verify webhook secret matches
   - Check GitHub App installation
   - Ensure webhook URL is accessible

3. **Commands not showing in Discord**:

   - Bot needs `applications.commands` scope
   - May take up to an hour to propagate globally
   - Try kicking and re-adding the bot

4. **Task stuck in "implementing"**:
   - Check `/rm-logs <task-id>` for errors
   - Use `/rm-cancel <task-id>` if needed
   - Bot will attempt recovery on restart

### Debug Mode

Enable debug logging:

```env
LOG_LEVEL=debug
```

## Security Considerations

- Webhook signatures are validated for all GitHub events
- User permissions are checked before executing commands
- Workspaces are isolated per task
- Sensitive data is not logged
- Regular cleanup prevents data accumulation

## Contributing

See the main project README for contribution guidelines. When working on the bot:

1. Test with a development Discord server
2. Use a test GitHub repository
3. Ensure database migrations are included
4. Add tests for new features
5. Update this documentation
