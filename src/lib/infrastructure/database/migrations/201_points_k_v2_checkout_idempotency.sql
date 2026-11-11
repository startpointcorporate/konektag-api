BEGIN;

-- A submitted ERPNext Payment Request identifies one and only one Points K
-- checkout for a user. The partial expression index leaves legacy recharges
-- and Link Pay / QR Pay orders untouched.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_payment_orders_points_k_payment_request
  ON konektag.api_payment_orders (
    target_user_id,
    (order_metadata #>> '{erpnextPointsK,paymentRequest}')
  )
  WHERE order_purpose = 'wallet_recharge'
    AND order_metadata #>> '{erpnextPointsK,paymentRequest}' IS NOT NULL;

COMMIT;
