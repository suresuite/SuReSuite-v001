# Demo readiness — projects named `Demo*`

3 project(s).
Latest engine build recorded: {'b': {'id': 'dd0b3c3f-52c8-4dc0-8668-fbaa95109ced', 'engine_id': '9650e024-3434-4d17-9f8c-6871e6ae1d0b', 'commit_sha': None, 'code_version': 'scsim-0.2.7', 'image_digest': None, 'last_seen_at': '2026-09-24T13:47:35.738609+00:00', 'scsim_digest': None, 'withdrawn_at': None, 'withdrawn_by': None, 'first_seen_at': '2026-09-24T13:47:35.738609+00:00', 'first_seen_by': 'backfill', 'withdrawn_reason': None, 'sim_worker_digest': None}}
Runs on the whole platform, last 14 days: [{'status': 'done', 'n': 30, 'last': '2026-11-12 15:38:55.360142+00'}]

## Demo — Control Unit Supply Network

- id `71d40a72-f350-44f0-a887-6087713a8df5` · model `Make-To-Order` · bom_level `multi` · plant `Stuttgart Plant` · modeler `superuser3+demo-owner@suresuite.com`
- simulation window: 2025-01-16 → 2027-01-14

| table | rows |
|---|---:|
| suppliers | 11 |
| materials | 10 |
| products | 1 |
| customers | 0 |
| demand_forecasts | 0 |
| bom_multi_level | 13 |
| bom_single_level | 0 |
| inbound_logistics | 11 |
| outbound_logistics | 2 |
| supply_chain_data | 23 |
| supply_chain_data_multi_tier | 26 |
| node_list | 27 |
| network_nodes | 41 |
| network_edges | 45 |
| policy_overrides | 13 |
| policy_versions | 3 |
| dataset_versions | 4 |
| scenarios | 4 |
| simulation_runs | 5 |
| model_validations | 2 |
| analysis_runs | 6 |
| policy_defaults | 1 |

**Fulfillment defaults (live):** `{}`
- policy v1 Baseline policies: fulfillment `{"price": 0, "allocation": "priority", "sourcing_firm": "", "primary_source": false, "tier_overrides": {}, "backorder_allowed": true, "max_backorder_days": 14, "service_level_beta": 0.98, "service_level_alpha": 0.95, "backorder_cost_per_day": 2, "lost_sales_cost_per_unit": 20, "order_batching_window_hours": 0}` · snapshot keys `defaults,overrides,schema_version,fulfillment_strategy`
- policy v3 Baseline — customer terms: fulfillment `{"price": 0, "allocation": "priority", "sourcing_firm": "", "primary_source": false, "tier_overrides": {}, "backorder_allowed": true, "max_backorder_days": 14, "service_level_beta": 0.98, "service_level_alpha": 0.95, "backorder_cost_per_day": 2, "lost_sales_cost_per_unit": 20, "order_batching_window_hours": 0}` · snapshot keys `defaults,overrides,schema_version,fulfillment_strategy`
- policy v4 Safety stock 28 days — customer terms: fulfillment `{"price": 0, "allocation": "priority", "sourcing_firm": "", "primary_source": false, "tier_overrides": {}, "backorder_allowed": true, "max_backorder_days": 14, "service_level_beta": 0.98, "service_level_alpha": 0.95, "backorder_cost_per_day": 2, "lost_sales_cost_per_unit": 20, "order_batching_window_hours": 0}` · snapshot keys `defaults,overrides,schema_version,fulfillment_strategy`

**Empty master cells (NULL count / rows)**

- materials (10 rows): no empty cells
- suppliers (11 rows): no empty cells
- products (1 rows): `production_lead_time` 1, `fg_policy` 1
- inbound_logistics (11 rows): no empty cells
- outbound_logistics (2 rows): no empty cells

**Runs by status:** done 5 (last 2026-11-12 15:38:55)

- run 2026-11-12 15:38:55 · Plant shutdown May 2026 (3 wk) · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 385711.9603, "fill_rate": 0.8841, "ttr_weeks": 7.2, "tts_weeks": 0.0, "max_backlog": 204.2731, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 18979.5522, "avg_on_hand_units": 12172.9818, "avg_on_hand_value": 15992.0382, "cost_of_resilience": 31034.0129, "lost_inbound_units": 0.0, "capacity_utilization": 0.8746, "products_capacity_bound": 1.0, "suppliers_capacity_bound": 9.0, "supplier_capacity_utilization": 0.2039}`
  - mapping warnings: `[{"field": "primary_source", "level": "info", "entity": "policy:sourcing", "reason": "10 material(s) are bought from the primary supplier saved on /policies; for 0 of them that is not the cheapest supplier the engine would otherwise pick"}, {"field": "production_capacity", "level": "info", "entity": "product:P-CONTROL", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "review_period_days", "level": "info", "entity": "policy:default", "reason": "review period 1 d → reviewed every 1 wk (the engine steps in whole weeks)"}, {"field": "order_up_to", "level": "info", "entity": "policy:inventory_control", "reason": "project-wide s/S are the formulas s = E[D]·T_s, S = E[D]·(T_s+κ); a supplier-grid row's absolute s/S IS that material's level, with no safety stock added on top"}, {"field": "customers.priority_weight", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): default 2"}, {"field": "materials.cost", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.initial_on_hand", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.moq", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "products.demand_cv", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.demand_mean", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.production_capacity", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.sell_price", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "suppliers.capacity_per_week", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "suppliers.reliability_score", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "inputs", "level": "info", "entity": "run", "reaso`

- run 2026-11-12 15:38:42 · Microcontroller outage May 2026 (10 wk) · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 385529.06, "fill_rate": 0.8841, "ttr_weeks": 13.9, "tts_weeks": 6.4, "max_backlog": 211.0929, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 19162.4526, "avg_on_hand_units": 12107.4098, "avg_on_hand_value": 15701.8561, "cost_of_resilience": 31269.8388, "lost_inbound_units": 0.0, "capacity_utilization": 0.8238, "products_capacity_bound": 1.0, "suppliers_capacity_bound": 9.0, "supplier_capacity_utilization": 0.2022}`
  - mapping warnings: `[{"field": "primary_source", "level": "info", "entity": "policy:sourcing", "reason": "10 material(s) are bought from the primary supplier saved on /policies; for 0 of them that is not the cheapest supplier the engine would otherwise pick"}, {"field": "production_capacity", "level": "info", "entity": "product:P-CONTROL", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "review_period_days", "level": "info", "entity": "policy:default", "reason": "review period 1 d → reviewed every 1 wk (the engine steps in whole weeks)"}, {"field": "order_up_to", "level": "info", "entity": "policy:inventory_control", "reason": "project-wide s/S are the formulas s = E[D]·T_s, S = E[D]·(T_s+κ); a supplier-grid row's absolute s/S IS that material's level, with no safety stock added on top"}, {"field": "customers.priority_weight", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): default 2"}, {"field": "materials.cost", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.initial_on_hand", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.moq", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "products.demand_cv", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.demand_mean", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.production_capacity", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.sell_price", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "suppliers.capacity_per_week", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "suppliers.reliability_score", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "inputs", "level": "info", "entity": "run", "reaso`

- run 2026-11-12 15:38:28 · Normal 2026 · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 404585.749, "fill_rate": 0.9997, "max_backlog": 0.0, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 105.7635, "avg_on_hand_units": 11826.9279, "avg_on_hand_value": 15395.0939, "cost_of_resilience": 642.4035, "lost_inbound_units": 0.0, "capacity_utilization": 0.8645, "products_capacity_bound": 0.7, "suppliers_capacity_bound": 9.0, "supplier_capacity_utilization": 0.2102}`
  - mapping warnings: `[{"field": "primary_source", "level": "info", "entity": "policy:sourcing", "reason": "10 material(s) are bought from the primary supplier saved on /policies; for 0 of them that is not the cheapest supplier the engine would otherwise pick"}, {"field": "production_capacity", "level": "info", "entity": "product:P-CONTROL", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "review_period_days", "level": "info", "entity": "policy:default", "reason": "review period 1 d → reviewed every 1 wk (the engine steps in whole weeks)"}, {"field": "order_up_to", "level": "info", "entity": "policy:inventory_control", "reason": "project-wide s/S are the formulas s = E[D]·T_s, S = E[D]·(T_s+κ); a supplier-grid row's absolute s/S IS that material's level, with no safety stock added on top"}, {"field": "customers.priority_weight", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): default 2"}, {"field": "materials.cost", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.initial_on_hand", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.moq", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "products.demand_cv", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.demand_mean", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.production_capacity", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.sell_price", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "suppliers.capacity_per_week", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "suppliers.reliability_score", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "inputs", "level": "info", "entity": "run", "reaso`

- run 2026-11-12 15:08:07 · Policy validation (auto) · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · evidence
  - kpis: `{"revenue": 404585.749, "fill_rate": 0.9997, "max_backlog": 0.0, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 105.7635, "avg_on_hand_units": 11826.9279, "avg_on_hand_value": 15395.0939, "cost_of_resilience": 642.4035, "lost_inbound_units": 0.0, "capacity_utilization": 0.8645, "products_capacity_bound": 0.7, "suppliers_capacity_bound": 9.0, "supplier_capacity_utilization": 0.2102}`
  - mapping warnings: `[{"field": "primary_source", "level": "info", "entity": "policy:sourcing", "reason": "10 material(s) are bought from the primary supplier saved on /policies; for 0 of them that is not the cheapest supplier the engine would otherwise pick"}, {"field": "production_capacity", "level": "info", "entity": "product:P-CONTROL", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "review_period_days", "level": "info", "entity": "policy:default", "reason": "review period 1 d → reviewed every 1 wk (the engine steps in whole weeks)"}, {"field": "order_up_to", "level": "info", "entity": "policy:inventory_control", "reason": "project-wide s/S are the formulas s = E[D]·T_s, S = E[D]·(T_s+κ); a supplier-grid row's absolute s/S IS that material's level, with no safety stock added on top"}, {"field": "customers.priority_weight", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): default 2"}, {"field": "materials.cost", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.initial_on_hand", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.moq", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "products.demand_cv", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.demand_mean", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.production_capacity", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.sell_price", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "suppliers.capacity_per_week", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "suppliers.reliability_score", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "inputs", "level": "info", "entity": "run", "reaso`

- run 2026-11-04 18:22:20 · Policy validation (auto) · Baseline policies · reps 10/10 · scsim-0.8.3+3a5c01d64236 · series stored · evidence
  - kpis: `{"revenue": 305675.9023, "fill_rate": 0.9994, "max_backlog": 1.9438, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 0.0, "avg_on_hand_units": 11759.3134, "avg_on_hand_value": 15486.2112, "cost_of_resilience": 443.8018, "lost_inbound_units": 0.0, "capacity_utilization": 0.8709, "products_capacity_bound": 0.6, "suppliers_capacity_bound": 9.0, "supplier_capacity_utilization": 0.2057}`
  - mapping warnings: `[{"field": "primary_source", "level": "info", "entity": "policy:sourcing", "reason": "10 material(s) are bought from the primary supplier saved on /policies; for 0 of them that is not the cheapest supplier the engine would otherwise pick"}, {"field": "production_capacity", "level": "info", "entity": "product:P-CONTROL", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "analysis_window", "level": "info", "entity": "scenario", "reason": "52 wk is outside the engine range [13, 39] wk → 39 wk used"}, {"field": "review_period_days", "level": "info", "entity": "policy:default", "reason": "review period 1 d → reviewed every 1 wk (the engine steps in whole weeks)"}, {"field": "order_up_to", "level": "info", "entity": "policy:inventory_control", "reason": "project-wide s/S are the formulas s = E[D]·T_s, S = E[D]·(T_s+κ); a supplier-grid row's absolute s/S IS that material's level, with no safety stock added on top"}, {"field": "customers.priority_weight", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): default 2"}, {"field": "materials.cost", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.initial_on_hand", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "materials.moq", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 10"}, {"field": "products.demand_cv", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.demand_mean", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.production_capacity", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "products.sell_price", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 1"}, {"field": "suppliers.capacity_per_week", "level": "info", "entity": "source", "reason": "value sources (override → item master → lanes → default): master 11"}, {"field": "suppliers.reliability_score", "level": "info", "entity": "source", "`

**Replication rows:** 50
**Item series rows:** 0

**Scenarios:** Policy validation (auto) (validation_baseline, 728 d, 10 reps, 0 events); Normal 2026 (experiment, 728 d, 10 reps, 0 events); Microcontroller outage May 2026 (10 wk) (experiment, 728 d, 10 reps, 1 events); Plant shutdown May 2026 (3 wk) (experiment, 728 d, 10 reps, 1 events)
**Policy versions:** v1 Baseline policies; v3 Baseline — customer terms; v4 Safety stock 28 days — customer terms
**Data versions:** v1 After combine 2026-11-04 17:07; v2 Dataset 2026-11-04 17:07; v3 After combine 2026-11-04 18:18; v4 Dataset 2026-11-04 18:18
**Validated Models:** 2026Q4 Baseline policies [revoked revoked]; 2026Q4-2 Validated model [active]
**Network analyses:** network_metrics succeeded ×1, process_structure succeeded ×2, product_metrics succeeded ×2, prominence succeeded ×1

**Gaps:** 
- products has empty production_lead_time, fg_policy

## Demo — Large Network (100 products, 1 000 suppliers)

- id `ec22cdcd-6570-4574-80ee-4757f0e994d8` · model `Make-To-Order` · bom_level `multi` · plant `Stuttgart Plant` · modeler `SuperUser3@suresuite.com`
- simulation window: None → None

| table | rows |
|---|---:|
| suppliers | 1000 |
| materials | 1800 |
| products | 100 |
| customers | 0 |
| demand_forecasts | 0 |
| bom_multi_level | 4868 |
| bom_single_level | 0 |
| inbound_logistics | 3054 |
| outbound_logistics | 192 |
| supply_chain_data | 6958 |
| supply_chain_data_multi_tier | 8114 |
| node_list | 3826 |
| network_nodes | 3101 |
| network_edges | 5207 |
| policy_overrides | 3054 |
| policy_versions | 0 |
| dataset_versions | 14 |
| scenarios | 0 |
| simulation_runs | 0 |
| model_validations | 0 |
| analysis_runs | 0 |
| policy_defaults | 1 |

**Fulfillment defaults (live):** `{}`

**Empty master cells (NULL count / rows)**

- materials (1800 rows): no empty cells
- suppliers (1000 rows): no empty cells
- products (100 rows): `production_lead_time` 100, `fg_policy` 100
- inbound_logistics (3054 rows): no empty cells
- outbound_logistics (192 rows): no empty cells

**Runs by status:** none

**Replication rows:** 0
**Item series rows:** 0

**Scenarios:** none
**Policy versions:** none
**Data versions:** v1 After upload 2026-11-05 20:39; v2 After upload 2026-11-05 20:47; v3 After upload 2026-11-05 20:47; v4 After upload 2026-11-05 20:47; v5 After upload 2026-11-06 12:39; v6 After upload 2026-11-06 12:40; v7 After upload 2026-11-06 12:40; v8 After upload 2026-11-06 12:40; v9 After upload 2026-11-06 12:40; v10 After upload 2026-11-06 12:41; v11 After upload 2026-11-06 12:42; v12 After upload 2026-11-06 12:42; v13 After upload 2026-11-06 12:42; v14 After upload 2026-11-06 12:43
**Validated Models:** none
**Network analyses:** none

**Gaps:** 
- products has empty production_lead_time, fg_policy
- no saved policy version — a run binds one
- no scenario — the Lab has nothing to run
- no simulation run — the Lab and /policies results are empty
- no Validated Model — Run & Validate baseline never ran; the Nexus battery needs one
- no network analysis run — centrality/criticality figures are empty

## Demo — Large Network (100 products, 500 suppliers)

- id `6c594fe2-1a50-4dbc-b730-0ac1f50a6d57` · model `Make-To-Order` · bom_level `multi` · plant `Stuttgart Plant` · modeler `SuperUser3@suresuite.com`
- simulation window: 2025-05-08 → 2027-05-06

| table | rows |
|---|---:|
| suppliers | 500 |
| materials | 1800 |
| products | 100 |
| customers | 0 |
| demand_forecasts | 0 |
| bom_multi_level | 4852 |
| bom_single_level | 0 |
| inbound_logistics | 3067 |
| outbound_logistics | 174 |
| supply_chain_data | 6915 |
| supply_chain_data_multi_tier | 8093 |
| node_list | 3319 |
| network_nodes | 1551 |
| network_edges | 2595 |
| policy_overrides | 174 |
| policy_versions | 2 |
| dataset_versions | 1 |
| scenarios | 3 |
| simulation_runs | 6 |
| model_validations | 0 |
| analysis_runs | 3 |
| policy_defaults | 1 |

**Fulfillment defaults (live):** `{}`
- policy v1 Baseline — customer terms: fulfillment `{"price": 0, "allocation": "priority", "sourcing_firm": "", "primary_source": false, "tier_overrides": {}, "backorder_allowed": true, "max_backorder_days": 14, "service_level_beta": 0.98, "service_level_alpha": 0.95, "backorder_cost_per_day": 2, "lost_sales_cost_per_unit": 20, "order_batching_window_hours": 0}` · snapshot keys `defaults,overrides,schema_version,fulfillment_strategy`
- policy v2 Safety stock 28 days — customer terms: fulfillment `{"price": 0, "allocation": "priority", "sourcing_firm": "", "primary_source": false, "tier_overrides": {}, "backorder_allowed": true, "max_backorder_days": 14, "service_level_beta": 0.98, "service_level_alpha": 0.95, "backorder_cost_per_day": 2, "lost_sales_cost_per_unit": 20, "order_batching_window_hours": 0}` · snapshot keys `defaults,overrides,schema_version,fulfillment_strategy`

**Empty master cells (NULL count / rows)**

- materials (1800 rows): no empty cells
- suppliers (500 rows): no empty cells
- products (100 rows): `production_lead_time` 100, `fg_policy` 100
- inbound_logistics (3067 rows): no empty cells
- outbound_logistics (174 rows): no empty cells

**Runs by status:** done 6 (last 2026-11-12 14:46:30)

- run 2026-11-12 14:46:30 · Plant shutdown May 2026 (3 wk) · Safety stock 28 days — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 418482603.0496, "fill_rate": 0.9124, "ttr_weeks": 6.0, "tts_weeks": 0.0, "max_backlog": 15477.5553, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 9400681.1049, "avg_on_hand_units": 10913546.0941, "avg_on_hand_value": 45078056.0481, "cost_of_resilience": 14271749.3565, "lost_inbound_units": 0.0, "capacity_utilization": 0.649, "products_capacity_bound": 100.0, "suppliers_capacity_bound": 417.6, "supplier_capacity_utilization": 0.3607}`
  - mapping warnings: `[{"field": "production_capacity", "level": "info", "entity": "product:P-001", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-002", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-003", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-004", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-005", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-006", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-007", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-008", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-009", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-010", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-011", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line c`

- run 2026-11-12 14:46:05 · Plant shutdown May 2026 (3 wk) · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 418270154.4326, "fill_rate": 0.8828, "ttr_weeks": 16.7, "tts_weeks": 0.0, "max_backlog": 15477.5553, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 9613129.7219, "avg_on_hand_units": 7110519.6643, "avg_on_hand_value": 29354589.5724, "cost_of_resilience": 11587019.4326, "lost_inbound_units": 0.0, "capacity_utilization": 0.6487, "products_capacity_bound": 100.0, "suppliers_capacity_bound": 418.1, "supplier_capacity_utilization": 0.3592}`
  - mapping warnings: `[{"field": "production_capacity", "level": "info", "entity": "product:P-001", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-002", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-003", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-004", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-005", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-006", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-007", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-008", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-009", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-010", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-011", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line c`

- run 2026-11-12 14:45:41 · Sensor supplier outage May 2026 (10 wk) · Safety stock 28 days — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 427146462.7232, "fill_rate": 0.9916, "ttr_weeks": 11.9, "tts_weeks": 7.4, "max_backlog": 1643.6353, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 736821.4313, "avg_on_hand_units": 10713613.8829, "avg_on_hand_value": 44251469.8714, "cost_of_resilience": 4922594.1543, "lost_inbound_units": 0.0, "capacity_utilization": 0.6242, "products_capacity_bound": 11.9, "suppliers_capacity_bound": 418.6, "supplier_capacity_utilization": 0.3687}`
  - mapping warnings: `[{"field": "production_capacity", "level": "info", "entity": "product:P-001", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-002", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-003", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-004", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-005", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-006", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-007", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-008", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-009", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-010", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-011", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line c`

- run 2026-11-12 14:45:26 · Sensor supplier outage May 2026 (10 wk) · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 423786663.1258, "fill_rate": 0.9752, "ttr_weeks": 15.3, "tts_weeks": 3.4, "max_backlog": 2712.6266, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 4096621.0287, "avg_on_hand_units": 7038273.6959, "avg_on_hand_value": 29104594.7401, "cost_of_resilience": 5331195.0219, "lost_inbound_units": 0.0, "capacity_utilization": 0.62, "products_capacity_bound": 19.0, "suppliers_capacity_bound": 418.9, "supplier_capacity_utilization": 0.3627}`
  - mapping warnings: `[{"field": "production_capacity", "level": "info", "entity": "product:P-001", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-002", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-003", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-004", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-005", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-006", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-007", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-008", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-009", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-010", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-011", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line c`

- run 2026-11-12 14:44:59 · Normal 2026 · Safety stock 28 days — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 427883284.1545, "fill_rate": 1.0, "max_backlog": 0.0, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 0.0, "avg_on_hand_units": 10706178.7226, "avg_on_hand_value": 44243960.791, "cost_of_resilience": 4111642.8, "lost_inbound_units": 0.0, "capacity_utilization": 0.6254, "products_capacity_bound": 0.0, "suppliers_capacity_bound": 418.4, "supplier_capacity_utilization": 0.3695}`
  - mapping warnings: `[{"field": "production_capacity", "level": "info", "entity": "product:P-001", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-002", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-003", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-004", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-005", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-006", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-007", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-008", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-009", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-010", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-011", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line c`

- run 2026-11-12 14:44:30 · Normal 2026 · Baseline — customer terms · reps 10/10 · scsim-0.8.3+a9b1181753c3 · series stored · standard
  - kpis: `{"revenue": 427883284.1545, "fill_rate": 1.0, "max_backlog": 0.0, "avg_fg_units": 0.0, "avg_fg_value": 0.0, "lost_sales_value": 0.0, "avg_on_hand_units": 6972804.8944, "avg_on_hand_value": 28860392.5757, "cost_of_resilience": 1027910.7, "lost_inbound_units": 0.0, "capacity_utilization": 0.6254, "products_capacity_bound": 0.0, "suppliers_capacity_bound": 418.0, "supplier_capacity_utilization": 0.3656}`
  - mapping warnings: `[{"field": "production_capacity", "level": "info", "entity": "product:P-001", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-002", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-003", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-004", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-005", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-006", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-007", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-008", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-009", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-010", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line capacity (units/day) — the line capacity entry is not applied"}, {"field": "production_capacity", "level": "info", "entity": "product:P-011", "reason": "production_capacity (units/week, the item master) shadows the plant grid's line c`

**Replication rows:** 60
**Item series rows:** 0

**Scenarios:** Normal 2026 (experiment, 728 d, 10 reps, 0 events); Sensor supplier outage May 2026 (10 wk) (experiment, 728 d, 10 reps, 1 events); Plant shutdown May 2026 (3 wk) (experiment, 728 d, 10 reps, 1 events)
**Policy versions:** v1 Baseline — customer terms; v2 Safety stock 28 days — customer terms
**Data versions:** v1 Dataset 2026-11-12 14:08
**Validated Models:** none
**Network analyses:** network_metrics running ×1, product_metrics running ×1, prominence succeeded ×1

**Gaps:** 
- products has empty production_lead_time, fg_policy
- no Validated Model — Run & Validate baseline never ran; the Nexus battery needs one

### Inventory — Demo — Control Unit Supply Network

**Validated Models**
- `a8b723e3` 2026Q4 "Baseline policies" [revoked revoked] policy `04cc6ce9` data `d2640b96` evidence-run `3e2e544b` warm-up 35 d horizon None · 2026-11-04 18:23:26.84829+00
- `ae94dd74` 2026Q4-2 "Validated model" [active] policy `bb1e9ac6` data `d2640b96` evidence-run `1316acd5` warm-up 350 d horizon None · 2026-11-12 15:16:14.375048+00

**Scenarios** (runs cascade with their scenario)
- `1f92fe7c` Policy validation (auto) · validation_baseline · 728 d · 2 runs · evidence for 2 model(s) · 2026-11-04 18:22
- `c8f7ee49` Normal 2026 · experiment · 728 d · 1 runs · evidence for 0 model(s) · 2026-11-12 15:38
- `6ce9a513` Microcontroller outage May 2026 (10 wk) · experiment · 728 d · 1 runs · evidence for 0 model(s) · 2026-11-12 15:38
- `c121cdc8` Plant shutdown May 2026 (3 wk) · experiment · 728 d · 1 runs · evidence for 0 model(s) · 2026-11-12 15:38

**Policy versions**
- `04cc6ce9` v1 Baseline policies · 1 runs · 1 model(s) · 2026-11-04 18:11
- `bb1e9ac6` v3 Baseline — customer terms · 4 runs · 1 model(s) · 2026-11-12 14:09
- `876315e9` v4 Safety stock 28 days — customer terms · 0 runs · 0 model(s) · 2026-11-12 14:09

**Data versions**
- `76414864` v1 After combine 2026-11-04 17:07 · 0 runs · 0 model(s) · 2026-11-04 17:07
- `e8ba1c19` v2 Dataset 2026-11-04 17:07 · 0 runs · 0 model(s) · 2026-11-04 17:07
- `54a1c964` v3 After combine 2026-11-04 18:18 · 0 runs · 0 model(s) · 2026-11-04 18:18
- `d2640b96` v4 Dataset 2026-11-04 18:18 · 5 runs · 2 model(s) · 2026-11-04 18:18

**Runs**
- `3e2e544b` Policy validation (auto) · Baseline policies · done · model `-` · 2026-11-04 18:22
- `1316acd5` Policy validation (auto) · Baseline — customer terms · done · model `-` · 2026-11-12 15:08
- `4f2aaf8e` Normal 2026 · Baseline — customer terms · done · model `ae94dd74` · 2026-11-12 15:38
- `c39b7e7a` Microcontroller outage May 2026 (10 wk) · Baseline — customer terms · done · model `ae94dd74` · 2026-11-12 15:38
- `d853f46c` Plant shutdown May 2026 (3 wk) · Baseline — customer terms · done · model `ae94dd74` · 2026-11-12 15:38

**Analyses still `running`:** 0

_snapshots of Demo — Control Unit Supply Network exported to `snapshots/demo-control-unit-supply-network`_

### Inventory — Demo — Large Network (100 products, 1 000 suppliers)

**Validated Models**

**Scenarios** (runs cascade with their scenario)

**Policy versions**

**Data versions**
- `170c274e` v1 After upload 2026-11-05 20:39 · 0 runs · 0 model(s) · 2026-11-05 20:39
- `9aa41de8` v2 After upload 2026-11-05 20:47 · 0 runs · 0 model(s) · 2026-11-05 20:47
- `5a724eeb` v3 After upload 2026-11-05 20:47 · 0 runs · 0 model(s) · 2026-11-05 20:47
- `08a577a3` v4 After upload 2026-11-05 20:47 · 0 runs · 0 model(s) · 2026-11-05 20:47
- `e912ebc8` v5 After upload 2026-11-06 12:39 · 0 runs · 0 model(s) · 2026-11-06 12:39
- `a72c6464` v6 After upload 2026-11-06 12:40 · 0 runs · 0 model(s) · 2026-11-06 12:40
- `9a251977` v7 After upload 2026-11-06 12:40 · 0 runs · 0 model(s) · 2026-11-06 12:40
- `484f99f0` v8 After upload 2026-11-06 12:40 · 0 runs · 0 model(s) · 2026-11-06 12:40
- `e7ec557e` v9 After upload 2026-11-06 12:40 · 0 runs · 0 model(s) · 2026-11-06 12:40
- `22a85006` v10 After upload 2026-11-06 12:41 · 0 runs · 0 model(s) · 2026-11-06 12:41
- `7af2b97e` v11 After upload 2026-11-06 12:42 · 0 runs · 0 model(s) · 2026-11-06 12:42
- `d8baa962` v12 After upload 2026-11-06 12:42 · 0 runs · 0 model(s) · 2026-11-06 12:42
- `32ab66f8` v13 After upload 2026-11-06 12:42 · 0 runs · 0 model(s) · 2026-11-06 12:42
- `5ceebcdb` v14 After upload 2026-11-06 12:43 · 0 runs · 0 model(s) · 2026-11-06 12:43

**Runs**

**Analyses still `running`:** 0

_snapshots of Demo — Large Network (100 products, 1 000 suppliers) exported to `snapshots/demo-large-network-100-products-1-000-su`_

### Inventory — Demo — Large Network (100 products, 500 suppliers)

**Validated Models**

**Scenarios** (runs cascade with their scenario)
- `b67e364a` Normal 2026 · experiment · 728 d · 2 runs · evidence for 0 model(s) · 2026-11-12 14:44
- `dd70c0bf` Sensor supplier outage May 2026 (10 wk) · experiment · 728 d · 2 runs · evidence for 0 model(s) · 2026-11-12 14:44
- `94753008` Plant shutdown May 2026 (3 wk) · experiment · 728 d · 2 runs · evidence for 0 model(s) · 2026-11-12 14:44

**Policy versions**
- `69c45903` v1 Baseline — customer terms · 3 runs · 0 model(s) · 2026-11-12 14:11
- `26759c3c` v2 Safety stock 28 days — customer terms · 3 runs · 0 model(s) · 2026-11-12 14:11

**Data versions**
- `7fe46c6b` v1 Dataset 2026-11-12 14:08 · 6 runs · 0 model(s) · 2026-11-12 14:08

**Runs**
- `cb5a7ad5` Normal 2026 · Baseline — customer terms · done · model `-` · 2026-11-12 14:44
- `9c8eb46d` Normal 2026 · Safety stock 28 days — customer terms · done · model `-` · 2026-11-12 14:44
- `de0974fb` Sensor supplier outage May 2026 (10 wk) · Baseline — customer terms · done · model `-` · 2026-11-12 14:45
- `3076e179` Sensor supplier outage May 2026 (10 wk) · Safety stock 28 days — customer terms · done · model `-` · 2026-11-12 14:45
- `add787a0` Plant shutdown May 2026 (3 wk) · Baseline — customer terms · done · model `-` · 2026-11-12 14:46
- `dae78d50` Plant shutdown May 2026 (3 wk) · Safety stock 28 days — customer terms · done · model `-` · 2026-11-12 14:46

**Analyses still `running`:** 2

_snapshots of Demo — Large Network (100 products, 500 suppliers) exported to `snapshots/demo-large-network-100-products-500-supp`_
