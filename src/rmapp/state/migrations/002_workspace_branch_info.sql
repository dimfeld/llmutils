-- Add branch information to workspaces table
ALTER TABLE workspaces ADD COLUMN branch_name TEXT;
ALTER TABLE workspaces ADD COLUMN base_ref TEXT;