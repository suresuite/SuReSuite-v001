-- =====================================================================
-- Phase 19 / WP 19.2 — evidence that remembers (docs/PLAN.md §29).
--
--   kg_assertions          one fact about two entities of an organization's
--                          graph: subject → relation → object, with a
--                          qualifier (tier, role, product, metal …), the dates
--                          it holds and when it was first and last seen
--   kg_assertion_evidence  which external_evidence rows support or contradict
--                          it. external_evidence stays THE evidence store; the
--                          graph links to it and never copies it
--                          (gate `single-source`)
--
-- STATUS IS COMPUTED, never stored by hand (kg_assertion_status):
--   verified      ≥ kg_verify_min_sources() INDEPENDENT fresh supporting sources
--   corroborated  2 independent fresh sources
--   provisional   1
--   stale         supporting evidence exists, all of it older than the
--                 declared age (kg_evidence_max_age_days)
--   contradicted  the newest contradicting evidence is newer than the newest
--                 supporting evidence
-- "Independent" counts distinct publisher groups: two documents from one
-- publisher, or from a parent and its subsidiary, count once. A company's own
-- supplier list is ONE source however many pages it has — so every fact in a
-- reference dataset starts provisional, and that is the honest reading.
--
-- Same posture as WP 19.1: RLS on, no policy, no grant; RPCs only, each
-- refusing an actor outside the organization. Outside the simulation.
-- =====================================================================

-- The one threshold. SQL cannot import networkEvidence.ts's
-- VERIFY_MIN_SOURCES, so this restates it and kgParity_test.ts holds the two
-- equal (the ingestSpecParity pattern).
CREATE OR REPLACE FUNCTION public.kg_verify_min_sources() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
-- The declared age after which evidence stops counting (three years).
CREATE OR REPLACE FUNCTION public.kg_evidence_max_age_days() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 1095 $$;

-- ── 1 · kg_assertions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kg_assertions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subject_id      uuid NOT NULL REFERENCES public.kg_entities(id) ON DELETE CASCADE,
  relation        text NOT NULL CHECK (relation IN
                    ('SuppliesTo','Produces','LocatedIn','OwnedBy','Ships','Operates','CustomerOf')),
  object_id       uuid NOT NULL REFERENCES public.kg_entities(id) ON DELETE CASCADE,
  -- What distinguishes two facts between the same pair (a tier, a role, a
  -- product strength). '' when nothing does. Part of the natural key.
  qualifier_key   text NOT NULL DEFAULT '',
  qualifier       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qualifier) = 'object'),
  valid_from      date,
  valid_to        date CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  CHECK (subject_id <> object_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS kg_assertions_natural_key
  ON public.kg_assertions (organization_id, subject_id, relation, object_id, qualifier_key);
CREATE INDEX IF NOT EXISTS kg_assertions_object_idx ON public.kg_assertions (organization_id, object_id);

-- ── 2 · kg_assertion_evidence ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kg_assertion_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  assertion_id    uuid NOT NULL REFERENCES public.kg_assertions(id) ON DELETE CASCADE,
  evidence_id     uuid NOT NULL REFERENCES public.external_evidence(id) ON DELETE CASCADE,
  stance          text NOT NULL DEFAULT 'supports' CHECK (stance IN ('supports','contradicts')),
  -- The independence unit: a publisher, or a publisher's parent group.
  publisher_group text NOT NULL CHECK (char_length(publisher_group) BETWEEN 1 AND 200),
  -- When the source says the fact held (a report's publication date); the
  -- staleness clock runs from here, not from when we fetched it.
  observed_on     date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kg_assertion_evidence_natural_key
  ON public.kg_assertion_evidence (assertion_id, evidence_id);

-- ── 3 · posture ────────────────────────────────────────────────────────────
ALTER TABLE public.kg_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kg_assertion_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kg_assertions, public.kg_assertion_evidence FROM anon, authenticated;
GRANT ALL ON public.kg_assertions, public.kg_assertion_evidence TO service_role;

-- ── 4 · audit, tier 3 ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_kg_assertions_insert ON public.kg_assertions;
CREATE TRIGGER audit_kg_assertions_insert AFTER INSERT ON public.kg_assertions
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_assertions_update ON public.kg_assertions;
CREATE TRIGGER audit_kg_assertions_update AFTER UPDATE ON public.kg_assertions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_assertions_delete ON public.kg_assertions;
CREATE TRIGGER audit_kg_assertions_delete AFTER DELETE ON public.kg_assertions
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_assertion_evidence_insert ON public.kg_assertion_evidence;
CREATE TRIGGER audit_kg_assertion_evidence_insert AFTER INSERT ON public.kg_assertion_evidence
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_assertion_evidence_update ON public.kg_assertion_evidence;
CREATE TRIGGER audit_kg_assertion_evidence_update AFTER UPDATE ON public.kg_assertion_evidence
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_assertion_evidence_delete ON public.kg_assertion_evidence;
CREATE TRIGGER audit_kg_assertion_evidence_delete AFTER DELETE ON public.kg_assertion_evidence
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');

-- ── 5 · the status rule — ONE function ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kg_assertion_status(_assertion_id uuid, _as_of date DEFAULT current_date)
RETURNS TABLE (status text, independent_sources integer, supporting integer, contradicting integer,
               newest_support date, newest_contradiction date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ev AS (
    SELECT stance, publisher_group, observed_on,
           observed_on >= _as_of - public.kg_evidence_max_age_days() AS fresh
      FROM public.kg_assertion_evidence WHERE assertion_id = _assertion_id
  ), agg AS (
    SELECT count(DISTINCT publisher_group) FILTER (WHERE stance = 'supports' AND fresh)::int AS ind,
           count(*) FILTER (WHERE stance = 'supports')::int AS sup,
           count(*) FILTER (WHERE stance = 'contradicts')::int AS con,
           max(observed_on) FILTER (WHERE stance = 'supports') AS ns,
           max(observed_on) FILTER (WHERE stance = 'contradicts') AS nc
      FROM ev
  )
  SELECT CASE
           WHEN nc IS NOT NULL AND (ns IS NULL OR nc > ns) THEN 'contradicted'
           WHEN ind >= public.kg_verify_min_sources() THEN 'verified'
           WHEN ind = 2 THEN 'corroborated'
           WHEN ind = 1 THEN 'provisional'
           WHEN sup > 0 THEN 'stale'
           ELSE 'unsupported'
         END, ind, sup, con, ns, nc
    FROM agg;
$$;
REVOKE ALL ON FUNCTION public.kg_assertion_status(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kg_assertion_status(uuid, date) TO service_role;

-- ── 6 · writer ─────────────────────────────────────────────────────────────
-- Record one fact with one piece of evidence. The fact is upserted on its
-- natural key (last_seen moves); the evidence link is idempotent. Both
-- entities and the evidence row must belong to the caller's organization —
-- evidence through its project — or the call is refused.
CREATE OR REPLACE FUNCTION public.kg_record_assertion(
  _org_id uuid, _subject_id uuid, _relation text, _object_id uuid, _qualifier_key text,
  _qualifier jsonb, _evidence_id uuid, _stance text, _publisher_group text, _observed_on date,
  _actor_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid;
BEGIN
  PERFORM public.kg_assert_org_member('kg_record_assertion', _org_id, _actor_user_id);
  PERFORM set_config('app.current_user_id', _actor_user_id::text, true);
  IF (SELECT count(*) FROM public.kg_entities WHERE id IN (_subject_id, _object_id) AND organization_id = _org_id)
     <> (CASE WHEN _subject_id = _object_id THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'kg_record_assertion: an entity is not in organization %', _org_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_evidence ee JOIN public.projects p ON p.id = ee.project_id
                  WHERE ee.id = _evidence_id AND p.organization_id = _org_id) THEN
    RAISE EXCEPTION 'kg_record_assertion: evidence % is not in organization %', _evidence_id, _org_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.kg_assertions (organization_id, subject_id, relation, object_id, qualifier_key, qualifier, created_by)
  VALUES (_org_id, _subject_id, _relation, _object_id, COALESCE(_qualifier_key, ''), COALESCE(_qualifier, '{}'::jsonb),
          _actor_user_id)
  ON CONFLICT (organization_id, subject_id, relation, object_id, qualifier_key)
  DO UPDATE SET last_seen = now()
  RETURNING id INTO v_id;
  INSERT INTO public.kg_assertion_evidence (organization_id, assertion_id, evidence_id, stance, publisher_group, observed_on)
  VALUES (_org_id, v_id, _evidence_id, COALESCE(_stance, 'supports'), _publisher_group, _observed_on)
  ON CONFLICT (assertion_id, evidence_id) DO NOTHING;
  RETURN v_id;
END; $fn$;
REVOKE ALL ON FUNCTION public.kg_record_assertion(uuid,uuid,text,uuid,text,jsonb,uuid,text,text,date,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kg_record_assertion(uuid,uuid,text,uuid,text,jsonb,uuid,text,text,date,uuid) TO service_role;

-- ── 7 · reader ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kg_list_assertions(_org_id uuid, _actor_user_id uuid)
RETURNS TABLE (id uuid, subject_key text, relation text, object_key text, qualifier jsonb,
               status text, independent_sources integer, supporting integer, contradicting integer,
               first_seen timestamptz, last_seen timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  PERFORM public.kg_assert_org_member('kg_list_assertions', _org_id, _actor_user_id);
  RETURN QUERY
    SELECT a.id, s.kg_key, a.relation, o.kg_key, a.qualifier,
           st.status, st.independent_sources, st.supporting, st.contradicting, a.first_seen, a.last_seen
      FROM public.kg_assertions a
      JOIN public.kg_entities s ON s.id = a.subject_id
      JOIN public.kg_entities o ON o.id = a.object_id
      CROSS JOIN LATERAL public.kg_assertion_status(a.id) st
     WHERE a.organization_id = _org_id
     ORDER BY s.kg_key, a.relation, o.kg_key, a.qualifier_key;
END; $fn$;
REVOKE ALL ON FUNCTION public.kg_list_assertions(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kg_list_assertions(uuid, uuid) TO anon, authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
