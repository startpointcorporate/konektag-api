-- Points K purchases use a free quantity selected by the customer.
-- A dynamic lot is immutable evidence of the purchased K quantity/value, not a commercial catalogue item.
BEGIN;

ALTER TABLE konektag.points_lots
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES konektag.api_payment_orders(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_points_lots_order
  ON konektag.points_lots(order_id)
  WHERE order_id IS NOT NULL;

ALTER TABLE konektag.points_lots
  DROP CONSTRAINT IF EXISTS points_lots_provider_check;

ALTER TABLE konektag.points_lots
  ADD CONSTRAINT points_lots_provider_check
  CHECK (provider IN ('stripe','pawapay','manual'));

CREATE OR REPLACE FUNCTION konektag.points_lot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.currency<>OLD.currency OR NEW.quantity<>OLD.quantity
   OR NEW.value_minor<>OLD.value_minor OR NEW.provider<>OLD.provider
   OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN RAISE EXCEPTION 'POINTS_LOT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;

COMMIT;
