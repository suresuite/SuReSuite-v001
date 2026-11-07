-- =====================================================================
-- Phase 19 / WP 19.1 — one identity per firm and site, per organization
-- (docs/PLAN.md §29; ai-agents.md §18.2 v3).
--
-- Three tables, all keyed by organization_id (gate `uuid-identity`) and
-- readable ONLY through RPCs that check the caller belongs to that
-- organization (owner decision 2026-11-07: the graph is per organization).
-- Unlike external_evidence (`USING (true)`), no API role may SELECT them
-- directly: RLS is on with no policy and no grant, so one organization's
-- supplier knowledge cannot be read by another.
--
--   kg_entities          one row per real firm, facility, product, material
--                        or location the organization has evidence about
--   kg_entity_aliases    every other name an entity goes by
--   kg_identity_review   names that matched more than one entity — the
--                        resolver never picks; a person decides (rule 3)
--
-- Identity is decided by ONE resolver (supabase/functions/_shared/
-- kgResolver.ts), which computes `kg_key` from the strongest identifier.
-- These functions store what it decided; they do not re-derive it.
--
-- Outside the simulation: no engine input and no graph-hash scope reads
-- these tables (PLAN.md §29 rule 4).
-- =====================================================================

-- ── 0 · the authorization every kg_* function runs ─────────────────────────
-- Actor named, GUC set LOCAL (so the audit trigger names them), and the
-- actor must belong to the organization — or be a super admin.
CREATE OR REPLACE FUNCTION public.kg_assert_org_member(_fn text, _org_id uuid, _actor_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF _actor_user_id IS NULL THEN
    RAISE EXCEPTION '%: this call must name its actor (invariant audit-actor)', _fn
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION '%: this call must name its organization', _fn
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  PERFORM set_config('app.current_user_id', _actor_user_id::text, true);
  IF NOT (COALESCE(public.get_current_user_org_id(_actor_user_id) = _org_id, false)
          OR COALESCE(public.is_super_admin(_actor_user_id), false)) THEN
    RAISE EXCEPTION '%: % is not a member of organization %', _fn, _actor_user_id, _org_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END; $fn$;
REVOKE ALL ON FUNCTION public.kg_assert_org_member(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kg_assert_org_member(text, uuid, uuid) TO service_role;

-- ── 1 · kg_entities ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kg_entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('Company','Facility','Product','Material','Location')),
  -- The strongest identifier as one string: lei:… · rmi:… · wd:… · osh:… ·
  -- ema:… · name:<normalized>|<country>. Written by the resolver only.
  kg_key          text NOT NULL CHECK (kg_key ~ '^(lei|rmi|wd|osh|ema|name|product|material|country):.+'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  country         text,
  identifiers     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(identifiers) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS kg_entities_natural_key
  ON public.kg_entities (organization_id, kg_key);
CREATE INDEX IF NOT EXISTS kg_entities_type_idx ON public.kg_entities (organization_id, entity_type);

-- ── 2 · kg_entity_aliases ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kg_entity_aliases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_id       uuid NOT NULL REFERENCES public.kg_entities(id) ON DELETE CASCADE,
  alias           text NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 300),
  normalized      text NOT NULL CHECK (char_length(normalized) BETWEEN 1 AND 300),
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kg_entity_aliases_natural_key
  ON public.kg_entity_aliases (organization_id, entity_id, normalized);
CREATE INDEX IF NOT EXISTS kg_entity_aliases_lookup ON public.kg_entity_aliases (organization_id, normalized);

-- ── 3 · kg_identity_review ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kg_identity_review (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  mention            text NOT NULL CHECK (char_length(mention) BETWEEN 1 AND 300),
  normalized         text NOT NULL,
  country            text,
  candidates         jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
  resolved_entity_id uuid REFERENCES public.kg_entities(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS kg_identity_review_natural_key
  ON public.kg_identity_review (organization_id, normalized, country) NULLS NOT DISTINCT;

-- ── 4 · posture: RLS on, no policy, no grant to API roles ──────────────────
ALTER TABLE public.kg_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kg_entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kg_identity_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kg_entities, public.kg_entity_aliases, public.kg_identity_review FROM anon, authenticated;
GRANT ALL ON public.kg_entities, public.kg_entity_aliases, public.kg_identity_review TO service_role;

-- ── 5 · audit (gate `audit-actor`): statement-level, tier 3 ────────────────
DROP TRIGGER IF EXISTS audit_kg_entities_insert ON public.kg_entities;
CREATE TRIGGER audit_kg_entities_insert AFTER INSERT ON public.kg_entities
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_entities_update ON public.kg_entities;
CREATE TRIGGER audit_kg_entities_update AFTER UPDATE ON public.kg_entities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_entities_delete ON public.kg_entities;
CREATE TRIGGER audit_kg_entities_delete AFTER DELETE ON public.kg_entities
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_entity_aliases_insert ON public.kg_entity_aliases;
CREATE TRIGGER audit_kg_entity_aliases_insert AFTER INSERT ON public.kg_entity_aliases
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_entity_aliases_update ON public.kg_entity_aliases;
CREATE TRIGGER audit_kg_entity_aliases_update AFTER UPDATE ON public.kg_entity_aliases
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_entity_aliases_delete ON public.kg_entity_aliases;
CREATE TRIGGER audit_kg_entity_aliases_delete AFTER DELETE ON public.kg_entity_aliases
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_identity_review_insert ON public.kg_identity_review;
CREATE TRIGGER audit_kg_identity_review_insert AFTER INSERT ON public.kg_identity_review
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_identity_review_update ON public.kg_identity_review;
CREATE TRIGGER audit_kg_identity_review_update AFTER UPDATE ON public.kg_identity_review
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');
DROP TRIGGER IF EXISTS audit_kg_identity_review_delete ON public.kg_identity_review;
CREATE TRIGGER audit_kg_identity_review_delete AFTER DELETE ON public.kg_identity_review
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.audit_tier_write('3');

-- ── 6 · writers ────────────────────────────────────────────────────────────
-- kg_upsert_entity: store the resolver's decision. An existing entity keeps
-- every identifier it has; a NEW identifier is added; a DIFFERENT value for an
-- identifier it already holds is an identity conflict and is refused — two
-- registries disagreeing about one firm is a person's call (rule 3).
CREATE OR REPLACE FUNCTION public.kg_upsert_entity(
  _org_id uuid, _entity_type text, _kg_key text, _name text, _country text,
  _identifiers jsonb, _aliases text[], _alias_normalized text[], _source text,
  _actor_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid; v_ids jsonb; k text;
BEGIN
  PERFORM public.kg_assert_org_member('kg_upsert_entity', _org_id, _actor_user_id);
  PERFORM set_config('app.current_user_id', _actor_user_id::text, true);
  IF COALESCE(array_length(_aliases, 1), 0) <> COALESCE(array_length(_alias_normalized, 1), 0) THEN
    RAISE EXCEPTION 'kg_upsert_entity: aliases and their normalized forms must pair up';
  END IF;
  SELECT id, identifiers INTO v_id, v_ids FROM public.kg_entities
   WHERE organization_id = _org_id AND kg_key = _kg_key;
  IF v_id IS NULL THEN
    INSERT INTO public.kg_entities (organization_id, entity_type, kg_key, name, country, identifiers, created_by)
    VALUES (_org_id, _entity_type, _kg_key, _name, NULLIF(_country, ''), COALESCE(_identifiers, '{}'::jsonb), _actor_user_id)
    RETURNING id INTO v_id;
  ELSE
    FOR k IN SELECT jsonb_object_keys(COALESCE(_identifiers, '{}'::jsonb)) LOOP
      IF v_ids ? k AND v_ids ->> k IS DISTINCT FROM _identifiers ->> k THEN
        RAISE EXCEPTION 'identity_conflict: % already has %=% (incoming %)', _kg_key, k, v_ids ->> k, _identifiers ->> k;
      END IF;
    END LOOP;
    UPDATE public.kg_entities
       SET identifiers = COALESCE(_identifiers, '{}'::jsonb) || identifiers,
           country = COALESCE(country, NULLIF(_country, '')),
           updated_at = now()
     WHERE id = v_id AND NOT (identifiers @> COALESCE(_identifiers, '{}'::jsonb)
                              AND (country IS NOT NULL OR NULLIF(_country, '') IS NULL));
  END IF;
  IF COALESCE(array_length(_aliases, 1), 0) > 0 THEN
    INSERT INTO public.kg_entity_aliases (organization_id, entity_id, alias, normalized, source)
    SELECT _org_id, v_id, a, n, _source FROM unnest(_aliases, _alias_normalized) AS u(a, n)
    ON CONFLICT (organization_id, entity_id, normalized) DO NOTHING;
  END IF;
  RETURN v_id;
END; $fn$;
REVOKE ALL ON FUNCTION public.kg_upsert_entity(uuid,text,text,text,text,jsonb,text[],text[],text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kg_upsert_entity(uuid,text,text,text,text,jsonb,text[],text[],text,uuid) TO service_role;

-- kg_queue_identity_review: a name with more than one candidate waits here.
CREATE OR REPLACE FUNCTION public.kg_queue_identity_review(
  _org_id uuid, _mention text, _normalized text, _country text, _candidates jsonb, _actor_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid;
BEGIN
  PERFORM public.kg_assert_org_member('kg_queue_identity_review', _org_id, _actor_user_id);
  PERFORM set_config('app.current_user_id', _actor_user_id::text, true);
  INSERT INTO public.kg_identity_review (organization_id, mention, normalized, country, candidates)
  VALUES (_org_id, _mention, _normalized, NULLIF(_country, ''), _candidates)
  ON CONFLICT (organization_id, normalized, country)
  DO UPDATE SET candidates = EXCLUDED.candidates
  RETURNING id INTO v_id;
  RETURN v_id;
END; $fn$;
REVOKE ALL ON FUNCTION public.kg_queue_identity_review(uuid,text,text,text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kg_queue_identity_review(uuid,text,text,text,jsonb,uuid) TO service_role;

-- ── 7 · reader ─────────────────────────────────────────────────────────────
-- The only read path for a browser or an agent: it names the reader, and a
-- reader outside the organization is refused rather than shown nothing.
CREATE OR REPLACE FUNCTION public.kg_list_entities(_org_id uuid, _actor_user_id uuid)
RETURNS TABLE (id uuid, entity_type text, kg_key text, name text, country text,
               identifiers jsonb, aliases text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  PERFORM public.kg_assert_org_member('kg_list_entities', _org_id, _actor_user_id);
  RETURN QUERY
    SELECT e.id, e.entity_type, e.kg_key, e.name, e.country, e.identifiers,
           COALESCE(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}')
      FROM public.kg_entities e
      LEFT JOIN public.kg_entity_aliases a ON a.entity_id = e.id
     WHERE e.organization_id = _org_id
     GROUP BY e.id
     ORDER BY e.entity_type, e.name;
END; $fn$;
REVOKE ALL ON FUNCTION public.kg_list_entities(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kg_list_entities(uuid, uuid) TO anon, authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
