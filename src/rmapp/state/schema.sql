-- Workflows table
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('issue', 'pr_review')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON
  error TEXT
);

-- Issue workflows specific data
CREATE TABLE IF NOT EXISTS issue_workflows (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  issue_title TEXT NOT NULL,
  plan_path TEXT,
  workspace_id TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  -- Steps tracking
  analyzed BOOLEAN DEFAULT FALSE,
  plan_generated BOOLEAN DEFAULT FALSE,
  implemented BOOLEAN DEFAULT FALSE,
  pr_created BOOLEAN DEFAULT FALSE
);

-- PR review workflows specific data
CREATE TABLE IF NOT EXISTS pr_review_workflows (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  pr_title TEXT NOT NULL,
  workspace_id TEXT,
  -- Steps tracking
  comments_parsed BOOLEAN DEFAULT FALSE,
  changes_applied BOOLEAN DEFAULT FALSE,
  responded BOOLEAN DEFAULT FALSE
);

-- Review comments
CREATE TABLE IF NOT EXISTS review_comments (
  id INTEGER PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES pr_review_workflows(workflow_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  action TEXT NOT NULL CHECK (action IN ('change_requested', 'suggestion', 'question', 'approval')),
  resolved BOOLEAN DEFAULT FALSE,
  response TEXT
);

-- Workspace information
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Command executions
CREATE TABLE IF NOT EXISTS command_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]', -- JSON array
  options TEXT NOT NULL DEFAULT '{}', -- JSON object
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  output TEXT,
  error TEXT,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- Workflow events for audit trail
CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('status_changed', 'step_completed', 'error', 'command_executed')),
  payload TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_repository ON workflows(repository_owner, repository_name);
CREATE INDEX IF NOT EXISTS idx_workflows_updated_at ON workflows(updated_at);
CREATE INDEX IF NOT EXISTS idx_workspaces_workflow ON workspaces(workflow_id);
CREATE INDEX IF NOT EXISTS idx_command_executions_workflow ON command_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow ON workflow_events(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at ON workflow_events(created_at);

-- Triggers to update timestamps
CREATE TRIGGER IF NOT EXISTS update_workflows_timestamp 
AFTER UPDATE ON workflows
BEGIN
  UPDATE workflows SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_workspaces_timestamp 
AFTER UPDATE ON workspaces
BEGIN
  UPDATE workspaces SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;