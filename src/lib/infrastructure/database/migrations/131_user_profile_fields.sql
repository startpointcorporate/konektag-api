-- Migration 128 : Ajout des champs de profil utilisateur
-- Version : 1.0 | Idempotent

-- Ajout des champs manquants pour le profil utilisateur
ALTER TABLE konektag.users 
ADD COLUMN IF NOT EXISTS display_name VARCHAR(200),
ADD COLUMN IF NOT EXISTS birth_date DATE,
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50),
ADD COLUMN IF NOT EXISTS transfer_history_email VARCHAR(255),
ADD COLUMN IF NOT EXISTS payment_otp_email VARCHAR(255);