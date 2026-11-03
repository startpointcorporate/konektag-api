BEGIN;

-- Parameterized, explicitly invoked by the migration administrator. No role is
-- guessed and no login credentials are created. Existing application grants on
-- orders, identities and the monetary ledger are deliberately not broadened.
CREATE FUNCTION konektag.grant_points_runtime_permissions(p_role NAME)
RETURNS VOID LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO v_role FROM pg_catalog.pg_roles WHERE rolname = p_role;
  IF NOT FOUND THEN RAISE EXCEPTION 'POINTS_RUNTIME_ROLE_NOT_FOUND'; END IF;
  IF v_role.rolsuper OR v_role.rolcreatedb OR v_role.rolcreaterole OR v_role.rolbypassrls
    OR pg_catalog.has_schema_privilege(p_role, 'konektag', 'CREATE')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'konektag' AND pg_catalog.pg_has_role(p_role, c.relowner, 'USAGE')
    ) THEN RAISE EXCEPTION 'POINTS_RUNTIME_ROLE_MUST_NOT_BE_ADMIN_OR_OWNER'; END IF;

  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA konektag TO %I', p_role);
  EXECUTE pg_catalog.format('GRANT SELECT ON konektag.points_lots TO %I', p_role);
  EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE ON konektag.points_payment_confirmations, konektag.points_acquisitions, konektag.api_payment_wallet_reservations TO %I', p_role);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION konektag.points_balance(UUID) TO %I', p_role);
  -- UUID defaults need no sequence grant. Trigger functions are not exposed.
END;
$$;
REVOKE ALL ON FUNCTION konektag.grant_points_runtime_permissions(NAME) FROM PUBLIC;

DO $$
DECLARE v_runtime_role TEXT := current_setting('konektag.runtime_role', true);
BEGIN
  IF COALESCE(v_runtime_role, '') <> '' THEN
    PERFORM konektag.grant_points_runtime_permissions(v_runtime_role::NAME);
  ELSE
    RAISE NOTICE 'Points runtime grants pending: administrator must configure and validate the actual runtime role';
  END IF;
END;
$$;

COMMIT;
