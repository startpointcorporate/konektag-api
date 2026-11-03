BEGIN;

-- Initial marketplace offer taxonomy. Idempotent seed: taxonomy remains editable
-- through the normal administration model after deployment.
INSERT INTO konektag.offer_categories(code,activity_code,name_i18n,sort_order,is_active)
VALUES
 ('restaurant-traditional','Restaurant','{"fr":"Cuisine traditionnelle","en":"Traditional cuisine"}',10,true),
 ('restaurant-fast-food','Restaurant','{"fr":"Fast-food & Street food","en":"Fast food & Street food"}',20,true),
 ('restaurant-cafe','Restaurant','{"fr":"Café & Salon de thé","en":"Cafe & Tea room"}',30,true),
 ('restaurant-bakery','Restaurant','{"fr":"Boulangerie & Pâtisserie","en":"Bakery & Pastry"}',40,true),
 ('restaurant-bar','Restaurant','{"fr":"Bar & Lounge","en":"Bar & Lounge"}',50,true),
 ('restaurant-catering','Restaurant','{"fr":"Traiteur","en":"Catering"}',60,true),
 ('hotel-hotel','Hotel','{"fr":"Hôtel","en":"Hotel"}',10,true),
 ('hotel-aparthotel','Hotel','{"fr":"Appart’hôtel","en":"Aparthotel"}',20,true),
 ('hotel-guesthouse','Hotel','{"fr":"Maison d’hôtes","en":"Guest house"}',30,true),
 ('hotel-residence','Hotel','{"fr":"Résidence","en":"Residence"}',40,true),
 ('hotel-hostel','Hotel','{"fr":"Auberge","en":"Hostel"}',50,true),
 ('commerce-fashion','Commerce','{"fr":"Mode & Accessoires","en":"Fashion & Accessories"}',10,true),
 ('commerce-food','Commerce','{"fr":"Alimentation","en":"Food & Grocery"}',20,true),
 ('commerce-beauty','Commerce','{"fr":"Beauté & Bien-être","en":"Beauty & Wellness"}',30,true),
 ('commerce-electronics','Commerce','{"fr":"Électronique & Téléphonie","en":"Electronics & Mobile"}',40,true),
 ('commerce-home','Commerce','{"fr":"Maison & Décoration","en":"Home & Decoration"}',50,true),
 ('commerce-services','Commerce','{"fr":"Services","en":"Services"}',60,true),
 ('commerce-other','Commerce','{"fr":"Autres commerces","en":"Other shops"}',70,true)
ON CONFLICT(code) DO UPDATE SET
 activity_code=EXCLUDED.activity_code,
 name_i18n=EXCLUDED.name_i18n,
 sort_order=EXCLUDED.sort_order,
 is_active=true,
 deleted_at=NULL,
 updated_at=now();

COMMIT;
