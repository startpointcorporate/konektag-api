CREATE INDEX IF NOT EXISTS idx_payment_provider_attempts_pawapay_open
  ON konektag.payment_provider_attempts(provider_reference, updated_at)
  WHERE provider = 'pawapay' AND state IN ('pending', 'processing');
