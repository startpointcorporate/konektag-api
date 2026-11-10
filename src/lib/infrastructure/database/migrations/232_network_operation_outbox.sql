-- Migration 232 : one outbox event per Network operation notification.
-- aggregate_ref holds the notification key (link-pay:<link>:issued, recharge:<attempt>:paid…):
-- a replayed webhook or reconciliation pass never queues a second event. Additive and replayable.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_network_operation_event
  ON konektag.outbox_events (aggregate_ref)
  WHERE event_type = 'NetworkOperationChanged';

COMMIT;
