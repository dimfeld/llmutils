-- Task checkpoints for resumption
CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  checkpoint_data TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);