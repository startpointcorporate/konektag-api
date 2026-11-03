BEGIN;
-- Preserve historical country labels; normalize only their city association/filter key.
CREATE FUNCTION konektag.city_country_code(value TEXT) RETURNS TEXT
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE lower(trim(value))
 WHEN 'cameroun' THEN 'CM' WHEN 'cameroon' THEN 'CM'
 WHEN 'congo' THEN 'CG' WHEN 'congo-brazzaville' THEN 'CG' WHEN 'republic of the congo' THEN 'CG'
 WHEN 'rdc' THEN 'CD' WHEN 'congo-kinshasa' THEN 'CD' WHEN 'république démocratique du congo' THEN 'CD' WHEN 'democratic republic of the congo' THEN 'CD'
 WHEN 'gabon' THEN 'GA' WHEN 'angola' THEN 'AO'
 WHEN 'guinée' THEN 'GN' WHEN 'guinea' THEN 'GN'
 WHEN 'tchad' THEN 'TD' WHEN 'chad' THEN 'TD'
 WHEN 'guinée éq.' THEN 'GQ' WHEN 'guinée équatoriale' THEN 'GQ' WHEN 'equatorial guinea' THEN 'GQ'
 WHEN 'centrafrique' THEN 'CF' WHEN 'république centrafricaine' THEN 'CF' WHEN 'central african republic' THEN 'CF'
 WHEN 'france' THEN 'FR'
 ELSE CASE WHEN trim(value) ~ '^[A-Za-z]{2}$' THEN upper(trim(value)) ELSE NULL END END;
$$;
INSERT INTO konektag.cities(country_code,name,normalized_name)
SELECT konektag.city_country_code(country),min(trim(city)),lower(trim(city))
FROM konektag.merchant_profiles
WHERE konektag.city_country_code(country) IS NOT NULL AND nullif(trim(city),'') IS NOT NULL
GROUP BY konektag.city_country_code(country),lower(trim(city)) ON CONFLICT DO NOTHING;
UPDATE konektag.merchant_profiles m SET city_id=c.id FROM konektag.cities c
WHERE c.country_code=konektag.city_country_code(m.country) AND c.normalized_name=lower(trim(m.city)) AND m.city_id IS DISTINCT FROM c.id;
CREATE OR REPLACE FUNCTION konektag.assign_merchant_city() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE country_key TEXT;
BEGIN
 IF TG_OP='INSERT' OR (NEW.country,NEW.city) IS DISTINCT FROM (OLD.country,OLD.city) THEN
  NEW.city_id=NULL;
  country_key=konektag.city_country_code(NEW.country);
  IF country_key IS NOT NULL AND nullif(trim(NEW.city),'') IS NOT NULL THEN
   INSERT INTO konektag.cities(country_code,name,normalized_name) VALUES(country_key,trim(NEW.city),lower(trim(NEW.city))) ON CONFLICT DO NOTHING;
   SELECT id INTO NEW.city_id FROM konektag.cities WHERE country_code=country_key AND normalized_name=lower(trim(NEW.city));
  END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
