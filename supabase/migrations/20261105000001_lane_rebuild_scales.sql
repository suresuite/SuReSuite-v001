-- THE LANE REBUILD SCALES: a 100-product, 1 000-supplier project loads in seconds, not minutes.
--
-- Found by loading `scripts/demo_project_large` (100 products, 1 800 materials, 1 000 suppliers,
-- a 4 868-row multi-level BOM) through the ordinary upload path. Each promotion rebuilds the
-- project's lanes (`rebuild_supply_chain_lanes`, fired by a statement trigger on every lane
-- source table, D142) and then its node list (D143), and under the 8 s an edge-function RPC
-- gets, the load stopped part-way: the same 700-row slice promoted in 2.8 s, 3.9 s, 7.7 s and
-- 11 s as the BOM filled, and then a 106-row slice failed. The cost belonged to the PROJECT,
-- not to the file, so cutting the file smaller made it worse (more rebuilds).
--
-- Reproduced on a local PostgreSQL 16 and measured (idle machine, the same 700-row slices):
--
--   BOM slices          0.6  1.2  2.4  5.1  7.9  10.7  14.1 s   →   0.6  0.8  0.9  1.0  1.1  1.2  1.1 s
--   outbound (192 rows) 388 s (one statement, with the first fix alone)  →  3.5 s
--   full rebuild at 4 868 BOM rows: 14.5 s → 0.8 s;  node-list refresh: 6.3 s → 0.1 s
--
-- TWO CAUSES, BOTH QUADRATIC.
--
--   1. THE NODE LIST ASKED ONE QUESTION PER NODE. `node_list_attributes` called
--      `node_bom_depth` and `node_supply_tier` for every node, and each call scans the project's
--      whole BOM (or lane) table, so a refresh cost nodes × BOM rows — and a rebuild runs the
--      refresh up to four times (a DELETE and an INSERT on each lane table), plus
--      `rebuild_supply_chain_lanes` called `node_bom_depth` once per INBOUND LANE. Both now read
--      one pass: `node_bom_depths(project)` and `node_supply_tiers(project)` return every node's
--      answer from a single grouped scan, and the per-node functions are left exactly as they
--      were. `rehearsal/920` §1 already holds the set-based collector equal to the per-node
--      functions for every node, so the rule cannot drift between them.
--
--   2. THE DEMAND WALK COMPARED EVERY WALK ROW WITH EVERY BOM ROW. `bom_edges` computed a
--      parent as `COALESCE(parent, d.product_id)` over a LEFT JOIN onto every product's demand,
--      so the planner could not use `parent_id = node_id` as a join key: it joined on plant
--      alone and filtered afterwards — 483 million rows removed by a join filter, 490 s for
--      one query, on 100 products. The parentless rows (whose parent is every product the
--      plant ships, D129) are now a separate branch, so the other branch's `parent_id` is a
--      plain expression the walk can hash-join on. A parentless row with no demand used to be
--      emitted with a NULL parent, which both consumers drop (`e.parent_id = w.node_id` never
--      matches NULL; the deep lane filters `parent_id IS NOT NULL`); it is no longer emitted.
--
-- A THIRD, SMALLER COST is a plan that depends on statistics the load has not updated yet; it is
-- explained where it is fixed, below (`enable_nestloop`).
--
-- THE ANSWER IS UNCHANGED. The lanes and the node list this produces were compared, row for
-- row (EXCEPT ALL both ways), against what the previous definitions produce, on three
-- projects: 590 and 2 017 BOM rows against the ORIGINAL functions, and the full 4 868-row
-- project against the intermediate version. Every difference count is zero. `rehearsal/960`
-- keeps the speed from regressing, and `rehearsal/920` §1 keeps the two collectors equal.

CREATE OR REPLACE FUNCTION public.node_bom_depths(p_project_id uuid)
RETURNS TABLE (node_id text, bom_depth integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT d.node_id, MIN(d.depth)::integer
    FROM (
      SELECT b.material_id AS node_id, b.level AS depth FROM public.bom_multi_level b
       WHERE b.project_id = p_project_id
      UNION ALL
      SELECT b.higher_level_component_id, GREATEST(b.level - 1, 0) FROM public.bom_multi_level b
       WHERE b.project_id = p_project_id
      UNION ALL
      SELECT s.material_id, 1 FROM public.bom_single_level s WHERE s.project_id = p_project_id
      UNION ALL
      SELECT s.product_id, 0 FROM public.bom_single_level s WHERE s.project_id = p_project_id
    ) d
   WHERE d.node_id IS NOT NULL
   GROUP BY d.node_id;
$function$;

CREATE OR REPLACE FUNCTION public.node_supply_tiers(p_project_id uuid)
RETURNS TABLE (node_id text, supply_tier integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT t.node_id, MIN(t.tier)::integer
    FROM (
      SELECT p.plant_name AS node_id, 0 AS tier FROM public.projects p WHERE p.id = p_project_id
      UNION ALL
      SELECT i.supplier_id, 1 FROM public.inbound_logistics i WHERE i.project_id = p_project_id
      UNION ALL
      SELECT x.supplier_id, 1 FROM public.tier2_suppliers x WHERE x.project_id = p_project_id
      UNION ALL
      SELECT x.upstream_supplier_id, 2 FROM public.tier2_suppliers x WHERE x.project_id = p_project_id
      UNION ALL
      SELECT x.supplier_id, 2 FROM public.tier3_suppliers x WHERE x.project_id = p_project_id
      UNION ALL
      SELECT x.upstream_supplier_id, 3 FROM public.tier3_suppliers x WHERE x.project_id = p_project_id
    ) t
   WHERE t.node_id IS NOT NULL
   GROUP BY t.node_id;
$function$;

CREATE OR REPLACE FUNCTION public.node_list_attributes(p_project_id uuid)
 RETURNS TABLE(node_id text, in_lanes boolean, plant_name text, echelon text, bom_depth integer, supply_tier integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET enable_nestloop TO 'off'
AS $function$
  WITH lanes AS (
    SELECT s.data_source, s.from_location, s.to_location, s.plant_name
      FROM public.supply_chain_data s WHERE s.project_id = p_project_id
    UNION ALL
    SELECT t.data_source, t.from_location, t.to_location, t.plant_name
      FROM public.supply_chain_data_multi_tier t WHERE t.project_id = p_project_id
  ), ends AS (
    SELECT l.from_location AS node_id, 'from' AS side, l.data_source, l.plant_name FROM lanes l
    UNION ALL
    SELECT l.to_location, 'to', l.data_source, l.plant_name FROM lanes l
  ), flags AS (
    SELECT e.node_id,
           MIN(e.plant_name)                                        AS plant_name,
           bool_or(e.data_source = 'outbound' AND e.side = 'to')    AS outbound_target,
           bool_or(e.data_source = 'outbound' AND e.side = 'from')  AS outbound_source,
           bool_or(e.data_source = 'inbound'  AND e.side = 'from')  AS inbound_source,
           bool_or(e.data_source = 'inbound'  AND e.side = 'to')    AS inbound_target,
           bool_or(e.data_source = 'bom'      AND e.side = 'from')  AS bom_source,
           bool_or(e.data_source = 'bom'      AND e.side = 'to')    AS bom_target
      FROM ends e
     WHERE e.node_id IS NOT NULL AND btrim(e.node_id) <> ''
     GROUP BY e.node_id
  ), nodes AS (
    SELECT f.node_id FROM flags f
    UNION
    SELECT n.node_id FROM public.node_list n WHERE n.project_id = p_project_id
  )
  SELECT n.node_id,
         f.node_id IS NOT NULL,
         f.plant_name,
         CASE WHEN n.node_id IS NULL OR btrim(n.node_id) = '' THEN 'unknown'
              ELSE public.node_echelon_from_flags(
                     f.outbound_target, f.outbound_source, f.inbound_source,
                     f.inbound_target, f.bom_source, f.bom_target,
                     EXISTS (SELECT 1 FROM public.projects p
                              WHERE p.id = p_project_id AND p.plant_name = n.node_id))
         END,
         d.bom_depth,
         t.supply_tier
    FROM nodes n
    LEFT JOIN flags f ON f.node_id = n.node_id
    LEFT JOIN public.node_bom_depths(p_project_id) d ON d.node_id = n.node_id
    LEFT JOIN public.node_supply_tiers(p_project_id) t ON t.node_id = n.node_id;
$function$

;
CREATE OR REPLACE FUNCTION public.rebuild_supply_chain_lanes(p_project_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
  v_org      text;
  v_modeler  uuid;
  v_actor    uuid;
  v_email    text;
  v_exists   boolean;
  v_scd      integer := 0;
  v_mt       integer := 0;
BEGIN
  SELECT true, p.organization, p.modeler_id
    INTO v_exists, v_org, v_modeler
    FROM public.projects p
   WHERE p.id = p_project_id;

  -- The project is gone, or was never there. This runs from a statement trigger
  -- on four tables that CASCADE from `projects`, so a project deletion fires it
  -- with the parent row already removed — and a rebuild there would re-insert
  -- rows into two tables that carry NO cascade of their own (`node_list` and
  -- `supply_chain_data_multi_tier`), which is orphan rows created by a repair.
  IF NOT COALESCE(v_exists, false) THEN
    RETURN jsonb_build_object('skipped', 'no_project');
  END IF;

  -- ATTRIBUTION, NOT AUTHORIZATION. The caller's actor, else whoever the
  -- enclosing statement already named, else the project owner — a tier-3 write
  -- must name somebody (`audit-actor`, G4), and a trigger has no caller to ask.
  v_actor := COALESCE(p_actor_user_id, public.get_current_user_id(), v_modeler);

  SELECT au.email INTO v_email
    FROM public.approved_users au WHERE au.id = v_actor LIMIT 1;

  IF v_actor IS NOT NULL THEN
    PERFORM public.set_current_user_context(v_actor, COALESCE(v_email, ''));
  END IF;
  PERFORM public.assert_writer_may_act('rebuild_supply_chain_lanes', p_project_id, v_actor);

  DELETE FROM public.supply_chain_data            WHERE project_id = p_project_id;
  DELETE FROM public.supply_chain_data_multi_tier WHERE project_id = p_project_id;

  -- ONE insert per table rather than four. Every lane statement fires
  -- `auto_refresh_node_list_on_lane_change`, so the old ten-statement build paid
  -- for ten full re-classifications of the graph per combine — and after this
  -- package a source edit triggers a combine, so that cost is now paid on
  -- uploads too. Four statements instead of ten is not a micro-optimisation
  -- here; it is what makes the trigger in section 5 affordable.
  WITH RECURSIVE
  -- D150 — `rate_to_weekly` at EVERY read, which the deployed writer never had.
  -- WP 0.2 closed D2 in the edge function and the RPC kept all eight raw reads.
  -- `normalize-at-promotion` (I3) makes this exactly identity (×7/7) for any row
  -- promoted since WP 3.3 and load-bearing for every row that predates it, which
  -- is the same reason `sc_nodes` still converts.
  outb AS (
    SELECT o.plant_name, o.product_id, o.customer_id,
           public.rate_to_weekly(COALESCE(o.volume, 0), o.time_unit) AS wk
      FROM public.outbound_logistics o
     WHERE o.project_id = p_project_id
       AND COALESCE(btrim(o.product_id), '') <> ''
  ),
  demand AS (
    SELECT plant_name, product_id, SUM(wk) AS wk
      FROM outb GROUP BY plant_name, product_id
  ),
  -- Both BOM tables, normalized to (parent ← child, rate, depth). Unconditional,
  -- exactly as the RPC has always read them: `projects.bom_level` gates which one
  -- a project UPLOADS, and branching on it is what left three projects with a
  -- permanently empty Process page (D130). A project holding rows in both holds
  -- two real uploads and both are built.
  bom_edges AS (
    -- D129 / D141 — A PARENTLESS BOM ROW'S PARENT IS THE FINISHED PRODUCT.
    --
    -- `bom_multi_level.higher_level_component_id` is "empty at the top of the
    -- tree, where the parent is the finished product itself" — its own sidecar
    -- says so — and the table names NO product, so the BOM is plant-scoped and
    -- "the finished product" means every product that plant ships. With one
    -- product it is unambiguous; with several the row genuinely feeds each of
    -- them, and each root carries its OWN demand, so nothing is double counted.
    -- A plant that ships no product yields NULL here and the edge is dropped by
    -- the walk — which is the same answer as "reaches no finished product".
    --
    -- The old writers: the edge function looked up `plant::<blank>`, found no
    -- parent demand and skipped the row in the EMIT loop, so a count of `''`
    -- could never see it (D129). The RPC wrote `COALESCE(…, 'ROOT')` into both
    -- `to_location` and `path_root` — a node no CSV contains, no user can
    -- explain, and every centrality on the page would be computed over (D141).
    SELECT b.plant_name,
           NULLIF(btrim(b.higher_level_component_id), '') AS parent_id,
           btrim(b.material_id)            AS child_id,
           COALESCE(b.consumption_rate, 0) AS rate,
           b.level                         AS depth
      FROM public.bom_multi_level b
     WHERE b.project_id = p_project_id
       AND COALESCE(btrim(b.material_id), '') <> ''
       AND NULLIF(btrim(b.higher_level_component_id), '') IS NOT NULL
    UNION ALL
    -- The parentless rows, whose parent is every product the plant ships (D129). A separate
    -- branch, so the walk below can hash-join on a plain `parent_id`: written as one SELECT
    -- with `COALESCE(parent, d.product_id)` over a LEFT JOIN, the planner could not use the
    -- join key and compared every walk row with every BOM row (483 million comparisons, 490 s,
    -- on 100 products and 4 868 BOM rows). A parentless row with no demand used to come out
    -- with a NULL parent, which both consumers drop; here it does not come out at all.
    SELECT b.plant_name,
           d.product_id,
           btrim(b.material_id),
           COALESCE(b.consumption_rate, 0),
           b.level
      FROM public.bom_multi_level b
      JOIN demand d ON d.plant_name = b.plant_name
     WHERE b.project_id = p_project_id
       AND COALESCE(btrim(b.material_id), '') <> ''
       AND NULLIF(btrim(b.higher_level_component_id), '') IS NULL
       -- §4 D171 — a parentless row whose child is itself a product is the product's own root
       -- row, not a component edge.
       AND NOT (EXISTS (SELECT 1 FROM public.products pr
                         WHERE pr.project_id = p_project_id
                           AND btrim(pr.product_id) = btrim(b.material_id))
                OR EXISTS (SELECT 1 FROM demand dd
                            WHERE dd.plant_name = b.plant_name
                              AND dd.product_id = btrim(b.material_id)))
    UNION ALL
    SELECT s.plant_name, btrim(s.product_id), btrim(s.material_id),
           COALESCE(s.consumption_rate, 0), 1
      FROM public.bom_single_level s
     WHERE s.project_id = p_project_id
       AND COALESCE(btrim(s.material_id), '') <> ''
       AND COALESCE(btrim(s.product_id), '')  <> ''
  ),
  -- THE DEMAND WALK, ported from `combine-project/index.ts`. A finished product's
  -- weekly demand propagates down the tree, multiplied by each edge's consumption
  -- rate, and every (node, root) pair sums the contributions of every path.
  --
  -- RECURSIVE and not a loop over `level`: a level-ordered loop is only correct if
  -- `level` is a topological order of the tree, and D140 is the finding that
  -- nobody may assume anything about that column. `path` is the cycle guard — a
  -- BOM that contains a cycle is bad data, not a reason to hang a migration — and
  -- the 64-step cap bounds a tree whose depth is data.
  walk AS (
    SELECT d.plant_name, d.product_id AS node_id, d.product_id AS root_id,
           d.wk AS qty, ARRAY[d.product_id] AS path
      FROM demand d
     WHERE d.wk IS NOT NULL
    UNION ALL
    SELECT e.plant_name, e.child_id, w.root_id, w.qty * e.rate, w.path || e.child_id
      FROM walk w
      JOIN bom_edges e
        ON e.plant_name = w.plant_name
       AND e.parent_id  = w.node_id
     WHERE e.child_id <> ALL (w.path)
       AND array_length(w.path, 1) < 64
  ),
  node_demand AS (
    SELECT plant_name, node_id, root_id, SUM(qty) AS qty
      FROM walk GROUP BY plant_name, node_id, root_id
  ),
  material_demand AS (
    SELECT plant_name, node_id, SUM(qty) AS qty
      FROM node_demand GROUP BY plant_name, node_id
  ),
  inb AS (
    SELECT i.plant_name, i.supplier_id, i.material_id,
           public.rate_to_weekly(COALESCE(i.volume, 0), i.time_unit) AS wk
      FROM public.inbound_logistics i
     WHERE i.project_id = p_project_id
       AND COALESCE(btrim(i.supplier_id), '') <> ''
       AND COALESCE(btrim(i.material_id), '') <> ''
  ),
  inb_total AS (
    SELECT plant_name, material_id, SUM(wk) AS wk
      FROM inb GROUP BY plant_name, material_id
  ),
  -- A PURCHASED material — one the plant buys rather than builds. This is what
  -- makes the flat lane the product-level graph: its bom rows run from the things
  -- a supplier delivers to the things a customer buys.
  purchased AS (
    SELECT DISTINCT plant_name, material_id FROM inb
  ),
  flat AS (
    SELECT o.plant_name, 'outbound'::text AS data_source,
           o.product_id AS from_location, o.customer_id AS to_location,
           o.wk AS rate,
           -- `volumeShare`, which is what this column's sidecar has always said
           -- it is. The RPC wrote a literal 1.0 on this lane and the edge
           -- function wrote the share; D140's class, settled toward the contract.
           CASE WHEN dm.wk > 0 THEN o.wk / dm.wk ELSE 1.0 END AS sourcing_ratio,
           o.wk AS weighted
      FROM outb o
      JOIN demand dm ON dm.plant_name = o.plant_name AND dm.product_id = o.product_id
     WHERE COALESCE(btrim(o.customer_id), '') <> ''
    UNION ALL
    SELECT nd.plant_name, 'bom',
           nd.node_id, nd.root_id,
           -- D136 — the EFFECTIVE consumption rate, where the multi-level path
           -- wrote a literal 0 and the single-level path wrote the real number.
           CASE WHEN dm.wk > 0 THEN nd.qty / dm.wk ELSE 0 END,
           1.0,
           nd.qty
      FROM node_demand nd
      JOIN purchased p  ON p.plant_name  = nd.plant_name AND p.material_id = nd.node_id
      JOIN demand    dm ON dm.plant_name = nd.plant_name AND dm.product_id = nd.root_id
     WHERE nd.qty > 0
       AND nd.node_id <> nd.root_id
    UNION ALL
    SELECT i.plant_name, 'inbound',
           i.supplier_id, i.material_id,
           i.wk,
           CASE WHEN t.wk > 0 THEN i.wk / t.wk ELSE 1.0 END,
           -- The MATERIAL's demand times this supplier's share of it. The RPC
           -- multiplied the plant's total outbound volume by the share instead,
           -- which is a number about products standing in for one about a
           -- material.
           COALESCE(md.qty, 0) * CASE WHEN t.wk > 0 THEN i.wk / t.wk ELSE 1.0 END
      FROM inb i
      JOIN inb_total t ON t.plant_name = i.plant_name AND t.material_id = i.material_id
      LEFT JOIN material_demand md
             ON md.plant_name = i.plant_name AND md.node_id = i.material_id
  )
  INSERT INTO public.supply_chain_data (
    project_id, plant_name, data_source, from_location, to_location,
    material_consumption_rate, sourcing_ratio, weighted, uploaded_by, organization)
  SELECT p_project_id, f.plant_name, f.data_source, f.from_location, f.to_location,
         f.rate, f.sourcing_ratio, f.weighted, v_actor, v_org
    FROM flat f
   WHERE COALESCE(btrim(f.from_location), '') <> ''
     AND COALESCE(btrim(f.to_location), '')   <> '';

  GET DIAGNOSTICS v_scd = ROW_COUNT;

  -- ── the deep lane ───────────────────────────────────────────────────────
  WITH RECURSIVE
  outb AS (
    SELECT o.plant_name, o.product_id, o.customer_id,
           public.rate_to_weekly(COALESCE(o.volume, 0), o.time_unit) AS wk
      FROM public.outbound_logistics o
     WHERE o.project_id = p_project_id
       AND COALESCE(btrim(o.product_id), '') <> ''
  ),
  demand AS (
    SELECT plant_name, product_id, SUM(wk) AS wk
      FROM outb GROUP BY plant_name, product_id
  ),
  bom_edges AS (
    SELECT b.plant_name,
           NULLIF(btrim(b.higher_level_component_id), '') AS parent_id,
           btrim(b.material_id)            AS child_id,
           COALESCE(b.consumption_rate, 0) AS rate,
           b.level                         AS depth
      FROM public.bom_multi_level b
     WHERE b.project_id = p_project_id
       AND COALESCE(btrim(b.material_id), '') <> ''
       AND NULLIF(btrim(b.higher_level_component_id), '') IS NOT NULL
    UNION ALL
    -- The parentless rows, whose parent is every product the plant ships (D129). A separate
    -- branch, so the walk below can hash-join on a plain `parent_id`: written as one SELECT
    -- with `COALESCE(parent, d.product_id)` over a LEFT JOIN, the planner could not use the
    -- join key and compared every walk row with every BOM row (483 million comparisons, 490 s,
    -- on 100 products and 4 868 BOM rows). A parentless row with no demand used to come out
    -- with a NULL parent, which both consumers drop; here it does not come out at all.
    SELECT b.plant_name,
           d.product_id,
           btrim(b.material_id),
           COALESCE(b.consumption_rate, 0),
           b.level
      FROM public.bom_multi_level b
      JOIN demand d ON d.plant_name = b.plant_name
     WHERE b.project_id = p_project_id
       AND COALESCE(btrim(b.material_id), '') <> ''
       AND NULLIF(btrim(b.higher_level_component_id), '') IS NULL
       -- §4 D171 — a parentless row whose child is itself a product is the product's own root
       -- row, not a component edge.
       AND NOT (EXISTS (SELECT 1 FROM public.products pr
                         WHERE pr.project_id = p_project_id
                           AND btrim(pr.product_id) = btrim(b.material_id))
                OR EXISTS (SELECT 1 FROM demand dd
                            WHERE dd.plant_name = b.plant_name
                              AND dd.product_id = btrim(b.material_id)))
    UNION ALL
    -- D130 — the single-level half of the deep lane, which never existed. A
    -- single-level BOM is a real two-level tree and the Process page can draw it.
    SELECT s.plant_name, btrim(s.product_id), btrim(s.material_id),
           COALESCE(s.consumption_rate, 0), 1
      FROM public.bom_single_level s
     WHERE s.project_id = p_project_id
       AND COALESCE(btrim(s.material_id), '') <> ''
       AND COALESCE(btrim(s.product_id), '')  <> ''
  ),
  walk AS (
    SELECT d.plant_name, d.product_id AS node_id, d.product_id AS root_id,
           d.wk AS qty, ARRAY[d.product_id] AS path
      FROM demand d
     WHERE d.wk IS NOT NULL
    UNION ALL
    SELECT e.plant_name, e.child_id, w.root_id, w.qty * e.rate, w.path || e.child_id
      FROM walk w
      JOIN bom_edges e
        ON e.plant_name = w.plant_name AND e.parent_id = w.node_id
     WHERE e.child_id <> ALL (w.path)
       AND array_length(w.path, 1) < 64
  ),
  node_demand AS (
    SELECT plant_name, node_id, root_id, SUM(qty) AS qty
      FROM walk GROUP BY plant_name, node_id, root_id
  ),
  material_demand AS (
    SELECT plant_name, node_id, SUM(qty) AS qty
      FROM node_demand GROUP BY plant_name, node_id
  ),
  inb AS (
    SELECT i.plant_name, i.supplier_id, i.material_id,
           public.rate_to_weekly(COALESCE(i.volume, 0), i.time_unit) AS wk
      FROM public.inbound_logistics i
     WHERE i.project_id = p_project_id
       AND COALESCE(btrim(i.supplier_id), '') <> ''
       AND COALESCE(btrim(i.material_id), '') <> ''
  ),
  inb_total AS (
    SELECT plant_name, material_id, SUM(wk) AS wk
      FROM inb GROUP BY plant_name, material_id
  ),
  deep AS (
    -- Outbound: the edge's upstream end is the finished product, and a finished
    -- product sits at BOM depth 0. That is a fact the tree states, not D134's
    -- substitution: NULL below means "this node is in no BOM", and a product is
    -- the root of one by definition.
    SELECT o.plant_name, 'outbound'::text AS data_source,
           o.product_id AS from_location, o.customer_id AS to_location,
           0::integer AS bom_depth, o.product_id AS path_root,
           o.wk AS rate,
           CASE WHEN dm.wk > 0 THEN o.wk / dm.wk ELSE 1.0 END AS sourcing_ratio,
           o.wk AS weighted
      FROM outb o
      JOIN demand dm ON dm.plant_name = o.plant_name AND dm.product_id = o.product_id
     WHERE COALESCE(btrim(o.customer_id), '') <> ''
    UNION ALL
    -- One row per BOM EDGE per ROOT PRODUCT, at the BOM's own depth.
    --
    -- `weighted` is THIS EDGE's contribution — the parent's demand for that root
    -- times this edge's rate — and not the child's total demand. The edge
    -- function wrote the child's total on every one of its parent edges, so a
    -- material used by two assemblies had its whole requirement counted twice.
    --
    -- LEFT JOIN, deliberately: a BOM subtree that reaches no finished product is
    -- still part of the tree this lane exists to draw. It arrives with a NULL
    -- `path_root` and a zero flow, which is what "we hold this structure and no
    -- demand reaches it" looks like — where an inner join would delete it and
    -- leave the Process page shorter than the CSV, with nothing to say why. It is
    -- also the only reading that does not regress a project holding a BOM and no
    -- outbound rows, which the RPC used to draw (flat, at level 2) and this would
    -- otherwise blank.
    SELECT e.plant_name, 'bom',
           e.child_id, e.parent_id,
           e.depth, nd.root_id,
           e.rate,
           1.0,
           COALESCE(nd.qty, 0) * e.rate
      FROM bom_edges e
      LEFT JOIN node_demand nd
        ON nd.plant_name = e.plant_name AND nd.node_id = e.parent_id
     WHERE e.parent_id IS NOT NULL
    UNION ALL
    -- Inbound: a supplier sits one step upstream of the material it feeds, so its
    -- depth is that material's depth PLUS ONE — from `node_bom_depth`, the one
    -- rule, and NULL when the material is in no BOM.
    --
    -- The RPC wrote `GREATEST(1, COALESCE(max_level, 0) + 1)`, whose two
    -- substitutions are the whole of the "two suppliers from one upload, four
    -- levels apart" §15 measured: a material absent from the BOM landed at 1,
    -- which the ladder calls a material, and one at depth 4 landed at 5.
    SELECT i.plant_name, 'inbound',
           i.supplier_id, i.material_id,
           nbd.bom_depth + 1,
           i.material_id,
           i.wk,
           CASE WHEN t.wk > 0 THEN i.wk / t.wk ELSE 1.0 END,
           COALESCE(md.qty, 0) * CASE WHEN t.wk > 0 THEN i.wk / t.wk ELSE 1.0 END
      FROM inb i
      JOIN inb_total t ON t.plant_name = i.plant_name AND t.material_id = i.material_id
      LEFT JOIN material_demand md
             ON md.plant_name = i.plant_name AND md.node_id = i.material_id
      LEFT JOIN public.node_bom_depths(p_project_id) nbd ON nbd.node_id = i.material_id
  )
  INSERT INTO public.supply_chain_data_multi_tier (
    project_id, plant_name, data_source, from_location, to_location,
    level, bom_depth, path_root, material_consumption_rate, sourcing_ratio, weighted,
    uploaded_by, organization)
  SELECT p_project_id, d.plant_name, d.data_source, d.from_location, d.to_location,
         -- `level` is the deprecated ALIAS: the same value, NULLs included.
         d.bom_depth, d.bom_depth, d.path_root, d.rate, d.sourcing_ratio, d.weighted,
         v_actor, v_org
    FROM deep d
   WHERE COALESCE(btrim(d.from_location), '') <> ''
     AND COALESCE(btrim(d.to_location), '')   <> '';

  GET DIAGNOSTICS v_mt = ROW_COUNT;

  RETURN jsonb_build_object(
    'project_id',        p_project_id,
    'actor',             v_actor,
    'supply_chain_data', v_scd,
    'multi_tier',        v_mt);
END; $function$

;

-- THE THIRD COST: A PLAN THAT DEPENDS ON STATISTICS THE LOAD HAS NOT YET UPDATED.
--
-- Right after a bulk load into a project the optimizer's statistics know nothing of it, so it
-- underestimates the project's rows and picks nested loops for the joins in the rebuild and the
-- node-list refresh. Measured on the project in `rehearsal/960` (100 products, 4 700 BOM rows),
-- the SAME rebuild took 6.7 s on a freshly loaded database and 1.5 s once `ANALYZE` had run,
-- and once 40 s on a database that had been rebuilt many times between analyses — which is the
-- state a person is in when they have just uploaded a big file. These functions are set-based
-- ETL over whole-project row sets: a hash join is right at every size they are called at, and a
-- nested loop is right at none of them. `enable_nestloop = off` for their duration (a function
-- setting, restored when each returns) took the fresh-database rebuild from 6.7 s to 2.1 s.
ALTER FUNCTION public.refresh_node_list_for_project(uuid, uuid) SET enable_nestloop TO 'off';

COMMENT ON FUNCTION public.node_bom_depths(uuid) IS
  'The BOM depth of EVERY node of one project, from a single grouped scan — the set-based '
  'twin of `node_bom_depth(project, node)`, which stays for single-node callers. Same four '
  'sources, same MIN. `node_list_attributes` and `rebuild_supply_chain_lanes` read this '
  'instead of calling the per-node function once per node (a scan of the whole BOM each '
  'time). `rehearsal/920` §1 holds the two equal for every node.';

COMMENT ON FUNCTION public.node_supply_tiers(uuid) IS
  'The supply tier of EVERY node of one project, from a single grouped scan — the set-based '
  'twin of `node_supply_tier(project, node)`. Same six sources, same MIN.';

-- Internal: called only by SECURITY DEFINER functions. This database's default privileges
-- grant EXECUTE on every new function to `anon` and `authenticated` as well as PUBLIC
-- (`20261027000003` closed the same gap for `node_list_attributes`), and both return any
-- project's nodes for a project id.
REVOKE ALL ON FUNCTION public.node_bom_depths(uuid)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.node_supply_tiers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.node_bom_depths(uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.node_supply_tiers(uuid) TO service_role;

SELECT pg_notify('pgrst', 'reload schema');
