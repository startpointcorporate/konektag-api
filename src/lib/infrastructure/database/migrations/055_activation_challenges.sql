-- Activation Challenge is a standalone financial incentive domain. It never uses
-- the cashback accounts or cashback transaction type.
BEGIN;

INSERT INTO konektag.financial_accounts
  (account_code, account_name, account_type, is_system, is_cash, description)
VALUES
  ('4200', 'Bonus Activation Distribués', 'expense', true, false,
   'Bonus de surbonification crédités aux wallets utilisateurs')
ON CONFLICT (account_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS konektag.activation_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_name VARCHAR(160) NOT NULL,
  public_title VARCHAR(200) NOT NULL,
  public_description TEXT NOT NULL DEFAULT '',
  baseline VARCHAR(300) NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  time_zone VARCHAR(64) NOT NULL DEFAULT 'Europe/Paris',
  individual_duration_days SMALLINT NOT NULL DEFAULT 90 CHECK (individual_duration_days > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  max_bonus_amount BIGINT NOT NULL CHECK (max_bonus_amount > 0),
  eligible_country_codes VARCHAR(2)[] NOT NULL DEFAULT '{}',
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  created_by UUID REFERENCES konektag.users(id),
  updated_by UUID REFERENCES konektag.users(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_campaign_active
  ON konektag.activation_campaigns(status)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_campaign_internal_name
  ON konektag.activation_campaigns(internal_name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activation_campaigns_schedule
  ON konektag.activation_campaigns(status, starts_at, ends_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS konektag.activation_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES konektag.activation_campaigns(id),
  metric_type VARCHAR(32) NOT NULL CHECK (metric_type IN ('Deposit', 'TransferSent', 'QrPaymentReceived', 'MerchantPayment')),
  target_amount BIGINT NOT NULL CHECK (target_amount > 0),
  bonus_amount BIGINT NOT NULL CHECK (bonus_amount > 0),
  requires_verified_account BOOLEAN NOT NULL DEFAULT false,
  sort_order SMALLINT NOT NULL CHECK (sort_order > 0),
  public_title VARCHAR(200) NOT NULL,
  public_description TEXT NOT NULL DEFAULT '',
  cta_type VARCHAR(32) NOT NULL,
  eligible_country_codes VARCHAR(2)[] NOT NULL DEFAULT '{}',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_activation_milestones_campaign
  ON konektag.activation_milestones(campaign_id, sort_order) WHERE is_enabled;

-- The requested first campaign is introduced as a draft. Publishing it remains
-- an explicit audited admin action because it credits real money.
INSERT INTO konektag.activation_campaigns
  (internal_name, public_title, public_description, baseline, starts_at, ends_at,
   time_zone, individual_duration_days, currency, max_bonus_amount, status)
VALUES
  ('challenge-100-eur-summer-2026', 'Jusqu''à 100 € offerts',
   'Débloquez vos bonus en utilisant Konektag pendant la campagne.',
   'Déposez. Envoyez. Recevez. Payez.',
   TIMESTAMPTZ '2026-07-24 00:00:00 Europe/Paris',
   TIMESTAMPTZ '2026-10-01 00:00:00 Europe/Paris',
   'Europe/Paris', 90, 'EUR', 100, 'draft')
ON CONFLICT (internal_name) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO konektag.activation_milestones
  (campaign_id, metric_type, target_amount, bonus_amount, requires_verified_account,
   sort_order, public_title, public_description, cta_type)
SELECT c.id, v.metric_type, v.target_amount, v.bonus_amount, v.requires_verified_account,
       v.sort_order, v.public_title, v.public_description, v.cta_type
FROM konektag.activation_campaigns c
JOIN (VALUES
  ('Deposit', 200, 10, true, 1, 'Déposer 200 €', 'Compte vérifié requis.', 'deposit'),
  ('TransferSent', 200, 15, false, 2, 'Envoyer 200 €', 'Envoyez de l''argent avec Konektag.', 'transfer'),
  ('QrPaymentReceived', 200, 15, false, 3, 'Recevoir 200 € par QR', 'Recevez des paiements avec votre QR personnel.', 'qr'),
  ('MerchantPayment', 250, 20, false, 4, 'Payer 250 € chez un commerçant', 'Payez chez les commerçants Konektag.', 'marketplace'),
  ('MerchantPayment', 500, 40, false, 5, 'Payer 500 € chez un commerçant', 'Continuez vos paiements chez les commerçants Konektag.', 'marketplace')
) AS v(metric_type, target_amount, bonus_amount, requires_verified_account, sort_order, public_title, public_description, cta_type)
  ON true
WHERE c.internal_name = 'challenge-100-eur-summer-2026'
ON CONFLICT (campaign_id, sort_order) DO NOTHING;

CREATE TABLE IF NOT EXISTS konektag.activation_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES konektag.activation_campaigns(id),
  user_id UUID NOT NULL REFERENCES konektag.users(id),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  campaign_snapshot JSONB NOT NULL,
  total_bonus_earned BIGINT NOT NULL DEFAULT 0 CHECK (total_bonus_earned >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, user_id),
  CHECK (expires_at > started_at)
);
CREATE INDEX IF NOT EXISTS idx_activation_challenges_user_active
  ON konektag.activation_challenges(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS konektag.activation_activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id),
  financial_transaction_id UUID REFERENCES konektag.financial_transactions(id),
  source_type VARCHAR(32) NOT NULL CHECK (source_type IN ('recharge', 'transfer', 'qr_personal', 'merchant_payment')),
  source_id VARCHAR(160) NOT NULL,
  metric_type VARCHAR(32) NOT NULL CHECK (metric_type IN ('Deposit', 'TransferSent', 'QrPaymentReceived', 'MerchantPayment')),
  source_amount BIGINT NOT NULL CHECK (source_amount > 0),
  source_currency VARCHAR(3) NOT NULL,
  campaign_amount NUMERIC(20, 6) NOT NULL CHECK (campaign_amount > 0),
  campaign_currency VARCHAR(3) NOT NULL DEFAULT 'EUR' CHECK (campaign_currency = 'EUR'),
  exchange_rate NUMERIC(20, 10) NOT NULL CHECK (exchange_rate > 0),
  country_code VARCHAR(2),
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id),
  UNIQUE (financial_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_activation_activity_user_metric
  ON konektag.activation_activity_events(user_id, metric_type, occurred_at);

CREATE TABLE IF NOT EXISTS konektag.activation_milestone_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES konektag.activation_challenges(id),
  milestone_id UUID NOT NULL REFERENCES konektag.activation_milestones(id),
  accumulated_amount NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (accumulated_amount >= 0),
  reached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (challenge_id, milestone_id)
);

CREATE TABLE IF NOT EXISTS konektag.activation_milestone_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_progress_id UUID NOT NULL REFERENCES konektag.activation_milestone_progress(id),
  activity_event_id UUID NOT NULL REFERENCES konektag.activation_activity_events(id),
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (milestone_progress_id, activity_event_id)
);

CREATE TABLE IF NOT EXISTS konektag.activation_bonuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES konektag.activation_challenges(id),
  milestone_id UUID NOT NULL REFERENCES konektag.activation_milestones(id),
  user_id UUID NOT NULL REFERENCES konektag.users(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  status VARCHAR(24) NOT NULL DEFAULT 'earned' CHECK (status IN ('earned', 'credited', 'reconciliation_required', 'rejected')),
  financial_transaction_id UUID UNIQUE REFERENCES konektag.financial_transactions(id),
  reconciliation_reason TEXT,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (challenge_id, milestone_id)
);
CREATE INDEX IF NOT EXISTS idx_activation_bonuses_user ON konektag.activation_bonuses(user_id, status, earned_at DESC);

CREATE TABLE IF NOT EXISTS konektag.activation_campaign_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES konektag.activation_campaigns(id),
  actor_id UUID REFERENCES konektag.users(id),
  action VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_activation_campaigns_updated_at ON konektag.activation_campaigns;
CREATE TRIGGER trg_activation_campaigns_updated_at BEFORE UPDATE ON konektag.activation_campaigns
  FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();
DROP TRIGGER IF EXISTS trg_activation_challenges_updated_at ON konektag.activation_challenges;
CREATE TRIGGER trg_activation_challenges_updated_at BEFORE UPDATE ON konektag.activation_challenges
  FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();
DROP TRIGGER IF EXISTS trg_activation_milestones_updated_at ON konektag.activation_milestones;
CREATE TRIGGER trg_activation_milestones_updated_at BEFORE UPDATE ON konektag.activation_milestones
  FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();
DROP TRIGGER IF EXISTS trg_activation_progress_updated_at ON konektag.activation_milestone_progress;
CREATE TRIGGER trg_activation_progress_updated_at BEFORE UPDATE ON konektag.activation_milestone_progress
  FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();
DROP TRIGGER IF EXISTS trg_activation_bonuses_updated_at ON konektag.activation_bonuses;
CREATE TRIGGER trg_activation_bonuses_updated_at BEFORE UPDATE ON konektag.activation_bonuses
  FOR EACH ROW EXECUTE FUNCTION konektag.set_updated_at();

COMMIT;
