-- Ajout du token de vérification d'email
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(64);
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMP WITH TIME ZONE;
