-- One-time bridge: historical wallet_recharge payments settled by the retired
-- monetary AcquisitionService become canonical Points K acquisitions.
BEGIN;
DO $$
DECLARE r RECORD; v_lot TEXT; v_acq UUID; v_tx UUID; v_klot UUID; v_minor BIGINT; v_corridor TEXT;
BEGIN
 FOR r IN
   SELECT DISTINCT ON (o.id)
     o.id,o.target_user_id,o.currency,o.subtotal_amount,o.settlement_legal_entity_id,
     o.settlement_regulatory_profile_id,o.settlement_corridor_id,
     a.id attempt_id,a.provider,a.provider_reference,a.expected_amount,
     e.id event_id,p.id party_id
   FROM konektag.api_payment_orders o
   JOIN konektag.users u ON u.id=o.target_user_id AND u.deleted_at IS NULL
   JOIN konektag.parties p ON p.keycloak_id=u.keycloak_id AND p.is_active=true
   JOIN konektag.payment_provider_attempts a ON a.source_type='api_payment' AND a.source_id::text=o.id::text AND a.state='succeeded'
   JOIN konektag.payment_provider_events e ON e.attempt_id=a.id AND e.failed_at IS NULL
   WHERE o.order_purpose='wallet_recharge' AND o.state='paid' AND o.currency='EUR'
     AND a.provider IN ('stripe','pawapay')
     AND o.subtotal_amount>0 AND o.subtotal_amount=trunc(o.subtotal_amount)
     AND NOT EXISTS(SELECT 1 FROM konektag.points_acquisitions x WHERE x.order_id=o.id)
   ORDER BY o.id,e.received_at DESC
 LOOP
   v_lot := 'PK-ORDER-'||r.id::text;
   v_minor := CASE WHEN r.currency IN ('XOF','XAF','XPF','JPY','KRW','VND','BIF','CLP','DJF','GNF','KMF','MGA','PYG','RWF','UGX','VUV')
                   THEN r.subtotal_amount::bigint ELSE (r.subtotal_amount*100)::bigint END;
   v_corridor := COALESCE(r.settlement_corridor_id,'LEGACY-'||r.currency);
   INSERT INTO konektag.points_lots(id,currency,value_minor,quantity,active,provider,order_id)
     VALUES(v_lot,r.currency,v_minor,r.subtotal_amount::bigint,true,r.provider,r.id)
     ON CONFLICT(id) DO NOTHING;
   INSERT INTO konektag.points_payment_confirmations(order_id,event_id,attempt_id,provider,provider_reference,confirmed_minor,currency,applied_at)
     VALUES(r.id,r.event_id,r.attempt_id,r.provider,r.provider_reference,r.expected_amount,r.currency,now())
     ON CONFLICT(order_id) DO NOTHING;
   INSERT INTO konektag.points_acquisitions(order_id,party_id,lot_id,quantity,idempotency_key,status,attempt_count)
     VALUES(r.id,r.party_id,v_lot,r.subtotal_amount::bigint,'points-acquisition:'||r.id::text,'processing',1)
     RETURNING id INTO v_acq;
   v_tx:=gen_random_uuid(); v_klot:=gen_random_uuid();
   INSERT INTO konektag.financial_transactions(id,transaction_type,business_reference,idempotency_key,currency,status,
     legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,eligibility_decision)
     VALUES(v_tx,'acquisition','POINTS-ACQ-'||r.id::text,'points-acquisition:'||r.id::text,'K','pending',
       r.settlement_legal_entity_id,v_corridor,'POINTS-ACQ-'||r.id::text,r.settlement_regulatory_profile_id,CURRENT_DATE,'ALLOWED');
   INSERT INTO konektag.klots(id,klot_ref,origin_entity_id,origin_country,rail,rail_ref,issuer,quantity_k,remaining_quantity,
     economic_currency,economic_value,regulatory_profile_id,status)
     SELECT v_klot,'KLOT-POINTS-'||r.id::text,r.settlement_legal_entity_id,le.country_code,r.provider,r.provider_reference,
       'Konektag',r.subtotal_amount,r.subtotal_amount,r.currency,r.subtotal_amount,r.settlement_regulatory_profile_id,'VALUATED'
     FROM konektag.legal_entities le WHERE le.id=r.settlement_legal_entity_id;
   INSERT INTO konektag.ledger_entries(transaction_id,account_code,entry_type,entry_side,party_id,amount,currency,
     document_type,document_ref,legal_entity_id,corridor_id,operation_id,regulatory_profile_id,value_date,klot_id,
     points_order_id,points_acquisition_id,points_lot_id,points_leg)
   VALUES
     (v_tx,'K_ISSUANCE','debit','debit',NULL,r.subtotal_amount,'K','points_acquisition','POINTS-ACQ-'||r.id::text,r.settlement_legal_entity_id,v_corridor,'POINTS-ACQ-'||r.id::text,r.settlement_regulatory_profile_id,CURRENT_DATE,v_klot,r.id,v_acq,v_lot,'issuance_debit'),
     (v_tx,'K_ALLOCATION_CLEARING','credit','credit',NULL,r.subtotal_amount,'K','points_acquisition','POINTS-ACQ-'||r.id::text,r.settlement_legal_entity_id,v_corridor,'POINTS-ACQ-'||r.id::text,r.settlement_regulatory_profile_id,CURRENT_DATE,v_klot,r.id,v_acq,v_lot,'issuance_credit'),
     (v_tx,'K_ALLOCATION_CLEARING','debit','debit',NULL,r.subtotal_amount,'K','points_acquisition','POINTS-ACQ-'||r.id::text,r.settlement_legal_entity_id,v_corridor,'POINTS-ACQ-'||r.id::text,r.settlement_regulatory_profile_id,CURRENT_DATE,v_klot,r.id,v_acq,v_lot,'allocation_debit'),
     (v_tx,'1000','credit','credit',r.party_id,r.subtotal_amount,'K','points_acquisition','POINTS-ACQ-'||r.id::text,r.settlement_legal_entity_id,v_corridor,'POINTS-ACQ-'||r.id::text,r.settlement_regulatory_profile_id,CURRENT_DATE,v_klot,r.id,v_acq,v_lot,'allocation_credit');
   UPDATE konektag.financial_transactions SET status='completed',completed_at=now(),klot_id=v_klot WHERE id=v_tx;
   INSERT INTO konektag.outbox_events(correlation_id,causation_id,aggregate_type,aggregate_id,aggregate_ref,event_type,event_version,payload)
     VALUES(gen_random_uuid(),gen_random_uuid(),'PointsAcquisition',v_acq,r.id::text,'PointsAcquisitionCompleted',1,
       jsonb_build_object('orderId',r.id,'userId',r.target_user_id,'partyId',r.party_id,'quantity',r.subtotal_amount,'transactionId',v_tx));
   UPDATE konektag.api_payment_orders SET points_quantity=r.subtotal_amount::bigint,lot_value_minor=v_minor,
     confirmed_payment_minor=r.expected_amount,payment_status='confirmed',acquisition_status='completed',recharge_lot_id=v_lot,updated_at=now()
     WHERE id=r.id;
   UPDATE konektag.points_acquisitions SET status='completed',transaction_id=v_tx,klot_id=v_klot,completed_at=now(),last_error=NULL WHERE id=v_acq;
 END LOOP;
END $$;
COMMIT;
