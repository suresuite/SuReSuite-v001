// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { Node, Edge, Position } from '@xyflow/react';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  placeLaneNodes,
  echelonToLegacyType,
  labelForEchelon,
  colorForEchelon,
  directedFocusIds,
  adaptiveColumnLayout,
  lensNodeSize,
  edgeWidthForFlow,
  flowLabel,
  maxFlow,
  sumLaneEdges,
  DEPTH_SHADE,
  GRAPH_INK,
  type Echelon,
} from '@/lib/graph';
import { useAuth } from '@/hooks/useAuth';
import { useGlobalProject } from '@/hooks/useGlobalProject';
import { fetchMultiTierNetworkData, MultiTierNetworkData } from '@/services/network';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  RefreshCw,
  AlertTriangle,
  Tag,
} from 'lucide-react';
import {
  PageLayout,
  PageHeader,
  HeaderRefreshButton,
  PAGE_GUTTER,
  PAGE_GUTTER_SKIN,
  HDR_FILTER_SELECT,
  HDR_ICON_BUTTON,
  HDR_ICON_BUTTON_ON,
  HDR_OUTLINE_BUTTON,
  HDR_PROJECT_SELECT,
} from '@/components/shared';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';
import { MobileGroup, MobilePageHeader, ProjectChip } from '@/components/mobile';
import {
  LensChip,
  LensHowToRead,
  LensDesktopOnlyNote,
  LensStructure,
  LensRisk,
  LensTable,
  LensSection,
} from '@/components/network/MobileLens';
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
  styleColumnEdge,
  type GraphCardHandle,
} from '@/components/network/lens';
import { NetworkDisruptionDialog } from '@/components/network/NetworkDisruptionDialog';
import MLPrediction from '@/components/MLPrediction';
import { GraphVersionChip } from '@/components/trust/GraphVersionChip';
import type { NetworkAnalysisState } from '@/components/trust/NetworkAnalysisBadge';
import { BarChart } from 'lucide-react';

interface MultiTierData {
  id: string;
  project_id: string;
  plant_name: string;
  from_location: string;
  to_location: string;
  level: number;
  material_consumption_rate: number | null;
  sourcing_ratio: number | null;
  weighted: number | null;
  data_source: string;
  data_source_group: string | null;
  path_root: string | null;
  uploaded_by: string | null;
  organization: string;
  created_at: string;
  updated_at: string;
}

interface NodeData extends Record<string, unknown> {
  label: string;
  /**
   * WP 8.3 · §4 D127. The node's ROLE, derived once by the one rule
   * (`classify_node_echelon`, mirrored client-side by `typedNodesFromLanes`) instead
   * of inferred from an integer. This is what the labels and the details panel read.
   */
  echelon: Echelon;
  /**
   * The legacy four-value field, kept because the lens classes and the level filters
   * still read it. DERIVED from `echelon` at the one place nodes are built, exactly
   * as `classify_node_type` is now a mapping over `classify_node_echelon` in SQL —
   * so the two vocabularies cannot disagree about the same node.
   */
  nodeType: 'supplier' | 'material' | 'product' | 'customer';
  /**
   * The node's position ordinate. Since WP 8.3 this is the REAL BOM depth from
   * `bom_multi_level` where the node is in a BOM, and the lane ordinate otherwise —
   * NOT `supply_chain_data_multi_tier.level`, which two live writers disagree about
   * and one of which flattens every BOM row to a literal 2 (§4 D140).
   */
  level: number;
  bomLevel: number | null;
  incoming: number;
  outgoing: number;
  flowVolume: number;
  consumptionRate: number | null;
  dataSource: string;
  isConnected: boolean;
  mappingConfidence: number | null;
  /** The lens class (legend item and column) this node is drawn in. */
  classKey?: string;
}

interface NetworkVisualizationProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

/**
 * The process lens's classes, in flow order (network-lenses handoff §2.1):
 * suppliers, materials by BOM depth deepest first, finished products, customers.
 *
 * A class is the node's ECHELON (via the legacy four-value mapping this page has
 * always drawn), split by depth inside the material band. A node whose role the
 * data does not carry gets a class of its own, drawn in the palette's `unknown`
 * grey — the amber "low-confidence" border that used to say so is gone with the
 * other border variants (§3), and the signal must not go with it (T2).
 */
interface ProcessClass {
  key: string;
  label: string;
  color: string;
  order: number;
}

/** Depth 1 is the material yellow, the deepest the darker gold; between, a blend. */
function materialDepthColor(depth: number, maxDepth: number): string {
  if (maxDepth <= 1 || depth <= 1) return colorForEchelon('material');
  if (depth >= maxDepth) return DEPTH_SHADE.deepMaterial;
  const t = (depth - 1) / (maxDepth - 1);
  const a = colorForEchelon('material');
  const b = DEPTH_SHADE.deepMaterial;
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('');
}

function processClassOf(n: Pick<NodeData, 'echelon' | 'nodeType' | 'level'>, maxMaterialDepth: number): ProcessClass {
  if (n.echelon === 'unknown') {
    return { key: 'unknown', label: 'Unknown role', color: colorForEchelon('unknown'), order: -3000 };
  }
  switch (n.nodeType) {
    case 'supplier':
      return { key: 'supplier', label: 'Suppliers', color: colorForEchelon('supplier'), order: 10000 };
    case 'product':
      return { key: 'product', label: 'Finished products', color: colorForEchelon('product'), order: -1000 };
    case 'customer':
      return { key: 'customer', label: 'Customers', color: colorForEchelon('customer'), order: -2000 };
    default:
      return {
        key: `material-${n.level}`,
        label: `Materials · depth ${n.level}`,
        color: materialDepthColor(n.level, maxMaterialDepth),
        order: 1000 + n.level,
      };
  }
}

/** A depth bucket's colour for the analytics, on the same scale as the graph. */
function depthBucketColor(level: number, maxMaterialDepth: number): string {
  if (level === -1) return colorForEchelon('customer');
  if (level === 0) return colorForEchelon('product');
  return materialDepthColor(level, maxMaterialDepth);
}

/** §8 — the path through the node: downstream along outgoing edges, upstream along incoming. */
function processFocusSet(id: string, _nodes: Node<NodeData>[], edges: Edge[]): Set<string> {
  return directedFocusIds(edges, id);
}

/*
 * `getNodeTypeFromLevel`, `getDisplayNodeType` and this page's `echelonToLegacyType`
 * used to live here. The first two inferred type from `level` (§4 D127, D140); the
 * mapping and the placement rule moved to `src/lib/graph/placement.ts` (audit
 * 2026-09-22 · F-09) so `/interactive-network-space` could call the same rule
 * instead of keeping a ladder of its own.
 */

/**
 * The label for a DEPTH BUCKET, as the level tiles and the flow list describe one.
 *
 * Distinct from `labelForEchelon`, which labels a NODE. A bucket is a set of nodes at
 * one ordinate, and since WP 8.3 that ordinate is the real BOM depth — so the honest
 * label names the depth rather than asserting a kind. `-1` and `0` are the two the
 * page's own convention reserves.
 */
function depthBucketLabel(level: number): string {
  if (level === -1) return 'Customers';
  if (level === 0) return 'Finished products';
  if (level > 0) return `BOM depth ${level}`;
  return 'Unknown depth';
}

export default function ProcessLevelNetwork({ isCollapsed, setIsCollapsed }: NetworkVisualizationProps) {
  const { user, demo } = useAuth();
  const isMobile = useIsMobile();
  const { globalSelectedProjectId, setGlobalSelectedProjectId } = useGlobalProject();
  const graphRef = useRef<GraphCardHandle>(null);
  // Bumped after every load, so the card refits the graph it has just been handed.
  const [loadNonce, setLoadNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [levelCounts, setLevelCounts] = useState<Record<number, number>>({});
  const [legendGroups, setLegendGroups] = useState<Array<{ key: string; label: string; count: number; color: string }>>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [topFlowFilter, setTopFlowFilter] = useState<string>('');
  interface LevelStats {
    level: number;
    displayType: string;
    count: number;
    avgIn: number;
    avgOut: number;
    avgFlow: number;
    color: string;
  }
  const [levelStats, setLevelStats] = useState<LevelStats[]>([]);
  const [topFlowNodes, setTopFlowNodes] = useState<{ id: string; flow: number; level: number; echelon: Echelon }[]>([]);
  // The legend's class order, which is also the column order — kept for Reset layout.
  const [classOrder, setClassOrder] = useState<string[]>([]);
  const [maxLevel, setMaxLevel] = useState(0);
  // The deepest BOM depth a material class reaches — the end of the depth shade.
  const [maxMaterialDepth, setMaxMaterialDepth] = useState(0);
  // Labels default ON, to match the product lens (handoff §3).
  const [showLabels, setShowLabels] = useState(true);
  
  // Level 1 node filter states
  const [selectedLevel1Node, setSelectedLevel1Node] = useState<string | null>(null);
  const [reachableNodes, setReachableNodes] = useState<Set<string>>(new Set());
  const [isLevel1FilterActive, setIsLevel1FilterActive] = useState(false);
  const [level1Nodes, setLevel1Nodes] = useState<string[]>([]);
  const [disruptionDialogOpen, setDisruptionDialogOpen] = useState(false);

  // Selection, focus, search and drags — shared with the other two lenses. The
  // Level 1 filter applies first, then the focus, then the search (handoff §8).
  const lens = useLensGraph<Node<NodeData>>({
    prefilter: isLevel1FilterActive ? reachableNodes : null,
    focusSet: processFocusSet,
    searchLabel: (n) => n.id,
    styleEdge: styleColumnEdge,
  });
  const { allNodes, allEdges, setAllNodes, setAllEdges, selectedNode, focusedId: focusedNode, setFocusedId: setFocusedNode } = lens;

  /** §6 — each class folds by its own count into the canvas it has, in legend order. */
  const layoutColumns = useCallback((list: Node<NodeData>[], classOrder: string[]): Node<NodeData>[] => {
    if (list.length === 0) return list;
    const { width: nodeWidth, height: nodeHeight } = lensNodeSize(list.length);
    const size = graphRef.current?.canvasSize() ?? { width: 900, height: 596 };
    const positions = adaptiveColumnLayout(
      classOrder.map((key) => ({
        ids: list.filter((n) => n.data.classKey === key).map((n) => n.id),
        stagger: key === 'supplier' || key.startsWith('material-'),
      })),
      { canvasWidth: size.width, canvasHeight: size.height, nodeWidth, nodeHeight },
    );
    return list.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position }));
  }, []);

  const fetchProjects = async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase.rpc('list_projects', {
        p_user_id: user.id,
        p_user_email: user.email
      });
      
      if (error) throw error;
      setProjects(data || []);
    } catch (e) {
      console.error('Failed to fetch projects:', e);
      toast.error('Failed to load projects');
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
      setLevelCounts({});
      setLegendGroups([]);
      lens.reset();
      setMaxLevel(0);
      return;
    }

    setLoading(true);
    lens.reset();

    try {
      console.log('📡 Fetching multi-tier network data via service for project:', globalSelectedProjectId);
      
      // Use the new service function that handles RLS context properly
      const multiTierData = await fetchMultiTierNetworkData(
        globalSelectedProjectId,
        user.id,
        user.email
      );

      if (!multiTierData || multiTierData.length === 0) {
        console.log('⚠️ No multi-tier network data for selected project');
        
        // Clear visualization
        setAllNodes([]);
        setAllEdges([]);
        setLevelCounts({});
        setLegendGroups([]);
        lens.reset();
        setMaxLevel(0);

        toast.info('No process network data available. Please upload and combine your project datasets.');
        
        return;
      }

      console.log('✅ Multi-tier data response:', { 
        recordCount: multiTierData.length,
        sample: multiTierData.slice(0, 3),
        levels: [...new Set(multiTierData.map(d => d.level))].sort((a, b) => a - b),
        dataSources: [...new Set(multiTierData.map(d => d.data_source))]
      });


      // ── WP 8.3 · §4 D127, D140 — TYPE AND DEPTH COME FROM THE DATA NOW ────
      //
      // Everything below this point reads `record.level` and `nodeType`. Both were
      // wrong, for two different reasons, and this is where they are fixed once
      // rather than at each of the places that consume them.
      //
      // DEPTH. `supply_chain_data_multi_tier.level` has TWO live writers that
      // disagree (§4 D140), and the deployed one — the SQL RPC
      // `combine_project_into_supply_chain` — stamps a LITERAL 2 on every
      // `bom_multi_level` row and never reads the real depth. §15 run 35433474185
      // measured a project whose BOM is four levels deep and whose entire bom lane
      // sits at level 2: its 260 materials and 66 products rendered as ONE flat
      // column, every one of them labelled a level-2 material. `bom_multi_level.level`
      // is the real depth, neither writer touches it, and it is one read away.
      //
      // TYPE. Derived from the LANE ROLES a node actually holds, by the one rule
      // (`classify_node_echelon`, WP 8.1) rather than from a fixed ladder over an
      // integer. That is what lets a `subassembly` exist at all — §15 found 65 nodes
      // that are both a BOM target and a BOM source on the reported project, every
      // one of which the ladder called a material and the SQL called a product.
      //
      // WHY NOT `node_list.echelon`, WHICH IS THE AUTHORITY. Because the migration
      // that adds it deploys on MERGE (`supabase-migrations.yml` is
      // `branches: [main]`), so reading it today renders nothing. `typedNodesFromLanes`
      // is the declared mirror of the same rule and `echelonMirror.test.ts` parses the
      // SQL's own branch order and fails if the two diverge. When the column reaches
      // production this block becomes a `useGraphNodes` call and the mirror's only
      // caller disappears.
      const projectPlant =
        projects.find((pr) => pr.id === globalSelectedProjectId)?.plant_name ?? null;

      const { data: bomDepthRows, error: bomDepthError } = await supabase
        .from('bom_multi_level')
        .select('material_id,higher_level_component_id,level')
        .eq('project_id', globalSelectedProjectId);

      if (bomDepthError) {
        // SAID, not swallowed. A depth we could not read is rendered as unknown
        // below, and the user is told why rather than shown a flat graph (T2).
        console.error('[ProcessLevelNetwork] bom_multi_level read failed:', bomDepthError.message);
        toast.warning(
          'Could not read the bill of materials, so BOM depth is shown as unknown. ' +
            'The graph is still correct about what connects to what.',
        );
      }

      // Type from the lane ROLES, depth from `bom_multi_level`, a supplier one step
      // beyond the deepest material it feeds — one rule, shared with
      // `/interactive-network-space` (audit 2026-09-22 · F-09). A NULL depth is never
      // substituted with 0 (§4 D134).
      const placed = placeLaneNodes(multiTierData, bomDepthRows ?? [], projectPlant);

      console.log('🔄 Processing nodes and edges from multi-tier data...');

      const nodeMap: { [key: string]: NodeData } = {};
      const edgeMap: { [key: string]: Edge } = {};
      const levelNodeCounts: Record<number, number> = {};

      // ── ONE node pass, over BOTH endpoints (WP 8.3 · §4 D128) ─────────────
      //
      // There were two passes and between them they lost nodes. The first read only
      // `record.from_location`. The second read `to_location` but ONLY for outbound
      // rows at level 0, i.e. customers. So **a BOM target that is never also a BOM
      // source and never an outbound source got no node at all** — and every edge
      // pointing at it was then skipped, silently, because the edge builder requires
      // both endpoints to exist. On the reported project that is invisible only
      // because its sub-assemblies happen to be both, which is luck rather than
      // design.
      //
      // The dedup guard is also fixed here: it used to test `nodeMap[dedupKey]` while
      // writing `nodeMap[nodeId]`, so it never fired and the last row won every
      // node's level, type, lane and colour. §15 measured 466 nodes for which "last
      // row wins" was a real choice. `levelNodeCounts` was incremented inside that
      // same unreachable branch, which is why the legend counts and the level tiles
      // counted ROWS rather than nodes.
      const addNode = (rawId: string | null | undefined, record: MultiTierData) => {
        const nodeId = (rawId ?? '').trim();
        if (!nodeId) return;                 // never a node for a blank endpoint
        if (nodeMap[nodeId]) return;         // first record wins, deterministically

        const { echelon, level, bomDepth } = placed.get(nodeId) ?? {
          echelon: 'unknown' as Echelon, level: record.level, bomDepth: null,
        };

        levelNodeCounts[level] = (levelNodeCounts[level] || 0) + 1;

        nodeMap[nodeId] = {
          label: nodeId,
          echelon,
          nodeType: echelonToLegacyType(echelon),
          level,
          bomLevel: bomDepth,
          incoming: 0,
          outgoing: 0,
          flowVolume: 0,
          consumptionRate: 0,
          dataSource: record.data_source,
          isConnected: true,
          // §4 D135 — this was a literal 1.0 at five creation sites, which made the
          // amber low-confidence border unreachable: a confidence signal that could
          // only ever say "confident". It is now computed from the one thing that
          // genuinely makes a node's role uncertain — the data not placing it.
          mappingConfidence: echelon === 'unknown' ? 0 : 1,
        };
      };

      for (const record of multiTierData) {
        addNode(record.from_location, record);
        addNode(record.to_location, record);
      }

      const echelonTally = Object.values(nodeMap).reduce<Record<string, number>>((acc, n) => {
        acc[n.echelon] = (acc[n.echelon] || 0) + 1;
        return acc;
      }, {});
      console.log('📍 Nodes by echelon:', echelonTally, '· depths:', levelNodeCounts);

      console.log('📍 Created', Object.keys(nodeMap).length, 'unique nodes using corrected logic');
      console.log('📊 Level distribution:', levelNodeCounts);
      
      // Log detailed breakdown by level AND node type for verification
      const levelTypeBreakdown: Record<string, Record<string, number>> = {};
      Object.values(nodeMap).forEach(node => {
        const levelKey = `Level ${node.level}`;
        if (!levelTypeBreakdown[levelKey]) levelTypeBreakdown[levelKey] = {};
        levelTypeBreakdown[levelKey][node.nodeType] = (levelTypeBreakdown[levelKey][node.nodeType] || 0) + 1;
      });
      
      Object.entries(levelTypeBreakdown).forEach(([level, types]) => {
        const typesSummary = Object.entries(types).map(([type, count]) => `${count} ${type}`).join(', ');
        console.log(`   ${level}: ${typesSummary}`);
      });

      // ── ONE edge per pair, its weight SUMMED (§4 D306) ────────────────────
      //
      // The deep lane writes a BOM edge once per ROOT product it serves, and every
      // lane once per plant. This used to keep the FIRST row per pair and drop the
      // rest — and the read orders ties by a random uuid, so a component shared by two
      // products showed one product's share, picked arbitrarily. `sumLaneEdges` is the
      // same rule the Product-level view uses, so the two pages show one number.
      for (const e of sumLaneEdges(multiTierData)) {
        const fromNode = e.source;
        const toNode = e.target;
        if (!nodeMap[fromNode] || !nodeMap[toNode]) continue;

        nodeMap[fromNode].outgoing++;
        nodeMap[toNode].incoming++;
        nodeMap[fromNode].flowVolume += e.flow;
        nodeMap[toNode].flowVolume += e.flow;
        nodeMap[fromNode].consumptionRate += e.consumptionRate;
        nodeMap[toNode].consumptionRate += e.consumptionRate;

        // Stroke, width and arrowhead come from `styleColumnEdge`; the label
        // from the Labels toggle, at render.
        const edgeKey = `${fromNode}-${toNode}`;
        edgeMap[edgeKey] = {
          id: edgeKey,
          source: fromNode,
          target: toNode,
          label: '',
          animated: false,
          type: 'straight',
          data: {
            consumptionRate: e.consumptionRate,
            flowVolume: e.flow,
            dataSource: e.lane,
            connectionType: e.lane,
            isConnected: true,
            mappingConfidence: 1.0,
            originalLabel: flowLabel(e.flow) ||
              (e.consumptionRate > 0 ? `${e.consumptionRate.toFixed(1)}` : ''),
          },
        };
      }

      console.log('📊 Created', Object.keys(edgeMap).length, 'edges using corrected logic');

      const currentMaxLevel = Math.max(...Object.keys(levelNodeCounts).map(Number));
      setLevelCounts(levelNodeCounts);
      setMaxLevel(currentMaxLevel);

      // The deepest depth a material class reaches, which ends the depth shade.
      const materialDepth = Math.max(
        0,
        ...Object.values(nodeMap)
          .filter((n) => n.nodeType === 'material' && n.echelon !== 'unknown')
          .map((n) => n.level),
      );
      setMaxMaterialDepth(materialDepth);

      // The legend and the columns are one list, grouped by class rather than by raw
      // level — a level can hold a mix of nodeTypes (inbound suppliers this project's
      // multi-tier pipeline never tiered past level 1), which grouping by level alone
      // would silently merge into one mislabeled bucket. Flow order: suppliers,
      // materials deepest → shallowest, products, customers, then any unplaced node.
      const legendGroupMap: Record<string, { key: string; label: string; count: number; color: string; order: number }> = {};
      Object.values(nodeMap).forEach((n) => {
        const cls = processClassOf(n, materialDepth);
        n.classKey = cls.key;
        if (!legendGroupMap[cls.key]) legendGroupMap[cls.key] = { ...cls, count: 0 };
        legendGroupMap[cls.key].count++;
      });
      const legendList = Object.values(legendGroupMap).sort((a, b) => b.order - a.order);
      setLegendGroups(legendList);
      const classOrder = legendList.map((g) => g.key);
      const classColor = Object.fromEntries(legendList.map((g) => [g.key, g.color]));

      // Extract Level 1 nodes for filtering
      const level1NodeIds = Object.entries(nodeMap)
        .filter(([_, nodeData]) => nodeData.level === 1)
        .map(([nodeId, _]) => nodeId)
        .sort();
      setLevel1Nodes(level1NodeIds);

      console.log('📊 Level distribution:', levelNodeCounts);
      
      // §3 — the product-level node, now the standard here too: ReactFlow's 1px
      // outline, the id in 10px bold white, one size for every node. The old
      // variants (a 3px white border and a shadow on products, lighter borders on
      // customers and materials, red and amber rings) are gone; an unplaced node is
      // said by its own grey class instead of by a ring.
      const { width: nodeWidth, height: nodeHeight } = lensNodeSize(Object.keys(nodeMap).length);
      const nodeList: Node<NodeData>[] = classOrder.flatMap((key) =>
        Object.entries(nodeMap)
          .filter(([, d]) => d.classKey === key)
          .map(([nodeId, nodeData]) => ({
            id: nodeId,
            position: { x: 0, y: 0 },
            data: nodeData,
            style: {
              background: classColor[key],
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
          })),
      );

      // §4 — width encodes flow, as on the product lens.
      const edgeList = Object.values(edgeMap);
      const flowMax = maxFlow(edgeList.map((e) => ({ flow: Number(e.data?.flowVolume) || 0 })));
      edgeList.forEach((e) => {
        e.data = { ...e.data, width: edgeWidthForFlow(Number(e.data?.flowVolume) || 0, flowMax) };
      });

    // ── Analytics: level stats ──────────────────────────────────────────
    const levelStatMap: Record<number, {
      count: number; totalIn: number; totalOut: number; totalFlow: number;
    }> = {};

    Object.values(nodeMap).forEach((n) => {
      const l = n.level;
      if (!levelStatMap[l]) levelStatMap[l] = { count: 0, totalIn: 0, totalOut: 0, totalFlow: 0 };
      levelStatMap[l].count++;
      levelStatMap[l].totalIn    += n.incoming;
      levelStatMap[l].totalOut   += n.outgoing;
      levelStatMap[l].totalFlow  += n.flowVolume;
    });

    const computedLevelStats: LevelStats[] = Object.entries(levelStatMap)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([lvl, s]) => {
        const l = Number(lvl);
        return {
          level: l,
          displayType: depthBucketLabel(l),
          count: s.count,
          avgIn:   Math.round((s.totalIn   / s.count) * 10) / 10,
          avgOut:  Math.round((s.totalOut  / s.count) * 10) / 10,
          avgFlow: Math.round( s.totalFlow / s.count),
          color: depthBucketColor(l, materialDepth),
        };
      });
    setLevelStats(computedLevelStats);

    // ── Analytics: top flow nodes ───────────────────────────────────────
    const topNodes = Object.entries(nodeMap)
      .map(([id, n]) => ({ id, flow: n.flowVolume, level: n.level, echelon: n.echelon }))
      .sort((a, b) => b.flow - a.flow)
      .slice(0, 10);
    setTopFlowNodes(topNodes);
    const firstType = topNodes.length > 0 ? depthBucketLabel(topNodes[0].level) : '';
    setTopFlowFilter(firstType);

      setAllNodes(layoutColumns(nodeList, classOrder));
      setAllEdges(edgeList);
      setClassOrder(classOrder);
      setLoadNonce((k) => k + 1);
      
      console.log('✅ Integrated process visualization updated with', nodeList.length, 'nodes and', Object.keys(edgeMap).length, 'edges');
      
      // Count by node type for summary
      const typeCounts = Object.values(nodeMap).reduce((acc, node) => {
        acc[node.nodeType] = (acc[node.nodeType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Enhanced success message with connection statistics  
      const connectedNodes = Object.values(nodeMap).filter(node => node.isConnected).length;
      const totalNodes = Object.values(nodeMap).length;
      const customerConnectionCount = multiTierData.filter(d => d.level === 0 && d.data_source === 'outbound').length;
      
      toast.success(`Loaded process network: ${typeCounts.supplier || 0} suppliers → ${typeCounts.material || 0} materials → ${typeCounts.product || 0} products → ${typeCounts.customer || 0} customers (${connectedNodes}/${totalNodes} connected, ${customerConnectionCount} customer connections)`);
    } catch (e) {
      console.error('❌ fetchData error:', e);
      
      // Clear visualization on error
      setAllNodes([]);
      setAllEdges([]);
      setLevelCounts({});
      setLegendGroups([]);
      lens.reset();
      setMaxLevel(0);

      toast.error('Failed to load network data. Please check your connection and try again.');
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

  // Reset Level 1 filter when project changes
  useEffect(() => {
    setSelectedLevel1Node(null);
    setIsLevel1FilterActive(false);
    setReachableNodes(new Set());
  }, [globalSelectedProjectId]);

  // ── WP 10.1 · §4 D239 — REACHABILITY IS READ, NOT RECOMPUTED ──────────────
  //
  // A level-hopping walk ran here in the browser on every Level-1 selection: it
  // depended on the order rows arrived in (a node's level was whichever row set it
  // last) and stopped at level 5. It is now a STORED analysis, `process_structure`,
  // computed where the data is and keyed on the PROCESS level hash — so it is
  // computed once per process graph, and every later load is a read. For each
  // Level-1 node it holds the nodes reachable downstream (following arcs) and
  // upstream (against them), transitively.
  const [structure, setStructure] = useState<{
    projectId: string;
    reachable: Record<string, { downstream?: string[]; upstream?: string[] }>;
    cacheHit: boolean;
    computedAt: string | null;
    inputHash: string | null;
    inProgress: boolean;
  } | null>(null);
  const [structureState, setStructureState] = useState<NetworkAnalysisState>('loading');

  useEffect(() => {
    let alive = true;
    setStructure(null);
    setStructureState('loading');
    if (!user?.id || !globalSelectedProjectId) return;
    (async () => {
      const { data, error } = await supabase.rpc('process_structure', {
        p_project_id: globalSelectedProjectId,
        _actor_user_id: user.id,
      });
      if (!alive) return;
      if (error) {
        console.error('[ProcessLevelNetwork] process_structure failed:', error.message);
        setStructureState('unavailable');
        return;
      }
      const d = (data ?? {}) as { reachable?: Record<string, { downstream?: string[]; upstream?: string[] }>; cache_hit?: boolean; finished_at?: string | null; started_at?: string | null; input_hash?: string | null; in_progress?: boolean };
      setStructureState(d.in_progress ? 'in progress' : d.input_hash ? 'current' : 'unknown');
      setStructure({
        projectId: globalSelectedProjectId,
        reachable: d.reachable ?? {},
        cacheHit: Boolean(d.cache_hit),
        computedAt: d.finished_at ?? d.started_at ?? null,
        inputHash: d.input_hash ?? null,
        inProgress: Boolean(d.in_progress),
      });
    })();
    return () => {
      alive = false;
    };
  }, [user?.id, globalSelectedProjectId, loadNonce]);

  // Handle Level 1 node selection
  const handleLevel1NodeSelect = useCallback((nodeId: string | null) => {
    // Treat 'all' as null (clear filter)
    const actualNodeId = nodeId === 'all' ? null : nodeId;
    setSelectedLevel1Node(actualNodeId);

    if (actualNodeId) {
      const entry = structure?.reachable?.[actualNodeId];
      if (!entry) {
        toast.info(structure
          ? `No stored reachability for ${actualNodeId} — it is not a Level 1 node of this process network.`
          : 'Reachability is still being computed for this graph; try again in a moment.');
        setReachableNodes(new Set());
        setIsLevel1FilterActive(false);
        return;
      }
      setReachableNodes(new Set([actualNodeId, ...(entry.downstream ?? []), ...(entry.upstream ?? [])]));
      setIsLevel1FilterActive(true);
      toast.success(`Filtered to show nodes reachable from Level 1 node: ${actualNodeId}`);
    } else {
      setReachableNodes(new Set());
      setIsLevel1FilterActive(false);
    }
  }, [structure]);

  // Audit 2026-09-22 · F-10: "Resilience" was `0.4 + 0.6(1 - HHI)`, floored at 0.4
  // with a red alert on `< 0.4` that no input could reach, and "Bottlenecks" counted
  // `level === 1` nodes as "assembly steps" no table describes. Both are DELETED; a
  // resilience measure is the engine's to compute. F-35: the unrendered diagnostics
  // routine (the page's last read of the deprecated lane `level`) went with them.
  const mobileProcessMetrics = useMemo(() => {
    const totalNodes = allNodes.length;
    const networkDepth = Object.keys(levelCounts).length;
    // Path concentration: HHI of flow volumes across top-flow nodes
    const flows = topFlowNodes.map(n => n.flow);
    const totalFlow = flows.reduce((s, f) => s + f, 0);
    let pathConc = 0;
    if (totalFlow > 0) flows.forEach(f => { const s = f / totalFlow; pathConc += s * s; });
    return {
      totalNodes,
      networkDepth,
      pathConcentration: totalFlow > 0 ? pathConc.toFixed(3) : '—',
    };
  }, [allNodes, levelCounts, topFlowNodes]);

  // The Labels toggle hides node ids and edge flow labels without touching the
  // data, so the details card and the search still read the real id.
  const displayNodes = useMemo(
    () => (showLabels ? lens.nodes : lens.nodes.map((n) => ({ ...n, style: { ...n.style, color: 'transparent' } }))),
    [lens.nodes, showLabels],
  );
  const displayEdges = useMemo(
    () => lens.edges.map((e) => ({ ...e, label: showLabels ? ((e.data?.originalLabel as string) || '') : '' })),
    [lens.edges, showLabels],
  );

  const classOf = useMemo(
    () => new globalThis.Map(legendGroups.map((g) => [g.key, g])),
    [legendGroups],
  );

  // §9 — the visible set, so search keeps working inside a focus and a filter.
  const searchCandidates = useMemo(
    () =>
      lens.visibleNodes.map((n) => {
        const cls = classOf.get(n.data.classKey ?? '');
        return { id: n.id, label: n.id, color: cls?.color ?? colorForEchelon(null), classLabel: cls?.label ?? '' };
      }),
    [lens.visibleNodes, classOf],
  );

  const maxBomDepth = useMemo(
    () => allNodes.reduce<number | null>((m, n) => (n.data.bomLevel != null ? Math.max(m ?? 0, n.data.bomLevel) : m), null),
    [allNodes],
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
          title="Product Structure — Multi-level BOM Network"
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
          title="Product Structure — Multi-level BOM Network"
          rightContent={
            /* `gap-2` rather than `space-x-2`: `space-x-*` puts its margin on
               the DOM children, so it would land on the `md:contents` wrapper
               below instead of on the controls inside it and collapse the
               desktop spacing. `gap` is inherited correctly through
               `display:contents`, and for this single-line row the two
               produce the same 8px. */
            <div className="flex items-center gap-2">
              {/* Spec 4.1 caps the mobile right slot at three controls, and
                  every control in this group drives the network graph or the
                  analytics panel, both of which are `hidden md:` on this page.
                  Below `md` the header therefore holds refresh + the project
                  select only; `md:contents` hands each control straight back
                  to the same flex row on desktop, unchanged. */}
              <span className="hidden md:contents">
              {/* Level 1 Node Filter */}
              {level1Nodes.length > 0 && (
                <>
              <Select value={selectedLevel1Node || 'all'} onValueChange={handleLevel1NodeSelect}>
                <SelectTrigger className={cn('h-11 md:h-9 w-[160px]', HDR_FILTER_SELECT)}>
                  <SelectValue placeholder="Level 1 Filter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Nodes</SelectItem>
                      {level1Nodes.map((nodeId) => (
                        <SelectItem key={nodeId} value={nodeId}>
                          {nodeId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {isLevel1FilterActive && (
                    <Button
                      onClick={() => handleLevel1NodeSelect(null)}
                      variant="outline"
                      size="sm"
                      className={cn('text-muted-foreground hover:text-foreground', HDR_OUTLINE_BUTTON)}
                    >
                      Clear Filter
                    </Button>
                  )}
                </>
              )}

              <Button
                onClick={() => setShowLabels(!showLabels)}
                variant={showLabels ? "default" : "outline"}
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
              
              {selectedNode && (
                <Button
                  onClick={() => setDisruptionDialogOpen(true)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    'gap-1 border-orange-600 text-orange-600 hover:bg-orange-50 hover:text-orange-700',
                    HDR_OUTLINE_BUTTON,
                    'md:border-border md:text-[#ea580c] md:hover:text-[#ea580c]',
                  )}
                >
                  <AlertTriangle className="h-4 w-4" />
                  <span className="hidden sm:inline">Add disruption event</span>
                </Button>
              )}
              
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
            <LensChip tone="teal">Process level</LensChip>
          </div>

          <LensHowToRead
            scope="Shop-floor dependencies from this project's multi-tier records — suppliers, materials, process steps and products — ordered by level from raw material through to customer."
            findings="The ten highest-flow nodes are ranked below. A level-1 node among them is a manufacturing or assembly step, and the highest-flow one is reported as the constraint on the critical path."
            columns={[
              { term: 'Node', def: 'The process step, material or product this row measures.' },
              { term: 'Type', def: 'Which of those it is, read from its level in the multi-tier data.' },
              { term: 'Flow', def: 'Total weighted volume across the edges touching the node.' },
              { term: 'In', def: 'Edges arriving at the node.' },
              { term: 'Out', def: 'Edges leaving the node.' },
            ]}
          />

          <LensDesktopOnlyNote>
            The process graph, its labels and the level analytics are desktop
            surfaces. Open this lens on a larger screen to explore them; the
            findings below are the same on both.
          </LensDesktopOnlyNote>

          {/* §13.4 — the numbers band. A stat grid is its own container and
              carries no head; the figures name themselves. */}
          <LensStructure
            items={[
              { label: 'Nodes', value: mobileProcessMetrics.totalNodes > 0 ? String(mobileProcessMetrics.totalNodes) : '—' },
              { label: 'Network depth', value: mobileProcessMetrics.networkDepth > 0 ? String(mobileProcessMetrics.networkDepth) : '—' },
              { label: 'Critical path', value: '—' },
            ]}
          />

          <LensSection label="Structural risk" counter="3" tone="primary" lens="teal">
            <LensRisk
              rows={[
                { label: 'Critical path', value: '—' },
                { label: 'Utilisation headroom', value: '—' },
                { label: 'Path concentration', value: mobileProcessMetrics.pathConcentration },
              ]}
            />
          </LensSection>

          <LensSection label="Centrality" lens="teal" counter={topFlowNodes.length ? String(Math.min(20, topFlowNodes.length)) : undefined}>
            <LensTable
              loading={loading}
              columns={[
                { key: 'node', label: 'Node' },
                { key: 'type', label: 'Type' },
                { key: 'flow', label: 'Flow', align: 'right' },
                { key: 'in', label: 'In', align: 'right' },
                { key: 'out', label: 'Out', align: 'right' },
              ]}
              rows={topFlowNodes.slice(0, 20).map(n => {
                const node = allNodes.find(an => an.id === n.id);
                // `||`, not `??`: the graph blanks every node label while the
                // Labels toggle is off (line 683), and that toggle is a
                // desktop-graph control. `??` kept the empty string, so the
                // identifying column rendered blank on every row.
                const label = node?.data?.label || n.id;
                return {
                  key: n.id,
                  id: String(label),
                  cells: [
                    { text: labelForEchelon(n.echelon as Echelon) },
                    { text: n.flow.toLocaleString(), primary: true },
                    { text: String((node?.data?.incoming as number) ?? 0) },
                    { text: String((node?.data?.outgoing as number) ?? 0) },
                  ],
                };
              })}
              empty="No process network data. Select a project, then upload and combine its datasets."
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
        {globalSelectedProjectId && (
          <div className="mb-3 hidden md:flex">
            <GraphVersionChip
              level="process"
              projectId={globalSelectedProjectId}
              metricsComputedAt={structure?.computedAt ?? null}
              outcome={structure ? (structure.inProgress ? 'in progress' : structure.cacheHit ? 'reused' : 'computed') : null}
              analysisState={loading ? 'loading' : structure && structure.projectId !== globalSelectedProjectId ? 'loading' : structureState}
              analysisHash={structure?.inputHash ?? null}
              refreshKey={`${loadNonce}:${structure?.inputHash ?? ''}:${structureState}`}
            />
          </div>
        )}
        <div className="hidden md:grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <GraphCard
            ref={graphRef}
            legend={legendGroups}
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={lens.onNodesChange}
            onNodeClick={lens.onNodeClick}
            onNodeDoubleClick={lens.onNodeDoubleClick}
            onNodeDragStart={lens.onNodeDragStart}
            onPaneClick={lens.onPaneClick}
            onResetLayout={() => setAllNodes((current) => layoutColumns(current, classOrder))}
            fitKey={`${globalSelectedProjectId}|${loadNonce}|${focusedNode ?? ''}|${selectedLevel1Node ?? ''}`}
            hint="Click a component to see details • Double-click to focus on process chain"
            storageKey="suresuite.lens.process.graphHeight"
            overlay={
              loading ? (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/80">
                  <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 animate-spin text-[var(--hair-quiet)]" />
                    <p className="text-[12.5px] text-[var(--hair-quiet)]">Loading process network data…</p>
                  </div>
                </div>
              ) : allNodes.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
                  <div className="max-w-[360px] text-center">
                    <AlertTriangle className="mx-auto h-8 w-8 text-[var(--hair-quiet)]" />
                    <h3 className="mt-3 text-[13px] font-semibold">No process network data</h3>
                    <p className="mt-1 text-[12.5px] text-[var(--hair-quiet)]">
                      {globalSelectedProjectId
                        ? "This project doesn't have multi-tier supply chain data uploaded yet. Upload it to see the visualization."
                        : 'Select a project to view its multi-level bill of materials.'}
                    </p>
                  </div>
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
                { label: 'BOM depth', value: maxBomDepth ?? '—' },
                { label: 'Products', value: legendGroups.find((g) => g.key === 'product')?.count ?? 0 },
              ]}
            />
            <LensDetails
              title="Component details"
              emptyText="Click a component to view details"
              selected={
                selectedNode
                  ? {
                      name: selectedNode.id,
                      classLabel: classOf.get(selectedNode.data.classKey ?? '')?.label ?? labelForEchelon(selectedNode.data.echelon),
                      classColor: classOf.get(selectedNode.data.classKey ?? '')?.color ?? colorForEchelon(selectedNode.data.echelon),
                      rows: [
                        { label: 'Node ID', value: selectedNode.id },
                        // WP 8.5 · §4 D140. This is the lane's own `level` ordinate,
                        // and TWO live writers disagree about what it means — so it
                        // is labelled as the raw column it is rather than as a
                        // process level or a BOM depth, neither of which it reliably
                        // carries.
                        { label: 'Lane level (raw)', value: selectedNode.data.level },
                        { label: 'Data source', value: selectedNode.data.dataSource },
                        { label: 'Incoming connections', value: selectedNode.data.incoming },
                        { label: 'Outgoing connections', value: selectedNode.data.outgoing },
                        { label: 'Total connections', value: selectedNode.data.incoming + selectedNode.data.outgoing },
                        {
                          label: 'Flow volume',
                          value: selectedNode.data.flowVolume.toLocaleString('en-US', { maximumFractionDigits: 0 }),
                        },
                        {
                          label: 'Consumption rate',
                          value: selectedNode.data.consumptionRate?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '—',
                        },
                        {
                          // F-10's class: this was a ladder over `level` that printed
                          // "Manufacturing" and "Direct Supplier" — nouns no table holds.
                          label: 'Chain position',
                          value:
                            labelForEchelon(selectedNode.data.echelon) +
                            (selectedNode.data.bomLevel != null ? ` · BOM depth ${selectedNode.data.bomLevel}` : ''),
                        },
                      ],
                    }
                  : null
              }
              focus={
                selectedNode
                  ? {
                      label: 'Focus process chain',
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
              subtitle="Where the flow concentrates, and how connected each BOM depth is."
              meta={`${allNodes.length} nodes · ${allEdges.length} edges`}
            />

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <LensCard title="Top nodes by flow volume" subtitle="Nodes handling the most weighted flow">
                <div className="flex flex-wrap gap-1 pb-3">
                  {Array.from(new Set(topFlowNodes.map(n => depthBucketLabel(n.level)))).map(type => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setTopFlowFilter(type)}
                      className={cn(
                        'h-11 rounded-[3px] border px-2 text-[11px] md:h-6',
                        topFlowFilter === type
                          ? 'border-[var(--brand-ink)] bg-[var(--brand-ink)] text-white'
                          : cn(LENS.border, 'bg-white', LENS.muted, LENS.hoverControl),
                      )}
                    >
                      {type}
                    </button>
                  ))}
                </div>
                <BarRows
                  empty="No nodes for this type"
                  rows={topFlowNodes
                    .filter(n => topFlowFilter === '' || depthBucketLabel(n.level) === topFlowFilter)
                    .map(n => ({
                      key: n.id,
                      label: n.id,
                      value: n.flow,
                      display: n.flow.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                      color: depthBucketColor(n.level, maxMaterialDepth),
                    }))}
                />
              </LensCard>

              <LensCard
                title="Level connectivity summary"
                subtitle="Average connections and flow per level — reveals structural thinness or concentration"
              >
                <table className="w-full text-[12.5px] tabular-nums">
                  <thead>
                    <tr className={cn('border-b', LENS.hairline)}>
                      {['Level', 'Type', 'Nodes', 'Avg in', 'Avg out', 'Avg flow'].map((h, i) => (
                        <th
                          key={h}
                          className={cn('pb-2 pr-3 font-mono text-[10px] font-normal uppercase tracking-[0.16em]', LENS.muted, i >= 2 ? 'text-right' : 'text-left')}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {levelStats.map(l => (
                      <tr key={l.level} className={cn('border-b last:border-0', LENS.hairline, LENS.hoverTableRow)}>
                        <td className="py-[9px] pr-3">{l.level}</td>
                        <td className="py-[9px] pr-3">
                          <span
                            className="inline-block whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[11px] font-medium"
                            style={{ background: l.color + '22', color: l.color }}
                          >
                            {l.displayType}
                          </span>
                        </td>
                        <td className="py-[9px] pr-3 text-right">{l.count}</td>
                        <td className="py-[9px] pr-3 text-right">{l.avgIn}</td>
                        <td className="py-[9px] pr-3 text-right">{l.avgOut}</td>
                        <td className="py-[9px] text-right">{l.avgFlow.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </LensCard>
            </div>
          </div>
        )}
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
      </div>
    </PageLayout>
  );
}
