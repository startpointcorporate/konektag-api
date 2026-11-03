-- 046_contact_messages.sql
-- Contact messaging for merchant-customer communication.

CREATE TABLE IF NOT EXISTS konektag.contact_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   UUID NOT NULL REFERENCES konektag.merchant_profiles(id),
  sender_name  TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_phone TEXT,
  message      TEXT NOT NULL,
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  version      INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_profile
  ON konektag.contact_messages(profile_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contact_messages_unread
  ON konektag.contact_messages(profile_id)
  WHERE is_read = FALSE AND deleted_at IS NULL;
