# Linear Integration Documentation

This document provides comprehensive information about rmplan's Linear integration, including setup, usage, and advanced features.

## Overview

rmplan includes native support for Linear issues, allowing you to use Linear as your issue tracking system instead of or alongside GitHub. The Linear integration provides the same core functionality as GitHub integration, including issue importing, plan generation, and comment support.

## Setup and Configuration

### Prerequisites

1. **Linear Account**: You need access to a Linear workspace
2. **API Key**: Generate a Personal API key from Linear
3. **rmplan Configuration**: Configure rmplan to use Linear as your issue tracker

### Step 1: Generate a Linear API Key

1. Go to [Linear Settings > API](https://linear.app/settings/api)
2. Create a new Personal API key
3. Copy the generated key (it starts with `lin_api_`)

### Step 2: Set Environment Variable

Set the `LINEAR_API_KEY` environment variable in your shell:

```bash
# Add to your shell profile (.bashrc, .zshrc, etc.)
export LINEAR_API_KEY="lin_api_1234567890abcdef"

# Or set it for a single session
LINEAR_API_KEY="lin_api_1234567890abcdef" rmplan import TEAM-123
```

### Step 3: Configure rmplan

Create or update your rmplan configuration file at `.rmfilter/config/rmplan.yml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-config-schema.json

# Set Linear as your issue tracker
issueTracker: 'linear'

# Optional: Configure other rmplan settings
paths:
  tasks: './tasks'
  docs:
    - './docs'
    - './project-docs'
```

## Linear Issue ID Formats

Linear uses a specific format for issue identifiers:

### Issue ID Format
- **Pattern**: `TEAM-123`
- **Team Identifier**: 2-10 uppercase letters and numbers (e.g., `TEAM`, `PROJ`, `ABC123`)
- **Issue Number**: Sequential number assigned by Linear

### Supported Input Formats

rmplan accepts Linear issues in multiple formats:

1. **Direct Issue ID**: `TEAM-123`
2. **Linear URL**: `https://linear.app/workspace/issue/TEAM-123`
3. **Linear URL with slug**: `https://linear.app/workspace/issue/TEAM-123/feature-title-slug`

### Examples

```bash
# All of these refer to the same Linear issue:
rmplan import TEAM-123
rmplan import https://linear.app/mycompany/issue/TEAM-123
rmplan import https://linear.app/mycompany/issue/TEAM-123/implement-user-authentication
```

## Core Features

### Issue Import

Import Linear issues as rmplan task files:

```bash
# Import a specific Linear issue
rmplan import TEAM-123

# Import with custom output location
rmplan import TEAM-456 --output custom-tasks/feature.yml

# Interactive mode - select multiple issues to import
rmplan import
```

**Interactive Mode Features:**
- Browse all open Linear issues in your workspace
- Multi-select issues using space bar
- Filter by team, status, or assignee
- Bulk import with automatic duplicate detection

### Plan Generation

Generate detailed implementation plans from Linear issues:

```bash
# Generate a plan from a Linear issue
rmplan generate --issue TEAM-456 -- src/**/*.ts

# Generate and commit the resulting plan file
rmplan generate --issue TEAM-789 --commit -- src/api/**/*.ts

# Use with rmfilter options for better context
rmplan generate --issue TEAM-123 -- src/**/*.ts --grep auth --with-imports
```

### Comment Integration

Linear issue comments are automatically included in imported plans:

- Comments appear in the plan's `details` section
- Author information is preserved
- Comments are formatted with attribution
- Nested comment threads are flattened in chronological order

## Example Workflows

### Basic Import Workflow

```bash
# 1. Set up your environment
export LINEAR_API_KEY="lin_api_your_key_here"

# 2. Configure rmplan for Linear
cat > .rmfilter/config/rmplan.yml << EOF
issueTracker: 'linear'
paths:
  tasks: './tasks'
EOF

# 3. Import a Linear issue
rmplan import TEAM-123

# 4. The resulting task file is created at tasks/team-123-issue-title.yml
```

### Advanced Planning Workflow

```bash
# 1. Generate a detailed plan from a Linear issue with full context
rmplan generate --issue TEAM-456 --rmfilter -- \
  src/**/*.ts \
  --grep authentication \
  --with-imports \
  --with-tests

# 2. Execute the plan step by step
rmplan next tasks/team-456-implement-oauth.yml --rmfilter -- src/auth/**/*.ts

# 3. Mark steps as completed and commit changes
rmplan done tasks/team-456-implement-oauth.yml --commit
```

### Multi-Issue Project Planning

```bash
# 1. Import multiple related Linear issues interactively
rmplan import

# 2. Create dependencies between imported plans
# Edit the YAML files to add dependency relationships

# 3. Execute plans in dependency order
rmplan agent --next-ready parent-plan-id
```

## Sample Output

### Import Command Output

```
$ rmplan import TEAM-123
✓ Connected to Linear workspace: MyCompany
✓ Found Linear issue: TEAM-123 - Implement user authentication
✓ Processing issue comments (3 found)
✓ Generated plan file: tasks/team-123-implement-user-authentication.yml

Issue imported successfully!
```

### Interactive Import Session

```
$ rmplan import
✓ Connected to Linear workspace: MyCompany
✓ Found 15 open Linear issues

Select issues to import (use Space to select, Enter to confirm):
❯ ◯ TEAM-123 - Implement user authentication
  ◯ TEAM-124 - Add password reset functionality  
  ◯ TEAM-125 - Create user profile page
  ◯ TEAM-126 - Implement two-factor authentication
  ◯ PROJ-001 - Database migration for user roles
  
Navigation: ↑/↓ to move, Space to select, Enter to confirm, q to quit
```

### Generated Plan File Structure

```yaml
id: 7
title: "Implement user authentication"
goal: "Implement: Implement user authentication"
details: |
  ## Problem
  
  Users need to authenticate to access protected resources in our application.
  
  ## Solution
  
  Implement JWT-based authentication with the following components:
  - Login/registration endpoints
  - JWT token generation and validation
  - Protected route middleware
  - User session management
  
  ---
  
  **Comments:**
  
  > We should also consider implementing OAuth for social login integration.
  > — Alice Johnson (2024-01-15)
  
  > Good point! Let's also add support for refresh tokens.
  > — Bob Smith (2024-01-16)

status: pending
issue: ["https://linear.app/mycompany/issue/TEAM-123"]
tasks: []
createdAt: "2024-01-16T10:30:00.000Z"
updatedAt: "2024-01-16T10:30:00.000Z"
```

## Supported Linear Features

### ✅ Fully Supported
- Issue importing and plan generation
- Issue comments with full attribution
- Interactive multi-issue selection
- Linear issue URL parsing
- Team-based issue identification
- Issue status and metadata
- User information (name, email, avatar)
- Automatic duplicate detection during import
- Custom output file locations

### ⚠️ Partially Supported
- **Rich Text Formatting**: Linear's rich text is converted to Markdown, some formatting may be lost
- **Attachments**: Issue attachments are not downloaded, only referenced by URL
- **Issue Labels**: Linear labels are not currently imported (can be added in future versions)

### ❌ Not Supported
- **Pull Requests**: Linear doesn't have pull requests; PR-related rmplan features remain GitHub-only
- **Issue Creation**: rmplan can only read Linear issues, not create them
- **Webhooks**: No webhook integration for automatic plan updates

## Differences from GitHub Integration

### Issue Numbers
- **GitHub**: Numeric IDs (e.g., `123`, `#456`)
- **Linear**: Team-prefixed IDs (e.g., `TEAM-123`, `PROJ-456`)

### Issue States  
- **GitHub**: `open`, `closed`
- **Linear**: `Backlog`, `Todo`, `In Progress`, `Done`, `Canceled`

### URLs
- **GitHub**: `https://github.com/owner/repo/issues/123`
- **Linear**: `https://linear.app/workspace/issue/TEAM-123`

### Comments
- **GitHub**: Rich Markdown support, reactions, editing history
- **Linear**: Rich text converted to Markdown, simpler comment structure

## Troubleshooting

### Common Issues

#### "LINEAR_API_KEY environment variable is not set"
```bash
# Solution: Set the environment variable
export LINEAR_API_KEY="lin_api_your_key_here"

# Verify it's set
echo $LINEAR_API_KEY
```

#### "Invalid Linear API key"
- Check that your API key starts with `lin_api_`
- Verify the key hasn't expired in Linear settings
- Ensure you have access to the workspace

#### "Issue not found: TEAM-123"
- Verify the issue exists and you have access to it
- Check that the team identifier matches your Linear workspace
- Ensure the issue hasn't been deleted or moved

#### "No Linear issues found"
- Check that your workspace has open issues
- Verify your API key has read access to issues
- Try specifying a specific team if you have multiple teams

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
# Enable debug output
DEBUG=rmplan:* rmplan import TEAM-123

# Or use the --debug flag
rmplan import TEAM-123 --debug
```

## Performance Considerations

### API Rate Limits
- Linear's API has rate limits (typically 1000 requests per hour)
- Bulk imports are batched to respect rate limits
- Interactive mode caches issue lists to minimize API calls

### Large Workspaces
- Interactive import mode shows up to 100 issues at once
- Use filtering options to narrow down large issue lists
- Consider importing issues by team or project for better organization

## Migration from GitHub

If you're migrating from GitHub to Linear integration:

1. **Update Configuration**: Change `issueTracker` from `'github'` to `'linear'`
2. **Set API Key**: Replace `GITHUB_TOKEN` with `LINEAR_API_KEY`
3. **Update Issue References**: Convert GitHub issue numbers to Linear issue IDs in existing plans
4. **Test Import**: Try importing a few Linear issues to verify the setup

### Example Migration

```bash
# Before (GitHub)
export GITHUB_TOKEN="ghp_your_github_token"
rmplan import 123

# After (Linear)  
export LINEAR_API_KEY="lin_api_your_linear_key"
rmplan import TEAM-123
```

## Advanced Configuration

### Using Both GitHub and Linear

You can maintain separate configurations for different projects:

```bash
# Project A uses GitHub
rmplan --config .rmfilter/config/github-rmplan.yml import 123

# Project B uses Linear
rmplan --config .rmfilter/config/linear-rmplan.yml import TEAM-456
```

### Custom Issue Processing

You can customize how Linear issues are processed by modifying the rmplan configuration:

```yaml
# Custom paths for Linear projects
paths:
  tasks: './linear-tasks'
  docs:
    - './docs/linear'
    - './specs'

# Auto-examples that work well with Linear issues
autoexamples:
  - 'authentication'
  - 'user management'
  - find: 'JWT'
    example: 'JWT token'
```

## API Reference

The Linear integration uses the `@linear/sdk` package. Key components:

- **LinearIssueTrackerClient**: Main client for Linear API interactions
- **Issue Parsing**: Handles Linear-specific issue ID formats
- **Comment Processing**: Converts Linear comments to rmplan format
- **Error Handling**: Provides specific error messages for Linear API issues

For detailed API information, see the Linear SDK documentation at: https://linear.app/developers/sdk