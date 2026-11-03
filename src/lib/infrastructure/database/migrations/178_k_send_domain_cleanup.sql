-- Migration 178: canonical K_SEND domain vocabulary and zero-fee K-to-K semantics.
-- Historical migrations are intentionally left unchanged; this migration transforms
-- the resulting schema without rewriting migration history.
BEGIN;

ALTER TABLE konektag.gift_intents RENAME TO k_send_intents;
ALTER TABLE konektag.gift_beneficiaries RENAME TO k_send_beneficiaries;

-- Canonical K quantity: K_SEND is K -> K. No user fee, FX, cashback or external funding.
ALTER TABLE konektag.k_send_intents
  DROP CONSTRAINT IF EXISTS gift_intents_receive_amount_positive,
  DROP CONSTRAINT IF EXISTS gift_intents_currency_and_fx_evidence;

DROP TRIGGER IF EXISTS trg_validate_gift_fx_evidence ON konektag.k_send_intents;
DROP FUNCTION IF EXISTS konektag.validate_gift_fx_evidence();

-- Pre-go-live cleanup: normalize any existing intent to the K quantity actually
-- destined for the recipient before removing abandoned monetary-transfer fields.
UPDATE konektag.k_send_intents
SET source_amount = receive_amount,
    fee_amount = 0,
    total_amount = receive_amount,
    cashback_amount = 0,
    funding_method = 'K_SEND',
    source_currency = 'K'
WHERE fee_amount <> 0
   OR total_amount <> receive_amount
   OR cashback_amount <> 0
   OR funding_method <> 'K_SEND'
   OR source_currency <> 'K';

ALTER TABLE konektag.k_send_intents
  RENAME COLUMN source_amount TO quantity_k;

ALTER TABLE konektag.k_send_intents
  DROP COLUMN IF EXISTS destination_currency,
  DROP COLUMN IF EXISTS exchange_rate_id,
  DROP COLUMN IF EXISTS fx_rate,
  DROP COLUMN IF EXISTS fx_rate_source,
  DROP COLUMN IF EXISTS fx_rate_timestamp,
  DROP COLUMN IF EXISTS fee_amount,
  DROP COLUMN IF EXISTS total_amount,
  DROP COLUMN IF EXISTS receive_amount,
  DROP COLUMN IF EXISTS cashback_amount,
  DROP COLUMN IF EXISTS funding_method;

ALTER TABLE konektag.k_send_intents
  ADD CONSTRAINT k_send_quantity_positive CHECK (quantity_k > 0);

-- A K_SEND saved recipient points to an internal Konektag user.
ALTER TABLE konektag.k_send_beneficiaries ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES konektag.users(id);
UPDATE konektag.k_send_beneficiaries b
SET recipient_user_id = u.id
FROM konektag.users u
WHERE b.recipient_user_id IS NULL
  AND b.phone_number_hash IS NOT NULL
  AND u.phone_hash = b.phone_number_hash
  AND u.deleted_at IS NULL;

-- Rows that cannot be resolved to a Konektag user are legacy external beneficiaries and
-- must not remain selectable in K_SEND.
UPDATE konektag.k_send_beneficiaries SET is_active=false, deleted_at=COALESCE(deleted_at,now()) WHERE recipient_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_k_send_recipient_owner_user_active ON konektag.k_send_beneficiaries(owner_keycloak_id, recipient_user_id) WHERE deleted_at IS NULL AND is_active = true;

-- Legacy beneficiary payment coordinates are not used by K_SEND.
ALTER TABLE konektag.k_send_beneficiaries
  DROP COLUMN IF EXISTS bank_account,
  DROP COLUMN IF EXISTS bank_account_encrypted;

-- K_SEND recipients are internal users. Legacy phone/operator columns stay nullable
-- for migration compatibility but are no longer read or written by runtime code.
ALTER TABLE konektag.k_send_beneficiaries ALTER COLUMN phone_number_encrypted DROP NOT NULL;
ALTER TABLE konektag.k_send_beneficiaries ALTER COLUMN phone_number_hash DROP NOT NULL;
ALTER TABLE konektag.k_send_beneficiaries ALTER COLUMN country DROP NOT NULL;
ALTER TABLE konektag.k_send_beneficiaries ALTER COLUMN operator DROP NOT NULL;

-- Rename indexes when they exist so schema inspection also uses canonical vocabulary.
ALTER INDEX IF EXISTS konektag.idx_gift_intents_sender_created RENAME TO idx_k_send_intents_sender_created;
ALTER INDEX IF EXISTS konektag.idx_gift_intents_recipient RENAME TO idx_k_send_intents_recipient;
ALTER INDEX IF EXISTS konektag.uq_gift_intents_financial_transaction RENAME TO uq_k_send_intents_financial_transaction;
ALTER INDEX IF EXISTS konektag.idx_gift_beneficiary_owner RENAME TO idx_k_send_beneficiary_owner;

-- Wallet authorization vocabulary.
ALTER TABLE konektag.wallet_debit_authorizations DROP CONSTRAINT IF EXISTS wallet_debit_authorizations_operation_type_check;
UPDATE konektag.wallet_debit_authorizations SET operation_type = 'k_send' WHERE operation_type = 'transfer';
ALTER TABLE konektag.wallet_debit_authorizations
  ADD CONSTRAINT wallet_debit_authorizations_operation_type_check
  CHECK (operation_type IN ('recharge', 'qr_pay', 'k_send', 'api_payment', 'payment_link'));

-- Activation projections: K_SEND is an internal K movement, not money transfer.
ALTER TABLE konektag.activation_activity_events DROP CONSTRAINT IF EXISTS activation_activity_events_source_type_check;
ALTER TABLE konektag.activation_activity_events DROP CONSTRAINT IF EXISTS activation_activity_events_metric_type_check;
UPDATE konektag.activation_activity_events
SET source_type = 'k_send', metric_type = 'KSend'
WHERE source_type = 'transfer' OR metric_type = 'TransferSent';
ALTER TABLE konektag.activation_activity_events
  ADD CONSTRAINT activation_activity_events_source_type_check
  CHECK (source_type IN ('recharge', 'k_send', 'qr_personal', 'merchant_payment'));
ALTER TABLE konektag.activation_activity_events
  ADD CONSTRAINT activation_activity_events_metric_type_check
  CHECK (metric_type IN ('Deposit', 'KSend', 'QrPaymentReceived', 'MerchantPayment'));

ALTER TABLE konektag.activation_milestones DROP CONSTRAINT IF EXISTS activation_milestones_metric_type_check;
UPDATE konektag.activation_milestones SET metric_type = 'KSend' WHERE metric_type = 'TransferSent';
UPDATE konektag.activation_milestones
SET public_title = replace(public_title, 'Envoyer', 'Envoyer des K'),
    public_description = 'Envoyez des K à un autre utilisateur Konektag.',
    cta_type = 'k_send'
WHERE metric_type = 'KSend';
ALTER TABLE konektag.activation_milestones
  ADD CONSTRAINT activation_milestones_metric_type_check
  CHECK (metric_type IN ('Deposit', 'KSend', 'QrPaymentReceived', 'MerchantPayment'));

-- Regulatory vocabulary: the user-to-user operation is K_SEND, not a gift or money transfer.
ALTER TABLE konektag.regulatory_profiles DROP CONSTRAINT IF EXISTS regulatory_profiles_authorized_operation_check;
UPDATE konektag.regulatory_profiles SET authorized_operation = 'k_send' WHERE authorized_operation = 'gift';
ALTER TABLE konektag.regulatory_profiles
  ADD CONSTRAINT regulatory_profiles_authorized_operation_check
  CHECK (authorized_operation IN ('acquisition','k_send','qr_payment','link_payment','consumption','settlement','clearing','refund','reversal'));

-- Canonicalize persisted financial/audit labels for internal K_SEND movements.
UPDATE konektag.financial_transactions
SET transaction_type = 'k_send'
WHERE transaction_type IN ('gift', 'points_transfer');
UPDATE konektag.ledger_entries
SET document_type = 'k_send'
WHERE document_type IN ('gift', 'points_transfer');

-- User preference vocabulary follows the canonical K_SEND domain.
ALTER TABLE konektag.users RENAME COLUMN transfer_history_email TO k_send_history_email;

-- Growth/marketing projection vocabulary. The projection function is redefined with the
-- renamed column only; its counting rules are unchanged from migration 037.
ALTER TABLE konektag.user_marketing_metrics RENAME COLUMN transfer_count TO k_send_count;
CREATE OR REPLACE FUNCTION konektag.refresh_user_marketing_metrics(p_user_id UUID)
RETURNS konektag.user_marketing_metrics AS $$
DECLARE
    v_wallet_funded         BOOLEAN;
    v_transfer_count        INTEGER;
    v_payment_count         INTEGER;
    v_first_activity        TIMESTAMPTZ;
    v_last_activity         TIMESTAMPTZ;
    v_result                konektag.user_marketing_metrics;
    v_client_id             VARCHAR(255);
BEGIN
    v_client_id := p_user_id::varchar;

    SELECT EXISTS(
        SELECT 1 FROM konektag.ledger_entries
        WHERE client_id = v_client_id AND document_type = 'Recharge' AND entry_type = 'credit'
    ) INTO v_wallet_funded;

    SELECT COUNT(*)::integer FROM konektag.ledger_entries
    WHERE client_id = v_client_id AND document_type = 'TransferSent' AND entry_type = 'debit'
    INTO v_transfer_count;

    SELECT COUNT(*)::integer FROM konektag.financial_transactions ft
    JOIN konektag.ledger_entries le ON le.transaction_id = ft.id
    JOIN konektag.parties p ON p.id = le.party_id
    WHERE p.keycloak_id = (SELECT keycloak_id FROM konektag.users WHERE id = p_user_id)
      AND ft.transaction_type = 'qr_payment'
      AND ft.status = 'completed'
      AND le.entry_side = 'debit'
    INTO v_payment_count;

    SELECT MIN(created_at), MAX(created_at) FROM (
        SELECT created_at FROM konektag.ledger_entries
        WHERE client_id = v_client_id AND document_type IN ('Recharge', 'TransferSent')
        UNION ALL
        SELECT ft.created_at FROM konektag.financial_transactions ft
        JOIN konektag.ledger_entries le ON le.transaction_id = ft.id
        JOIN konektag.parties p ON p.id = le.party_id
        WHERE p.keycloak_id = (SELECT keycloak_id FROM konektag.users WHERE id = p_user_id)
          AND ft.transaction_type = 'qr_payment'
          AND ft.status = 'completed'
          AND le.entry_side = 'debit'
    ) AS acts
    INTO v_first_activity, v_last_activity;

    INSERT INTO konektag.user_marketing_metrics
        (user_id, wallet_funded_once, k_send_count, merchant_payment_count,
         first_business_activity_at, last_business_activity_at)
    VALUES (p_user_id, v_wallet_funded, v_transfer_count, v_payment_count,
            v_first_activity, v_last_activity)
    ON CONFLICT (user_id) DO UPDATE SET
        wallet_funded_once         = EXCLUDED.wallet_funded_once,
        k_send_count               = EXCLUDED.k_send_count,
        merchant_payment_count     = EXCLUDED.merchant_payment_count,
        first_business_activity_at = EXCLUDED.first_business_activity_at,
        last_business_activity_at  = EXCLUDED.last_business_activity_at,
        updated_at                 = now()
    RETURNING * INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- K_SEND chain-depth vocabulary used by regulatory profiles. K-lots carry no depth column.
ALTER TABLE konektag.regulatory_profiles RENAME COLUMN max_gift_depth TO max_k_send_depth;

COMMIT;
