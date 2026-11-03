BEGIN;
CREATE OR REPLACE FUNCTION konektag.city_country_code(value TEXT) RETURNS TEXT
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
 WHEN 'belgique' THEN 'BE'
 WHEN 'belgium' THEN 'BE'
 WHEN 'canada' THEN 'CA'
 WHEN 'états-unis' THEN 'US'
 WHEN 'united states' THEN 'US'
 WHEN 'liban' THEN 'LB'
 WHEN 'lebanon' THEN 'LB'
 WHEN 'bénin' THEN 'BJ'
 WHEN 'benin' THEN 'BJ'
 WHEN 'burkina faso' THEN 'BF'
 WHEN 'côte d’ivoire' THEN 'CI'
 WHEN 'côte d''ivoire' THEN 'CI'
 WHEN 'ivory coast' THEN 'CI'
 WHEN 'sénégal' THEN 'SN'
 WHEN 'senegal' THEN 'SN'
 WHEN 'mali' THEN 'ML'
 WHEN 'togo' THEN 'TG'
 WHEN 'niger' THEN 'NE'
 WHEN 'nigeria' THEN 'NG'
 WHEN 'ghana' THEN 'GH'
 WHEN 'kenya' THEN 'KE'
 WHEN 'éthiopie' THEN 'ET'
 WHEN 'ethiopia' THEN 'ET'
 WHEN 'rwanda' THEN 'RW'
 WHEN 'burundi' THEN 'BI'
 WHEN 'ouganda' THEN 'UG'
 WHEN 'uganda' THEN 'UG'
 WHEN 'tanzanie' THEN 'TZ'
 WHEN 'tanzania' THEN 'TZ'
 WHEN 'afrique du sud' THEN 'ZA'
 WHEN 'south africa' THEN 'ZA'
 WHEN 'mozambique' THEN 'MZ'
 WHEN 'zambie' THEN 'ZM'
 WHEN 'zambia' THEN 'ZM'
 WHEN 'zimbabwe' THEN 'ZW'
 WHEN 'malawi' THEN 'MW'
 WHEN 'lesotho' THEN 'LS'
 WHEN 'madagascar' THEN 'MG'
 WHEN 'maroc' THEN 'MA'
 WHEN 'morocco' THEN 'MA'
 WHEN 'algérie' THEN 'DZ'
 WHEN 'algeria' THEN 'DZ'
 WHEN 'tunisie' THEN 'TN'
 WHEN 'tunisia' THEN 'TN'
 WHEN 'portugal' THEN 'PT'
 WHEN 'espagne' THEN 'ES'
 WHEN 'spain' THEN 'ES'
 WHEN 'allemagne' THEN 'DE'
 WHEN 'germany' THEN 'DE'
 WHEN 'royaume-uni' THEN 'GB'
 WHEN 'united kingdom' THEN 'GB'
 WHEN 'italie' THEN 'IT'
 WHEN 'italy' THEN 'IT'
 WHEN 'suisse' THEN 'CH'
 WHEN 'switzerland' THEN 'CH'
 ELSE CASE WHEN trim(value) ~ '^[A-Za-z]{2}$' THEN upper(trim(value)) ELSE NULL END END;
$$;

-- Repair derived associations using BOTH explicit country and city; never infer country from a city name.
INSERT INTO konektag.cities(country_code,name,normalized_name)
SELECT konektag.city_country_code(country),min(trim(city)),lower(trim(city)) FROM konektag.merchant_profiles
WHERE konektag.city_country_code(country) IS NOT NULL AND nullif(trim(city),'') IS NOT NULL
GROUP BY konektag.city_country_code(country),lower(trim(city)) ON CONFLICT DO NOTHING;
UPDATE konektag.merchant_profiles m SET city_id=c.id FROM konektag.cities c
WHERE c.country_code=konektag.city_country_code(m.country) AND c.normalized_name=lower(trim(m.city)) AND m.city_id IS DISTINCT FROM c.id;
-- Non-destructive reconciliation: retain original rows, merchant data and publication snapshots.
ALTER TABLE konektag.cities ADD COLUMN marketplace_canonical_id UUID REFERENCES konektag.cities(id);
ALTER TABLE konektag.cities ADD COLUMN marketplace_review_reason TEXT;
ALTER TABLE konektag.cities ADD CONSTRAINT marketplace_canonical_country_fk FOREIGN KEY(marketplace_canonical_id,country_code) REFERENCES konektag.cities(id,country_code);
-- Obvious imported address fragments must be reviewed rather than guessed into a city.
UPDATE konektag.cities SET marketplace_review_reason='INVALID_CITY_LABEL'
WHERE name ~ '[@0-9⁰]' OR length(trim(name))<2
 OR lower(trim(name)) IN ('face','noire')
 OR lower(trim(name)) ~ '^(av[. ]|avenue |rue |boulevard |quartier |en[0-9])';
UPDATE konektag.cities SET marketplace_review_reason='COUNTRY_CITY_CONFLICT'
WHERE (lower(trim(name))='brazzaville' AND country_code<>'CG')
 OR (lower(trim(name))='kinshasa' AND country_code<>'CD');
-- Merge only equivalent spellings within the SAME country. Old city IDs remain resolvable.
WITH normalized AS (
 SELECT id,country_code,lower(regexp_replace(translate(trim(name),'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ','aaaeeeeiioouuucAAAEEEEIIOOUUUC'),'[[:space:]_-]+','-','g')) AS key
 FROM konektag.cities WHERE marketplace_review_reason IS NULL
), targets AS (
 SELECT country_code,key,(array_agg(id ORDER BY id))[1] AS canonical_id FROM normalized GROUP BY country_code,key
)
UPDATE konektag.cities c SET marketplace_canonical_id=t.canonical_id
FROM normalized n JOIN targets t USING(country_code,key) WHERE c.id=n.id AND c.id<>t.canonical_id;
-- Also screen newly imported city labels. Normalization never changes a merchant's country.
CREATE FUNCTION konektag.screen_marketplace_city() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.marketplace_review_reason=NULL;
 NEW.marketplace_canonical_id=NULL;
 IF NEW.name ~ '[@0-9⁰]' OR length(trim(NEW.name))<2 OR lower(trim(NEW.name)) IN ('face','noire')
 OR lower(trim(NEW.name)) ~ '^(av[. ]|avenue |rue |boulevard |quartier |en[0-9])' THEN
 NEW.marketplace_review_reason='INVALID_CITY_LABEL';
 ELSIF (lower(trim(NEW.name))='brazzaville' AND NEW.country_code<>'CG') OR (lower(trim(NEW.name))='kinshasa' AND NEW.country_code<>'CD') THEN
 NEW.marketplace_review_reason='COUNTRY_CITY_CONFLICT';
 END IF;
 IF NEW.marketplace_review_reason IS NULL THEN
 SELECT COALESCE(c.marketplace_canonical_id,c.id) INTO NEW.marketplace_canonical_id
 FROM konektag.cities c WHERE c.id<>NEW.id AND COALESCE(c.marketplace_canonical_id,c.id)<>NEW.id AND c.country_code=NEW.country_code AND c.marketplace_review_reason IS NULL
 AND lower(regexp_replace(translate(trim(c.name),'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ','aaaeeeeiioouuucAAAEEEEIIOOUUUC'),'[[:space:]_-]+','-','g'))
 =lower(regexp_replace(translate(trim(NEW.name),'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ','aaaeeeeiioouuucAAAEEEEIIOOUUUC'),'[[:space:]_-]+','-','g'))
 ORDER BY c.id LIMIT 1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER screen_marketplace_city BEFORE INSERT OR UPDATE OF name,country_code ON konektag.cities FOR EACH ROW EXECUTE FUNCTION konektag.screen_marketplace_city();
COMMIT;
