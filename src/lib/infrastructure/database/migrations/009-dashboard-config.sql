CREATE TABLE IF NOT EXISTS konektag.dashboard_config (
  user_id VARCHAR(255) PRIMARY KEY,
  layout JSONB NOT NULL DEFAULT '{"widgets":[]}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);
