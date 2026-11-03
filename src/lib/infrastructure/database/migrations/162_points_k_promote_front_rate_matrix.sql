BEGIN;

-- The legacy browser tables expressed one unit of each source currency in XOF.
-- Promote that exact source into direct EUR authorities using the displayed
-- EUR/XOF anchor (656 XOF = 1 EUR). No browser value is read at runtime.
--
-- Production may still carry the historical UNIQUE(from_currency,to_currency)
-- constraint. Promote an existing pair in place first, then insert only pairs
-- that do not exist. This remains compatible with the newer
-- UNIQUE(from_currency,to_currency,valid_from) model as well.
CREATE TEMP TABLE points_k_front_rate_matrix (
  source_currency varchar(3) PRIMARY KEY,
  rate numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO points_k_front_rate_matrix(source_currency, rate) VALUES
  ('XAF', 0.001524390::numeric),
  ('XOF', 0.001524390::numeric),
  ('USD', 0.922256098::numeric),
  ('LBP', 0.000076220::numeric),
  ('AOA', 0.000990854::numeric),
  ('CDF', 0.000503049::numeric);

UPDATE konektag.exchange_rates existing
SET rate = matrix.rate,
    valid_from = now(),
    valid_to = '9999-12-31',
    rate_source = 'FRONT_LEGACY_RATE_TABLE',
    published_at = now(),
    points_k_status = 'APPROVED',
    points_k_matrix_version = 2,
    points_k_approved_at = now(),
    points_k_approval_source = 'FRONT_LEGACY_RATE_TABLE',
    points_k_change_reason =
      'Promoted from the legacy XOF-relative browser matrix: 1 EUR = 656 XOF'
FROM points_k_front_rate_matrix matrix
WHERE existing.from_currency = matrix.source_currency
  AND existing.to_currency = 'EUR';

INSERT INTO konektag.exchange_rates
  (from_currency, to_currency, rate, valid_from, valid_to, rate_source,
   published_at, points_k_status, points_k_matrix_version,
   points_k_approved_at, points_k_approval_source, points_k_change_reason)
SELECT matrix.source_currency, 'EUR', matrix.rate, now(), '9999-12-31',
       'FRONT_LEGACY_RATE_TABLE', now(), 'APPROVED', 2, now(),
       'FRONT_LEGACY_RATE_TABLE',
       'Promoted from the legacy XOF-relative browser matrix: 1 EUR = 656 XOF'
FROM points_k_front_rate_matrix matrix
WHERE NOT EXISTS (
  SELECT 1
  FROM konektag.exchange_rates existing
  WHERE existing.from_currency = matrix.source_currency
    AND existing.to_currency = 'EUR'
);

COMMIT;
