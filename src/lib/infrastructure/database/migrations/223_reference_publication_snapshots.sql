-- Freeze newly referenced public data at creation. Never backfill mutable historical rows.
BEGIN;
CREATE OR REPLACE FUNCTION konektag.snapshot_new_reference(profile_id uuid, code varchar) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE merchant jsonb; activity jsonb;
BEGIN
 SELECT jsonb_build_object(
 'id',mp.id,'businessName',mp.business_name,'slug',mp.slug,'logoUrl',mp.logo_url,'coverImageUrl',mp.cover_image_url,
 'shortDescription',mp.short_description,'longDescription',mp.long_description,
 'city',mp.city,'cityId',mp.city_id,'country',mp.country,'address',mp.address,'neighborhood',mp.neighborhood,
 'phone',mp.phone,'email',mp.email,'websiteUrl',mp.website_url,'latitude',mp.latitude,'longitude',mp.longitude,
 'certificationStatus',mp.certification_status,'photoUrls',mp.photo_urls)
 INTO merchant FROM konektag.merchant_profiles mp WHERE mp.id=profile_id AND mp.status='Referenced'
 AND mp.user_id IS NULL AND mp.deleted_at IS NULL AND mp.created_at>=transaction_timestamp()
 AND NOT EXISTS(SELECT 1 FROM konektag.merchant_n2_publication_snapshots s WHERE s.merchant_profile_id=mp.id);
 IF merchant IS NULL THEN RAISE EXCEPTION 'NEW_REFERENCE_REQUIRED'; END IF;
 IF code='Restaurant' THEN
 SELECT jsonb_build_object('status',status,'shortDescription',short_description,'longDescription',long_description,
   'phone',phone,'email',email,'hasDelivery',has_delivery,'hasTakeAway',has_take_away,'hasDineIn',has_dine_in,
   'hasReservation',has_reservation,'cuisineTypes',cuisine_types,'priceRange',price_range)
 INTO activity FROM konektag.restaurant_profiles WHERE merchant_profile_id=profile_id AND status='Referenced' AND deleted_at IS NULL;
 ELSIF code='Hotel' THEN
 SELECT jsonb_build_object('status',status,'shortDescription',short_description,'longDescription',long_description,
   'phone',phone,'email',email,'hasDelivery',has_delivery,'hasTakeout',has_takeout,'hasDineIn',has_dine_in,
   'stars',stars,'amenities',amenities,'priceRange',price_range)
 INTO activity FROM konektag.hotel_profiles WHERE merchant_profile_id=profile_id AND status='Referenced' AND deleted_at IS NULL;
 ELSIF code='Commerce' THEN
 SELECT jsonb_build_object('status',status,'shortDescription',short_description,'longDescription',long_description,
   'phone',phone,'email',email,'hasDelivery',has_delivery,'hasTakeout',has_takeout,'hasDineIn',has_dine_in,
   'mainActivity',main_activity,'productsServices',products_services,'hasCatalog',has_catalog,'priceRange',price_range)
 INTO activity FROM konektag.commerce_profiles WHERE merchant_profile_id=profile_id AND status='Referenced' AND deleted_at IS NULL;
 END IF;
 IF activity IS NULL THEN RAISE EXCEPTION 'REFERENCED_ACTIVITY_REQUIRED'; END IF;
 INSERT INTO konektag.merchant_n2_publication_snapshots(merchant_profile_id,version,snapshot)
 VALUES(profile_id,1,jsonb_build_object('schemaVersion',1,'merchant',merchant,'activities',jsonb_build_array(code)));
 INSERT INTO konektag.merchant_publication_snapshots(merchant_profile_id,activity_code,version,snapshot)
 VALUES(profile_id,code,1,jsonb_build_object('schemaVersion',2,'merchant',merchant,'activityCode',code,'activity',activity,
   'media','[]'::jsonb,'externalLinks','[]'::jsonb,'products','[]'::jsonb,'openingHours','[]'::jsonb));
END;
$$;
COMMIT;
