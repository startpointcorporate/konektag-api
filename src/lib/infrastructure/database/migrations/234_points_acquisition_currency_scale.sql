-- Match the canonical money-unit.ts precision for NEW Points K acquisitions.
-- Preserve all balance/proof/idempotency checks and all existing financial rows.
BEGIN;
CREATE OR REPLACE FUNCTION konektag.check_points_acquisition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a konektag.points_acquisitions; n INTEGER; valid INTEGER; outbox_count INTEGER;
BEGIN
 SELECT * INTO a FROM konektag.points_acquisitions WHERE id = NEW.id;
 IF a.status <> 'completed' THEN RETURN NULL; END IF;
 SELECT count(*), count(*) FILTER(WHERE currency='K' AND amount=a.quantity
   AND points_order_id=a.order_id AND points_lot_id=a.lot_id AND transaction_id=a.transaction_id AND klot_id=a.klot_id
   AND ((points_leg='issuance_debit' AND account_code='K_ISSUANCE' AND entry_side='debit' AND party_id IS NULL)
     OR (points_leg='issuance_credit' AND account_code='K_ALLOCATION_CLEARING' AND entry_side='credit' AND party_id IS NULL)
     OR (points_leg='allocation_debit' AND account_code='K_ALLOCATION_CLEARING' AND entry_side='debit' AND party_id IS NULL)
     OR (points_leg='allocation_credit' AND account_code='1000' AND entry_side='credit' AND party_id=a.party_id)))
 INTO n,valid FROM konektag.ledger_entries WHERE points_acquisition_id=a.id;
 IF n<>4 OR valid<>4 OR a.klot_id IS NULL OR a.transaction_id IS NULL THEN RAISE EXCEPTION 'POINTS_ACQUISITION_UNBALANCED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.points_lots WHERE id=a.lot_id AND quantity=a.quantity) THEN RAISE EXCEPTION 'POINTS_LOT_QUANTITY_MISMATCH'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.klots k JOIN konektag.points_lots l ON l.id=a.lot_id
   WHERE k.id=a.klot_id AND k.quantity_k=a.quantity AND k.economic_currency=l.currency
     AND k.economic_value=l.value_minor / CASE WHEN l.currency IN ('XAF','XOF','GNF','RWF','UGX') THEN 1.0 ELSE 100.0 END) THEN RAISE EXCEPTION 'POINTS_KLOT_MISMATCH'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.points_payment_confirmations WHERE order_id=a.order_id AND applied_at IS NOT NULL) THEN RAISE EXCEPTION 'POINTS_PROOF_NOT_APPLIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM konektag.api_payment_orders WHERE id=a.order_id AND state='paid' AND acquisition_status='completed') THEN RAISE EXCEPTION 'POINTS_ORDER_NOT_FINALIZED'; END IF;
 SELECT count(*) INTO outbox_count FROM konektag.outbox_events WHERE aggregate_id=a.id AND event_type='PointsAcquisitionCompleted';
 IF outbox_count<>1 THEN RAISE EXCEPTION 'POINTS_OUTBOX_REQUIRED'; END IF;
 RETURN NULL;
END $$;
COMMIT;
