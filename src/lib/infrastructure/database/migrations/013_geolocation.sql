-- Migration 013 : Géolocalisation — colonnes lat/lng + Haversine + index
-- Version : 1.0 | Idempotent

-- ═══ Colonnes latitude / longitude ═══
ALTER TABLE konektag.merchant_profiles
  ADD COLUMN IF NOT EXISTS latitude  DECIMAL(10,7),
  ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7);

-- ═══ Fonction Haversine (distance en km entre deux points) ═══
CREATE OR REPLACE FUNCTION konektag.haversine_km(
    lat1 DECIMAL, lng1 DECIMAL,
    lat2 DECIMAL, lng2 DECIMAL
) RETURNS DECIMAL AS $$
    SELECT 6371 * 2 * ASIN(SQRT(
        POWER(SIN(RADIANS($3 - $1) / 2), 2) +
        COS(RADIANS($1)) * COS(RADIANS($3)) *
        POWER(SIN(RADIANS($4 - $2) / 2), 2)
    ));
$$ LANGUAGE sql IMMUTABLE;

-- ═══ Index pour les recherches spatiales ═══
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'konektag'
      AND indexname = 'idx_merchant_profiles_coords'
  ) THEN
    CREATE INDEX idx_merchant_profiles_coords
      ON konektag.merchant_profiles (latitude, longitude)
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND deleted_at IS NULL;
  END IF;
END $$;
