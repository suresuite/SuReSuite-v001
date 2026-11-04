// @ts-nocheck — RPC return shape not in generated types.
import { readAllPages } from "@/lib/pagedRead";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { ProjectContext } from "@/lib/policies/resolvePreset";
import type { FulfillmentStrategy } from "@/lib/policies/schemas";

interface Args {
  projectId: string | null | undefined;
  fulfillmentStrategy: FulfillmentStrategy;
}

/**
 * Build ProjectContext from the same multi-tier table the network pages use.
 * - Suppliers   = distinct from_location where data_source='inbound'
 * - Customers   = distinct to_location   where data_source='outbound'
 * - Focal plant = `plant_name` carried on the rows (one per project)
 * Lead-time / demand stats are not stored on these rows, so they're left
 * undefined and the presets fall back to their internal defaults.
 */
export function useProjectContext({ projectId, fulfillmentStrategy }: Args) {
  const { user } = useAuth();
  const [ctx, setCtx] = useState<ProjectContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasData, setHasData] = useState<boolean>(true);

  useEffect(() => {
    if (!projectId || !user) {
      setCtx(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // page through the RPC (same one InteractiveNetworkSpace uses)
        const sb = supabase as any;
        // hard cap so a huge project doesn't lock the UI; pages are read several at a time
        const { rows: all, error } = await readAllPages<{
          from_location: string;
          to_location: string;
          data_source: string;
          level: number;
          plant_name: string;
        }>(
          async (offset, limit) =>
            await sb.rpc("get_supply_chain_data_multi_tier", {
              p_project_id: projectId,
              p_user_id: user.id,
              p_user_email: user.email,
              p_limit: limit,
              p_offset: offset,
            }),
          { maxPages: 20 },
        );
        if (error) throw error;

        if (cancelled) return;

        const suppliers = new Set<string>();
        const customers = new Set<string>();
        const supplierVol = new Map<string, number>();
        const customerVol = new Map<string, number>();
        let plant = "";

        for (const r of all) {
          if (!plant && r.plant_name) plant = r.plant_name;
          if (r.data_source === "inbound" && r.from_location) {
            suppliers.add(r.from_location);
            supplierVol.set(
              r.from_location,
              (supplierVol.get(r.from_location) ?? 0) + 1,
            );
          }
          if (r.data_source === "outbound" && r.to_location) {
            customers.add(r.to_location);
            customerVol.set(
              r.to_location,
              (customerVol.get(r.to_location) ?? 0) + 1,
            );
          }
        }

        const topSupplier = [...supplierVol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const topCustomer = [...customerVol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

        setHasData(all.length > 0);
        setCtx({
          project_id: projectId,
          plant_name: plant || "",
          supply_chain_model: "",
          bom_level: "",
          supplier_count: suppliers.size,
          plant_count: plant ? 1 : 0,
          customer_count: customers.size,
          top_supplier: topSupplier,
          top_customer: topCustomer,
          fulfillment_strategy: fulfillmentStrategy,
        });
      } catch (err) {
        console.warn("[useProjectContext] failed:", err);
        if (!cancelled) {
          setHasData(false);
          setCtx({
            project_id: projectId,
            plant_name: "",
            supply_chain_model: "",
            bom_level: "",
            supplier_count: 0,
            plant_count: 0,
            customer_count: 0,
            fulfillment_strategy: fulfillmentStrategy,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, fulfillmentStrategy, user]);

  return { ctx, loading, hasData };
}
