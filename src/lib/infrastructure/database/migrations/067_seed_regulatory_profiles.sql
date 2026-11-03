-- Migration 067 : Seed des profils reglementaires de base
-- Legal entities, regulated actors, regulatory profiles avec plafonds par defaut
-- Les plafonds individuels sont geres via konektag.user_regulatory_overrides
-- Idempotent : ON CONFLICT DO NOTHING / DO UPDATE

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. Legal Entities — KTG-FR et KTG-CG
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.legal_entities (code, legal_name, country_code, base_currency, status, valid_from)
VALUES
    ('KTG-FR', 'Konektag France', 'FR', 'EUR', 'PENDING_APPROVAL', CURRENT_DATE),
    ('KTG-CG', 'Konektag Congo', 'CG', 'XAF', 'PENDING_APPROVAL', CURRENT_DATE)
ON CONFLICT (code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 2. Regulated Actors
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.regulated_actors (actor_code, actor_name, actor_type, jurisdiction, status)
VALUES
    ('STRIPE-FR', 'Stripe France (PSP)', 'psp', 'FR', 'PENDING_APPROVAL'),
    ('MTN-CG', 'MTN Mobile Money Congo', 'mobile_money_operator', 'CG', 'PENDING_APPROVAL'),
    ('AIRTEL-CG', 'Airtel Money Congo', 'mobile_money_operator', 'CG', 'PENDING_APPROVAL'),
    ('ORANGE-CG', 'Orange Money Congo', 'mobile_money_operator', 'CG', 'PENDING_APPROVAL'),
    ('INTERNAL', 'Konektag (operations internes)', 'internal', 'FR', 'PENDING_APPROVAL')
ON CONFLICT (actor_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 3. Regulatory Profiles — Acquisition (recharges K)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'ACQ-FR-STRIPE', 'Recharge Stripe EUR France',
    le.id, 'FR', 'FR',
    'FR-FR', 'acquisition', 'konektag_user',
    ra.id, 'stripe',
    'provider_confirmation', 'basic',
    2000.00, 2000.00, 2000.00,
    false, '["payment_intent_id"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le, konektag.regulated_actors ra
WHERE le.code = 'KTG-FR' AND ra.actor_code = 'STRIPE-FR'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'ACQ-CG-MM', 'Recharge Mobile Money Congo',
    le.id, 'CG', 'CG',
    'CG-CG', 'acquisition', 'konektag_user',
    NULL, 'mtn_money',
    'manual_double_approval', 'basic',
    500000.00, 1000000.00, 5000000.00,
    false, '["transaction_reference", "operator_receipt"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-CG'
ON CONFLICT (profile_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 4. Regulatory Profiles — Cadeaux K (Gift)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     max_gift_depth, netting_allowed, evidence_required, status, valid_from)
SELECT
    'GIFT-FR-FR', 'Cadeau K France → France',
    le.id, 'FR', 'FR',
    'FR-FR', 'gift', 'konektag_user',
    NULL, 'internal',
    'provider_confirmation', 'basic',
    500.00, 1000.00, 2000.00,
    3, false, '["recipient_kyc"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-FR'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     max_gift_depth, netting_allowed, evidence_required, status, valid_from)
SELECT
    'GIFT-FR-CG', 'Cadeau K France → Congo',
    le.id, 'FR', 'CG',
    'FR-CG', 'gift', 'konektag_user',
    NULL, 'internal',
    'provider_confirmation', 'standard',
    500.00, 1000.00, 2000.00,
    2, false, '["recipient_kyc", "corridor_restrictions"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-FR'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     max_gift_depth, netting_allowed, evidence_required, status, valid_from)
SELECT
    'GIFT-CG-CG', 'Cadeau K Congo → Congo',
    le.id, 'CG', 'CG',
    'CG-CG', 'gift', 'konektag_user',
    NULL, 'internal',
    'provider_confirmation', 'basic',
    100000.00, 200000.00, 500000.00,
    3, false, '["recipient_kyc"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-CG'
ON CONFLICT (profile_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 5. Regulatory Profiles — Paiements QR
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'QR-FR-FR-CONSUMER', 'QR France consommateur',
    le.id, 'FR', 'FR',
    'FR-FR', 'qr_payment', 'konektag_user',
    NULL, 'internal',
    'provider_confirmation', 'basic',
    1500.00, 3000.00, 5000.00,
    false, '["qr_intent_id"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-FR'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'QR-FR-CG', 'QR France → Congo',
    le.id, 'FR', 'CG',
    'FR-CG', 'qr_payment', 'konektag_user',
    NULL, 'internal',
    'provider_confirmation', 'standard',
    200000.00, 500000.00, 2000000.00,
    false, '["qr_intent_id", "merchant_kyb"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-FR'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, max_amount_daily, max_amount_monthly,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'QR-CG-CG', 'QR Congo',
    le.id, 'CG', 'CG',
    'CG-CG', 'qr_payment', 'konektag_user',
    NULL, 'internal',
    'provider_confirmation', 'basic',
    200000.00, 500000.00, 2000000.00,
    false, '["qr_intent_id"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-CG'
ON CONFLICT (profile_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 6. Regulatory Profiles — Consommation K
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, netting_allowed, evidence_required, status, valid_from)
SELECT
    'CONSUME-FR', 'Consommation K France',
    le.id, 'FR', 'FR',
    'FR-FR', 'consumption', 'konektag_france',
    NULL, 'internal',
    'provider_confirmation', 'basic',
    NULL, false, '["sale_ref", "merchant_id"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-FR'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     max_amount_per_tx, netting_allowed, evidence_required, status, valid_from)
SELECT
    'CONSUME-CG', 'Consommation K Congo',
    le.id, 'CG', 'CG',
    'CG-CG', 'consumption', 'konektag_congo',
    NULL, 'internal',
    'provider_confirmation', 'basic',
    NULL, false, '["sale_ref", "merchant_id"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-CG'
ON CONFLICT (profile_code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- 7. Regulatory Profiles — Settlement (reglement commerçant)
-- ═══════════════════════════════════════════════════════════════
INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'SETTLE-FR', 'Reglement commercant France',
    le.id, 'FR', 'FR',
    'FR-FR', 'settlement', 'konektag_france',
    ra.id, 'bank_transfer',
    'provider_confirmation', 'none',
    false, '["bank_proof", "settlement_list"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le, konektag.regulated_actors ra
WHERE le.code = 'KTG-FR' AND ra.actor_code = 'INTERNAL'
ON CONFLICT (profile_code) DO NOTHING;

INSERT INTO konektag.regulatory_profiles
    (profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination,
     corridor_id, authorized_operation, fund_holder, regulated_actor_id, rail,
     execution_mode, min_kyc_level,
     netting_allowed, evidence_required, status, valid_from)
SELECT
    'SETTLE-CG', 'Reglement commercant Congo',
    le.id, 'CG', 'CG',
    'CG-CG', 'settlement', 'konektag_congo',
    NULL, 'mobile_money',
    'provider_confirmation', 'none',
    false, '["operator_proof", "settlement_list", "merchant_phone", "merchant_network"]',
    'DRAFT', CURRENT_DATE
FROM konektag.legal_entities le
WHERE le.code = 'KTG-CG'
ON CONFLICT (profile_code) DO NOTHING;

COMMIT;
