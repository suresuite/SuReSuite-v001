-- Phase 19 / WP 19.2 · EVIDENCE THAT REMEMBERS (docs/PLAN.md §29).
--
-- `20261107000002` adds kg_assertions and kg_assertion_evidence. What only a running database
-- can settle:
--
--   §1 STATUS IS INDEPENDENCE: three documents from ONE publisher are one source (provisional);
--      a second publisher group makes it corroborated; a third, verified — and the threshold is
--      kg_verify_min_sources(), not a literal here.
--   §2 TIME: evidence older than kg_evidence_max_age_days() stops counting (stale); a newer
--      contradiction wins over older support (contradicted), and newer support wins back.
--   §3 THE NATURAL KEY: the same fact twice is one row whose last_seen moves; the same evidence
--      linked twice is one link; a different qualifier_key is a different fact.
--   §4 ISOLATION: Org B cannot record a fact about A's entities, nor link evidence from A's
--      project into its own graph, nor read A's facts.

DO $kg192$
DECLARE
  v_a     uuid := gen_random_uuid();
  v_b     uuid := gen_random_uuid();
  v_org_a uuid := gen_random_uuid();
  v_org_b uuid := gen_random_uuid();
  v_pa    uuid := gen_random_uuid();
  v_pb    uuid := gen_random_uuid();
  v_sup   uuid; v_prod uuid; v_b_ent uuid;
  v_f     uuid; v_f2 uuid; v_g uuid;
  e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; e6 uuid; e7 uuid; eb uuid;
  v_st    text;
  v_n     integer;
  v_seen  timestamptz;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org_a, 'KG2 Org A', 'kg2a-' || substr(v_org_a::text, 1, 8)),
    (v_org_b, 'KG2 Org B', 'kg2b-' || substr(v_org_b::text, 1, 8));
  INSERT INTO public.approved_users (id, email, name, password_hash, role, organization, organization_id, is_active) VALUES
    (v_a, 'kg2a@example.invalid', 'KG2 A', 'x', 'modeler', 'KG2 Org A', v_org_a, true),
    (v_b, 'kg2b@example.invalid', 'KG2 B', 'x', 'modeler', 'KG2 Org B', v_org_b, true);
  INSERT INTO public.projects (id, name, modeler_id, plant_name, organization, organization_id, bom_level) VALUES
    (v_pa, 'KG2 ref A', v_a, 'P', 'KG2 Org A', v_org_a, 'single'),
    (v_pb, 'KG2 ref B', v_b, 'P', 'KG2 Org B', v_org_b, 'single');

  v_sup  := public.kg_upsert_entity(v_org_a, 'Company', 'name:ams|thailand', 'Ams', 'Thailand', '{}'::jsonb, '{}', '{}', NULL, v_a);
  v_prod := public.kg_upsert_entity(v_org_a, 'Product', 'product:fairphone 5', 'Fairphone 5', NULL, '{}'::jsonb, '{}', '{}', NULL, v_a);
  v_b_ent := public.kg_upsert_entity(v_org_b, 'Company', 'name:x|y', 'X', 'Y', '{}'::jsonb, '{}', '{}', NULL, v_b);

  -- Seven evidence rows in A's project; one in B's.
  SELECT public.record_external_evidence(v_pa, 'fairphone-sce-2024', 'u', 'hash0001', 0.8, '{"n":1}'::jsonb) INTO e1;
  SELECT public.record_external_evidence(v_pa, 'fairphone-sce-2023', 'u', 'hash0002', 0.8, '{"n":2}'::jsonb) INTO e2;
  SELECT public.record_external_evidence(v_pa, 'fairphone-map', 'u', 'hash0003', 0.8, '{"n":3}'::jsonb) INTO e3;
  SELECT public.record_external_evidence(v_pa, 'opensupplyhub', 'u', 'hash0004', 0.8, '{"n":4}'::jsonb) INTO e4;
  SELECT public.record_external_evidence(v_pa, 'gleif', 'u', 'hash0005', 0.8, '{"n":5}'::jsonb) INTO e5;
  SELECT public.record_external_evidence(v_pa, 'news', 'u', 'hash0006', 0.8, '{"n":6}'::jsonb) INTO e6;
  SELECT public.record_external_evidence(v_pa, 'fairphone-sce-2026', 'u', 'hash0007', 0.8, '{"n":7}'::jsonb) INTO e7;
  SELECT public.record_external_evidence(v_pb, 'b-src', 'u', 'hash0008', 0.8, '{"n":8}'::jsonb) INTO eb;

  -- ── §1 independence ─────────────────────────────────────────────────────
  v_f := public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e1, 'supports', 'Fairphone', current_date - 30, v_a);
  PERFORM public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e2, 'supports', 'Fairphone', current_date - 400, v_a);
  PERFORM public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e3, 'supports', 'Fairphone', current_date - 10, v_a);
  SELECT status INTO v_st FROM public.kg_assertion_status(v_f);
  IF v_st <> 'provisional' THEN RAISE EXCEPTION 'KG/970 §1: three documents of one publisher read %, expected provisional', v_st; END IF;
  PERFORM public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e4, 'supports', 'Open Supply Hub', current_date - 5, v_a);
  SELECT status INTO v_st FROM public.kg_assertion_status(v_f);
  IF v_st <> 'corroborated' THEN RAISE EXCEPTION 'KG/970 §1: two publisher groups read %, expected corroborated', v_st; END IF;
  PERFORM public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e5, 'supports', 'GLEIF', current_date - 5, v_a);
  SELECT status INTO v_st FROM public.kg_assertion_status(v_f);
  IF v_st <> 'verified' OR public.kg_verify_min_sources() <> 3 THEN
    RAISE EXCEPTION 'KG/970 §1: three publisher groups read % (threshold %)', v_st, public.kg_verify_min_sources();
  END IF;

  -- ── §2 time ─────────────────────────────────────────────────────────────
  SELECT status INTO v_st FROM public.kg_assertion_status(v_f, current_date + public.kg_evidence_max_age_days() + 31);
  IF v_st <> 'stale' THEN RAISE EXCEPTION 'KG/970 §2: evidence past the declared age read %, expected stale', v_st; END IF;
  PERFORM public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e6, 'contradicts', 'News', current_date - 1, v_a);
  SELECT status INTO v_st FROM public.kg_assertion_status(v_f);
  IF v_st <> 'contradicted' THEN RAISE EXCEPTION 'KG/970 §2: a newer contradiction read %, expected contradicted', v_st; END IF;
  PERFORM public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e7, 'supports', 'Fairphone', current_date, v_a);
  SELECT status INTO v_st FROM public.kg_assertion_status(v_f);
  IF v_st <> 'verified' THEN RAISE EXCEPTION 'KG/970 §2: newer support after a contradiction read %, expected verified', v_st; END IF;

  -- ── §3 the natural key ──────────────────────────────────────────────────
  SELECT count(*) INTO v_n FROM public.kg_assertions WHERE organization_id = v_org_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'KG/970 §3: % fact rows for one fact', v_n; END IF;
  SELECT last_seen INTO v_seen FROM public.kg_assertions WHERE id = v_f;
  v_f2 := public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:2', '{"tier":2}'::jsonb,
           e1, 'supports', 'Fairphone', current_date - 30, v_a);
  IF v_f2 <> v_f THEN RAISE EXCEPTION 'KG/970 §3: the same fact made a second row'; END IF;
  SELECT count(*) INTO v_n FROM public.kg_assertion_evidence WHERE assertion_id = v_f;
  IF v_n <> 7 THEN RAISE EXCEPTION 'KG/970 §3: % evidence links, expected 7 (one repeated)', v_n; END IF;
  v_g := public.kg_record_assertion(v_org_a, v_sup, 'SuppliesTo', v_prod, 'tier:3', '{"tier":3}'::jsonb,
           e1, 'supports', 'Fairphone', current_date - 30, v_a);
  IF v_g = v_f THEN RAISE EXCEPTION 'KG/970 §3: a different qualifier was folded into one fact'; END IF;

  -- ── §4 isolation ────────────────────────────────────────────────────────
  BEGIN
    PERFORM public.kg_record_assertion(v_org_b, v_sup, 'SuppliesTo', v_prod, '', '{}'::jsonb,
              eb, 'supports', 'B', current_date, v_b);
    RAISE EXCEPTION 'KG/970 §4: B recorded a fact about A''s entities';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.kg_record_assertion(v_org_b, v_b_ent, 'LocatedIn',
              public.kg_upsert_entity(v_org_b, 'Location', 'country:Y', 'Y', 'Y', '{}'::jsonb, '{}', '{}', NULL, v_b),
              '', '{}'::jsonb, e1, 'supports', 'B', current_date, v_b);
    RAISE EXCEPTION 'KG/970 §4: B linked evidence from A''s project';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.kg_list_assertions(v_org_a, v_b);
    RAISE EXCEPTION 'KG/970 §4: B read A''s facts';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT count(*) INTO v_n FROM public.kg_list_assertions(v_org_a, v_a);
  IF v_n <> 2 THEN RAISE EXCEPTION 'KG/970 §4: A reads % of its own facts, expected 2', v_n; END IF;

  RAISE NOTICE 'KG/970: independence, time, contradiction, natural key and isolation hold';
END $kg192$;
