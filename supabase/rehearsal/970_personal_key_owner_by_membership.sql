-- A PERSONAL KEY FOLLOWS MEMBERSHIP, NOT THE ACTIVE ORGANIZATION — `20261112000001`, §4 D321.
--
-- The reported shape: an account that belongs to two organizations mints a personal
-- key in organization A, switches to organization B, and the A key is refused
-- `401 key_owner_inactive` although its owner is active and still a member of A.
--
--   §1 A member of A and B mints a personal read key in A; it acts as them.
--   §2 THE REPORT: they switch to B; the A key still acts as them, with its scopes.
--   §3 A modeler's write-scoped A key keeps its write scope while they work in B
--      (the grant decides for the KEY's organization; before D321 it raised).
--   §4 An org-role manager: an owner of A who is a plain `user` account, working in B,
--      keeps the write scope; a plain member of A is cut to the read scopes.
--   §5 What still kills the key: the membership of A removed; the account deactivated.
--   §6 Management is unchanged for the active organization: the account working in B
--      cannot mint an A key, and an owner of A only (not B) is refused for B.
--   §7 GRANTS: the new rule is nobody's but the definer's.

DO $d970$
DECLARE
  v_a      uuid := gen_random_uuid();
  v_b      uuid := gen_random_uuid();
  v_u      uuid := gen_random_uuid();   -- plain user, member of A and B
  v_m      uuid := gen_random_uuid();   -- modeler account, member of A and B
  v_o      uuid := gen_random_uuid();   -- plain user, OWNER of A, member of B
  v_ukey   uuid;
  v_mkey   uuid;
  v_okey   uuid;
  v_actor  uuid;
  v_scopes text[];
  v_refused boolean;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_a, 'D970 A', 'd970-a-' || substr(v_a::text, 1, 8)),
    (v_b, 'D970 B', 'd970-b-' || substr(v_b::text, 1, 8));
  INSERT INTO public.approved_users (id, name, email, password_hash, role, organization, organization_id, is_active) VALUES
    (v_u, 'D970 user',    'd970u@example.invalid', 'x', 'user',    'D970 A', v_a, true),
    (v_m, 'D970 modeler', 'd970m@example.invalid', 'x', 'modeler', 'D970 A', v_a, true),
    (v_o, 'D970 owner',   'd970o@example.invalid', 'x', 'user',    'D970 A', v_a, true);
  INSERT INTO public.organization_members (org_id, user_id, org_role) VALUES
    (v_b, v_u, 'member'), (v_b, v_m, 'member'), (v_b, v_o, 'member');
  UPDATE public.organization_members SET org_role = 'owner' WHERE org_id = v_a AND user_id = v_o;
  PERFORM set_config('app.current_user_id', '', true);

  -- §1
  SET LOCAL ROLE anon;
  SELECT id INTO v_ukey FROM public.create_api_key(v_u, 'd970u@example.invalid', 'notebook',
    ARRAY['read:data','read:policies'], 'test', NULL, NULL, NULL, 'personal');
  SELECT id INTO v_mkey FROM public.create_api_key(v_m, 'd970m@example.invalid', 'ci',
    ARRAY['read:data','write:runs'], 'test', NULL, NULL, NULL, 'personal');
  SELECT id INTO v_okey FROM public.create_api_key(v_o, 'd970o@example.invalid', 'owner',
    ARRAY['read:data','write:runs'], 'test', NULL, NULL, NULL, 'personal');
  RESET ROLE;
  IF (SELECT org_id FROM public.api_keys WHERE id = v_ukey) IS DISTINCT FROM v_a THEN
    RAISE EXCEPTION 'D970 §1: the key was not minted for the active organization A';
  END IF;
  IF public.api_personal_key_actor(v_ukey) IS DISTINCT FROM v_u THEN
    RAISE EXCEPTION 'D970 §1: the key does not act as its owner while they work in A';
  END IF;

  -- §2 — the report
  -- Each request is its own transaction in production: the previous call's GUC is gone.
  PERFORM set_config('app.current_user_id', '', true);
  SET LOCAL ROLE anon;
  PERFORM public.switch_my_organization(v_b, v_u);
  RESET ROLE;
  PERFORM set_config('app.current_user_id', '', true);
  SET LOCAL ROLE anon;
  PERFORM public.switch_my_organization(v_b, v_m);
  RESET ROLE;
  PERFORM set_config('app.current_user_id', '', true);
  SET LOCAL ROLE anon;
  PERFORM public.switch_my_organization(v_b, v_o);
  RESET ROLE;
  IF (SELECT organization_id FROM public.approved_users WHERE id = v_u) IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION 'D970 §2: setup — the switch to B did not happen';
  END IF;
  SELECT g.actor_user_id, g.scopes INTO v_actor, v_scopes FROM public.api_personal_key_grant(v_ukey) g;
  IF v_actor IS DISTINCT FROM v_u THEN
    RAISE EXCEPTION 'D970 §2: the A key is refused (key_owner_inactive) after its owner switched to B';
  END IF;
  IF v_scopes IS DISTINCT FROM ARRAY['read:data','read:policies']::text[] THEN
    RAISE EXCEPTION 'D970 §2: the A key''s scopes changed after the switch: %', v_scopes;
  END IF;

  -- §3
  SELECT g.actor_user_id, g.scopes INTO v_actor, v_scopes FROM public.api_personal_key_grant(v_mkey) g;
  IF v_actor IS DISTINCT FROM v_m OR NOT ('write:runs' = ANY (v_scopes)) THEN
    RAISE EXCEPTION 'D970 §3: a modeler''s A key lost its write scope while they work in B (actor %, scopes %)', v_actor, v_scopes;
  END IF;

  -- §4
  SELECT g.scopes INTO v_scopes FROM public.api_personal_key_grant(v_okey) g;
  IF NOT ('write:runs' = ANY (v_scopes)) THEN
    RAISE EXCEPTION 'D970 §4: an owner of A lost the write scope on an A key while working in B: %', v_scopes;
  END IF;
  UPDATE public.organization_members SET org_role = 'member' WHERE org_id = v_a AND user_id = v_o;
  SELECT g.scopes INTO v_scopes FROM public.api_personal_key_grant(v_okey) g;
  IF v_scopes IS DISTINCT FROM ARRAY['read:data']::text[] THEN
    RAISE EXCEPTION 'D970 §4: a plain member of A kept % on an A key', v_scopes;
  END IF;

  -- §5
  DELETE FROM public.organization_members WHERE org_id = v_a AND user_id = v_u;
  IF public.api_personal_key_actor(v_ukey) IS NOT NULL THEN
    RAISE EXCEPTION 'D970 §5: the A key still acts after its owner left A';
  END IF;
  UPDATE public.approved_users SET is_active = false WHERE id = v_m;
  IF public.api_personal_key_actor(v_mkey) IS NOT NULL THEN
    RAISE EXCEPTION 'D970 §5: the key still acts after its owner was deactivated';
  END IF;

  -- §6 — v_o (plain user) works in B, where they are a plain member
  PERFORM set_config('app.current_user_id', '', true);
  v_refused := false;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.create_api_key(v_o, 'd970o@example.invalid', 'for A',
      ARRAY['read:data'], 'test', NULL, NULL, v_a, 'personal');
  EXCEPTION WHEN raise_exception THEN
    v_refused := true;
  END;
  RESET ROLE;
  IF NOT v_refused THEN RAISE EXCEPTION 'D970 §6: an account working in B minted a key for A'; END IF;
  v_refused := false;
  BEGIN
    PERFORM public._api_key_management_org(v_o, NULL);
  EXCEPTION WHEN raise_exception THEN
    v_refused := SQLERRM LIKE '%forbidden%';
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'D970 §6: a plain member manages B''s keys'; END IF;

  -- §7
  IF has_function_privilege('anon', 'public._api_key_manages_org(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._api_key_manages_org(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.api_personal_key_actor(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.api_personal_key_grant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D970 §7: a browser role may execute a key resolver';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.api_personal_key_grant(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D970 §7: the gateway (service_role) lost EXECUTE on api_personal_key_grant';
  END IF;

  RAISE NOTICE 'D970: a personal key follows membership of its organization, not the active organization';
END
$d970$;
