-- Historical compatibility snapshot. Runtime Pro accounting resolves its
-- corridor-specific accounts from the approved Frappe regulatory profile.
INSERT INTO konektag.accounting_entry_guides
  (legal_entity_id, event_type, debit_account, credit_account, description)
SELECT le.id, 'subscription_sale',
  CASE le.code
    WHEN 'KTG-FR' THEN '5115 - Compensation Stripe - KTF'
    WHEN 'KTG-CG' THEN '5188-Compensation PawaPay - KTC'
    WHEN 'KTG-CM' THEN '5188-Compensation PawaPay - KTCM'
    WHEN 'KTG-GA' THEN '5188-Compensation PawaPay - KTGA'
  END,
  CASE le.code
    WHEN 'KTG-FR' THEN '7061 - Abonnements Pro - KTF'
    WHEN 'KTG-CG' THEN '7066-Abonnements Pro - KTC'
    WHEN 'KTG-CM' THEN '7066-Abonnements Pro - KTCM'
    WHEN 'KTG-GA' THEN '7066-Abonnements Pro - KTGA'
  END,
  'Abonnement Pro — configuration Frappe par corridor'
FROM konektag.legal_entities le
WHERE le.code IN ('KTG-FR', 'KTG-CG', 'KTG-CM', 'KTG-GA')
  AND NOT EXISTS (
    SELECT 1 FROM konektag.accounting_entry_guides existing
    WHERE existing.legal_entity_id = le.id
      AND existing.event_type = 'subscription_sale'
  );
