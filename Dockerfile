# Build stage
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the project
RUN bun run build

# Runtime stage
FROM oven/bun:1-alpine

# Install required tools
RUN apk add --no-cache \
    git \
    ripgrep \
    sqlite

WORKDIR /app

# Copy built application and dependencies
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lockb ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/schema ./schema

# Create data directory
RUN mkdir -p /data/workspaces

# Set environment variables
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/bot.db
ENV WORKSPACE_BASE_DIR=/data/workspaces

# Expose the webhook port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run the bot
CMD ["bun", "run", "src/bot/main.ts"]