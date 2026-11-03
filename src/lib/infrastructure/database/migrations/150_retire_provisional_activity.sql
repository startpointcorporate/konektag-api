BEGIN;
-- CORE-01 has no historical business data. All runtime callers now use core_transactions.
DROP TABLE konektag.orders;
DROP TABLE konektag.bookings;
COMMIT;
