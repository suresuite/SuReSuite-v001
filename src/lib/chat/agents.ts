import { ShieldAlert, FlaskConical, Package, Truck, MessageSquare, type LucideIcon } from "lucide-react";

/**
 * Chat PERSONAS — the five entries in the picker.
 *
 * These are not the routed agents. A persona is a system-prompt preamble and
 * nothing else: all five share one tool surface, one model and one prompt
 * body, and the only behavioural difference is a sentence like "Prefer the
 * risk and criticality tools first" (see the server mirror,
 * supabase/functions/project-ai-chat/agents.ts).
 *
 * The specialist agents — data-steward, policy-configurator, vv-analyst,
 * experiment-designer, report-builder, cost-estimator, network-cartographer,
 * disruption-sentinel — each have their own prompt, least-privilege tool
 * subset and proposal artifact, and are selected by the §6 router from what
 * the user asks, never from this picker. Nothing here maps onto them.
 */
export interface AgentSpec {
  id: string;
  name: string;
  blurb: string;
  icon: LucideIcon;
  color: string; // tailwind text color
  starter?: string;
  requiresProject?: boolean;
}

export const AGENTS: AgentSpec[] = [
  {
    id: "risk-analyst",
    name: "Risk Analyst",
    blurb: "Supplier & network risk, single-source exposure, criticality.",
    icon: ShieldAlert,
    color: "text-rose-500",
    requiresProject: true,
  },
  {
    id: "simulation-modeler",
    name: "Simulation Modeler",
    blurb: "What-ifs, mitigation studies, sensitivity sweeps, results, readiness and setup — ask \"what can you do?\"",
    icon: FlaskConical,
    color: "text-violet-500",
    requiresProject: true,
  },
  {
    id: "inventory-strategist",
    name: "Inventory Strategist",
    blurb: "Safety stock, MOQ, service level, and working capital trade-offs.",
    icon: Package,
    color: "text-amber-500",
    requiresProject: true,
  },
  {
    id: "logistics-planner",
    name: "Logistics Planner",
    blurb: "Lead times, routing, in-transit inventory, expediting.",
    icon: Truck,
    color: "text-sky-500",
    requiresProject: true,
  },
  {
    id: "general",
    name: "General Assistant",
    blurb: "Open-ended supply-chain conversation. No project required.",
    icon: MessageSquare,
    color: "text-emerald-500",
    requiresProject: false,
  },
];

export const DEFAULT_AGENT_ID = "general";

export function getAgent(id: string | null | undefined): AgentSpec {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[AGENTS.length - 1];
}
