CREATE TABLE IF NOT EXISTS konektag.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  rate DECIMAL(21,9) NOT NULL,
  valid_from TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  valid_to TIMESTAMP WITH TIME ZONE DEFAULT '9999-12-31',
  UNIQUE(from_currency, to_currency, valid_from)
);

INSERT INTO konektag.exchange_rates (from_currency, to_currency, rate) VALUES
  ('EUR', 'XOF', 656),
  ('XOF', 'EUR', 0.001524),
  ('USD', 'XOF', 605),
  ('XOF', 'USD', 0.001653),
  ('LBP', 'XOF', 0.05),
  ('XOF', 'LBP', 20),
  ('AOA', 'XOF', 0.65),
  ('XOF', 'AOA', 1.538),
  ('CDF', 'XOF', 0.33),
  ('XOF', 'CDF', 3.03)
-- Idempotent : ignorer toute ligne en conflit avec une contrainte unique existante
-- (la table peut avoir une contrainte UNIQUE(from_currency, to_currency) historique)
ON CONFLICT DO NOTHING;
