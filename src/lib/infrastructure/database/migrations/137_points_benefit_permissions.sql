-- Runtime role is supplied by approved configuration; no implicit grant to an owner.
BEGIN;
CREATE FUNCTION konektag.grant_points_benefit_runtime_permissions(p_role NAME)
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM konektag.grant_points_runtime_permissions(p_role);
 EXECUTE format('GRANT SELECT ON konektag.merchant_points_benefit_eligibility,konektag.points_accounting_roles,konektag.points_merchant_settlement_details TO %I',p_role);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON konektag.points_merchant_consumptions,konektag.fee_credits,konektag.fee_credit_applications,konektag.merchant_points_bonuses TO %I',p_role);
 EXECUTE format('GRANT SELECT,INSERT ON konektag.fee_credit_uses TO %I',p_role);
 EXECUTE format('GRANT EXECUTE ON FUNCTION konektag.apply_fee_credit_to_fees(UUID,TEXT,TEXT,NUMERIC,INT,BOOLEAN),konektag.finish_fee_credit_application(TEXT,BOOLEAN) TO %I',p_role);
END; $$;
REVOKE ALL ON FUNCTION konektag.grant_points_benefit_runtime_permissions(NAME) FROM PUBLIC;
DO $$ DECLARE r TEXT:=current_setting('konektag.runtime_role',true); BEGIN
 IF COALESCE(r,'')<>'' THEN PERFORM konektag.grant_points_benefit_runtime_permissions(r::NAME);
 ELSE RAISE NOTICE 'Points benefits runtime permissions pending: configure konektag.runtime_role'; END IF;
END; $$;
COMMIT;
