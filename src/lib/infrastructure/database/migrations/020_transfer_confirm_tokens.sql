CREATE TABLE IF NOT EXISTS konektag.transfer_confirm_tokens (
  token VARCHAR(64) PRIMARY KEY,
  transfer_name VARCHAR(64) NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_confirm_tokens_token ON konektag.transfer_confirm_tokens(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_confirm_tokens_transfer ON konektag.transfer_confirm_tokens(transfer_name);
