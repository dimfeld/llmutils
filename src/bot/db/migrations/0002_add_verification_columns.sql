-- Add verification columns to user_mappings table for self-registration
ALTER TABLE user_mappings ADD COLUMN verification_code TEXT;
ALTER TABLE user_mappings ADD COLUMN verification_code_expires_at DATETIME;