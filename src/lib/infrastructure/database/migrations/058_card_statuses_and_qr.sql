-- Migration 058: Renommer les statuts de carte INACTIVE→GENERATED, REDEEMED→ACTIVATED
-- Ajout champ qr_code (data URL stocké au moment de la génération)
-- Ajout index sur sold_by pour les rapports commerçant

-- Step 1: drop the old check constraint and add the new one
ALTER TABLE konektag.cards DROP CONSTRAINT IF EXISTS valid_status;

-- Step 2: migrate existing data: INACTIVE → GENERATED, REDEEMED → ACTIVATED
UPDATE konektag.cards SET status = 'GENERATED' WHERE status = 'INACTIVE';
UPDATE konektag.cards SET status = 'ACTIVATED' WHERE status = 'REDEEMED';

-- Step 3: add the qr_code column
ALTER TABLE konektag.cards ADD COLUMN IF NOT EXISTS qr_code TEXT;

-- Step 4: add the new constraint with GENERATED / SOLD / ACTIVATED
ALTER TABLE konektag.cards ADD CONSTRAINT valid_status CHECK (status IN ('GENERATED', 'SOLD', 'ACTIVATED'));

-- Step 5: index for merchant sales reporting
CREATE INDEX IF NOT EXISTS idx_cards_sold_by ON konektag.cards(sold_by) WHERE sold_by IS NOT NULL AND deleted_at IS NULL;
