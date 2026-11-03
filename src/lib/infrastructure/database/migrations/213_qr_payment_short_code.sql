-- QR Pay: human-friendly alternate lookup for the same signed payment intent.
ALTER TABLE konektag.checkout_intents
  ADD COLUMN IF NOT EXISTS qr_short_code TEXT;

ALTER TABLE konektag.checkout_intents
  ADD CONSTRAINT checkout_intents_qr_short_code_ck
  CHECK (qr_short_code IS NULL OR qr_short_code ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$');

CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_qr_short_code_uq
  ON konektag.checkout_intents(qr_short_code)
  WHERE qr_short_code IS NOT NULL AND source_type = 'qr';
