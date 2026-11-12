-- THE LANE REBUILD SCALES: a 100-product, four-level project rebuilds its lanes inside the
-- 8 s an edge-function RPC gets.
--
-- `20261105000001` removes two quadratic costs from the rebuild that every lane promotion
-- fires (`rebuild_supply_chain_lanes`, then the node-list refresh): a per-node scan of the BOM
-- for each node's depth and tier, and a demand walk that compared every walk row with every
-- BOM row. Found loading `scripts/demo_project_large`: the same 700-row slice promoted in
-- 2.8 / 3.9 / 7.7 / 11 s as the BOM filled, and then a 106-row slice failed — the cost belongs
-- to the PROJECT, not to the file.
--
--   §1 SAME ANSWER: on the project below the set-based `node_bom_depths` / `node_supply_tiers`
--      give every node what the per-node functions give it (920 §1 holds this on a graph built
--      to be awkward; this holds it on a big, shared-material, four-level one), and
--      `node_list_attributes` agrees with both.
--   §2 THE TIMING: 100 products, a four-level BOM of 4 700 rows whose materials are shared
--      across products, 1 800 inbound lanes and 200 outbound lanes. The sources are loaded with
--      the lane triggers OFF (loading is not what is measured), the triggers are switched back
--      on, and ONE rebuild — with the node-list refreshes its four statements fire — must finish
--      in under 6 s, below the 8 s production gives it with room for a slower CI runner.
--      Measured on an idle local database: ~2 s with this migration; with the previous
--      definitions the same call takes minutes (the BOM alone, before any demand, 14 s; the
--      demand walk 490 s), which is what the 30 s `statement_timeout` below turns into a
--      failure rather than a hung job. The timeout is set BEFORE the statement that runs the
--      rebuild: one set inside a running statement is never armed (880's note), which is also
--      why the elapsed time is read with `clock_timestamp()`.
--   §3 THE LANES ARE COMPLETE: every BOM edge reaches the deep lane once (the trees do not
--      overlap, so one root each) and carries demand, every inbound pair is a lane, every
--      outbound row is a lane.

CREATE TEMP TABLE s960_state (proj uuid, usr uuid, took interval);

DO $s960setup$
DECLARE
  v_org  uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_proj uuid := gen_random_uuid();
  v_n    integer;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org, 'S960 Org', 's960-' || substr(v_org::text, 1, 8));
  INSERT INTO public.approved_users (id, email, name, password_hash, role, organization, organization_id, is_active) VALUES
    (v_user, 's960-' || substr(v_user::text, 1, 8) || '@example.invalid', 'S960 Admin', 'x', 'admin', 'S960 Org', v_org, true);
  INSERT INTO public.projects (id, name, modeler_id, plant_name, organization, organization_id, bom_level) VALUES
    (v_proj, 'S960 large multi-level', v_user, 'S960P', 'S960 Org', v_org, 'multi');
  INSERT INTO s960_state (proj, usr) VALUES (v_proj, v_user);

  INSERT INTO public.products (project_id, product_id, name)
  SELECT v_proj, 'P-' || lpad(p::text, 3, '0'), 'Product ' || p FROM generate_series(1, 100) p;

END;
$s960setup$;

-- Loading is not what is measured: the lane triggers (which rebuild the whole project on every
-- statement) are off while the sources go in, and on again before the one rebuild below. Each
-- ALTER is its own statement (and so its own transaction): PostgreSQL refuses to change a
-- table's triggers in the transaction that still has deferred constraint checks pending on it.
ALTER TABLE public.bom_multi_level      DISABLE TRIGGER USER;
ALTER TABLE public.inbound_logistics    DISABLE TRIGGER USER;
ALTER TABLE public.outbound_logistics   DISABLE TRIGGER USER;

DO $s960load$
DECLARE
  v_proj uuid;
  v_n    integer;
BEGIN
  SELECT proj INTO v_proj FROM s960_state;

  -- The BOM, product by product: 2 materials and 3 sub-assemblies under the product; each
  -- sub-assembly has 4 materials and a nested sub-assembly (5 materials and a sub-sub-assembly
  -- of 3). 47 rows a product, four levels deep. Materials are numbered so that products share
  -- them (38 slots a product, drawn from a pool of 1 800).
  INSERT INTO public.bom_multi_level (project_id, plant_name, material_id, level, higher_level_component_id, consumption_rate)
  WITH pm AS (
    SELECT p, 'P-' || lpad(p::text, 3, '0') AS pid FROM generate_series(1, 100) p
  ), rows_ AS (
    SELECT 'MAT-' || lpad((((pm.p - 1) * 38 + j) % 1800 + 1)::text, 4, '0') AS material_id, 1 AS level, pm.pid AS parent
      FROM pm, generate_series(0, 1) j
    UNION ALL  -- the 3 sub-assemblies under the product
    SELECT 'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k, 1, pm.pid
      FROM pm, generate_series(1, 3) k
    UNION ALL  -- 4 materials under each sub-assembly
    SELECT 'MAT-' || lpad((((pm.p - 1) * 38 + 2 + (k - 1) * 12 + i) % 1800 + 1)::text, 4, '0'), 2,
           'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k
      FROM pm, generate_series(1, 3) k, generate_series(0, 3) i
    UNION ALL  -- the nested sub-assembly
    SELECT 'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k || '-1', 2,
           'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k
      FROM pm, generate_series(1, 3) k
    UNION ALL  -- 5 materials under the nested sub-assembly
    SELECT 'MAT-' || lpad((((pm.p - 1) * 38 + 2 + (k - 1) * 12 + 4 + i) % 1800 + 1)::text, 4, '0'), 3,
           'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k || '-1'
      FROM pm, generate_series(1, 3) k, generate_series(0, 4) i
    UNION ALL  -- the sub-sub-assembly
    SELECT 'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k || '-1-1', 3,
           'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k || '-1'
      FROM pm, generate_series(1, 3) k
    UNION ALL  -- 3 materials under it
    SELECT 'MAT-' || lpad((((pm.p - 1) * 38 + 2 + (k - 1) * 12 + 9 + i) % 1800 + 1)::text, 4, '0'), 4,
           'ASM-' || lpad(pm.p::text, 3, '0') || '-' || k || '-1-1'
      FROM pm, generate_series(1, 3) k, generate_series(0, 2) i
  )
  SELECT v_proj, 'S960P', material_id, level, parent, 1 + (row_number() OVER () % 3) FROM rows_;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 100 * 47 THEN
    RAISE EXCEPTION 'S960/960: the generated BOM has % rows, expected %', v_n, 100 * 47;
  END IF;

  -- One supplier a material (a pool of 400 suppliers), and two customers a product.
  INSERT INTO public.inbound_logistics (project_id, plant_name, supplier_id, material_id, volume, time_unit, lead_time, unit_price)
  SELECT v_proj, 'S960P', 'SUP-' || lpad(((m * 7) % 400 + 1)::text, 3, '0'), 'MAT-' || lpad(m::text, 4, '0'),
         10, 'week', 4, 1
    FROM generate_series(1, 1800) m;
  INSERT INTO public.outbound_logistics (project_id, plant_name, customer_id, product_id, volume, time_unit, expected_lead_time, unit_price)
  SELECT v_proj, 'S960P', 'CUST-0' || c, 'P-' || lpad(p::text, 3, '0'), 50, 'week', 1, 40
    FROM generate_series(1, 100) p, generate_series(1, 2) c;

END;
$s960load$;

-- (run any deferred constraint checks now, or the ENABLEs below are refused when this file is run
-- as one transaction, as the rehearsal runner does)
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.bom_multi_level      ENABLE TRIGGER USER;
ALTER TABLE public.inbound_logistics    ENABLE TRIGGER USER;
ALTER TABLE public.outbound_logistics   ENABLE TRIGGER USER;

-- §2 — ONE rebuild, with the lane triggers on. Its own top-level statement, so the timeout set
-- on the line before is armed for it.
CREATE FUNCTION pg_temp.s960_rebuild() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_t0 timestamptz;
BEGIN
  v_t0 := clock_timestamp();
  PERFORM public.rebuild_supply_chain_lanes((SELECT proj FROM s960_state), (SELECT usr FROM s960_state));
  UPDATE s960_state SET took = clock_timestamp() - v_t0;
END;
$f$;

SET statement_timeout = '30s';
SELECT pg_temp.s960_rebuild();
RESET statement_timeout;

DO $s960check$
DECLARE
  v_proj uuid;
  v_took interval;
  v_n    integer;
  v_exp  integer;
  v_bad  text;
BEGIN
  SELECT proj, took INTO v_proj, v_took FROM s960_state;

  RAISE NOTICE 'S960/960 §2: rebuilding a 100-product, 4 700-row project took %', v_took;
  IF v_took > interval '6 seconds' THEN
    RAISE EXCEPTION 'S960/960 §2: one lane rebuild took % — production cancels an edge-function RPC at 8 s. The rebuild is quadratic again.', v_took;
  END IF;

  -- ── §1 same answer ─────────────────────────────────────────────────────────
  SELECT string_agg(format('%s: set depth %s / tier %s, per-node %s / %s', n.node_id,
                           d.bom_depth, t.supply_tier,
                           public.node_bom_depth(v_proj, n.node_id), public.node_supply_tier(v_proj, n.node_id)), '; ')
    INTO v_bad
    FROM public.node_list n
    LEFT JOIN public.node_bom_depths(v_proj)   d ON d.node_id = n.node_id
    LEFT JOIN public.node_supply_tiers(v_proj) t ON t.node_id = n.node_id
   WHERE n.project_id = v_proj
     AND (d.bom_depth, t.supply_tier) IS DISTINCT FROM
         (public.node_bom_depth(v_proj, n.node_id), public.node_supply_tier(v_proj, n.node_id));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S960/960 §1: the set-based depth/tier differ from the per-node functions — %', left(v_bad, 600);
  END IF;
  SELECT string_agg(a.node_id, ', ') INTO v_bad
    FROM public.node_list_attributes(v_proj) a
   WHERE (a.bom_depth, a.supply_tier) IS DISTINCT FROM
         (public.node_bom_depth(v_proj, a.node_id), public.node_supply_tier(v_proj, a.node_id));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'S960/960 §1: node_list_attributes disagrees with the per-node functions for %', left(v_bad, 300);
  END IF;

  -- ── §3 the lanes are complete ──────────────────────────────────────────────
  SELECT count(*) INTO v_n FROM public.supply_chain_data_multi_tier WHERE project_id = v_proj AND data_source = 'bom';
  IF v_n <> 100 * 47 THEN
    RAISE EXCEPTION 'S960/960 §3: the deep lane holds % BOM edge(s), expected % (every edge once, one root each)', v_n, 100 * 47;
  END IF;
  SELECT count(*) INTO v_n FROM public.supply_chain_data_multi_tier
   WHERE project_id = v_proj AND data_source = 'bom' AND path_root IS NOT NULL AND weighted > 0;
  IF v_n <> 100 * 47 THEN
    RAISE EXCEPTION 'S960/960 §3: only % of % BOM edges carry demand', v_n, 100 * 47;
  END IF;
  SELECT count(*) INTO v_n FROM public.supply_chain_data WHERE project_id = v_proj AND data_source = 'inbound';
  SELECT count(*) INTO v_exp FROM (SELECT DISTINCT supplier_id, material_id FROM public.inbound_logistics WHERE project_id = v_proj) x;
  IF v_n <> v_exp OR v_n <> 1800 THEN
    RAISE EXCEPTION 'S960/960 §3: % inbound lane(s) in the flat lane for % distinct (supplier, material) pair(s), expected 1800', v_n, v_exp;
  END IF;
  SELECT count(*) INTO v_n FROM public.supply_chain_data WHERE project_id = v_proj AND data_source = 'outbound';
  IF v_n <> 200 THEN
    RAISE EXCEPTION 'S960/960 §3: % outbound lane(s), expected 200', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.node_list WHERE project_id = v_proj;
  IF v_n < 1800 + 100 THEN
    RAISE EXCEPTION 'S960/960 §3: the node list holds % node(s) for 1 800 materials and 100 products', v_n;
  END IF;

  RAISE NOTICE 'S960/960: a 100-product, four-level project rebuilds inside the edge function''s statement timeout';
END;
$s960check$;

DROP TABLE s960_state;
