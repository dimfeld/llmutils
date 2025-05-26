# LLMUtils Bot Deployment Guide

This guide covers deploying the LLMUtils Bot in production environments.

## Prerequisites

- Docker and Docker Compose (recommended)
- OR Bun runtime environment
- GitHub App or Personal Access Token
- Discord Bot Token
- Domain with HTTPS for GitHub webhooks

## Quick Start with Docker

1. Clone the repository:

```bash
git clone https://github.com/dimfeld/llmutils.git
cd llmutils
```

2. Create your environment file:

```bash
cp .env.example .env
# Edit .env with your tokens and configuration
```

3. Build and start the bot:

```bash
docker-compose up -d
```

4. Check the logs:

```bash
docker-compose logs -f llmutils-bot
```

## Production Configuration

### Environment Variables

Required variables:

- `GITHUB_TOKEN` - GitHub authentication token
- `GITHUB_WEBHOOK_SECRET` - Secret for validating webhooks
- `DISCORD_TOKEN` - Discord bot token
- `DATABASE_PATH` - Path to SQLite database
- `WORKSPACE_BASE_DIR` - Directory for task workspaces

### GitHub Webhook Configuration

1. Set up a reverse proxy (nginx example):

```nginx
server {
    listen 443 ssl;
    server_name bot.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /webhook {
        proxy_pass http://localhost:3000/webhook;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

2. Configure your GitHub App webhook URL:
   - URL: `https://bot.yourdomain.com/webhook`
   - Secret: Match `GITHUB_WEBHOOK_SECRET` in your .env

### Database Backup

Set up regular SQLite backups:

```bash
#!/bin/bash
# backup-bot-db.sh
BACKUP_DIR="/backups/llmutils-bot"
DB_PATH="/data/bot.db"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
sqlite3 $DB_PATH ".backup '$BACKUP_DIR/bot_$DATE.db'"

# Keep only last 7 days of backups
find $BACKUP_DIR -name "bot_*.db" -mtime +7 -delete
```

Add to crontab:

```cron
0 */6 * * * /path/to/backup-bot-db.sh
```

## Deployment Options

### Option 1: Docker Compose (Recommended)

Use the provided docker-compose.yml with modifications:

```yaml
version: '3.8'
services:
  llmutils-bot:
    image: llmutils-bot:latest
    restart: always
    env_file: .env
    volumes:
      - ./data:/data
      - ./config:/app/.rmfilter:ro
    ports:
      - '127.0.0.1:3000:3000' # Only expose locally
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
```

### Option 2: Kubernetes

Example deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llmutils-bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: llmutils-bot
  template:
    metadata:
      labels:
        app: llmutils-bot
    spec:
      containers:
        - name: bot
          image: llmutils-bot:latest
          envFrom:
            - secretRef:
                name: llmutils-bot-secrets
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests:
              memory: '512Mi'
              cpu: '250m'
            limits:
              memory: '2Gi'
              cpu: '1'
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: llmutils-bot-pvc
```

### Option 3: Systemd Service

For VPS or bare metal deployment:

1. Create service file `/etc/systemd/system/llmutils-bot.service`:

```ini
[Unit]
Description=LLMUtils Bot
After=network.target

[Service]
Type=simple
User=llmbot
Group=llmbot
WorkingDirectory=/opt/llmutils
ExecStart=/usr/local/bin/bun run src/bot/main.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/llmutils/.env

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/llmutils/data

[Install]
WantedBy=multi-user.target
```

2. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable llmutils-bot
sudo systemctl start llmutils-bot
```

## Monitoring

### Health Checks

The bot exposes a health endpoint:

```bash
curl http://localhost:3000/health
```

### Prometheus Metrics (if implemented)

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'llmutils-bot'
    static_configs:
      - targets: ['localhost:3000']
```

### Log Aggregation

For production, consider shipping logs to a centralized system:

```yaml
# docker-compose with logging
services:
  llmutils-bot:
    logging:
      driver: 'syslog'
      options:
        syslog-address: 'udp://logserver:514'
        tag: 'llmutils-bot'
```

## Security Hardening

### Network Security

1. Use a firewall to restrict access:

```bash
# UFW example
sudo ufw allow from 10.0.0.0/24 to any port 3000
sudo ufw allow 443/tcp  # For webhook proxy
```

2. Set up fail2ban for the webhook endpoint

### File Permissions

```bash
# Secure the data directory
chmod 750 /opt/llmutils/data
chown -R llmbot:llmbot /opt/llmutils/data

# Protect environment file
chmod 600 /opt/llmutils/.env
chown llmbot:llmbot /opt/llmutils/.env
```

### Secrets Management

Consider using a secrets manager in production:

- AWS Secrets Manager
- HashiCorp Vault
- Kubernetes Secrets
- Docker Secrets

Example with Docker Secrets:

```yaml
services:
  llmutils-bot:
    secrets:
      - github_token
      - discord_token
    environment:
      GITHUB_TOKEN_FILE: /run/secrets/github_token
      DISCORD_TOKEN_FILE: /run/secrets/discord_token

secrets:
  github_token:
    external: true
  discord_token:
    external: true
```

## Scaling Considerations

### Database

For high-load scenarios, consider:

- WAL mode for better concurrency: `PRAGMA journal_mode=WAL;`
- Regular VACUUM operations
- Migration to PostgreSQL for better performance

### Workspace Management

- Use fast SSD storage for workspaces
- Consider network-attached storage for multi-instance deployments
- Implement workspace quotas per user

### Rate Limiting

Implement rate limiting for:

- Discord commands per user
- GitHub webhook processing
- Task creation per repository

## Troubleshooting

### Common Issues

1. **Database locked errors**:

   - Enable WAL mode
   - Check for long-running transactions
   - Ensure single instance per database

2. **Webhook timeouts**:

   - Increase proxy timeout settings
   - Implement webhook queue processing
   - Return 200 OK immediately, process async

3. **Memory issues**:
   - Monitor workspace disk usage
   - Implement aggressive cleanup
   - Set memory limits in container

### Debug Mode

Enable verbose logging:

```bash
LOG_LEVEL=debug docker-compose up
```

### Recovery Procedures

1. **Database corruption**:

```bash
# Check integrity
sqlite3 bot.db "PRAGMA integrity_check;"

# Restore from backup
cp /backups/bot_latest.db ./bot.db
```

2. **Stuck tasks**:

```sql
-- Mark stuck tasks as failed
UPDATE tasks
SET status = 'failed',
    updated_at = datetime('now')
WHERE status = 'implementing'
  AND updated_at < datetime('now', '-1 hour');
```

## Maintenance

### Regular Tasks

- **Daily**: Check logs for errors
- **Weekly**: Review disk usage, cleanup old workspaces
- **Monthly**: Update dependencies, review security patches
- **Quarterly**: Test disaster recovery procedures

### Upgrade Process

1. Backup database and workspaces
2. Build new image
3. Test in staging environment
4. Deploy with rolling update:

```bash
docker-compose pull
docker-compose up -d --no-deps --build llmutils-bot
```

## Support

For issues and questions:

- GitHub Issues: https://github.com/dimfeld/llmutils/issues
- Documentation: Check `/src/bot/README.md` for bot-specific details
