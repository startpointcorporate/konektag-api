-- PAY-01: QR monetary wallet entries use the existing user wallet account (1000).
-- The historical points trigger incorrectly rejected every non-K monetary entry
-- on that account. Keep strict K invariants while allowing signed QR fiat rails.
CREATE OR REPLACE FUNCTION konektag.points_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.currency = 'K' OR NEW.account_code IN ('K_ISSUANCE','K_ALLOCATION_CLEARING') THEN
   IF NEW.currency <> 'K' OR NEW.amount <> trunc(NEW.amount) OR NEW.amount <= 0 THEN
     RAISE EXCEPTION 'POINTS_ACCOUNT_REQUIRES_K_INTEGER';
   END IF;
   IF NEW.account_code = '1000' AND NEW.party_id IS NULL THEN RAISE EXCEPTION 'POINTS_OWNER_REQUIRED'; END IF;
   IF NEW.account_code <> '1000' AND NEW.party_id IS NOT NULL THEN RAISE EXCEPTION 'SYSTEM_POINTS_ACCOUNT_HAS_NO_USER'; END IF;
   IF NEW.transaction_id IS NULL THEN RAISE EXCEPTION 'POINTS_TRANSACTION_REQUIRED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.transaction_id AND currency='K') THEN RAISE EXCEPTION 'POINTS_TRANSACTION_REQUIRES_K'; END IF;
   IF EXISTS(SELECT 1 FROM konektag.financial_transactions WHERE id=NEW.transaction_id AND status IN ('completed','reversed')) THEN RAISE EXCEPTION 'FINAL_POINTS_TRANSACTION_IMMUTABLE'; END IF;
   NEW.gl_scope := 'GLOBAL_USER_GL'; NEW.legacy_classification := NULL;
 ELSIF NEW.currency IS NOT NULL AND NEW.account_code = '1000' THEN
   IF NEW.party_id IS NULL THEN RAISE EXCEPTION 'WALLET_OWNER_REQUIRED'; END IF;
   IF NEW.transaction_id IS NULL THEN RAISE EXCEPTION 'WALLET_TRANSACTION_REQUIRED'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM konektag.financial_transactions t WHERE t.id=NEW.transaction_id
   AND (t.currency='K' OR NEW.currency='K') AND t.currency<>NEW.currency) THEN
   RAISE EXCEPTION 'POINTS_TRANSACTION_UNIT_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
