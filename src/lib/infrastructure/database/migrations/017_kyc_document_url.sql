-- Ajout du champ id_document_url sur la table users
ALTER TABLE konektag.users ADD COLUMN IF NOT EXISTS id_document_url VARCHAR(1000);

-- Ajout d'un index pour le suivi des documents
CREATE INDEX IF NOT EXISTS idx_users_id_document_url ON konektag.users(id_document_url) WHERE id_document_url IS NOT NULL;
