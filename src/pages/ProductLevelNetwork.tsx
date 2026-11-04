// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { listProjectsCached } from '@/lib/projects/projectsCache';
import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { lazyChunk } from '@/lib/lazyChunk';
import { Node, Edge, Position } from '@xyflow/react';

import { supabase } from '@/integrations/supabase/client';
import {
  buildProductLevelGraph,
  edgeWidthForFlow,
  flowLabel,
  maxFlow,
  adaptiveColumnLayout,
  lensNodeSize,
  colorForEchelon,
  labelForEchelon,
  GRAPH_INK,
  type Echelon,
  type FlatLaneRow,
} from '@/lib/graph';
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
  Map as MapIcon,
  Tag,
} from 'lucide-react';
import {
  PageLayout,
  PageHeader,
  HeaderRefreshButton,
  PAGE_GUTTER,
  PAGE_GUTTER_SKIN,
  HDR_GHOST_BUTTON,
  HDR_ICON_BUTTON,
  HDR_ICON_BUTTON_ON,
  HDR_PROJECT_SELECT,
} from '@/components/shared';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';
import MLPrediction from '@/components/MLPrediction';
import SupplierVolumeChart, { SupplierVolumeDatum, aggregateSupplierVolumes } from '@/components/SupplierVolumeChart';
import SupplierMaterialChart from '@/components/SupplierMaterialChart';
import { NetworkDisruptionDialog } from '@/components/network/NetworkDisruptionDialog';
// See the note in FirmLevelNetwork.tsx — mapbox-gl loads only when the user
// actually switches this card to map view.
const MapView = lazyChunk(() => import('@/components/MapView'));
import { NetworkMetricsTable } from '@/components/NetworkMetricsTable';
import { calculateSupplierMetrics, calculateMaterialMetrics } from '@/utils/networkMetrics';
import { MobileGroup, MobilePageHeader, ProjectChip } from '@/components/mobile';
import { RiskDataNotice } from '@/components/network/RiskDataNotice';
import { GraphVersionChip, type MetricsOutcome } from '@/components/trust/GraphVersionChip';
import type { NetworkAnalysisState } from '@/components/trust/NetworkAnalysisBadge';
import { analyzerOutcome, storedMetricsDecision } from '@/lib/network/storedMetrics';
import {
  GraphCard,
  LensSearch,
  LensSummary,
  LensDetails,
  LensAnalyticsHeader,
  useLensGraph,
  styleColumnEdge,
  type GraphCardHandle,
} from '@/components/network/lens';
import {
  LensChip,
  LensSection,
  LensHowToRead,
  LensDesktopOnlyNote,
  LensStructure,
  LensRisk,
  LensTable,
  LensAction,
} from '@/components/network/MobileLens';

const GROUP_ORDER = ['A', 'B', 'C', 'D'] as const;
type GroupKey = typeof GROUP_ORDER[number];

// The page's A/B/C/D columns ARE four echelons (WP 8.4), so their colours and labels
// come from the one palette rather than from a table of this page's own.
const GROUP_COLORS: Record<GroupKey, string> = {
  A: colorForEchelon('supplier'),
  B: colorForEchelon('material'),
  C: colorForEchelon('product'),
  D: colorForEchelon('customer'),
};

const GROUP_LABELS: Record<GroupKey, string> = {
  A: labelForEchelon('supplier'),
  B: labelForEchelon('material'),
  C: labelForEchelon('product'),
  D: labelForEchelon('customer'),
};

interface SupplyChainData {
  id: string;
  plant_name: string;
  from_location: string;
  to_location: string;
  material_consumption_rate: number;
  sourcing_ratio: number;
  weighted: number;
  data_source?: string;
}

interface NodeData extends Record<string, unknown> {
  label: string;
  type: 'location';
  group?: GroupKey;
  incoming: number;
  outgoing: number;
  incomingFlow: number;
  outgoingFlow: number;
}

interface SupplierMaterialCount {
  supplier: string;
  count: number;
}

interface NetworkVisualizationProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

/**
 * The four columns this page draws, DERIVED — WP 8.4 · §4 D127.
 *
 * `buildGroupClassification` and `getLocationGroup` used to live here. They assigned a
 * node to a column by the LANE that produced each row, letting the last row win — so a
 * sub-assembly, which is a bom source AND a bom target, landed in the Material column
 * or the Product column depending on the order the rows came back from the database.
 * `getLocationGroup` then defaulted anything unrecognised to **A, Supplier**, which is
 * a value displayed for data that does not carry it (T1).
 *
 * Both are gone. `buildProductLevelGraph` resolves every node's echelon once, from the
 * lane ROLES it holds rather than from one row, collapses the bill of materials to
 * purchased-material → finished-product, and recomputes the edge flows so they describe
 * the path actually drawn.
 */

/**
 * The product lens's focus, unchanged from the page's double-click handler: from the
 * node's column, walk A→B→C→D forward and backward by role — the full supply path
 * through the node (handoff §8, "keep the existing echelon-aware path").
 */
function productFocusSet(id: string, nodes: Node<NodeData>[], edges: Edge[]): Set<string> {
  const groupOf = new globalThis.Map(nodes.map((n) => [n.id, n.data.group]));
  const included = new Set<string>([id]);
  const targets = (sources: Set<string>, g: GroupKey) =>
    new Set(edges.filter((e) => sources.has(e.source) && groupOf.get(e.target) === g).map((e) => e.target));
  const sources = (dests: Set<string>, g: GroupKey) =>
    new Set(edges.filter((e) => dests.has(e.target) && groupOf.get(e.source) === g).map((e) => e.source));
  const me = new Set([id]);
  let A = new Set<string>(), B = new Set<string>(), C = new Set<string>(), D = new Set<string>();
  switch (groupOf.get(id)) {
    case 'A': B = targets(me, 'B'); C = targets(B, 'C'); D = targets(C, 'D'); break;
    case 'B': A = sources(me, 'A'); C = targets(me, 'C'); D = targets(C, 'D'); break;
    case 'C': B = sources(me, 'B'); A = sources(B, 'A'); D = targets(me, 'D'); break;
    case 'D': C = sources(me, 'C'); B = sources(C, 'B'); A = sources(B, 'A'); break;
  }
  [A, B, C, D].forEach((set) => set.forEach((n) => included.add(n)));
  return included;
}

export default function NetworkVisualization({ isCollapsed, setIsCollapsed }: NetworkVisualizationProps) {
  const { user, demo } = useAuth();
  const isMobile = useIsMobile();
  const { globalSelectedProjectId, setGlobalSelectedProjectId } = useGlobalProject();
  const graphRef = useRef<GraphCardHandle>(null);
  // Bumped after every load, so the card refits the graph it has just been handed.
  const [loadNonce, setLoadNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [groupCounts, setGroupCounts] = useState<Record<GroupKey, number>>({ A: 0, B: 0, C: 0, D: 0 });
  const [projects, setProjects] = useState<any[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [supplierVolumes, setSupplierVolumes] = useState<SupplierVolumeDatum[]>([]);
  const [supplierMaterialCounts, setSupplierMaterialCounts] = useState<SupplierMaterialCount[]>([]);
  const [networkMetrics, setNetworkMetrics] = useState<Array<{
    id: string;
    uid: string;
    name: string;
    echelon?: string | null;
    /** Weekly flow through the node on this graph — the propagated demand (§4 D313). */
    flow: number | null;
    degree_centrality: number | null;
    weighted_degree_centrality: number | null;
    eigenvector_centrality: number | null;
    betweenness_centrality: number | null;
    closeness_centrality: number | null;
    prominence: number | null;
    connection_count: number;
    // WP 6.3 / 10.1 · where each number came from, beside it (T1/T2).
    metrics_source?: 'store' | 'column' | 'none' | null;
    hash_is_current?: boolean | null;
    run_id?: string | null;
    computed_at?: string | null;
  }>>([]);
  // §4 D313 — the same run's supplier rows, in a table of their own.
  const [supplierNetworkMetrics, setSupplierNetworkMetrics] = useState<typeof networkMetrics>([]);
  const [networkMetricsLoading, setNetworkMetricsLoading] = useState(false);
  const [metricsOutcome, setMetricsOutcome] = useState<MetricsOutcome>(null);
  const [metricsStatus, setMetricsStatus] = useState<{ projectId: string; state: NetworkAnalysisState } | null>(null);
  const [metricsRevision, setMetricsRevision] = useState(0);
  const [disruptionDialogOpen, setDisruptionDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'network' | 'map'>('network');
  // Labels default ON, as on the Process-level view: node ids and each edge's flow.
  const [showLabels, setShowLabels] = useState(true);
  const [countryRiskMap, setCountryRiskMap] = useState<Record<string, string>>({});
  // D4: `risk_data` gained its migration in WP 1.4, so the read now succeeds
  // against a real table — but an EMPTY one until an operator loads a vintage.
  // The page used to warn to the console and render an unshaded graph as if
  // nothing were missing; it says so on screen instead (RiskDataNotice).
  const [riskDataError, setRiskDataError] = useState<string | null>(null);
  // Add state for metrics metadata
  const [metricsMetadata, setMetricsMetadata] = useState<{
    lastCalculated: string | null;
    dataLastModified: string | null;
    reason: string;
  } | null>(null);
  // Add state for calculated risk metrics
  const [supplierMetrics, setSupplierMetrics] = useState({ supplierDiversity: 0, singleSourceRisk: '0%' });
  const [materialMetrics, setMaterialMetrics] = useState({ materialDiversity: 0, materialConcentrationRisk: '0%' });

  // Selection, focus, search and drags — shared with the other two lenses. The
  // focus is this page's echelon-aware supply path, unchanged (handoff §8).
  const lens = useLensGraph<Node<NodeData>>({
    focusSet: productFocusSet,
    searchLabel: (n) => n.id,
    styleEdge: styleColumnEdge,
  });
  const { allNodes, allEdges, setAllNodes, setAllEdges, selectedNode, focusedId: focusedNode, setFocusedId: setFocusedNode } = lens;

  /** §6 — each class folds by its own count into the canvas it has. */
  const layoutColumns = useCallback((list: Node<NodeData>[]): Node<NodeData>[] => {
    if (list.length === 0) return list;
    const { width: nodeWidth, height: nodeHeight } = lensNodeSize(list.length);
    const size = graphRef.current?.canvasSize() ?? { width: 900, height: 596 };
    const positions = adaptiveColumnLayout(
      GROUP_ORDER.map((g) => ({
        ids: list.filter((n) => n.data.group === g).map((n) => n.id),
        stagger: g === 'A' || g === 'B',
      })),
      { canvasWidth: size.width, canvasHeight: size.height, nodeWidth, nodeHeight },
    );
    return list.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position }));
  }, []);

  const fetchProjects = async () => {
    if (!user) return;
    
    try {
      setProjects(await listProjectsCached(user));
    } catch (e) {
      console.error('Failed to fetch projects:', e);
      toast.error('Failed to load projects');
    }
  };

  // WP 10.1 · §4 D235–D239 — COMPUTE ONCE. The page READS the stored metrics and
  // invokes the analyzer only when no stored run is CURRENT — the database's answer
  // per row (`hash_is_current`, the run's level hash against the project's now). A
  // reload with unchanged data invokes nothing; a price edit, which no network level
  // reads, invokes nothing either. It replaced an all-or-nothing gate over
  // `network_nodes` rows and a browser fallback computation whose numbers
  // were never saved and carried no provenance — a number that cannot say where it
  // came from may not render (T1), so that fallback is gone, not relabelled.
  const fetchNetworkMetrics = async (projectId: string, forceRecalculate = false) => {
    if (!user?.id || !user?.email) return;

    // §4 D313 — the metrics of THIS page's graph. `get_network_metrics_for_materials`
    // joined the FIRM table to material ids on a bare string (D137), so a project
    // with a deep-tier network showed an empty table. `product_metrics` is computed
    // on the four-echelon graph drawn above, by the same `buildProductLevelGraph`,
    // and stored; the table lists its purchased materials.
    const readStored = async () => {
      const { data, error } = await supabase.rpc('get_product_level_metrics', {
        p_project_id: projectId,
        p_user_id: user.id,
      });
      if (error) throw error;
      // Every echelon of one run; the page shows the materials and the suppliers.
      return (data ?? []) as typeof networkMetrics;
    };

    setNetworkMetricsLoading(true);
    setMetricsStatus({ projectId, state: 'loading' });
    try {
      let rows = await readStored();
      let decision = storedMetricsDecision(rows);
      let outcome: MetricsOutcome = decision.state === 'current' ? 'reused' : null;

      // A demo reads what the seed stored and computes nothing: the analyzer writes
      // tier 3 and a demo visitor is not who should be asking it to.
      if ((forceRecalculate || decision.invoke) && !demo) {
        // WP 4.3 · the analyzer writes tier 3 through an RPC that takes the
        // actor, so the actor travels with the request (invariant audit-actor).
        const { data: calc, error: calcError } = await supabase.functions.invoke('calculate-network-science-metrics', {
          body: { project_id: projectId, uploaded_by: user?.id, analysis_kind: 'product_metrics' }
        });
        if (calcError) {
          console.error('Error calculating network metrics:', calcError);
          // What is stored stays on screen, SAID to be what it is; nothing is invented.
          toast.error(rows.length > 0
            ? 'Could not recompute network metrics — showing the stored figures, marked by freshness'
            : 'Could not compute network metrics');
        } else {
          outcome = analyzerOutcome(calc);
          rows = await readStored();
          decision = storedMetricsDecision(rows);
        }
      }

      setNetworkMetrics(rows.filter((r) => r.echelon === 'material'));
      setSupplierNetworkMetrics(rows.filter((r) => r.echelon === 'supplier'));
      setMetricsStatus({ projectId, state: outcome === 'in progress' && decision.state !== 'current' ? 'in progress' : decision.state });
      setMetricsOutcome(outcome);
      setMetricsMetadata({
        lastCalculated: decision.computedAt,
        // "When did the data last change" is the question §4 D12 says is the wrong
        // one; the level hash is the answer that replaces it.
        dataLastModified: null,
        reason: {
          current: 'Every figure below is a stored result computed on the graph now loaded.',
          stale: 'The stored figures were computed on an earlier graph; each row says so.',
          unknown: 'These figures predate provenance: nothing can say which graph they were computed on.',
          missing: 'No network metrics are stored for this project yet.',
        }[decision.state],
      });
      if (outcome === 'reused' && !forceRecalculate) {
        toast.success('Loaded stored metrics — computed once for this graph, reused');
      }
    } catch (error) {
      console.error('Error in fetchNetworkMetrics:', error);
      setMetricsStatus({ projectId, state: 'unavailable' });
      toast.error('Failed to load network metrics');
    } finally {
      setNetworkMetricsLoading(false);
      setMetricsRevision((revision) => revision + 1);
    }
  };

  const fetchData = async () => {
    console.log('🔍 fetchData called with:', { 
      hasUser: !!user, 
      selectedProject: globalSelectedProjectId
    });

    if (!user || !globalSelectedProjectId) {
      console.log('❌ Clearing data - no user or project');
      setAllNodes([]);
      setAllEdges([]);
      setGroupCounts({ A: 0, B: 0, C: 0, D: 0 });
      lens.reset();
      setSupplierVolumes([]);
      setSupplierMaterialCounts([]);
      return;
    }

    setLoading(true);
    lens.reset();

    try {
      console.log('📡 Fetching data for project:', globalSelectedProjectId);
      const [
        { data: scData, error: scError },
        { data: riskData, error: riskError }
      ] = await Promise.all([
        supabase.rpc('get_supply_chain_data', {
          p_project_id: globalSelectedProjectId,
          p_plant_name: null, 
          p_user_id: user.id,
          p_user_email: user.email
        }),
        supabase.from('risk_data').select('country, risk_class')
      ]);
      
      if (scError) {
        console.error('❌ Database error:', scError);
        throw scError;
      }

      // D4: the risk table is optional to the graph but NOT invisible when it
      // fails — an empty risk map renders every node as "Unknown", which reads
      // as an answer rather than as a missing source.
      if (riskError) {
        console.warn('⚠️ Could not load risk data:', riskError);
        setRiskDataError(riskError.message ?? String(riskError));
        setCountryRiskMap({});
      } else if (riskData) {
        const riskMap: Record<string, string> = {};
        riskData.forEach(row => {
          // WP 1.4: snake_case columns, and a CHECK that the stored country is
          // already `upper(btrim(...))` — see 20260915000003_risk_data.sql.
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

      // Reassign scData to 'data' so the rest of your existing code works without changes
      const data = scData;

      console.log('✅ Supply chain data fetched:', data?.length, 'records');
      
      if (!data || data.length === 0) {
        console.log('⚠️ No data for selected project');
        toast.error(`No data found for project`);
        return;
      }

      // Filter out multi-tier data sources from the product-level network
      const filteredData = data.filter((d: SupplyChainData) => d.data_source !== 'multi_tier');

      console.log('Unique data_source values:', [...new Set(filteredData.map(d => d.data_source))]);
      console.log('Sample row:', filteredData[0]);

      setSupplierVolumes(aggregateSupplierVolumes(filteredData));

      // How many distinct materials each supplier delivers. Read off the INBOUND lane
      // directly: that lane IS "a supplier delivers this material", so it needs no
      // classification at all — which is why the group lookup it used to do was both
      // indirect and order-dependent (§4 D127).
      const supplierMaterialMap: { [key: string]: Set<string> } = {};
      filteredData.forEach((d: SupplyChainData) => {
        if ((d.data_source ?? '').toLowerCase() !== 'inbound') return;
        const supplier = (d.from_location ?? '').trim();
        const material = (d.to_location ?? '').trim();
        if (!supplier || !material) return;
        if (!supplierMaterialMap[supplier]) supplierMaterialMap[supplier] = new Set();
        supplierMaterialMap[supplier].add(material);
      });
      setSupplierMaterialCounts(
        Object.entries(supplierMaterialMap)
          .map(([supplier, materials]) => ({
            supplier,
            count: materials.size,
          }))
          .sort((a, b) => b.count - a.count)
      );

      // Calculate risk metrics
      const calculatedSupplierMetrics = calculateSupplierMetrics(filteredData);
      const calculatedMaterialMetrics = calculateMaterialMetrics(filteredData);
      setSupplierMetrics(calculatedSupplierMetrics);
      setMaterialMetrics(calculatedMaterialMetrics);

      // ── FOUR ECHELONS, AND THE BOM COLLAPSED (WP 8.4 · §4 D127, D136) ─────
      //
      // This page is Supplier → purchased Material → finished Product → Customer, and
      // nothing else. The material is the one a supplier actually DELIVERS — the
      // purchased leaf of the bill of materials — and the product is the one a customer
      // actually BUYS. Everything the plant builds in between belongs to the
      // Process-level view, and is collapsed away here.
      //
      // IT USED TO DRAW THE WHOLE BOM TREE. The deployed ETL writes the bom lane as
      // `material → IMMEDIATE PARENT`, one row per BOM row, so `supply_chain_data`
      // holds the tree and this page drew it. Worse, a sub-assembly is a bom
      // `from_location` (a material) AND a bom `to_location` (a product), and
      // `buildGroupClassification` assigned groups by lane with the LAST ROW WINNING —
      // so every sub-assembly landed in the Material column or the Product column
      // depending on the order the rows came back in.
      //
      // AND THE EDGES ARE RECOMPUTED, NOT JUST THE NODES. Collapsing nodes while
      // keeping the old weights would leave every material→product edge describing one
      // BOM hop of a path it no longer draws. `buildProductLevelGraph` propagates the
      // product's demand down the tree — the product of the consumption rates along
      // every path — and SUMS the paths when a material reaches the same product more
      // than one way, because it is needed for all of them.
      const productGraph = buildProductLevelGraph(filteredData);

      const nodeMap: { [key: string]: NodeData } = {};
      const edgeMap: { [key: string]: Edge } = {};

      const GROUP_OF_ECHELON: Record<string, GroupKey> = {
        supplier: 'A',
        material: 'B',
        product: 'C',
        customer: 'D',
      };

      for (const [nodeId, { echelon }] of productGraph.nodes) {
        nodeMap[nodeId] = {
          label: nodeId,
          type: 'location',
          // The page's A/B/C/D columns, now DERIVED from the echelon rather than from
          // whichever lane row was read last. `subassembly`, `plant` and `unknown`
          // cannot appear here: this view has no column for them, which is what
          // collapsing the BOM means.
          group: GROUP_OF_ECHELON[echelon] ?? 'B',
          incoming: 0,
          outgoing: 0,
          incomingFlow: 0,
          outgoingFlow: 0,
        };
      }

      // `buildProductLevelGraph` returns ONE edge per pair with its flow summed over
      // every lane row it stands for (§4 D306), so a node's totals and the edge drawn
      // between two nodes read the same number.
      const edgeFlowMax = maxFlow(productGraph.edges);
      for (const e of productGraph.edges) {
        const from = nodeMap[e.source];
        const to = nodeMap[e.target];
        if (!from || !to) continue;

        from.outgoing++;
        from.outgoingFlow += e.flow;
        to.incoming++;
        to.incomingFlow += e.flow;

        const edgeKey = `${e.source}-${e.target}`;
        edgeMap[edgeKey] = {
          id: edgeKey,
          source: e.source,
          target: e.target,
          // WIDTH ENCODES FLOW, and DIRECTION IS VISIBLE: `styleColumnEdge` draws
          // `data.width` and a fixed-size arrowhead, grey at rest and blue with a
          // selection. The NUMBER is the edge label, behind the Labels toggle — the
          // same keys and the same formatter as the Process-level view (§4 D306).
          type: 'straight',
          data: {
            flowVolume: e.flow,
            lane: e.lane,
            width: edgeWidthForFlow(e.flow, edgeFlowMax),
            originalLabel: flowLabel(e.flow),
          },
        };
      }

      // T3 — a view states the limit of its own computation, at the point of display.
      if (productGraph.unreachedMaterials.length > 0) {
        const sample = productGraph.unreachedMaterials.slice(0, 5).join(', ');
        toast.warning(
          `${productGraph.unreachedMaterials.length} purchased material(s) reach no finished ` +
            `product through the bill of materials, so they connect to nothing on this view: ` +
            `${sample}${productGraph.unreachedMaterials.length > 5 ? ' …' : ''}. ` +
            `Either the BOM does not link them, or their product is not in outbound logistics.`,
          { duration: 10000 },
        );
      }
      console.log(
        `[ProductLevelNetwork] four echelons · ${Object.keys(nodeMap).length} nodes · ` +
          `${Object.keys(edgeMap).length} edges · ${productGraph.collapsedIntermediates} ` +
          `intermediate assemblies collapsed · ${productGraph.unreachedMaterials.length} materials reach no product`,
      );

      // Hide a node only when NO EDGE touches it, as the Process-level view does. A
      // zero-flow edge is drawn at the minimum width rather than hidden — "no demand
      // reaches this lane" is a finding (`edgeWidthForFlow`) — and filtering on FLOW
      // used to hide a supplier whose material no product's demand reaches (§4 D306).
      const originalNodeCount = Object.keys(nodeMap).length;
      const filteredNodeMap = Object.fromEntries(
        Object.entries(nodeMap).filter(([, node]) => node.incoming + node.outgoing > 0)
      );

      const filteredCount = originalNodeCount - Object.keys(filteredNodeMap).length;

      // Also filter edges to only include those connecting filtered nodes
      const filteredNodeIds = new Set(Object.keys(filteredNodeMap));
      const filteredEdgeMap = Object.fromEntries(
        Object.entries(edgeMap).filter(([key, edge]) => 
          filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
        )
      );

      const grouped: Record<GroupKey, string[]> = { A: [], B: [], C: [], D: [] };
      for (const [id, node] of Object.entries(filteredNodeMap)) {
        grouped[node.group || 'A'].push(id);
      }
      
      console.log('📊 Node groups (after filtering):', {
        suppliers: grouped.A.length,
        materials: grouped.B.length,
        products: grouped.C.length,
        customers: grouped.D.length,
        filtered: filteredCount
      });
      
      setGroupCounts({ A: grouped.A.length, B: grouped.B.length, C: grouped.C.length, D: grouped.D.length });

      // §3 — the product-level node is the standard the process lens now shares:
      // a rounded rect sized from the graph's node count, ReactFlow's 1px outline,
      // the id always visible. Positions come from the adaptive layout (§6).
      const { width: nodeWidth, height: nodeHeight } = lensNodeSize(Object.keys(filteredNodeMap).length);
      const nodeList: Node<NodeData>[] = GROUP_ORDER.flatMap((group) =>
        grouped[group].map((id) => {
          const data = filteredNodeMap[id];
          return {
            id,
            position: { x: 0, y: 0 },
            data,
            style: {
              background: GROUP_COLORS[data.group || 'A'],
              color: 'white',
              width: nodeWidth,
              height: nodeHeight,
              fontSize: 10,
              fontWeight: 'bold',
              borderRadius: 8,
              border: `1px solid ${GRAPH_INK.nodeOutline}`,
              // One line, clipped: React Flow's default 10px padding wrapped every
              // id onto two lines inside a node this size.
              padding: 2,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              display: 'flex',
              // `safe`: an id wider than the node clips at its END, keeping the prefix.
              justifyContent: 'safe center',
              alignItems: 'center',
              textAlign: 'center',
            },
            type: 'default',
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
          } as Node<NodeData>;
        }),
      );

      setAllNodes(layoutColumns(nodeList));
      setAllEdges(Object.values(filteredEdgeMap));
      setLoadNonce((k) => k + 1);
      console.log('✅ Visualization updated with', nodeList.length, 'nodes and', Object.keys(filteredEdgeMap).length, 'edges');
      const message = filteredCount > 0 
        ? `Loaded ${filteredData.length} records for project (${filteredCount} unconnected nodes hidden)`
        : `Loaded ${filteredData.length} records for project`;
      toast.success(message);
    } catch (e) {
      console.error('❌ fetchData error:', e);
      toast.error('Failed to load data');
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

  // Auto-fetch network metrics when analytics are shown
  useEffect(() => {
    if (showAnalytics && globalSelectedProjectId && user) {
      fetchNetworkMetrics(globalSelectedProjectId);
    }
  }, [showAnalytics, globalSelectedProjectId, user, loadNonce]);

  // Manual refresh function
  const handleRefreshMetrics = async () => {
    if (!globalSelectedProjectId || demo) return;
    await fetchNetworkMetrics(globalSelectedProjectId, true);
  };

  // §4 D173 — F-10's cousin on THIS page, found by the 2026-09-23 acceptance
  // audit. "Resilience" here was `(hasSPOF ? 0 : 0.4) + 0.3(1−HHI) +
  // 0.3(1−peak prominence)`, red below 0.4 — the same class of ad-hoc
  // composite the Process page deleted as F-10, alive one lens over. DELETED
  // for the same reason: it resolves to no data, no named rule and no stated
  // default (§5 T1), and a resilience measure is the engine's to compute.
  // "Peak prominence" replaces it in the band: the largest prominence the
  // analysis store holds, a number a reader can trace to a run.
  const mobileProductMetrics = useMemo(() => {
    const totalNodes = (groupCounts.A || 0) + (groupCounts.B || 0) + (groupCounts.C || 0) + (groupCounts.D || 0);
    const networkDepth = ['A', 'B', 'C', 'D'].filter(k => (groupCounts[k as GroupKey] || 0) > 0).length;
    const totalVolume = supplierVolumes.reduce((s, v) => s + v.volume, 0);
    let hhi = 0;
    if (totalVolume > 0) supplierVolumes.forEach(v => { const s = v.volume / totalVolume; hhi += s * s; });
    const peakProminence = networkMetrics.reduce((m, n) => Math.max(m, n.prominence ?? 0), 0);
    const nexusMaterials = networkMetrics.filter(n => (n.prominence ?? 0) >= 0.8).length;
    const hasSPOF = nexusMaterials > 0;
    const topNexus = [...networkMetrics].sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0))[0];
    return {
      totalNodes,
      networkDepth,
      hhi: hhi.toFixed(3),
      peakProminence: peakProminence.toFixed(3),
      nexusMaterials,
      hasSPOF,
      topNexusName: topNexus?.name ?? null,
    };
  }, [groupCounts, supplierVolumes, networkMetrics]);

  // The Labels toggle hides node ids and edge flow labels without touching the
  // data, so the details card, the search and the map still read the real id. The
  // same two memos as the Process-level view (§4 D306).
  const displayNodes = useMemo(
    () => (showLabels ? lens.nodes : lens.nodes.map((n) => ({ ...n, style: { ...n.style, color: 'transparent' } }))),
    [lens.nodes, showLabels],
  );
  const displayEdges = useMemo(
    () => lens.edges.map((e) => ({ ...e, label: showLabels ? ((e.data?.originalLabel as string) || '') : '' })),
    [lens.edges, showLabels],
  );

  // §9 — the visible set, so search keeps working inside a focus.
  const searchCandidates = useMemo(
    () =>
      lens.visibleNodes.map((n) => ({
        id: n.id,
        label: n.id,
        color: GROUP_COLORS[n.data.group || 'A'],
        classLabel: GROUP_LABELS[n.data.group || 'A'],
      })),
    [lens.visibleNodes],
  );

  return (
    <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
      {/* v3 §1.1/§1.4, D3-a — see FirmLevelNetwork's identical comment: root
          variant (a root with no tab of its own keeps the bar, no item
          active — not a back arrow), chip on the second row, refresh as the
          one meta action, the rest stays desktop-only exactly as before. */}
      {isMobile && (
        <MobilePageHeader
          variant="root"
          title="Product-level Network Intelligence"
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
           page's own graph controls — including the metrics `Refresh` ghost,
           which is a different control with a different handler — and before
           the project select. Same button, same handler as before. */
        <PageHeader
          title="Product-level Network Intelligence"
          rightContent={
            /* `gap-2` rather than `space-x-2`: `space-x-*` puts its margin on
               the DOM children, so it would land on the `md:contents` wrapper
               below instead of on the controls inside it and collapse the
               desktop spacing. `gap` is inherited correctly through
               `display:contents`, and for this single-line row the two
               produce the same 8px. */
            <div className="flex items-center gap-2">
              {/* Spec 4.1 caps the mobile right slot at three controls, and
                  everything in this group drives the network graph / analytics
                  panels, which are `hidden md:` on this page. Below `md` the
                  header therefore holds refresh + the project select only, and
                  `md:contents` hands every control straight back to the same
                  flex row on desktop - so the desktop header is unchanged. */}
              <span className="hidden md:contents">
              {selectedNode && (
                <>
                  <Button
                    onClick={() => setDisruptionDialogOpen(true)}
                    variant="outline"
                    size="icon"
                    className={cn(
                      'text-orange-600 hover:bg-orange-50 hover:text-orange-700',
                      HDR_ICON_BUTTON,
                      'md:text-[#ea580c] md:hover:text-[#ea580c]',
                    )}
                    aria-label="Add disruption event"
                    title="Add disruption event"
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </Button>
                </>
              )}
              
              <Button
                onClick={() => setShowLabels(!showLabels)}
                variant={showLabels ? 'default' : 'outline'}
                size="icon"
                className={cn(HDR_ICON_BUTTON, showLabels && HDR_ICON_BUTTON_ON)}
                aria-label={showLabels ? 'Hide labels' : 'Show labels'}
                title={showLabels ? 'Hide labels' : 'Show labels'}
              >
                <Tag className="h-4 w-4" />
              </Button>

              <LensSearch
                open={lens.searchOpen}
                onOpenChange={lens.setSearchOpen}
                term={lens.searchTerm}
                onTermChange={lens.setSearchTerm}
                candidates={searchCandidates}
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
                variant={viewMode === 'map' ? 'default' : 'outline'}
                size="icon"
                className={cn(HDR_ICON_BUTTON, viewMode === 'map' && HDR_ICON_BUTTON_ON)}
                onClick={() => setViewMode(viewMode === 'network' ? 'map' : 'network')}
                aria-label={viewMode === 'network' ? 'Map view' : 'Network view'}
                title={viewMode === 'network' ? 'Map view' : 'Network view'}
              >
                {viewMode === 'network' ? <MapIcon className="h-4 w-4" /> : <Network className="h-4 w-4" />}
              </Button>

              {/* The metrics refresh — a different control with a different
                  handler from the page refresh beside it, which is why the
                  handoff keeps both and only changes their heights. */}
              <Button
                variant="ghost"
                size="sm"
                className={cn('gap-1', HDR_GHOST_BUTTON)}
                onClick={handleRefreshMetrics}
                disabled={networkMetricsLoading || demo}
                title={demo ? 'Recalculation is switched off in the demo' : undefined}
              >
                <RotateCcw className="h-4 w-4" />
                Refresh
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
             Spec 5 row 7 / demo entry 08. Nothing below md: renders the
             graph, so this column is the lens itself: how to read it, the
             structure, the risk, the ranking, the prediction. Every piece
             is a presentational component from components/network/MobileLens
             so the three lenses cannot drift apart again. */}
        <div className="md:hidden mt-4 flex min-w-0 flex-col gap-[var(--m-gap)]">

          <div>
            <LensChip tone="violet">Product level</LensChip>
          </div>

          <LensHowToRead
            scope="Suppliers, materials, products and customers built from this project's inbound, BOM and outbound records. Multi-tier rows are excluded here — the deep-tier graph is the firm lens."
            findings="A material is reported as a nexus material once its prominence reaches 0.800: at that level the graph has no path around it. Prominence is coloured from 0.400 up, so a row is worth reading before it becomes a finding."
            columns={[
              { term: 'Node', def: 'The material this row measures.' },
              { term: 'Prominence', def: 'Overall network importance.' },
              { term: 'Betweenness', def: 'Bridge between network clusters.' },
              { term: 'Degree', def: 'Connection ratio to max possible.' },
              { term: 'Connections', def: 'Distinct nodes this one is joined to.' },
            ]}
          />

          <LensDesktopOnlyNote>
            The network graph, the map view and the supplier charts are desktop
            surfaces. Open this lens on a larger screen to explore them; the
            findings below are the same on both.
          </LensDesktopOnlyNote>

          {/* §13.4 — the numbers band. A stat grid is its own container and
              carries no head; the figures name themselves. */}
          <LensStructure
            items={[
              { label: 'Nodes', value: mobileProductMetrics.totalNodes > 0 ? String(mobileProductMetrics.totalNodes) : '—' },
              { label: 'Network depth', value: mobileProductMetrics.networkDepth > 0 ? String(mobileProductMetrics.networkDepth) : '—' },
              // §4 D173 — "Critical path" was a HARDCODED '—' (a permanent
              // placeholder in a band of real figures) and "Resilience" an
              // invented composite; both deleted. These two are measured
              // (nexus counts stay in the Structural-risk rows below):
              { label: 'Materials measured', value: networkMetrics.length > 0 ? String(networkMetrics.length) : '—' },
              {
                label: 'Peak prominence',
                value: networkMetrics.length > 0 ? mobileProductMetrics.peakProminence : '—',
                red: mobileProductMetrics.hasSPOF,
              },
            ]}
          />

          <LensSection label="Structural risk" counter="4" tone="primary" lens="violet">
            <LensRisk
              rows={[
                { label: 'Single-source risk', value: supplierMetrics.supplierDiversity > 0 ? supplierMetrics.singleSourceRisk : '—' },
                { label: 'Concentration risk', value: materialMetrics.materialDiversity > 0 ? materialMetrics.materialConcentrationRisk : '—' },
                { label: 'Mean HHI', value: mobileProductMetrics.totalNodes > 0 ? mobileProductMetrics.hhi : '—' },
                { label: 'Nexus materials', value: networkMetrics.length > 0 ? String(mobileProductMetrics.nexusMaterials) : '—' },
              ]}
              alert={
                mobileProductMetrics.hasSPOF && mobileProductMetrics.topNexusName
                  ? `${mobileProductMetrics.topNexusName} is a nexus material — a single source of failure in the supply network.`
                  : undefined
              }
            />
          </LensSection>

          <LensSection label="Centrality" lens="violet" counter={networkMetrics.length ? String(Math.min(20, networkMetrics.length)) : undefined}>
            <LensTable
              loading={networkMetricsLoading}
              columns={[
                { key: 'node', label: 'Node' },
                { key: 'prominence', label: 'Prominence', align: 'right' },
                { key: 'betweenness', label: 'Betweenness', align: 'right' },
                { key: 'degree', label: 'Degree', align: 'right' },
                { key: 'connections', label: 'Connections', align: 'right' },
              ]}
              rows={[...networkMetrics]
                .sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0))
                .slice(0, 20)
                .map(n => {
                  // The same four thresholds the desktop table colours its
                  // prominence cell with, spent as the row's 6px dot instead
                  // of as coloured type (skin §3).
                  const p = n.prominence ?? 0;
                  const tone = p >= 0.8 ? 'blocking' as const
                    : p >= 0.6 ? 'warn' as const
                      : p >= 0.4 ? 'notable' as const
                        : undefined;
                  return {
                    key: n.id,
                    id: n.name,
                    cells: [
                      { text: n.prominence != null ? n.prominence.toFixed(3) : '—', tone, primary: true },
                      { text: n.betweenness_centrality != null ? n.betweenness_centrality.toFixed(3) : '—' },
                      { text: n.degree_centrality != null ? n.degree_centrality.toFixed(3) : '—' },
                      { text: String(n.connection_count) },
                    ],
                  };
                })}
              empty="No centrality metrics yet. Calculate them to rank the materials in this lens."
              action={
                <LensAction
                  onClick={handleRefreshMetrics}
                  disabled={networkMetricsLoading || !globalSelectedProjectId || demo}
                  disabledReason={demo ? 'Switched off in the demo' : !globalSelectedProjectId ? 'Select a project first' : 'Already calculating'}
                >
                  <RotateCcw className={`h-3.5 w-3.5 ${networkMetricsLoading ? 'animate-spin' : ''}`} />
                  Calculate
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
               Graph card + right rail, then the analytics when toggled. The rail
               stacks under the graph below `lg`, the sanctioned multi-pane step. */}
          <div className="hidden md:block">
            {globalSelectedProjectId && riskDataError && (
              <RiskDataNotice reason={riskDataError} />
            )}
          </div>
          <div className="hidden md:grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <GraphCard
              ref={graphRef}
              legend={GROUP_ORDER.map((g) => ({ key: g, label: GROUP_LABELS[g], color: GROUP_COLORS[g], count: groupCounts[g] }))}
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={lens.onNodesChange}
              onNodeClick={lens.onNodeClick}
              onNodeDoubleClick={lens.onNodeDoubleClick}
              onNodeDragStart={lens.onNodeDragStart}
              onPaneClick={lens.onPaneClick}
              onResetLayout={() => setAllNodes((current) => layoutColumns(current))}
              fitKey={`${globalSelectedProjectId}|${loadNonce}|${focusedNode ?? ''}`}
              hint="Click/double-click node to select and add disruptions • Double-click to focus supply chain path"
              storageKey="suresuite.lens.product.graphHeight"
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
                  { label: 'Nodes', value: allNodes.length },
                  { label: 'Edges', value: allEdges.length },
                  { label: 'Echelons', value: GROUP_ORDER.filter((g) => groupCounts[g] > 0).length },
                  {
                    label: 'Single-source %',
                    value: supplierMetrics.supplierDiversity > 0 ? supplierMetrics.singleSourceRisk : '—',
                  },
                ]}
              />
              <LensDetails
                title="Node details"
                emptyText="Click a node to view details"
                selected={
                  selectedNode
                    ? {
                        name: selectedNode.data.label,
                        classLabel: GROUP_LABELS[selectedNode.data.group || 'A'],
                        classColor: GROUP_COLORS[selectedNode.data.group || 'A'],
                        rows: [
                          { label: 'Incoming connections', value: selectedNode.data.incoming },
                          {
                            label: 'Incoming flow',
                            value: selectedNode.data.incomingFlow.toLocaleString('en-US', { maximumFractionDigits: 0 }),
                          },
                          { label: 'Outgoing connections', value: selectedNode.data.outgoing },
                          {
                            label: 'Outgoing flow',
                            value: selectedNode.data.outgoingFlow.toLocaleString('en-US', { maximumFractionDigits: 0 }),
                          },
                        ],
                      }
                    : null
                }
                focus={
                  selectedNode
                    ? {
                        label: 'Focus supply path',
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
                subtitle="Supplier volume and material spread, and the centrality of every material in this lens."
                meta={
                  metricsMetadata?.lastCalculated
                    ? `Last calculated ${new Date(metricsMetadata.lastCalculated).toLocaleString()}`
                    : undefined
                }
              />
              <GraphVersionChip
                level="product"
                projectId={globalSelectedProjectId}
                metricsComputedAt={metricsMetadata?.lastCalculated ?? null}
                outcome={metricsOutcome}
                analysisState={loading ? 'loading' : metricsStatus?.projectId === globalSelectedProjectId ? metricsStatus.state : 'loading'}
                refreshKey={`${loadNonce}:${metricsRevision}`}
              />
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <SupplierVolumeChart
                  data={supplierVolumes}
                  materialDiversity={String(materialMetrics.materialDiversity)}
                  materialConcentrationRisk={materialMetrics.materialConcentrationRisk}
                  sidebarCollapsed={isCollapsed}
                />
                <SupplierMaterialChart
                  data={supplierMaterialCounts}
                  supplierDiversity={String(supplierMetrics.supplierDiversity)}
                  singleSourceRisk={supplierMetrics.singleSourceRisk}
                  sidebarCollapsed={isCollapsed}
                />
              </div>
              <NetworkMetricsTable
                metrics={networkMetrics}
                loading={networkMetricsLoading}
              />
              <NetworkMetricsTable
                echelon="supplier"
                metrics={supplierNetworkMetrics}
                loading={networkMetricsLoading}
              />
              {metricsMetadata && (
                <p className="text-[12px] text-muted-foreground">{metricsMetadata.reason}</p>
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
