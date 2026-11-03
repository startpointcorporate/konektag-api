-- Immutable wire proofs supplement CORE-01 without duplicating canonical amounts.
CREATE TABLE konektag.core_payment_submissions (
  proof_hash TEXT PRIMARY KEY,
  order_hash TEXT NOT NULL,
  submitter_device_id UUID NOT NULL REFERENCES konektag.core_offline_devices(id),
  proof JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON konektag.core_payment_submissions(order_hash);
CREATE TABLE konektag.core_payment_links (
  device_id UUID NOT NULL REFERENCES konektag.core_offline_devices(id),
  local_counter BIGINT NOT NULL CHECK(local_counter >= 0),
  digest TEXT NOT NULL,
  previous_hash TEXT,
  order_hash TEXT NOT NULL,
  PRIMARY KEY(device_id, digest)
);
CREATE INDEX ON konektag.core_payment_links(device_id,local_counter);
CREATE TABLE konektag.core_payment_decisions (
  order_hash TEXT PRIMARY KEY,
  operation_id UUID NOT NULL,
  device_id UUID NOT NULL REFERENCES konektag.core_offline_devices(id),
  authorization_id UUID NOT NULL REFERENCES konektag.core_offline_authorizations(id),
  state TEXT NOT NULL CHECK(state IN ('SETTLED','REJECTED','REQUIRES_REVIEW')),
  receipt TEXT NOT NULL,
  transaction_id UUID REFERENCES konektag.core_transactions(id),
  decision_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  UNIQUE(device_id,operation_id)
);
CREATE TABLE konektag.core_payment_batches (
  device_id UUID NOT NULL REFERENCES konektag.core_offline_devices(id),
  batch_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  PRIMARY KEY(device_id,batch_id)
);
CREATE TABLE konektag.core_payment_envelopes (
  authorization_id UUID PRIMARY KEY REFERENCES konektag.core_offline_authorizations(id),
  token TEXT NOT NULL UNIQUE
);
CREATE TABLE konektag.core_payment_qr_claims (
  request_id UUID PRIMARY KEY,
  order_hash TEXT NOT NULL UNIQUE
);
CREATE FUNCTION konektag.core_payment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OFFLINE_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER core_payment_submissions_immutable BEFORE UPDATE OR DELETE ON konektag.core_payment_submissions
FOR EACH ROW EXECUTE FUNCTION konektag.core_payment_immutable();
CREATE TRIGGER core_payment_links_immutable BEFORE UPDATE OR DELETE ON konektag.core_payment_links
FOR EACH ROW EXECUTE FUNCTION konektag.core_payment_immutable();
CREATE TRIGGER core_payment_envelopes_immutable BEFORE UPDATE OR DELETE ON konektag.core_payment_envelopes
FOR EACH ROW EXECUTE FUNCTION konektag.core_payment_immutable();
CREATE TRIGGER core_payment_batches_immutable BEFORE UPDATE OR DELETE ON konektag.core_payment_batches
FOR EACH ROW EXECUTE FUNCTION konektag.core_payment_immutable();
