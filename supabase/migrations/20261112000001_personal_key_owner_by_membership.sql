-- §4 D321 — a personal API key died when its owner SWITCHED organization.
--
-- Reported 2026-11-12: a notebook run with a personal key for one organization was
-- refused `401 key_owner_inactive` — "this personal key's owner is no longer active in
-- its organization" — while the owner was active and still a member of it.
--
-- The cause is an ordering of two packages. D210 (`20260930000004`) made an account a
-- member of SEVERAL organizations: `organization_members` became the authority for
-- membership and `approved_users.organization_id` became the ACTIVE organization — the
-- one the account is switched into now. WP 12.3 (`20261002000001`), two days later,
-- wrote `api_personal_key_actor` against the earlier meaning:
--
--     AND u.organization_id = k.org_id
--
-- So a personal key worked only while its owner happened to be switched into the
-- key's organization. A consultant who minted a key in organization A and then
-- switched to organization B (or signed in to B, D216) killed the A key without
-- leaving A. WP 12.7's `api_personal_key_grant` repeated the same reading one level
-- down: whether the owner MANAGES keys was asked of `_api_key_caller(actor, key_org)`,
-- which refuses an org that is not the active one — the grant then raised and the
-- gateway answered 503 rather than 401 for a manager's key.
--
-- What changes — the key's organization is asked of MEMBERSHIP, never of the active
-- organization:
--
--   * `api_personal_key_actor`: the owner is active AND holds an `organization_members`
--     row for the key's organization. The invariant D210 keeps (the active organization
--     is always a membership) makes this a strict superset of the old test: every key
--     that worked still works, and the only keys newly admitted are those whose owner
--     is genuinely a member of the key's organization. Removing the membership
--     (`admin_remove_org_member`, `admin_delete_organization`) or deactivating the
--     account still kills the key — WP 12.3's promise is unchanged.
--   * `_api_key_manages_org(user, org)`: the ONE rule for "may manage this
--     organization's keys" — a super admin; an admin/modeler account; or an
--     owner/admin membership of THAT organization. `_api_key_management_org` now
--     decides through it (body otherwise verbatim), and `api_personal_key_grant` asks
--     it of the KEY's organization, so a write-scoped key keeps its scopes while its
--     owner works elsewhere, exactly as if they had switched back.
--
-- Not changed, stated: CREATING a key still mints it for the active organization
-- (`_api_key_caller`) — the page the user is on is the organization they are working
-- in. Listing and revoking likewise.

-- ── the one rule: may this account manage this organization's keys ──────────
CREATE OR REPLACE FUNCTION public._api_key_manages_org(p_user_id uuid, p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.approved_users u
     WHERE u.id = p_user_id
       AND (u.role::text IN ('super_admin', 'admin', 'modeler')
            OR EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.org_id = p_org_id AND m.user_id = p_user_id
                          AND m.org_role IN ('owner', 'admin'))));
$$;
COMMENT ON FUNCTION public._api_key_manages_org(uuid, uuid) IS
  'D321 — the one rule for whether an account manages an organization''s API keys: a super '
  'admin, an admin/modeler account, or an owner/admin membership of that organization. Read by '
  '_api_key_management_org (for the active organization) and api_personal_key_grant (for the '
  'key''s organization).';
REVOKE EXECUTE ON FUNCTION public._api_key_manages_org(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── _api_key_management_org: verbatim but the last decision, which is now the rule above
CREATE OR REPLACE FUNCTION public._api_key_management_org(p_user_id uuid, p_org_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_user  public.approved_users%ROWTYPE;
  v_org   uuid;
BEGIN
  SELECT * INTO v_user FROM public.approved_users WHERE id = p_user_id;
  IF NOT FOUND OR COALESCE(v_user.is_active, true) = false THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_user.role::text = 'super_admin' THEN
    v_org := COALESCE(p_org_id, v_user.organization_id);
    IF v_org IS NULL THEN
      SELECT o.id INTO v_org FROM public.organizations o
      WHERE o.name = v_user.organization OR o.slug = v_user.organization
      LIMIT 1;
    END IF;
    IF v_org IS NULL THEN RAISE EXCEPTION 'no organization resolved for key'; END IF;
    RETURN v_org;
  END IF;

  v_org := v_user.organization_id;
  IF v_org IS NULL THEN
    SELECT o.id INTO v_org FROM public.organizations o
    WHERE o.name = v_user.organization OR o.slug = v_user.organization
    LIMIT 1;
  END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'user has no organization'; END IF;
  IF p_org_id IS NOT NULL AND p_org_id <> v_org THEN RAISE EXCEPTION 'forbidden'; END IF;

  IF NOT public._api_key_manages_org(p_user_id, v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;  -- D321
  RETURN v_org;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._api_key_management_org(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── the key's owner: active, and a MEMBER of the key's organization ─────────
CREATE OR REPLACE FUNCTION public.api_personal_key_actor(p_key_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT u.id
    FROM public.api_keys k
    JOIN public.approved_users u ON u.id = k.created_by
   WHERE k.id = p_key_id
     AND k.principal = 'personal'
     AND COALESCE(u.is_active, false)
     AND EXISTS (SELECT 1 FROM public.organization_members m       -- D321: membership,
                  WHERE m.org_id = k.org_id AND m.user_id = u.id);  -- not the active org
$$;
COMMENT ON FUNCTION public.api_personal_key_actor(uuid) IS
  'WP 12.3, D321 — the person a personal key acts as: its creator, while active and a member '
  'of the key''s organization (organization_members — not the active organization, D210). '
  'NULL refuses the key (401 key_owner_inactive).';
REVOKE EXECUTE ON FUNCTION public.api_personal_key_actor(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_personal_key_actor(uuid) TO service_role;

-- ── the grant: scopes decided for the KEY's organization ────────────────────
CREATE OR REPLACE FUNCTION public.api_personal_key_grant(p_key_id uuid)
RETURNS TABLE (actor_user_id uuid, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_actor  uuid;
  v_org    uuid;
  v_scopes text[];
BEGIN
  v_actor := public.api_personal_key_actor(p_key_id);
  IF v_actor IS NULL THEN RETURN; END IF;           -- no row: the gateway refuses the key
  SELECT k.org_id, k.scopes INTO v_org, v_scopes FROM public.api_keys k WHERE k.id = p_key_id;
  IF NOT public._api_key_manages_org(v_actor, v_org) THEN   -- D321: the key's org, not the active one
    SELECT COALESCE(array_agg(s ORDER BY s), ARRAY[]::text[]) INTO v_scopes
      FROM unnest(v_scopes) s WHERE s = ANY (public.api_key_self_service_scopes());
  END IF;
  RETURN QUERY SELECT v_actor, v_scopes;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.api_personal_key_grant(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_personal_key_grant(uuid) TO service_role;
