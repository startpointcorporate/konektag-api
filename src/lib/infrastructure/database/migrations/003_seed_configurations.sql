-- Seed 003 : Configuration par défaut
-- Version : 1.0 | Idempotent

INSERT INTO konektag.configurations (key, value, description) VALUES
    ('FACE_MATCH_THRESHOLD', '{"score": 0.85}',
     'Seuil minimal de correspondance faciale (0-1)'),
    ('LIVENESS_THRESHOLD', '{"score": 0.80}',
     'Seuil minimal de détection de présence réelle (0-1)'),
    ('OCR_MIN_CONFIDENCE', '{"score": 0.70}',
     'Seuil minimal de confiance OCR (0-1)'),
    ('OTP_TTL_SECONDS', '{"value": 300}',
     'Durée de validité OTP en secondes'),
    ('OTP_MAX_ATTEMPTS', '{"value": 5}',
     'Tentatives OTP avant blocage'),
    ('KYC_DOC_RETENTION_DAYS', '{"value": 365}',
     'Durée de conservation documents KYC validés (jours)'),
    ('KYC_REJECTED_RETENTION_DAYS', '{"value": 30}',
     'Durée de conservation documents KYC rejetés (jours)')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description;
