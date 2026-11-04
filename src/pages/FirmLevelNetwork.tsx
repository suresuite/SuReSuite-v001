// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { listProjectsCached } from '@/lib/projects/projectsCache';
import { Suspense, useEffect, useState, useMemo, useRef } from 'react';
import { lazyChunk } from '@/lib/lazyChunk';
import { Node, Edge } from '@xyflow/react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useGlobalProject } from '@/hooks/useGlobalProject';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  RefreshCw,
  Network,
  BarChart,
  RotateCcw,
  AlertTriangle,
  Map,
} from 'lucide-react';
import {
  PageLayout,
  PageHeader,
  HeaderRefreshButton,
  PAGE_GUTTER,
  PAGE_GUTTER_SKIN,
  HDR_ICON_BUTTON,
  HDR_ICON_BUTTON_ON,
  HDR_OUTLINE_BUTTON,
  HDR_PROJECT_SELECT,
} from '@/components/shared';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';
import MLPrediction from '@/components/MLPrediction';
import { NetworkDisruptionDialog } from '@/components/network/NetworkDisruptionDialog';
// mapbox-gl and its CSS are ~200 kB gzipped and only reachable from here and
// /network/product-level — and then only once the user switches to map view.
// Lazy keeps it out of this page's chunk entirely for anyone who never does.
const MapView = lazyChunk(() => import('@/components/MapView'));
import { FROZEN_CELL } from '@/components/shared';
import { MobileGroup, MobilePageHeader, ProjectChip } from '@/components/mobile';
import { RiskDataNotice } from '@/components/network/RiskDataNotice';
import { GraphVersionChip, type MetricsOutcome } from '@/components/trust/GraphVersionChip';
import { analyzerOutcome, storedMetricsDecision, type StoredDecision } from '@/lib/network/storedMetrics';
import {
  LensChip,
  LensHowToRead,
  LensDesktopOnlyNote,
  LensStructure,
  LensRisk,
  LensTable,
  LensAction,
  LensSection,
} from '@/components/network/MobileLens';
import { formatMoneyCompact } from '@/lib/sim/money';
import { GRAPH_INK } from '@/lib/graph';
import {
  GraphCard,
  LensSearch,
  LensSummary,
  LensDetails,
  LensAnalyticsHeader,
  LensCard,
  BarRows,
  LENS,
  useLensGraph,
  styleFirmEdge,
  type GraphCardHandle,
} from '@/components/network/lens';


const TIER_ORDER = ['Tier 1', 'Tier 2', 'Tier 3', 'Plant'] as const;
type TierKey = typeof TIER_ORDER[number];

const TIER_COLORS: Record<TierKey, string> = {
  'Tier 1': '#22c55e',    // Green
  'Tier 2': '#facc15',    // Yellow
  'Tier 3': '#3b82f6',    // Blue
  'Plant': '#8b5cf6',     // Purple
};

const TIER_LABELS: Record<TierKey, string> = {
  'Tier 1': 'Tier 1 Suppliers',
  'Tier 2': 'Tier 2 Suppliers', 
  'Tier 3': 'Tier 3 Suppliers',
  'Plant': 'Manufacturing Plant',
};

interface NetworkNode {
  id: string;
  project_id: string;
  plant_name: string;
  uid: string;
  depth: number | null;
  name: string | null;
  country: string | null;
  industry: string | null;
  website: string | null;
  traded_as: string | null;
  number_of_employees: number | null;
  revenue: number | null;
  lat: number | null;
  long: number | null;
  is_seed: boolean | null;
  prominence: number | null;
  prominence_updated_at: string | null;
  // WP 10.1 · the stored prominence's provenance, from `get_network_nodes` (T1/T2).
  metrics_source?: 'store' | 'column' | 'none' | null;
  metrics_run_id?: string | null;
  metrics_computed_at?: string | null;
  hash_is_current?: boolean | null;
}

interface NetworkEdge {
  id: string;
  project_id: string;
  plant_name: string;
  src_uid: string;
  dst_uid: string;
  relation_type: string | null;
  relative_revenue: number | null;
  relative_revenue_percentage: number | null;
  depth: number | null;
  direction: string | null;
}

// NetworkSummary interface removed - no longer needed

interface NodeData extends Record<string, unknown> {
  label: string;
  type: 'location';
  tier?: TierKey;
  group?: 'A' | 'B' | 'C' | 'D';
  incoming: number;
  outgoing: number;
  incomingFlow: number;
  outgoingFlow: number;
  revenue: number;
  country: string;
  industry: string;
  /** Stored prominence, or the local fallback when none is stored (see calculateNodeImportance). */
  prominence?: number;
}

interface FirmRevenueDatum {
  firm: string;
  revenue: number;
}

interface FirmConnectionDatum {
  firm: string;
  connections: number;
}

interface FirmLevelNetworkProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

function getTierFromDepth(depth: number | null, isPlant: boolean = false): TierKey {
  if (isPlant) return 'Plant';
  if (depth === null || depth === 0) return 'Plant';
  if (depth === 1) return 'Tier 1';
  if (depth === 2) return 'Tier 2';
  return 'Tier 3';
}

/** The firm lens's focus, unchanged: the firm and its direct neighbours (handoff §8). */
function firmFocusSet(id: string, _nodes: Node<NodeData>[], edges: Edge[]): Set<string> {
  const included = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id || e.target === id) {
      included.add(e.source);
      included.add(e.target);
    }
  }
  return included;
}

/** Legend order, which is the shell order from the centre out (handoff §2.1). */
const LEGEND_TIERS: TierKey[] = ['Plant', 'Tier 1', 'Tier 2', 'Tier 3'];

export default function FirmLevelNetwork({ isCollapsed, setIsCollapsed }: FirmLevelNetworkProps) {
  const { user, demo } = useAuth();
  const isMobile = useIsMobile();
  const { globalSelectedProjectId, setGlobalSelectedProjectId } = useGlobalProject();
  const graphRef = useRef<GraphCardHandle>(null);
  // Bumped after every load, so the card refits the graph it has just been handed.
  const [loadNonce, setLoadNonce] = useState(0);
  // The shell layout as computed, so Reset layout can discard dragged positions.
  const shellPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  // Selection, focus, search and drags — shared with the other two lenses. Search
  // matches a firm's NAME exactly, which is what the user reads (handoff §9).
  const lens = useLensGraph<Node<NodeData>>({
    focusSet: firmFocusSet,
    searchLabel: (n) => n.data.label,
    styleEdge: styleFirmEdge,
  });
  const { allNodes, allEdges, setAllNodes, setAllEdges, selectedNode, focusedId: focusedNode, setFocusedId: setFocusedNode } = lens;
  const [loading, setLoading] = useState(false);
  const [tierCounts, setTierCounts] = useState<Record<TierKey, number>>({ 'Tier 1': 0, 'Tier 2': 0, 'Tier 3': 0, 'Plant': 0 });
  const [projects, setProjects] = useState<any[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [firmRevenues, setFirmRevenues] = useState<FirmRevenueDatum[]>([]);
  const [firmConnections, setFirmConnections] = useState<FirmConnectionDatum[]>([]);
  const [disruptionDialogOpen, setDisruptionDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'network' | 'map'>('network');
  const [countryRiskMap, setCountryRiskMap] = useState<Record<string, string>>({});
  // D4: `risk_data` gained its migration in WP 1.4, so the read now succeeds
  // against a real table — but an EMPTY one until an operator loads a vintage.
  // The page used to warn to the console and render an unshaded graph as if
  // nothing were missing; it says so on screen instead (RiskDataNotice).
  const [riskDataError, setRiskDataError] = useState<string | null>(null);
  // networkSummary state removed - no longer needed
  const [networkNodes, setNetworkNodes] = useState<NetworkNode[]>([]);
  const [networkEdges, setNetworkEdges] = useState<NetworkEdge[]>([]);
  const [storedDecision, setStoredDecision] = useState<StoredDecision | null>(null);
  const [metricsProjectId, setMetricsProjectId] = useState<string | null>(null);
  const [metricsReadError, setMetricsReadError] = useState(false);
  const [metricsOutcome, setMetricsOutcome] = useState<MetricsOutcome>(null);
  const [prominenceStats, setProminenceStats] = useState<{
    count: number;
    min: number;
    max: number;
    average: number;
    distribution: { low: number; medium: number; high: number };
  } | null>(null);
  const [recalculatingProminence, setRecalculatingProminence] = useState(false);

  // Function to recalculate prominence using edge function
  const recalculateProminence = async () => {
    if (demo) return; // the demo shows what the seed stored; it computes nothing
    if (!user || !globalSelectedProjectId) {
      toast.error('No project selected');
      return;
    }

    setRecalculatingProminence(true);
    
    try {
      console.log('🔄 Recalculating prominence for project:', globalSelectedProjectId);
      
      // WP 4.3 · the analyzer writes tier 3 through an RPC that takes the
      // actor, so the actor travels with the request (invariant audit-actor).
      const { data, error } = await supabase.functions.invoke('calculate-node-prominence', {
        body: { project_id: globalSelectedProjectId, uploaded_by: user?.id }
      });

      if (error) throw error;

      // WP 10.1 · §4 D239 — a cache hit is a no-op that SAYS so. The store returns
      // the stored answer when the firm level has not moved, with no statistics
      // (nothing was computed); the page re-reads the stored figures either way and
      // derives its statistics from them, which is the one source both paths share.
      const outcome = analyzerOutcome(data);
      setMetricsOutcome(outcome);
      toast.success(outcome === 'reused'
        ? 'Prominence reused — this graph was already computed, nothing recalculated'
        : `Recalculated prominence for ${data?.updated_count ?? 0} nodes`);

      // Refresh the network data to get the stored prominence values
      await fetchData();
      
    } catch (error: any) {
      console.error('❌ Error recalculating prominence:', error);
      toast.error(`Failed to recalculate prominence: ${error.message}`);
    } finally {
      setRecalculatingProminence(false);
    }
  };

  const fetchProjects = async () => {
    if (!user) return;
    
    try {
      setProjects(await listProjectsCached(user));
    } catch (e) {
      console.error('Failed to fetch projects:', e);
      toast.error('Failed to load projects');
    }
  };
  
  // // At the top of fetchData, store the fetched nodes in a local variable
  // const fetchedNodes = networkNodes as unknown as NetworkNode[];
  // setNetworkNodes(fetchedNodes); // still update state for other uses


  const fetchData = async () => {
    console.log('🔍 FirmLevel fetchData called with:', { 
      hasUser: !!user, 
      selectedProject: globalSelectedProjectId
    });

    if (!user || !globalSelectedProjectId) {
      console.log('❌ Clearing data - no user or project');
      setAllNodes([]);
      setAllEdges([]);
      setTierCounts({ 'Tier 1': 0, 'Tier 2': 0, 'Tier 3': 0, 'Plant': 0 });
      lens.reset();
      setFirmRevenues([]);
      setFirmConnections([]);
      // networkSummary state reset removed - no longer needed
      return;
    }

    setLoading(true);
    lens.reset();
    
    try {
      const [
              { data: rawNodes, error: nodesError },
              { data: rawEdges, error: edgesError },
              { data: riskData, error: riskError }
            ] = await Promise.all([
              supabase.rpc('get_network_nodes', {
                p_project_id: globalSelectedProjectId,
                p_user_id: user.id,
                p_user_email: user.email,
                p_plant_name: null
              }),
              supabase.rpc('get_network_edges', {
                p_project_id: globalSelectedProjectId,
                p_user_id: user.id,
                p_user_email: user.email,
                p_plant_name: null
              }),
              supabase.from('risk_data').select('country, risk_class')
            ]);

            if (nodesError) throw nodesError;
            if (edgesError) throw edgesError;
            
            // We don't throw the riskError to avoid crashing the whole graph if
            // just the risk table fails — but D4: not crashing is not the same
            // as not telling the user. An empty risk map renders every node's
            // risk as "Unknown", which reads as an answer rather than as a
            // missing source, so the failure is surfaced (RiskDataNotice).
            if (riskError) {
              console.warn('⚠️ Could not load risk data:', riskError);
              setRiskDataError(riskError.message ?? String(riskError));
              setCountryRiskMap({});
            } else if (riskData) {
              const riskMap: Record<string, string> = {};
              riskData.forEach(row => {
                // WP 1.4 gave the table a migration and snake_case columns. The
                // `upper(btrim(country))` CHECK means the stored spelling already
                // matches this lookup; normalizing again is belt and braces, not
                // a second opinion about what a country name is.
                if (row.country) {
                  riskMap[row.country.trim().toUpperCase()] = row.risk_class;
                }
              });
              setRiskDataError(Object.keys(riskMap).length === 0 ? 'The risk_data table returned no rows.' : null);
              setCountryRiskMap(riskMap);
            } else {
              setRiskDataError('The risk_data table returned no rows.');
              setCountryRiskMap({});
            }

            // ✅ Local variables — no stale state, no re-render loop
            const fetchedNodes = (rawNodes || []) as unknown as NetworkNode[];
            const fetchedEdges = (rawEdges || []) as unknown as NetworkEdge[];

            // ✅ Update state for UI use elsewhere (sidebar, banner, etc.)
            setNetworkNodes(fetchedNodes);
            setNetworkEdges(fetchedEdges);

            // WP 10.1 · §4 D239 — `get_network_nodes` returns the STORED prominence
            // and where it came from. It never returned prominence at all, so the
            // local approximation below stood in for EVERY node as if it were the
            // stored figure. Now it stands in only when nothing is stored, and the
            // page says it is an approximation (T1).
            const decision = storedMetricsDecision(fetchedNodes);
            setStoredDecision(decision);
            if (decision.state === 'current') {
              setMetricsOutcome((outcome) => outcome === 'in progress' ? 'reused' : outcome);
            }
            setMetricsProjectId(globalSelectedProjectId);
            setMetricsReadError(false);
            const useApproximation = decision.state === 'missing';

      // ✅ calculateNodeImportance uses fetchedNodes and fetchedEdges directly
      const calculateNodeImportance = (data: NodeData, nodeId: string) => {
        const nodeData = fetchedNodes.find((n) => n.uid === nodeId);
        let prominence: number;

        if (typeof nodeData?.prominence === 'number' && !Number.isNaN(nodeData.prominence)) {
          prominence = nodeData.prominence;
        } else if (!useApproximation) {
          // A stored run exists and did not score this node: NOT computed, said as
          // the smallest node rather than invented as a mid-sized one.
          prominence = 0;
        } else {
          // In the else branch (no stored prominence):
          const totalConnections    = data.incoming + data.outgoing;
          const connectionWeight    = Math.min(totalConnections / 20, 1.0);
          const connections = fetchedEdges.filter((e): e is NetworkEdge =>
            e.src_uid === nodeId || e.dst_uid === nodeId
          );
          const revenueWeight       = data.revenue > 0
            ? Math.min(Math.log(data.revenue) / Math.log(1000000), 1.0) : 0;
          const balanceWeight       = totalConnections > 0
            ? 1 - Math.abs(data.incoming - data.outgoing) / totalConnections : 0;
          const uniquePartners = new Set(
            connections.map((conn: NetworkEdge) => 
              conn.src_uid === nodeId ? conn.dst_uid : conn.src_uid
            )
          );
          const betweennessApprox   = Math.min(uniquePartners.size / 15, 1.0);

          // Eigenvector + closeness not computable without full graph here
          // — these will be 0 in fallback; stored prominence from DB is preferred
          const eigenvectorWeight   = 0;
          const closenessWeight     = 0;

          prominence = Math.min(Math.max(
            connectionWeight  * 0.60 +  // was 0.30
            revenueWeight     * 0.05 +  // was 0.25
            balanceWeight     * 0.05 +  // was 0.20
            betweennessApprox * 0.10 +  // was 0.25
            eigenvectorWeight * 0.10 +
            closenessWeight   * 0.10,
          0), 1);
        }

        return {
          prominence,
          size: 12 + (prominence * 16),
          opacity: 0.75 + (prominence * 0.25),
          glowIntensity: prominence * 0.8,
        };
      };


      // Calculate prominence statistics from stored values
      const prominenceValues = fetchedNodes
        .filter(n => typeof n.prominence === 'number' && !Number.isNaN(n.prominence))
        .map(n => n.prominence!);
        
      // if (prominenceValues.length > 0) {
      //   const prominenceStats = {
      //     count: prominenceValues.length,
      //     min: Math.min(...prominenceValues),
      //     max: Math.max(...prominenceValues),
      //     average: prominenceValues.reduce((a, b) => a + b, 0) / prominenceValues.length,
      //     distribution: {
      //       low: prominenceValues.filter(p => p < 0.3).length,
      //       medium: prominenceValues.filter(p => p >= 0.3 && p < 0.7).length,
      //       high: prominenceValues.filter(p => p >= 0.7).length,
      //     }
      //   };
      //   setProminenceStats(prominenceStats);
        
      //   console.log('📈 Prominence stats:', {
      //     ...prominenceStats,
      //     hasStoredValues: prominenceValues.length,
      //     totalNodes: (networkNodes as unknown as NetworkNode[]).length
      //   });
      // } else {
      //   console.log('⚠️ No stored prominence values found — auto-calculating...');
      //   // Auto-calculate instead of showing the banner
      //   // await recalculateProminence();
      // }



      // Process firm revenues
      const revenueData: FirmRevenueDatum[] = fetchedNodes
        .filter(n => n.revenue != null && n.revenue > 0)
        .map(n => ({
          firm: n.name || n.uid,
          revenue: n.revenue || 0
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 20);

      setFirmRevenues(revenueData);

      // Process firm connections
      const connectionCounts: { [key: string]: number } = {};
      fetchedEdges.forEach(edge => {
        connectionCounts[edge.src_uid] = (connectionCounts[edge.src_uid] || 0) + 1;
        connectionCounts[edge.dst_uid] = (connectionCounts[edge.dst_uid] || 0) + 1;
      });

      const connectionData: FirmConnectionDatum[] = (networkNodes as unknown as NetworkNode[])
        .map(n => ({
          firm: n.name || n.uid,
          connections: connectionCounts[n.uid] || 0
        }))
        .sort((a, b) => b.connections - a.connections)
        .slice(0, 20);

      setFirmConnections(connectionData);

      // Build node map
      const nodeMap: { [key: string]: NodeData } = {};
      const edgeMap: { [key: string]: Edge } = {};

      fetchedNodes.forEach((n: NetworkNode) => {
        const isPlant = n.is_seed === true;
        const tier = getTierFromDepth(n.depth, isPlant);
        
        nodeMap[n.uid] = {
          label: n.name || n.uid,
          type: 'location',
          tier,
          group: tier === 'Plant' ? 'C' : 'A', // Map tiers to groups for MapView compatibility
          incoming: 0,
          outgoing: 0,
          incomingFlow: 0,
          outgoingFlow: 0,
          revenue: n.revenue || 0,
          country: n.country || 'Unknown',
          industry: n.industry || 'Unknown',
        };
      });

      // Process edges
      fetchedEdges.forEach((e: NetworkEdge) => {
        if (nodeMap[e.src_uid] && nodeMap[e.dst_uid]) {
          const flowValue = e.relative_revenue || 1;
          nodeMap[e.src_uid].outgoing++;
          nodeMap[e.src_uid].outgoingFlow += flowValue;
          nodeMap[e.dst_uid].incoming++;
          nodeMap[e.dst_uid].incomingFlow += flowValue;

          const edgeKey = `${e.src_uid}-${e.dst_uid}`;
          edgeMap[edgeKey] = {
            id: edgeKey,
            source: e.src_uid,
            target: e.dst_uid,
            // Stroke and width come from `styleFirmEdge` — centre to centre, no arrowhead.
            type: 'straight',
            data: { 
              weight: e.relative_revenue || 1,
              relationType: e.relation_type 
            },
          };
        }
      });

      const activeProminenceValues = fetchedNodes.map(n => {
        const data = nodeMap[n.uid];
        if (!data) return 0;
        // This will use the DB number if valid, or calculate it locally if missing/NaN!
        return calculateNodeImportance(data, n.uid).prominence;
      });

      if (activeProminenceValues.length > 0) {
        setProminenceStats({
          count: activeProminenceValues.length,
          min: Math.min(...activeProminenceValues),
          max: Math.max(...activeProminenceValues),
          average: activeProminenceValues.reduce((a, b) => a + b, 0) / activeProminenceValues.length,
          distribution: {
            low: activeProminenceValues.filter(p => p < 0.3).length,
            medium: activeProminenceValues.filter(p => p >= 0.3 && p < 0.7).length,
            high: activeProminenceValues.filter(p => p >= 0.7).length,
          }
        });
      }

      // Group by tiers
      const grouped: Record<TierKey, string[]> = { 'Tier 1': [], 'Tier 2': [], 'Tier 3': [], 'Plant': [] };
      for (const [id, node] of Object.entries(nodeMap)) {
        grouped[node.tier || 'Tier 1'].push(id);
      }
      
      console.log('📊 Firm tier groups:', {
        tier1: grouped['Tier 1'].length,
        tier2: grouped['Tier 2'].length,
        tier3: grouped['Tier 3'].length,
        plant: grouped['Plant'].length
      });
      
      setTierCounts({ 
        'Tier 1': grouped['Tier 1'].length, 
        'Tier 2': grouped['Tier 2'].length, 
        'Tier 3': grouped['Tier 3'].length, 
        'Plant': grouped['Plant'].length 
      });

      // Create advanced shell layout with mathematical optimization
      const nodeList: Node<NodeData>[] = [];
      const centerX = 400;
      const centerY = 300;
      const baseNodeSize = 16; // Reduced from 24 for smaller nodes
      const subRingSpacing = 10; // Reduced sub-ring spacing for tighter clustering
      const mainRingDistance = subRingSpacing * 18; // Increased major ring distance (180px)
      
      // Mathematical constants for optimal distribution
      const OPTIMAL_NODE_SPACING = 45; // Keep at 45px for major rings
      const SUB_RING_NODE_SPACING = 35; // Reduced spacing for sub-rings
      const COLLISION_THRESHOLD = 30; // Reduced for tighter packing
      
      // Advanced mathematical helper functions
      const calculateOptimalSubRings = (nodeCount: number, baseRadius: number): number => {
        // Calculate optimal number of sub-rings based on circumference and node density
        const maxNodesPerRing = Math.floor((2 * Math.PI * baseRadius) / SUB_RING_NODE_SPACING);
        return Math.ceil(nodeCount / maxNodesPerRing);
      };
      
      const calculateOptimalNodesPerSubRing = (nodeCount: number, subRingCount: number): number => {
        return Math.ceil(nodeCount / subRingCount);
      };
      
      const calculateDynamicRadius = (baseRadius: number, subRingIndex: number, nodeCount: number): number => {
        // Dynamic radius with adaptive spacing based on node density
        const densityFactor = Math.max(0.8, Math.min(1.5, nodeCount / 20));
        return baseRadius + (subRingIndex * subRingSpacing * densityFactor);
      };
      
      // Advanced collision detection with force-directed adjustment
      const resolveCollisions = (positions: Array<{x: number, y: number, id: string}>, newPos: {x: number, y: number}, nodeId: string): {x: number, y: number} => {
        let adjustedPos = { ...newPos };
        let iterations = 0;
        const maxIterations = 25;
        
        while (iterations < maxIterations) {
          let totalForceX = 0;
          let totalForceY = 0;
          let hasCollision = false;
          
          for (const pos of positions) {
            if (pos.id === nodeId) continue;
            
            const dx = adjustedPos.x - pos.x;
            const dy = adjustedPos.y - pos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < COLLISION_THRESHOLD && distance > 0) {
              hasCollision = true;
              // Apply repulsive force inversely proportional to distance
              const force = (COLLISION_THRESHOLD - distance) / distance;
              totalForceX += (dx / distance) * force;
              totalForceY += (dy / distance) * force;
            }
          }
          
          if (!hasCollision) break;
          
          // Apply forces with damping
          const damping = 0.3;
          adjustedPos.x += totalForceX * damping;
          adjustedPos.y += totalForceY * damping;
          iterations++;
        }
        
        return adjustedPos;
      };
      
      // Track all positions for collision detection
      const allPositions: Array<{x: number, y: number, id: string}> = [];
      
      // Color utility functions for HSL manipulation
      const hexToHsl = (hex: string): [number, number, number] => {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h = 0, s = 0, l = (max + min) / 2;
        
        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
          }
          h /= 6;
        }
        
        return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
      };
      
      const hslToHex = (h: number, s: number, l: number): string => {
        h /= 360; s /= 100; l /= 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h * 6) % 2 - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        
        if (0 <= h && h < 1/6) { r = c; g = x; b = 0; }
        else if (1/6 <= h && h < 2/6) { r = x; g = c; b = 0; }
        else if (2/6 <= h && h < 3/6) { r = 0; g = c; b = x; }
        else if (3/6 <= h && h < 4/6) { r = 0; g = x; b = c; }
        else if (4/6 <= h && h < 5/6) { r = x; g = 0; b = c; }
        else if (5/6 <= h && h < 1) { r = c; g = 0; b = x; }
        
        r = Math.round((r + m) * 255);
        g = Math.round((g + m) * 255);
        b = Math.round((b + m) * 255);
        
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      };
      
      const withAlpha = (color: string, alpha: number): string => {
        const alphaHex = Math.round(alpha * 255).toString(16).padStart(2, '0');
        return color + alphaHex;
      };
      
      const shadeForProminence = (baseColor: string, prominence: number): string => {
        const [h, s, l] = hexToHsl(baseColor);
        // Higher prominence = darker/richer color (lower lightness, higher saturation)
        const newL = Math.max(25, l - (prominence * 25)); // Darken by up to 25%
        const newS = Math.min(100, s + (prominence * 20)); // Increase saturation by up to 20%
        return hslToHex(h, newS, newL);
      };
      
      const gradientFromShade = (baseShade: string, prominence: number): string => {
        const [h, s, l] = hexToHsl(baseShade);
        const lighterShade = hslToHex(h, Math.max(30, s - 10), Math.min(85, l + 15));
        return `radial-gradient(circle, ${baseShade}, ${lighterShade})`;
      };
      
      // Size scaling with eased curve
      const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
      
      const computeTierSize = (prominence: number, tierSizeRange: [number, number]): number => {
        const [minSize, maxSize] = tierSizeRange;
        const easedProminence = easeOutCubic(prominence);
        return Math.round(minSize + (maxSize - minSize) * easedProminence);
      };


      
      // Fibonacci spiral distribution for organic positioning
      const calculateFibonacciPosition = (index: number, total: number, baseRadius: number): { angle: number, radius: number } => {
        const goldenRatio = (1 + Math.sqrt(5)) / 2;
        const angle = index * 2 * Math.PI / goldenRatio;
        const spiralRadius = Math.sqrt(index / total) * baseRadius;
        return { angle, radius: spiralRadius };
      };
      
      // Enhanced density-aware clustering
      const calculateClusterPosition = (
        nodeIndex: number, 
        clusterNodes: number, 
        baseRadius: number, 
        clusterId: number
      ): { x: number, y: number } => {
        // Golden ratio spacing for natural distribution
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));  // ~137.5 degrees
        const normalizedIndex = nodeIndex / Math.max(clusterNodes - 1, 1);
        
        // Spiral positioning with cluster offset
        const spiralAngle = nodeIndex * goldenAngle + (clusterId * Math.PI / 3);
        const spiralRadius = baseRadius + Math.sqrt(normalizedIndex) * 25;
        
        return {
          x: centerX + Math.cos(spiralAngle) * spiralRadius,
          y: centerY + Math.sin(spiralAngle) * spiralRadius
        };
      };
      
      // Position Plant nodes (Tier 0) at center with enhanced prominence
      const plantIds = grouped['Plant'];
      if (plantIds.length > 0) {
        plantIds.forEach((id, i) => {
          const data = nodeMap[id];
          const { prominence, size, opacity, glowIntensity } = calculateNodeImportance(data, id);
          
          // Central positioning with sophisticated spacing for multiple plants
          const angle = plantIds.length === 1 ? 0 : (i * 2 * Math.PI) / plantIds.length;
          const radius = plantIds.length === 1 ? 0 : Math.min(30, 15 + plantIds.length * 2);
          
          let position = {
            x: centerX + Math.cos(angle) * radius,
            y: centerY + Math.sin(angle) * radius
          };
          
          position = resolveCollisions(allPositions, position, id);
          allPositions.push({...position, id});
          
          // Enhanced visual styling with prominence-based effects
          const tierColor = TIER_COLORS[data.tier || 'Plant'];
          const glowColor = `${tierColor}40`; // 25% opacity for glow
          
          nodeList.push({
            id,
            position,
            data,
            style: {
              background: `linear-gradient(135deg, ${tierColor}, ${tierColor}E6)`,
              color: 'white',
              width: Math.max(24, Math.round(size * 1.2)), // Plant nodes are larger
              height: Math.max(24, Math.round(size * 1.2)),
              fontSize: 0,
              borderRadius: '50%',
              border: '3px solid white',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              boxShadow: `0 6px 20px rgba(0,0,0,0.15), 0 0 ${Math.round(glowIntensity * 20)}px ${glowColor}`,
              opacity,
              zIndex: 30,
              filter: `brightness(${1 + prominence * 0.2})`,
            },
            type: 'default',
          });
        });
      }
      
      // Position Tier 1 nodes with cluster-based prominence distribution (matching Tier 2 approach)
      const tier1Ids = grouped['Tier 1'];
      if (tier1Ids.length > 0) {
        const baseRadius = mainRingDistance;
        
        // Create prominence-based clusters for Tier 1
        const tier1NodesWithProminence = tier1Ids.map(id => ({
          id,
          data: nodeMap[id],
          ...calculateNodeImportance(nodeMap[id], id)
        })).sort((a, b) => b.prominence - a.prominence);
        
        type NodeWithProminence = typeof tier1NodesWithProminence[0];
        
        // Divide into clusters based on prominence levels
        const clusterSize = Math.ceil(tier1Ids.length / 6); // 6 clusters max
        const clusters: NodeWithProminence[][] = [];
        for (let i = 0; i < tier1NodesWithProminence.length; i += clusterSize) {
          clusters.push(tier1NodesWithProminence.slice(i, i + clusterSize));
        }
        
        clusters.forEach((cluster, clusterIndex) => {
          cluster.forEach((nodeInfo, nodeIndex) => {
            const { id, data, prominence, size, opacity, glowIntensity } = nodeInfo;
            
            // Calculate cluster-based position with golden ratio distribution  
            const position = calculateClusterPosition(
              nodeIndex, 
              cluster.length, 
              baseRadius + (clusterIndex * subRingSpacing), 
              clusterIndex
            );
            
            // Apply prominence-based radial adjustment
            const distanceFromCenter = Math.sqrt(
              Math.pow(position.x - centerX, 2) + Math.pow(position.y - centerY, 2)
            );
            const adjustedDistance = distanceFromCenter + ((1 - prominence) * 20); // Stronger prominence effect
            const angle = Math.atan2(position.y - centerY, position.x - centerX);
            
            let finalPosition = {
              x: centerX + Math.cos(angle) * adjustedDistance,
              y: centerY + Math.sin(angle) * adjustedDistance
            };
            
            finalPosition = resolveCollisions(allPositions, finalPosition, id);
            allPositions.push({...finalPosition, id});
            
            // Enhanced Tier 1 styling using prominence-based color shading
            const tierColor = TIER_COLORS[data.tier || 'Tier 1'];
            const shadedColor = shadeForProminence(tierColor, prominence);
            const gradientBg = gradientFromShade(shadedColor, prominence);
            const glowColor = withAlpha(shadedColor, 0.3);
            const dynamicSize = computeTierSize(prominence, [16, 32]);
            
            nodeList.push({
              id,
              position: finalPosition,
              data,
              style: {
                background: gradientBg,
                color: 'white',
                width: dynamicSize,
                height: dynamicSize,
                fontSize: 0,
                borderRadius: '50%',
                border: `${Math.round(1 + prominence * 2)}px solid rgba(255,255,255,${0.7 + prominence * 0.3})`,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                boxShadow: `0 ${Math.round(2 + prominence * 6)}px ${Math.round(8 + prominence * 12)}px rgba(0,0,0,${0.1 + prominence * 0.15}), 0 0 ${Math.round(glowIntensity * 15)}px ${glowColor}`,
                opacity,
                  zIndex: Math.round(20 + prominence * 5),
              },
              type: 'default',
            });
          });
        });
      }
      
      // Position Tier 2 nodes with cluster-based prominence distribution
      const tier2Ids = grouped['Tier 2'];
      if (tier2Ids.length > 0) {
        const baseRadius = mainRingDistance * 2; // 360px (180px × 2)
        
        // Create prominence-based clusters for Tier 2
        const tier2NodesWithProminence = tier2Ids.map(id => ({
          id,
          data: nodeMap[id],
          ...calculateNodeImportance(nodeMap[id], id)
        })).sort((a, b) => b.prominence - a.prominence);
        
        type NodeWithProminence = typeof tier2NodesWithProminence[0];
        
        // Divide into clusters based on prominence levels
        const clusterSize = Math.ceil(tier2Ids.length / 6); // 6 clusters max
        const clusters: NodeWithProminence[][] = [];
        for (let i = 0; i < tier2NodesWithProminence.length; i += clusterSize) {
          clusters.push(tier2NodesWithProminence.slice(i, i + clusterSize));
        }
        
        clusters.forEach((cluster, clusterIndex) => {
          cluster.forEach((nodeInfo, nodeIndex) => {
            const { id, data, prominence, size, opacity, glowIntensity } = nodeInfo;
            
            // Calculate cluster-based position with golden ratio distribution  
            const position = calculateClusterPosition(
              nodeIndex, 
              cluster.length, 
              baseRadius + (clusterIndex * subRingSpacing), 
              clusterIndex
            );
            
            // Apply prominence-based radial adjustment
            const distanceFromCenter = Math.sqrt(
              Math.pow(position.x - centerX, 2) + Math.pow(position.y - centerY, 2)
            );
            const prominenceAdjustment = (1 - prominence) * 25; // Enhanced prominence adjustment for better visibility
            const adjustedDistance = distanceFromCenter + prominenceAdjustment;
            const angle = Math.atan2(position.y - centerY, position.x - centerX);
            
            let finalPosition = {
              x: centerX + Math.cos(angle) * adjustedDistance,
              y: centerY + Math.sin(angle) * adjustedDistance
            };
            
            finalPosition = resolveCollisions(allPositions, finalPosition, id);
            allPositions.push({...finalPosition, id});
            
            // Enhanced Tier 2 styling using prominence-based color shading with improved visibility
            const tierColor = TIER_COLORS[data.tier || 'Tier 2'];
            const shadedColor = shadeForProminence(tierColor, prominence);
            const gradientBg = gradientFromShade(shadedColor, prominence);
            const glowColor = withAlpha(shadedColor, 0.3); // Increased glow for better visibility
            const dynamicSize = computeTierSize(prominence, [10, 30]); // Expanded size range for better contrast
            
            // Enhanced border thickness based on prominence for Tier 2
            const borderThickness = Math.round(2 + prominence * 4); // 2-6px border based on prominence
            
            // Debug log for Tier 2 prominence visibility
            if (Math.random() < 0.05) { // Log only 5% of nodes to avoid spam
              console.log(`🔍 Tier 2 Debug - ${data.label}: prominence=${prominence.toFixed(3)}, size=${dynamicSize}px, border=${borderThickness}px`);
            }
            
            nodeList.push({
              id,
              position: finalPosition,
              data,
              style: {
                background: gradientBg,
                color: 'white',
                width: dynamicSize,
                height: dynamicSize,
                fontSize: 0,
                borderRadius: '50%',
                border: `${borderThickness}px solid rgba(255,255,255,${0.7 + prominence * 0.3})`, // Enhanced border using calculated thickness
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                boxShadow: `0 ${Math.round(2 + prominence * 5)}px ${Math.round(8 + prominence * 10)}px rgba(0,0,0,${0.1 + prominence * 0.15}), 0 0 ${Math.round(glowIntensity * 12)}px ${glowColor}`,
                opacity: opacity * 0.98, // Increased opacity for better visibility  
                  zIndex: Math.round(15 + prominence * 5), // Enhanced z-index range
              },
              type: 'default',
            });
          });
        });
      }
      
      // Position Tier 3+ nodes with organic spiral distribution
      const tier3Ids = grouped['Tier 3'];
      if (tier3Ids.length > 0) {
        const baseRadius = mainRingDistance * 3; // 540px (180px × 3)
        
        // Sort Tier 3 nodes by prominence for outer ring positioning
        const tier3NodesWithProminence = tier3Ids.map(id => ({
          id,
          data: nodeMap[id],
          ...calculateNodeImportance(nodeMap[id], id)
        })).sort((a, b) => b.prominence - a.prominence);
        
        tier3NodesWithProminence.forEach((nodeInfo, i) => {
          const { id, data, prominence, size, opacity, glowIntensity } = nodeInfo;
          
          // Advanced organic spiral for outermost tier
          const goldenAngle = Math.PI * (3 - Math.sqrt(5));
          const angle = i * goldenAngle * 1.2; // Extended spiral
          const spiralRadius = baseRadius + Math.sqrt(i / tier3Ids.length) * 80;
          
          // Prominence affects distance from center (less prominent = further out)
          const prominenceRadius = spiralRadius + ((1 - prominence) * 20);
          
          let position = {
            x: centerX + Math.cos(angle) * prominenceRadius,
            y: centerY + Math.sin(angle) * prominenceRadius
          };
          
          position = resolveCollisions(allPositions, position, id);
          allPositions.push({...position, id});
          
          // Enhanced Tier 3 styling using prominence-based color shading
          const tierColor = TIER_COLORS[data.tier || 'Tier 3'];
          const shadedColor = shadeForProminence(tierColor, prominence);
          const gradientBg = gradientFromShade(shadedColor, prominence);
          const glowColor = withAlpha(shadedColor, 0.2);
          const dynamicSize = computeTierSize(prominence, [10, 18]);
          
          nodeList.push({
            id,
            position,
            data,
            style: {
              background: gradientBg,
              color: 'white',
              width: dynamicSize,
              height: dynamicSize,
              fontSize: 0,
              borderRadius: '50%',
              border: `1px solid rgba(255,255,255,${0.4 + prominence * 0.3})`,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              boxShadow: `0 ${Math.round(0.5 + prominence * 2)}px ${Math.round(4 + prominence * 4)}px rgba(0,0,0,${0.06 + prominence * 0.08}), 0 0 ${Math.round(glowIntensity * 6)}px ${glowColor}`,
              opacity: opacity * 0.85, // Most subtle opacity
              zIndex: Math.round(10 + prominence * 2),
            },
            type: 'default',
          });
        });
      }

      nodeList.forEach((n) => {
        n.data.prominence = calculateNodeImportance(n.data, n.id).prominence;
      });
      shellPositionsRef.current = Object.fromEntries(nodeList.map((n) => [n.id, n.position]));
      setAllNodes(nodeList);
      setAllEdges(Object.values(edgeMap));
      setLoadNonce((k) => k + 1);
      console.log('✅ Firm visualization updated with', nodeList.length, 'nodes and', Object.keys(edgeMap).length, 'edges');
      toast.success(`Loaded firm network: ${nodeList.length} firms, ${Object.keys(edgeMap).length} connections`);
    } catch (error) {
      console.error('❌ fetchData error:', error);
      setMetricsReadError(true);
      toast.error('Failed to load firm network data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchProjects();
    }
  }, [user]);

  useEffect(() => {
    fetchData();
  }, [globalSelectedProjectId, user]);

  // §9 — the visible set, by firm name, so search keeps working inside a focus.
  const searchCandidates = useMemo(
    () =>
      lens.visibleNodes.map((n) => ({
        id: n.id,
        label: n.data.label,
        color: TIER_COLORS[n.data.tier || 'Tier 1'],
        classLabel: n.data.tier === 'Plant' ? 'Plant' : n.data.tier || 'Tier 1',
      })),
    [lens.visibleNodes],
  );

  const mobileFirmMetrics = useMemo(() => {
    const totalNodes = networkNodes.length;
    const maxDepth = networkNodes.reduce((m, n) => Math.max(m, n.depth ?? 0), 0);
    const supplierDiversity = (tierCounts['Tier 1'] ?? 0) + (tierCounts['Tier 2'] ?? 0) + (tierCounts['Tier 3'] ?? 0);
    const tier1Exposure = totalNodes > 0
      ? ((tierCounts['Tier 1'] / totalNodes) * 100).toFixed(1) + '%'
      : '—';
    // `Map` is shadowed in this module by the lucide icon of the same name
    // (line 35), so the global constructor is reached through globalThis -
    // the pattern ProductLevelNetwork.tsx already uses for the same reason.
    const dstSources = new globalThis.Map<string, Set<string>>();
    networkEdges.forEach(e => {
      if (!dstSources.has(e.dst_uid)) dstSources.set(e.dst_uid, new Set());
      dstSources.get(e.dst_uid)!.add(e.src_uid);
    });
    const soleSourceSet = new Set<string>();
    dstSources.forEach(sources => { if (sources.size === 1) sources.forEach(s => soleSourceSet.add(s)); });
    const hubBetweenness = prominenceStats?.max ?? null;
    const hubNode = hubBetweenness !== null
      ? networkNodes.find(n => Math.abs((n.prominence ?? 0) - hubBetweenness) < 0.001)
      : null;
    const revMap = new globalThis.Map<string, number>();
    let revTotal = 0;
    networkEdges.forEach(e => {
      if (e.relative_revenue_percentage != null) {
        revMap.set(e.src_uid, (revMap.get(e.src_uid) || 0) + e.relative_revenue_percentage);
        revTotal += e.relative_revenue_percentage;
      }
    });
    let hhi = 0;
    if (revTotal > 0) revMap.forEach(v => { const s = v / revTotal; hhi += s * s; });
    const peak = hubBetweenness ?? 0;
    const hasSPOF = peak >= 0.999;
    const resilience = (hasSPOF ? 0 : 0.4) + 0.3 * (1 - hhi) + 0.3 * (1 - peak);
    return {
      totalNodes,
      networkDepth: maxDepth,
      supplierDiversity,
      tier1Exposure,
      soleSources: soleSourceSet.size,
      hubDependence: hubBetweenness !== null ? hubBetweenness.toFixed(3) : '—',
      hubNodeName: hubNode?.name ?? null,
      resilience: resilience.toFixed(3),
      resilienceRed: resilience < 0.4,
      hasSPOF,
    };
  }, [networkNodes, networkEdges, tierCounts, prominenceStats]);

  return (
    <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
      {/* v3 §1.1/§1.4, D3-a: sibling before the gutter, root variant — Network
          isn't one of the tab bar's four labelled tabs, but it IS a root
          (reached from More) and D3-a's design review is explicit that it
          keeps the tab bar (no item active), not a back arrow. The chip
          rides the second row exactly as GAP-CLOSE T4 names it for Network.
          Refresh is the one meta-slot action; the search/analytics/map/
          recalculate controls stay desktop-only exactly as before
          (`hidden md:contents`), so nothing that already worked on mobile
          is lost. */}
      {isMobile && (
        <MobilePageHeader
          variant="root"
          title="Firm-Level Network Intelligence"
          meta={
            <button
              type="button"
              onClick={fetchData}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
              className="relative -mr-1 grid h-[32px] w-[32px] shrink-0 place-items-center text-[#18181b] after:absolute after:-inset-1.5 after:content-['']"
            >
              <RefreshCw className={loading ? 'h-[16px] w-[16px] animate-spin' : 'h-[16px] w-[16px]'} />
            </button>
          }
        >
          <ProjectChip
            projects={projects}
            selectedId={globalSelectedProjectId}
            onSelect={setGlobalSelectedProjectId}
          />
        </MobilePageHeader>
      )}
      <div className={isMobile ? PAGE_GUTTER_SKIN : PAGE_GUTTER}>
        {!isMobile && (
        /* Refresh is composed inside `rightContent` rather than passed as
           `onRefresh`, because the handoff's slot order puts it after this
           page's own graph controls and before the project select. Same
           button, same handler — see HeaderRefreshButton. */
        <PageHeader
          title="Firm-Level Network Intelligence"
          rightContent={
            /* `gap-2` rather than `space-x-2`: `space-x-*` puts its margin on
               the DOM children, so it would land on the `md:contents` wrapper
               below instead of on the controls inside it and collapse the
               desktop spacing. `gap` is inherited correctly through
               `display:contents`, and for this single-line row the two
               produce the same 8px. */
            <div className="flex items-center gap-2">
              {/* Spec 4.1 caps the mobile right slot at three controls. Search,
                  the map toggle and the analytics panel all drive surfaces that
                  are `hidden md:` on this page, and "recalculate prominence"
                  moves next to the centrality table it changes. Below `md` the
                  header therefore holds refresh + the project select only;
                  `md:contents` hands every control straight back to the same
                  flex row on desktop, unchanged. */}
              <span className="hidden md:contents">
              {selectedNode && (
                <Button
                  onClick={() => setDisruptionDialogOpen(true)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    'gap-1 text-orange-600 hover:bg-orange-50 hover:text-orange-700',
                    HDR_OUTLINE_BUTTON,
                    'md:text-[#ea580c] md:hover:text-[#ea580c]',
                  )}
                >
                  <AlertTriangle className="h-4 w-4" />
                  <span className="hidden sm:inline">Add disruption event</span>
                </Button>
              )}
              
              <LensSearch
                open={lens.searchOpen}
                onOpenChange={lens.setSearchOpen}
                term={lens.searchTerm}
                onTermChange={lens.setSearchTerm}
                candidates={searchCandidates}
                monoLabels={false}
                onPick={(c) => {
                  lens.setSelectedId(c.id);
                  graphRef.current?.centerOn(c.id);
                }}
              />

              <Button
                variant={showAnalytics ? 'default' : 'outline'}
                size="icon"
                className={cn(HDR_ICON_BUTTON, showAnalytics && HDR_ICON_BUTTON_ON)}
                onClick={() => setShowAnalytics(!showAnalytics)}
                aria-label="Analytics"
                title="Analytics"
              >
                <BarChart className="h-4 w-4" />
              </Button>

              <Button
                variant="outline"
                size="icon"
                className={HDR_ICON_BUTTON}
                onClick={recalculateProminence}
                disabled={loading || recalculatingProminence || !globalSelectedProjectId || demo}
                aria-label="Recalculate prominence"
                title={demo ? 'Recalculation is switched off in the demo' : 'Recalculate prominence'}
              >
                <RotateCcw className={`h-4 w-4 ${recalculatingProminence ? 'animate-spin' : ''}`} />
              </Button>

              <Button
                variant={viewMode === 'map' ? 'default' : 'outline'}
                size="icon"
                className={cn(HDR_ICON_BUTTON, viewMode === 'map' && HDR_ICON_BUTTON_ON)}
                onClick={() => setViewMode(viewMode === 'network' ? 'map' : 'network')}
                aria-label={viewMode === 'network' ? 'Map view' : 'Network view'}
                title={viewMode === 'network' ? 'Map view' : 'Network view'}
              >
                {viewMode === 'network' ? <Map className="h-4 w-4" /> : <Network className="h-4 w-4" />}
              </Button>

              </span>

              <HeaderRefreshButton onClick={fetchData} loading={loading} />

              <Select value={globalSelectedProjectId || ''} onValueChange={setGlobalSelectedProjectId}>
                {/* Case A select (spec 2.1 / parity plan G3): the vw term
                    exceeds 180px at every width from 768 up, so the clamp
                    resolves to the desktop literal without an `md:`. The
                    handoff raises that desktop literal to the product-wide
                    200px project select. */}
                <SelectTrigger className={cn('h-11 md:h-9 w-[clamp(120px,38vw,180px)]', HDR_PROJECT_SELECT)}>
                  <SelectValue placeholder="Select Project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
        )}

        {/* ── Mobile composition (md:hidden) ──────────────────────────
             Spec 5 row 7 / demo entry 08. See ProductLevelNetwork for the
             shape; the pieces come from components/network/MobileLens so the
             three lenses stay identical in composition and differ only in
             what each lens measures. */}
        <div className="md:hidden mt-4 flex min-w-0 flex-col gap-[var(--m-gap)]">

          <div>
            <LensChip tone="amber">Firm level</LensChip>
          </div>

          <LensHowToRead
            scope="Every firm in this project's deep-tier graph, with your plant as the seed and tiers counted outward from it."
            findings="A firm is reported as a single hub once it carries the graph's peak prominence: every shortest path runs through it and nothing routes around it. Prominence is coloured from 0.400 up, so a row is worth reading before it becomes a finding."
            columns={[
              { term: 'Firm', def: 'The firm this row measures.' },
              { term: 'Tier', def: 'Distance from your plant, counted outward.' },
              { term: 'Prominence', def: 'Overall network importance.' },
              { term: 'In', def: 'Firms supplying this one.' },
              { term: 'Out', def: 'Firms this one supplies.' },
            ]}
          />

          <LensDesktopOnlyNote>
            The firm graph, the map view and the tier analytics are desktop
            surfaces. Open this lens on a larger screen to explore them; the
            findings below are the same on both.
          </LensDesktopOnlyNote>

          {/* §13.4 — the numbers band. A stat grid is its own container and
              carries no head; the figures name themselves. */}
          <LensStructure
            items={[
              { label: 'Nodes', value: mobileFirmMetrics.totalNodes > 0 ? String(mobileFirmMetrics.totalNodes) : '—' },
              { label: 'Network depth', value: mobileFirmMetrics.networkDepth > 0 ? String(mobileFirmMetrics.networkDepth) : '—' },
              { label: 'Critical path', value: '—' },
              {
                label: 'Resilience',
                value: mobileFirmMetrics.totalNodes > 0 ? mobileFirmMetrics.resilience : '—',
                red: mobileFirmMetrics.resilienceRed && mobileFirmMetrics.totalNodes > 0,
              },
            ]}
          />

          <LensSection label="Structural risk" counter="4" tone="primary" lens="amber">
            <LensRisk
              rows={[
                { label: 'Supplier diversity', value: mobileFirmMetrics.totalNodes > 0 ? String(mobileFirmMetrics.supplierDiversity) : '—' },
                { label: 'Tier-1 exposure', value: mobileFirmMetrics.totalNodes > 0 ? mobileFirmMetrics.tier1Exposure : '—' },
                { label: 'Sole-source firms', value: mobileFirmMetrics.totalNodes > 0 ? String(mobileFirmMetrics.soleSources) : '—' },
                { label: 'Hub dependence', value: mobileFirmMetrics.hubDependence },
              ]}
              alert={
                mobileFirmMetrics.hasSPOF && mobileFirmMetrics.hubNodeName
                  ? `${mobileFirmMetrics.hubNodeName} is a single hub — every path runs through it.`
                  : undefined
              }
            />
          </LensSection>

          <LensSection label="Centrality" lens="amber" counter={networkNodes.length ? String(Math.min(20, networkNodes.length)) : undefined}>
            <LensTable
              loading={loading}
              columns={[
                { key: 'firm', label: 'Firm' },
                { key: 'tier', label: 'Tier' },
                { key: 'prominence', label: 'Prominence', align: 'right' },
                { key: 'in', label: 'In', align: 'right' },
                { key: 'out', label: 'Out', align: 'right' },
              ]}
              rows={[...networkNodes]
                .sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0))
                .slice(0, 20)
                .map(node => {
                  // The same four thresholds the desktop table colours its
                  // prominence cell with, spent as the row's 6px dot instead
                  // of as coloured type (skin §3).
                  const p = node.prominence ?? 0;
                  const tone = p >= 0.8 ? 'blocking' as const
                    : p >= 0.6 ? 'warn' as const
                      : p >= 0.4 ? 'notable' as const
                        : undefined;
                  return {
                    key: node.id,
                    id: node.name ?? node.uid,
                    cells: [
                      { text: getTierFromDepth(node.depth, node.is_seed ?? false) },
                      { text: node.prominence != null ? node.prominence.toFixed(3) : '—', tone, primary: true },
                      { text: String(networkEdges.filter(e => e.dst_uid === node.uid).length) },
                      { text: String(networkEdges.filter(e => e.src_uid === node.uid).length) },
                    ],
                  };
                })}
              empty="No deep-tier network data. Select a project with deep-tier sourcing enabled."
              action={
                <LensAction
                  onClick={recalculateProminence}
                  disabled={loading || recalculatingProminence || !globalSelectedProjectId}
                  disabledReason={!globalSelectedProjectId ? 'Select a project first' : 'Already recalculating'}
                >
                  <RotateCcw className={`h-3.5 w-3.5 ${recalculatingProminence ? 'animate-spin' : ''}`} />
                  Recalculate
                </LensAction>
              }
            />
          </LensSection>

          {!demo && (
            <MobileGroup label="Prediction">
              <MLPrediction skin selectedPlant={
                globalSelectedProjectId
                  ? projects.find(p => p.id === globalSelectedProjectId)?.plant_name || null
                  : null
              } />
            </MobileGroup>
          )}

        </div>
        {/* ── End mobile composition ── */}

          {/* ── Desktop workspace (network-lenses handoff §1) ──────────────
               Graph card + right rail, then the analytics when toggled. The shell
               layout itself is unchanged (§5); only the card around it is shared.
               The rail stacks under the graph below `lg`, the sanctioned step. */}
          <div className="hidden md:block">
            {globalSelectedProjectId && riskDataError && (
              <RiskDataNotice reason={riskDataError} />
            )}
            {globalSelectedProjectId && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <GraphVersionChip
                  level="firm"
                  projectId={globalSelectedProjectId}
                  metricsComputedAt={storedDecision?.computedAt ?? null}
                  outcome={metricsOutcome ?? (storedDecision?.state === 'current' ? 'reused' : null)}
                  approximation={storedDecision?.state === 'missing' && networkNodes.length > 0}
                  analysisState={loading || recalculatingProminence
                    ? 'loading' : metricsReadError ? 'unavailable' : metricsProjectId !== globalSelectedProjectId ? 'loading'
                      : storedDecision?.state === 'current' ? 'current'
                        : metricsOutcome === 'in progress' ? 'in progress' : storedDecision?.state ?? 'missing'}
                  refreshKey={loadNonce}
                />
                {storedDecision?.state === 'missing' && networkNodes.length > 0 && (
                  <span className="text-[12px] text-muted-foreground">
                    Prominence shown is a local approximation (connections, revenue, balance) — nothing is stored for this graph yet. Recalculate computes and stores it once.
                  </span>
                )}
                {storedDecision?.state === 'stale' && (
                  <span className="text-[12px] text-muted-foreground">
                    Stored prominence was computed on an earlier version of this network. Recalculate to compute it for this one.
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="hidden md:grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <GraphCard
              ref={graphRef}
              legendShape="round"
              legend={LEGEND_TIERS.map((t) => ({ key: t, label: TIER_LABELS[t], color: TIER_COLORS[t], count: tierCounts[t] }))}
              nodes={lens.nodes}
              edges={lens.edges}
              onNodesChange={lens.onNodesChange}
              onNodeClick={lens.onNodeClick}
              onNodeDoubleClick={lens.onNodeDoubleClick}
              onNodeDragStart={lens.onNodeDragStart}
              onPaneClick={lens.onPaneClick}
              onResetLayout={() =>
                setAllNodes((current) =>
                  current.map((n) => ({ ...n, position: shellPositionsRef.current[n.id] ?? n.position })),
                )
              }
              fitKey={`${globalSelectedProjectId}|${loadNonce}|${focusedNode ?? ''}`}
              hint="Click/double-click firm to select and add disruptions • Double-click to focus network connections"
              storageKey="suresuite.lens.firm.graphHeight"
              minimapNodeColor={(n) => TIER_COLORS[(n.data as NodeData).tier || 'Tier 1']}
              replaceCanvas={
                viewMode === 'map' ? (
                  <Suspense
                    fallback={
                      <div className="h-full grid place-content-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                      </div>
                    }
                  >
                    <MapView
                      nodes={lens.nodes}
                      selectedNode={selectedNode}
                      onNodeClick={(node) => lens.setSelectedId(node.id)}
                      projectId={globalSelectedProjectId}
                      plantData={projects.find(p => p.id === globalSelectedProjectId) ?? null}
                      countryRiskMap={countryRiskMap}
                    />
                  </Suspense>
                ) : undefined
              }
              overlay={
                !globalSelectedProjectId ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-muted-foreground">
                    Please select a project
                  </div>
                ) : undefined
              }
            />

            {/* §10 right rail */}
            <div className="flex min-w-0 flex-col gap-4">
              <LensSummary
                cells={[
                  { label: 'Firms', value: allNodes.length },
                  { label: 'Connections', value: allEdges.length },
                  { label: 'Tiers', value: (['Tier 1', 'Tier 2', 'Tier 3'] as TierKey[]).filter((t) => tierCounts[t] > 0).length },
                  { label: 'Peak prominence', value: prominenceStats ? prominenceStats.max.toFixed(3) : '—' },
                ]}
              />
              <LensDetails
                title="Firm details"
                emptyText="Click a firm to view details"
                selected={
                  selectedNode
                    ? {
                        name: selectedNode.data.label,
                        classLabel: TIER_LABELS[selectedNode.data.tier || 'Tier 1'],
                        classColor: TIER_COLORS[selectedNode.data.tier || 'Tier 1'],
                        rows: [
                          { label: 'Incoming', value: selectedNode.data.incoming },
                          { label: 'Outgoing', value: selectedNode.data.outgoing },
                          {
                            label: 'Revenue',
                            value: selectedNode.data.revenue > 0 ? formatMoneyCompact(selectedNode.data.revenue) : 'N/A',
                          },
                          { label: 'Country', value: selectedNode.data.country },
                          { label: 'Industry', value: selectedNode.data.industry },
                          {
                            label: 'Prominence',
                            value: typeof selectedNode.data.prominence === 'number' ? selectedNode.data.prominence.toFixed(3) : '—',
                          },
                        ],
                      }
                    : null
                }
                focus={
                  selectedNode
                    ? {
                        label: 'Focus connections',
                        active: focusedNode === selectedNode.id,
                        onToggle: () => setFocusedNode(focusedNode === selectedNode.id ? null : selectedNode.id),
                      }
                    : undefined
                }
              />
              <MLPrediction selectedPlant={
                globalSelectedProjectId
                  ? projects.find(p => p.id === globalSelectedProjectId)?.plant_name || null
                  : null
              } />
            </div>
          </div>

          <div className="hidden md:block">
          {showAnalytics && (
            <div className="mt-8 flex flex-col gap-5">
              <LensAnalyticsHeader
                subtitle="Prominence, sector and country spread, tier composition and single-source exposure."
                meta={`${networkNodes.length} firms · ${networkEdges.length} connections`}
              />

              {prominenceStats && (
                <LensCard title="Prominence statistics" subtitle="Node prominence distribution and calculation metrics">
                  <div className={cn('grid grid-cols-4 gap-px overflow-hidden rounded-[4px] border bg-[var(--hair-border)]', LENS.border)}>
                    {[
                      { label: 'Total nodes', value: String(prominenceStats.count) },
                      { label: 'Average', value: prominenceStats.average.toFixed(3) },
                      { label: 'Maximum', value: prominenceStats.max.toFixed(3) },
                      { label: 'Minimum', value: prominenceStats.min.toFixed(3) },
                      { label: 'Low (< 0.3)', value: String(prominenceStats.distribution.low) },
                      { label: 'Medium (0.3–0.7)', value: String(prominenceStats.distribution.medium) },
                      { label: 'High (> 0.7)', value: String(prominenceStats.distribution.high) },
                    ].map((c) => (
                      <div key={c.label} className="bg-white px-3.5 py-2.5">
                        <div className={cn('text-[11px]', LENS.muted)}>{c.label}</div>
                        <div className={cn('text-[20px] font-semibold leading-[1.1] tracking-[-0.019em] tabular-nums', LENS.ink)}>{c.value}</div>
                      </div>
                    ))}
                  </div>
                </LensCard>
              )}

              {/* Industry breakdown + Geographic concentration */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {(['industry', 'country'] as const).map((field) => {
                  const counts: Record<string, number> = {};
                  networkNodes.forEach(n => {
                    const k = n[field] || 'Unknown';
                    counts[k] = (counts[k] || 0) + 1;
                  });
                  const rows = Object.entries(counts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([k, count]) => ({
                      key: k,
                      label: k,
                      value: count,
                      display: String(count),
                      color: field === 'industry' ? TIER_COLORS['Plant'] : TIER_COLORS['Tier 3'],
                    }));
                  return (
                    <LensCard
                      key={field}
                      title={field === 'industry' ? 'Industry breakdown' : 'Geographic concentration'}
                      subtitle={field === 'industry' ? 'Firm count by sector' : 'Top countries by firm count'}
                    >
                      <div className="max-h-[168px] overflow-y-auto pr-1">
                        <BarRows rows={rows} empty="No firms loaded" />
                      </div>
                    </LensCard>
                  );
                })}
              </div>

              {/* Tier composition + Revenue coverage */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <LensCard title="Tier composition" subtitle="Share of firms per supply chain tier">
                  {(() => {
                    const total = Object.values(tierCounts).reduce((a, b) => a + b, 0) || 1;
                    const tiers = TIER_ORDER.map(t => ({
                      label: t,
                      count: tierCounts[t],
                      pct: Math.round((tierCounts[t] / total) * 100),
                      color: TIER_COLORS[t],
                    }));
                    const circumference = 2 * Math.PI * 32;
                    let offset = 0;
                    return (
                      <div className="flex items-center gap-6">
                        <svg width="90" height="90" viewBox="0 0 90 90" className="shrink-0" aria-hidden>
                          {tiers.map(t => {
                            const dash = (t.pct / 100) * circumference;
                            const seg = (
                              <circle
                                key={t.label}
                                cx="45" cy="45" r="32"
                                fill="none"
                                stroke={t.color}
                                strokeWidth="14"
                                strokeDasharray={`${dash} ${circumference - dash}`}
                                strokeDashoffset={-offset}
                              />
                            );
                            offset += dash;
                            return seg;
                          })}
                        </svg>
                        <div className="flex flex-col gap-1.5">
                          {tiers.map(t => (
                            <div key={t.label} className={cn('flex items-center gap-2 text-[12px]', LENS.muted)}>
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                              {t.label} — {t.pct}% ({t.count})
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </LensCard>

                <LensCard title="Revenue coverage" subtitle="Firms with known revenue per tier">
                  <BarRows
                    max={100}
                    rows={TIER_ORDER.map(t => {
                      const tierNodes = networkNodes.filter(n => getTierFromDepth(n.depth, n.is_seed === true) === t);
                      const withRevenue = tierNodes.filter(n => n.revenue != null && n.revenue > 0).length;
                      const pct = tierNodes.length > 0 ? Math.round((withRevenue / tierNodes.length) * 100) : 0;
                      return { key: t, label: t, value: pct, display: `${pct}%`, color: TIER_COLORS[t] };
                    })}
                  />
                </LensCard>
              </div>

              {/* Single-source exposure */}
              <LensCard
                title="Single-source exposure"
                subtitle="Nodes with only one upstream supplier but multiple downstream connections — highest disruption risk"
              >
                {(() => {
                  const inCount: Record<string, number> = {};
                  const outCount: Record<string, number> = {};
                  networkEdges.forEach(e => {
                    inCount[e.dst_uid]  = (inCount[e.dst_uid]  || 0) + 1;
                    outCount[e.src_uid] = (outCount[e.src_uid] || 0) + 1;
                  });

                  const exposed = networkNodes
                    .filter(n => (inCount[n.uid] || 0) === 1 && (outCount[n.uid] || 0) > 0)
                    .map(n => {
                      const nodeCountry = n.country || 'Unknown';
                      // The map is keyed `upper(btrim(country))`, exactly as stored.
                      const rawRisk = countryRiskMap[nodeCountry.trim().toUpperCase()];
                      return {
                        name: n.name || n.uid,
                        tier: getTierFromDepth(n.depth, n.is_seed === true),
                        country: nodeCountry,
                        incoming: inCount[n.uid] || 0,
                        outgoing: outCount[n.uid] || 0,
                        risk: rawRisk ? rawRisk.trim() : 'Unknown',
                      };
                    })
                    .sort((a, b) => b.outgoing - a.outgoing)
                    .slice(0, 10);

                  if (exposed.length === 0) return (
                    <p className={cn('py-4 text-center text-[12.5px]', LENS.muted)}>No single-source nodes detected</p>
                  );

                  // Keys must match the risk class spelling stored in `risk_data`.
                  const riskStyle: Record<string, string> = {
                    'Very High': 'bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-200 font-bold',
                    'High':      'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
                    'Medium':    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
                    'Low':       'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
                    'Very Low':  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
                    'Unknown':   'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
                  };

                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12.5px] tabular-nums">
                        <thead>
                          <tr className={cn('border-b', LENS.hairline)}>
                            {['Firm', 'Tier', 'Country', 'In', 'Out', 'Risk class'].map((h, i) => (
                              <th
                                key={h}
                                className={cn(
                                  'pb-2 pr-3 font-mono text-[10px] font-normal uppercase tracking-[0.16em]',
                                  LENS.muted,
                                  i === 3 || i === 4 ? 'text-right' : 'text-left',
                                  i === 0 && FROZEN_CELL,
                                )}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {exposed.map(row => (
                            <tr key={row.name} className={cn('border-b last:border-0', LENS.hairline, LENS.hoverTableRow)}>
                              <td className={`max-w-[160px] truncate py-[9px] pr-3 ${FROZEN_CELL}`} title={row.name}>{row.name}</td>
                              <td className="py-[9px] pr-3">
                                <span
                                  className="inline-block whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium"
                                  style={{ background: TIER_COLORS[row.tier] + '22', color: TIER_COLORS[row.tier] }}
                                >
                                  {row.tier}
                                </span>
                              </td>
                              <td className={cn('py-[9px] pr-3', LENS.muted)}>{row.country}</td>
                              <td className="py-[9px] pr-3 text-right">{row.incoming}</td>
                              <td className="py-[9px] pr-3 text-right">{row.outgoing}</td>
                              <td className="py-[9px]">
                                <span className={`inline-block rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium ${riskStyle[row.risk] || riskStyle['Unknown']}`}>
                                  {row.risk}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </LensCard>

              {(firmRevenues.length > 0 || firmConnections.length > 0) && (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  {firmRevenues.length > 0 && (
                    <LensCard title="Top firms by revenue" subtitle="Revenue distribution across network firms">
                      <div className="max-h-60 overflow-y-auto pr-1">
                        <BarRows
                          rows={firmRevenues.map(f => ({
                            key: f.firm,
                            label: f.firm,
                            value: f.revenue,
                            display: formatMoneyCompact(f.revenue),
                            color: TIER_COLORS['Tier 1'],
                          }))}
                        />
                      </div>
                    </LensCard>
                  )}
                  {firmConnections.length > 0 && (
                    <LensCard title="Most connected firms" subtitle="Firms ranked by number of network connections">
                      <div className="max-h-60 overflow-y-auto pr-1">
                        <BarRows
                          rows={firmConnections.map(f => ({
                            key: f.firm,
                            label: f.firm,
                            value: f.connections,
                            display: String(f.connections),
                            color: TIER_COLORS['Tier 3'],
                          }))}
                        />
                      </div>
                    </LensCard>
                  )}
                </div>
              )}
            </div>
          )}
          </div>

        </div>

      <NetworkDisruptionDialog
        open={disruptionDialogOpen}
        onOpenChange={setDisruptionDialogOpen}
        nodeId={selectedNode?.id ?? null}
        projectId={globalSelectedProjectId ?? null}
        plantName={projects.find((p) => p.id === globalSelectedProjectId)?.plant_name ?? null}
        connectedEdges={
          selectedNode
            ? allEdges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
            : []
        }
        onSuccess={fetchData}
      />
    </PageLayout>
  );
}
