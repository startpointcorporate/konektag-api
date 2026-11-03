CREATE TABLE IF NOT EXISTS konektag.ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(255) NOT NULL,
  entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('credit', 'debit')),
  amount BIGINT NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
  document_type VARCHAR(50) NOT NULL,
  document_ref VARCHAR(255),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_client
  ON konektag.ledger_entries(client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_client_type
  ON konektag.ledger_entries(client_id, entry_type);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_doc_ref
  ON konektag.ledger_entries(document_ref);
