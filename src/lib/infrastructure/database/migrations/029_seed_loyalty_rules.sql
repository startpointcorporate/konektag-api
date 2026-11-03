INSERT INTO konektag.configurations (key, value, description) VALUES
    ('LOYALTY_POINTS_PER_ACTION', '{"transfer": 10, "qr_payment": 5, "review": 3, "referral": 50, "signup": 25}',
     'Points attribués par type d''action'),
    ('LOYALTY_POINTS_PER_AMOUNT', '{"per": 1000, "points": 1}',
     'Points attribués par tranche de montant (devise locale)'),
    ('LOYALTY_LEVEL_THRESHOLDS', '{"bronze": 0, "silver": 500, "gold": 2000, "platinum": 5000}',
     'Seuils de points cumulés pour chaque niveau'),
    ('LOYALTY_LEVEL_NAMES', '{"bronze": "Bronze", "silver": "Argent", "gold": "Or", "platinum": "Platine"}',
     'Noms affichés des niveaux de fidélité')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description;
