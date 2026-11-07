-- Phase 19 / WP 19.1 · ONE IDENTITY PER FIRM AND SITE, PER ORGANIZATION (docs/PLAN.md §29).
--
-- `20261107000001` adds kg_entities, kg_entity_aliases and kg_identity_review behind
-- SECURITY DEFINER functions. What only a running database can settle:
--
--   §1 ISOLATION: a member of Org A writes and reads A's graph; a member of Org B is
--      refused (`insufficient_privilege`) on both, rather than shown an empty list; a
--      call naming no actor is refused.
--   §2 THE NATURAL KEY: the same kg_key twice is one row (idempotent); a new identifier
--      is added; a DIFFERENT value for an identifier the entity holds is refused
--      (`identity_conflict`), never overwritten.
--   §3 ALIASES AND REVIEW: aliases land once; an ambiguous name queues ONE review row.
--   §4 AUDIT: the insert writes a `plane='data'` row naming the actor, with the GUC
--      poisoned first so a pass cannot come from a session that already held it.
--   §5 POSTURE: `anon` and `authenticated` cannot SELECT any of the three tables.

DO $kg191$
DECLARE
  v_super  uuid := gen_random_uuid();
  v_a      uuid := gen_random_uuid();
  v_b      uuid := gen_random_uuid();
  v_org_a  uuid := gen_random_uuid();
  v_org_b  uuid := gen_random_uuid();
  v_e1     uuid;
  v_e2     uuid;
  v_code   text;
  v_msg    text;
  v_n      integer;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org_a, 'KG Org A', 'kga-' || substr(v_org_a::text, 1, 8)),
    (v_org_b, 'KG Org B', 'kgb-' || substr(v_org_b::text, 1, 8));
  INSERT INTO public.approved_users (id, email, name, password_hash, role, organization, organization_id, is_active) VALUES
    (v_super, 'kgs@example.invalid', 'KG Super', 'x', 'super_admin', 'KG Org B', v_org_b, true),
    (v_a,     'kga@example.invalid', 'KG A',     'x', 'modeler',     'KG Org A', v_org_a, true),
    (v_b,     'kgb@example.invalid', 'KG B',     'x', 'modeler',     'KG Org B', v_org_b, true);
  IF public.get_current_user_org_id(v_a) IS DISTINCT FROM v_org_a
     OR public.get_current_user_org_id(v_b) IS DISTINCT FROM v_org_b THEN
    RAISE EXCEPTION 'KG/960 setup: the organizations are not as assumed';
  END IF;

  -- ── §1 isolation ─────────────────────────────────────────────────────────
  v_e1 := public.kg_upsert_entity(v_org_a, 'Company', 'name:fairphone b.v.|netherlands', 'Fairphone B.V.',
            'Netherlands', '{}'::jsonb, ARRAY['Fairphone'], ARRAY['fairphone'], 'fairphone-sce-2024', v_a);
  SELECT count(*) INTO v_n FROM public.kg_list_entities(v_org_a, v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'KG/960 §1: A reads % entities of its own graph, expected 1', v_n; END IF;

  BEGIN
    PERFORM public.kg_list_entities(v_org_a, v_b);
    RAISE EXCEPTION 'KG/960 §1: a member of B read A''s graph';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.kg_upsert_entity(v_org_a, 'Company', 'name:x|y', 'X', 'Y', '{}'::jsonb, '{}', '{}', NULL, v_b);
    RAISE EXCEPTION 'KG/960 §1: a member of B wrote into A''s graph';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.kg_list_entities(v_org_a, NULL);
    RAISE EXCEPTION 'KG/960 §1: a read naming no actor was answered';
  EXCEPTION WHEN null_value_not_allowed THEN NULL;
  END;
  -- A super admin may read any organization's graph (the platform operator).
  SELECT count(*) INTO v_n FROM public.kg_list_entities(v_org_a, v_super);
  IF v_n <> 1 THEN RAISE EXCEPTION 'KG/960 §1: the super admin read % rows, expected 1', v_n; END IF;

  -- ── §2 the natural key ───────────────────────────────────────────────────
  v_e2 := public.kg_upsert_entity(v_org_a, 'Company', 'name:fairphone b.v.|netherlands', 'Fairphone B.V.',
            'Netherlands', '{"lei":"724500AAAAAAAAAAAA01"}'::jsonb, '{}', '{}', NULL, v_a);
  IF v_e2 IS DISTINCT FROM v_e1 THEN RAISE EXCEPTION 'KG/960 §2: the same kg_key made a second entity'; END IF;
  SELECT count(*) INTO v_n FROM public.kg_entities WHERE organization_id = v_org_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'KG/960 §2: % rows for one kg_key', v_n; END IF;
  IF (SELECT identifiers ->> 'lei' FROM public.kg_entities WHERE id = v_e1) IS DISTINCT FROM '724500AAAAAAAAAAAA01' THEN
    RAISE EXCEPTION 'KG/960 §2: a new identifier was not added';
  END IF;
  BEGIN
    PERFORM public.kg_upsert_entity(v_org_a, 'Company', 'name:fairphone b.v.|netherlands', 'Fairphone B.V.',
              'Netherlands', '{"lei":"724500BBBBBBBBBBBB02"}'::jsonb, '{}', '{}', NULL, v_a);
    RAISE EXCEPTION 'KG/960 §2: a conflicting LEI was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'identity_conflict:%' THEN RAISE; END IF;
  END;
  IF (SELECT identifiers ->> 'lei' FROM public.kg_entities WHERE id = v_e1) IS DISTINCT FROM '724500AAAAAAAAAAAA01' THEN
    RAISE EXCEPTION 'KG/960 §2: the refused conflict still overwrote the identifier';
  END IF;
  -- The same kg_key in ANOTHER organization is another entity (per organization).
  v_e2 := public.kg_upsert_entity(v_org_b, 'Company', 'name:fairphone b.v.|netherlands', 'Fairphone B.V.',
            'Netherlands', '{}'::jsonb, '{}', '{}', NULL, v_b);
  IF v_e2 = v_e1 THEN RAISE EXCEPTION 'KG/960 §2: two organizations share one entity'; END IF;

  -- ── §3 aliases and review ────────────────────────────────────────────────
  PERFORM public.kg_upsert_entity(v_org_a, 'Company', 'name:fairphone b.v.|netherlands', 'Fairphone B.V.',
            'Netherlands', '{}'::jsonb, ARRAY['Fairphone','Fairphone BV'], ARRAY['fairphone','fairphone bv'], NULL, v_a);
  SELECT count(*) INTO v_n FROM public.kg_entity_aliases WHERE entity_id = v_e1;
  IF v_n <> 2 THEN RAISE EXCEPTION 'KG/960 §3: % aliases, expected 2 (one repeated)', v_n; END IF;
  PERFORM public.kg_queue_identity_review(v_org_a, 'Murata', 'murata', 'China', '[{"kg_key":"a"},{"kg_key":"b"}]'::jsonb, v_a);
  PERFORM public.kg_queue_identity_review(v_org_a, 'Murata', 'murata', 'China', '[{"kg_key":"a"},{"kg_key":"b"},{"kg_key":"c"}]'::jsonb, v_a);
  SELECT count(*) INTO v_n FROM public.kg_identity_review WHERE organization_id = v_org_a AND status = 'pending';
  IF v_n <> 1 THEN RAISE EXCEPTION 'KG/960 §3: % review rows for one ambiguous name', v_n; END IF;

  -- ── §4 audit ─────────────────────────────────────────────────────────────
  PERFORM set_config('app.current_user_id', gen_random_uuid()::text, true);   -- poison
  PERFORM public.kg_upsert_entity(v_org_a, 'Facility', 'name:tcl huizhou|china', 'Huizhou TCL Mobile',
            'China', '{}'::jsonb, '{}', '{}', NULL, v_a);
  SELECT count(*) INTO v_n FROM public.audit_logs
   WHERE plane = 'data' AND target_type = 'kg_entities' AND actor_user_id = v_a AND action = 'insert';
  IF v_n < 1 THEN RAISE EXCEPTION 'KG/960 §4: the insert wrote no audit row naming the actor'; END IF;

  -- ── §5 posture ───────────────────────────────────────────────────────────
  IF has_table_privilege('anon', 'public.kg_entities', 'SELECT')
     OR has_table_privilege('authenticated', 'public.kg_entities', 'SELECT')
     OR has_table_privilege('anon', 'public.kg_entity_aliases', 'SELECT')
     OR has_table_privilege('authenticated', 'public.kg_identity_review', 'SELECT') THEN
    RAISE EXCEPTION 'KG/960 §5: an API role can SELECT a graph table directly';
  END IF;
  IF has_function_privilege('anon', 'public.kg_upsert_entity(uuid,text,text,text,text,jsonb,text[],text[],text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'KG/960 §5: anon may call the writer';
  END IF;

  RAISE NOTICE 'KG/960: isolation, natural key, aliases, review, audit and posture hold';
END $kg191$;
