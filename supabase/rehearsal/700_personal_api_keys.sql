-- PERSONAL API KEYS — `20261002000001`, Phase 12 / WP 12.3.
--
-- A personal key acts as the user who created it. Each section calls the key RPCs as
-- the /developer page does (`anon`, the user as a parameter) and reads the gateway's
-- own resolver (`api_personal_key_actor`) as the service role.
--
--   §1 A PERSONAL key resolves to its owner; an ORG key resolves to nobody.
--   §2 The owner DEACTIVATED → the key resolves to nobody (the gateway refuses it);
--      reactivated → it works again.
--   §3 The owner SWITCHED to another organization → still them (D321); LEFT the key's
--      organization (membership removed) → nobody.
--   §4 A super admin cannot mint a personal key for an organization they are not in.
--   §5 ROTATION keeps the kind; an administrator may not rotate someone else's
--      personal key (it would hand them a secret that acts as that person); the
--      owner may, and the new key is still theirs.
--   §6 list_api_keys reports the kind.
--   §7 GRANTS: the resolver is the service role's alone; the two re-created RPCs keep
--      `anon` and `authenticated` as EXPLICIT grantees (a DROP took them).

DO $d700$
DECLARE
  v_org_a   uuid := gen_random_uuid();
  v_org_b   uuid := gen_random_uuid();
  v_owner   uuid := gen_random_uuid();
  v_admin   uuid := gen_random_uuid();
  v_super_b uuid := gen_random_uuid();
  v_pkey    uuid;
  v_okey    uuid;
  v_rot     uuid;
  v_actor   uuid;
  v_kind    text;
  v_by      uuid;
  v_n       integer;
  v_refused boolean;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org_a, 'D700 A', 'd700a-' || substr(v_org_a::text, 1, 8)),
    (v_org_b, 'D700 B', 'd700b-' || substr(v_org_b::text, 1, 8));
  INSERT INTO public.approved_users (id, name, email, password_hash, role, organization, organization_id, is_active) VALUES
    (v_owner,   'D700 owner',   'd700o@example.invalid',  'x', 'modeler',     'D700 A', v_org_a, true),
    (v_admin,   'D700 admin',   'd700a@example.invalid',  'x', 'admin',       'D700 A', v_org_a, true),
    (v_super_b, 'D700 super B', 'd700sb@example.invalid', 'x', 'super_admin', 'D700 B', v_org_b, true);

  SET LOCAL ROLE anon;
  SELECT id INTO v_pkey FROM public.create_api_key(v_owner, 'd700o@example.invalid', 'mine',
    ARRAY['read:data'], 'test', NULL, NULL, NULL, 'personal');
  SELECT id INTO v_okey FROM public.create_api_key(v_admin, 'd700a@example.invalid', 'org',
    ARRAY['read:data'], 'test');
  RESET ROLE;

  -- §1
  SELECT principal INTO v_kind FROM public.api_keys WHERE id = v_pkey;
  IF v_kind <> 'personal' THEN RAISE EXCEPTION '§1: the personal key is stored as %', v_kind; END IF;
  SELECT principal INTO v_kind FROM public.api_keys WHERE id = v_okey;
  IF v_kind <> 'org' THEN RAISE EXCEPTION '§1: a key created without a kind is %, not org', v_kind; END IF;
  IF public.api_personal_key_actor(v_pkey) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '§1: the personal key does not resolve to its owner';
  END IF;
  IF public.api_personal_key_actor(v_okey) IS NOT NULL THEN
    RAISE EXCEPTION '§1: an organization key resolved to a person';
  END IF;

  -- §2
  UPDATE public.approved_users SET is_active = false WHERE id = v_owner;
  IF public.api_personal_key_actor(v_pkey) IS NOT NULL THEN
    RAISE EXCEPTION '§2: a deactivated owner''s key still resolves';
  END IF;
  UPDATE public.approved_users SET is_active = true WHERE id = v_owner;
  IF public.api_personal_key_actor(v_pkey) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '§2: the reactivated owner''s key does not resolve';
  END IF;

  -- §3 — since D210 setting `organization_id` SWITCHES the account (it adds a membership of
  -- B and keeps A's), so the key must survive it (D321); LEAVING A is removing that membership.
  UPDATE public.approved_users SET organization_id = v_org_b, organization = 'D700 B' WHERE id = v_owner;
  IF public.api_personal_key_actor(v_pkey) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '§3: the key stopped acting when its owner only switched organization (D321)';
  END IF;
  SELECT org_role INTO v_kind FROM public.organization_members WHERE org_id = v_org_a AND user_id = v_owner;
  DELETE FROM public.organization_members WHERE org_id = v_org_a AND user_id = v_owner;
  IF public.api_personal_key_actor(v_pkey) IS NOT NULL THEN
    RAISE EXCEPTION '§3: the key still acts for an owner who left its organization';
  END IF;
  INSERT INTO public.organization_members (org_id, user_id, org_role) VALUES (v_org_a, v_owner, v_kind);
  UPDATE public.approved_users SET organization_id = v_org_a, organization = 'D700 A' WHERE id = v_owner;
  v_kind := NULL;

  -- §4
  v_refused := false;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.create_api_key(v_super_b, 'd700sb@example.invalid', 'impersonal',
      ARRAY['read:data'], 'test', NULL, NULL, v_org_a, 'personal');
  EXCEPTION WHEN raise_exception THEN
    v_refused := SQLERRM LIKE '%personal key can only be created for your own organization%';
  END;
  RESET ROLE;
  IF NOT v_refused THEN RAISE EXCEPTION '§4: a super admin minted a personal key for another organization'; END IF;

  -- §5
  v_refused := false;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.rotate_api_key(v_admin, 'd700a@example.invalid', v_pkey, 0);
  EXCEPTION WHEN raise_exception THEN
    v_refused := SQLERRM LIKE '%only its owner can rotate a personal key%';
  END;
  RESET ROLE;
  IF NOT v_refused THEN RAISE EXCEPTION '§5: an administrator rotated someone else''s personal key'; END IF;
  SET LOCAL ROLE anon;
  SELECT id INTO v_rot FROM public.rotate_api_key(v_owner, 'd700o@example.invalid', v_pkey, 0);
  RESET ROLE;
  SELECT principal, created_by INTO v_kind, v_by FROM public.api_keys WHERE id = v_rot;
  IF v_kind <> 'personal' OR v_by IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '§5: the rotated key is % owned by % (want personal, the owner)', v_kind, v_by;
  END IF;
  IF public.api_personal_key_actor(v_rot) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION '§5: the rotated key does not act as its owner';
  END IF;

  -- §6
  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_n FROM public.list_api_keys(v_admin, 'd700a@example.invalid') l
   WHERE (l.id = v_pkey AND l.principal = 'personal') OR (l.id = v_okey AND l.principal = 'org');
  RESET ROLE;
  IF v_n <> 2 THEN RAISE EXCEPTION '§6: list_api_keys reports the kind of % of 2 keys', v_n; END IF;

  -- §7
  IF has_function_privilege('anon', 'public.api_personal_key_actor(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.api_personal_key_actor(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '§7: the key resolver is callable by the browser roles';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.proname IN ('create_api_key', 'list_api_keys') AND p.pronamespace = 'public'::regnamespace
     AND a.privilege_type = 'EXECUTE'
     AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole);
  IF v_n <> 4 THEN
    RAISE EXCEPTION '§7: create_api_key/list_api_keys carry % of 4 explicit browser-role grants', v_n;
  END IF;

  RAISE NOTICE 'rehearsal 700: personal API keys — 7 sections hold';
END
$d700$;
