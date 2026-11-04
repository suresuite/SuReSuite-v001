// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { listProjectsCached } from '@/lib/projects/projectsCache';
import { useEffect, useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  NodeMouseHandler,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useGlobalProject } from '@/hooks/useGlobalProject';
import { fetchMultiTierNetworkData } from '@/services/network';
import {
  placeLaneNodes,
  echelonToLegacyType,
  colorForEchelon,
  labelForEchelon,
  GRAPH_INK,
  ECHELONS,
  type Echelon,
} from '@/lib/graph';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  RefreshCw,
  Network,
  Search,
  AlertTriangle,
  Tag,
  HelpCircle,
  Target,
} from 'lucide-react';
import {
  PageLayout,
  PageHeader,
  ProjectSelector,
  PAGE_GUTTER,
  HDR_OUTLINE_BUTTON,
  HDR_PROJECT_SELECT,
} from '@/components/shared';

/*
 * Colour is the ECHELON, from the one palette (`@/lib/graph`). This page used to
 * carry a level ramp and a type table of its own, and type a node with the integer
 * ladder `getNodeTypeFromLevel` over `supply_chain_data_multi_tier.level` — which
 * the deployed ETL stamped 2 on every BOM row, so every product and sub-assembly
 * rendered as a material while `/process-level-network` called it a product
 * (audit 2026-09-22 · F-09 · §4 D127). Both pages now place nodes with
 * `placeLaneNodes`, so they cannot disagree about the same node.
 */

const HIGHLIGHT_HEX = '#ff0000';

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
  echelon: Echelon;
  nodeType: 'supplier' | 'material' | 'product' | 'customer';
  level: number;
  bomLevel: number | null;
  incoming: number;
  outgoing: number;
  flowVolume: number;
  consumptionRate: number | null;
  dataSource: string;
  isConnected: boolean;
  mappingConfidence: number | null;
}

interface NetworkVisualizationProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

interface QueryParams {
  searchTerm: string;
  dir: 'both' | 'up' | 'down';
  hops: number | 'infinity';
  stopUp: number[];
  stopDown: number[];
  minFlow: number;
  levelRange: { min: number; max: number } | null;
  includeTerminals: boolean;
}

// Advanced query parsing
function parseAdvancedQuery(input: string): QueryParams {
  const defaultParams: QueryParams = {
    searchTerm: '',
    dir: 'both',
    hops: 'infinity',
    stopUp: [5, 6],
    stopDown: [-1],
    minFlow: 0,
    levelRange: null,
    includeTerminals: false,
  };

  // Extract main search term (everything before first parameter)
  const paramMatch = input.match(/^([^a-z:]*?)(?:\s+[a-z]+:|$)/);
  const searchTerm = paramMatch ? paramMatch[1].trim() : input.trim();
  
  // Parse parameters
  const params = { ...defaultParams, searchTerm };
  
  // dir: both | up | down
  const dirMatch = input.match(/dir:\s*(\w+)/);
  if (dirMatch && ['both', 'up', 'down'].includes(dirMatch[1])) {
    params.dir = dirMatch[1] as 'both' | 'up' | 'down';
  }
  
  // hops: N or ∞
  const hopsMatch = input.match(/hops:\s*(\d+|∞|infinity)/);
  if (hopsMatch) {
    params.hops = hopsMatch[1] === '∞' || hopsMatch[1] === 'infinity' 
      ? 'infinity' 
      : parseInt(hopsMatch[1]);
  }
  
  // stopUp: comma list
  const stopUpMatch = input.match(/stopUp:\s*([\d,\s]+)/);
  if (stopUpMatch) {
    params.stopUp = stopUpMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }
  
  // stopDown: comma list
  const stopDownMatch = input.match(/stopDown:\s*([\d,-\s]+)/);
  if (stopDownMatch) {
    params.stopDown = stopDownMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }
  
  // minFlow: number
  const minFlowMatch = input.match(/minFlow:\s*(\d+(?:\.\d+)?)/);
  if (minFlowMatch) {
    params.minFlow = parseFloat(minFlowMatch[1]);
  }
  
  // level: a..b
  const levelMatch = input.match(/level:\s*(-?\d+)\.\.(-?\d+)/);
  if (levelMatch) {
    params.levelRange = {
      min: parseInt(levelMatch[1]),
      max: parseInt(levelMatch[2]),
    };
  }
  
  // includeTerminals: on | off
  const terminalsMatch = input.match(/includeTerminals:\s*(on|off)/);
  if (terminalsMatch) {
    params.includeTerminals = terminalsMatch[1] === 'on';
  }
  
  return params;
}

// Subgraph extraction with reachability
function extractSubgraph(
  allNodes: Node<NodeData>[],
  allEdges: Edge[],
  queryParams: QueryParams
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  if (!queryParams.searchTerm) {
    return { nodes: allNodes, edges: allEdges };
  }
  
  // Find matching nodes
  const rootNodes = allNodes.filter(node => 
    node.data?.label?.toLowerCase().includes(queryParams.searchTerm.toLowerCase())
  );
  
  if (rootNodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  
  const visitedNodes = new Set<string>();
  const resultNodeIds = new Set<string>();
  const resultEdges: Edge[] = [];
  
  // Create adjacency maps
  const upstreamMap = new Map<string, string[]>();
  const downstreamMap = new Map<string, string[]>();
  
  allEdges.forEach(edge => {
    if (!downstreamMap.has(edge.source)) downstreamMap.set(edge.source, []);
    if (!upstreamMap.has(edge.target)) upstreamMap.set(edge.target, []);
    downstreamMap.get(edge.source)!.push(edge.target);
    upstreamMap.get(edge.target)!.push(edge.source);
  });
  
  // BFS traversal function
  const traverse = (startNodeIds: string[], direction: 'up' | 'down', maxHops: number) => {
    const queue: { nodeId: string; hops: number }[] = startNodeIds.map(id => ({ nodeId: id, hops: 0 }));
    const visited = new Set<string>();
    
    while (queue.length > 0) {
      const { nodeId, hops } = queue.shift()!;
      
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      resultNodeIds.add(nodeId);
      
      const currentNode = allNodes.find(n => n.id === nodeId);
      if (!currentNode) continue;
      
      // Check if we should stop at this level
      const currentLevel = currentNode.data?.level;
      if (direction === 'up' && queryParams.stopUp.includes(currentLevel)) {
        if (queryParams.includeTerminals) {
          // Include terminal node but don't expand further
          continue;
        }
      }
      if (direction === 'down' && queryParams.stopDown.includes(currentLevel)) {
        if (queryParams.includeTerminals) {
          continue;
        }
      }
      
      // Check hop limit
      if (queryParams.hops !== 'infinity' && hops >= queryParams.hops) continue;
      
      // Get neighbors based on direction
      const neighbors = direction === 'up' 
        ? (upstreamMap.get(nodeId) || [])
        : (downstreamMap.get(nodeId) || []);
      
      neighbors.forEach(neighborId => {
        if (!visited.has(neighborId)) {
          const edge = allEdges.find(e => 
            (direction === 'up' && e.source === neighborId && e.target === nodeId) ||
            (direction === 'down' && e.source === nodeId && e.target === neighborId)
          );
          
          // Apply flow filter
          if (edge && queryParams.minFlow > 0) {
            const flowVolume = (edge.data?.flowVolume as number) || 0;
            if (flowVolume < queryParams.minFlow) return;
          }
          
          queue.push({ nodeId: neighborId, hops: hops + 1 });
        }
      });
    }
  };
  
  // Start traversal from root nodes
  const rootNodeIds = rootNodes.map(n => n.id);
  
  // Add root nodes
  rootNodeIds.forEach(id => resultNodeIds.add(id));
  
  // Traverse based on direction
  if (queryParams.dir === 'both' || queryParams.dir === 'up') {
    traverse(rootNodeIds, 'up', queryParams.hops === 'infinity' ? 100 : queryParams.hops as number);
  }
  if (queryParams.dir === 'both' || queryParams.dir === 'down') {
    traverse(rootNodeIds, 'down', queryParams.hops === 'infinity' ? 100 : queryParams.hops as number);
  }
  
  // Filter nodes and edges based on results
  const filteredNodes = allNodes.filter(node => {
    if (!resultNodeIds.has(node.id)) return false;
    
        // Apply level range filter
        if (queryParams.levelRange) {
          const level = node.data?.level as number;
          if (level < queryParams.levelRange.min || level > queryParams.levelRange.max) {
            return false;
          }
        }
    
    return true;
  });
  
  const filteredEdges = allEdges.filter(edge => 
    resultNodeIds.has(edge.source) && resultNodeIds.has(edge.target)
  );
  
  return { nodes: filteredNodes, edges: filteredEdges };
}

export default function InteractiveNetworkSpace({ isCollapsed, setIsCollapsed }: NetworkVisualizationProps) {
  const { user } = useAuth();
  const { globalSelectedProjectId, setGlobalSelectedProjectId } = useGlobalProject();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [focusedNode, setFocusedNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node<NodeData> | null>(null);
  const [loading, setLoading] = useState(false);
  const [levelCounts, setLevelCounts] = useState<Record<number, number>>({});
  const [echelonCounts, setEchelonCounts] = useState<Partial<Record<Echelon, number>>>({});
  const [allNodes, setAllNodes] = useState<Node<NodeData>[]>([]);
  const [allEdges, setAllEdges] = useState<Edge[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [searchInput, setSearchInput] = useState<string>('');
  const [showHelp, setShowHelp] = useState(false);
  const [maxLevel, setMaxLevel] = useState(0);
  const [showLabels, setShowLabels] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const fetchProjects = async () => {
    if (!user) return;
    
    try {
      setProjects(await listProjectsCached(user));
    } catch (e) {
      console.error('Failed to fetch projects:', e);
      toast.error('Failed to load projects');
    }
  };

  const checkDataAvailability = async (projectId: string): Promise<boolean> => {
    try {
      const { data, error } = await supabase
        .from('supply_chain_data_multi_tier')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId);

      if (error) throw error;
      return (data as any) > 0;
    } catch (e) {
      console.warn('Could not check data availability:', e);
      return true; // Assume data exists if check fails
    }
  };

  const fetchData = async () => {
    console.log('🔍 fetchData called with:', { 
      hasUser: !!user, 
      selectedProject: globalSelectedProjectId
    });

    if (!user || !globalSelectedProjectId) {
      console.log('❌ Clearing data - no user or project');
      setNodes([]);
      setEdges([]);
      setAllNodes([]);
      setAllEdges([]);
      setLevelCounts({});
      setEchelonCounts({});
      setSelectedNode(null);
      setFocusedNode(null);
      setMaxLevel(0);
      setDataError(null);
      return;
    }

    setLoading(true);
    setDataError(null);
    
    try {
      // Check data availability first
      console.log('🔍 Checking data availability for project:', globalSelectedProjectId);
      const hasData = await checkDataAvailability(globalSelectedProjectId);
      
      if (!hasData) {
        setDataError('No multi-tier data found for this project. Please upload and combine your datasets first.');
        setNodes([]);
        setEdges([]);
        setAllNodes([]);
        setAllEdges([]);
        setLevelCounts({});
        setEchelonCounts({});
        setSelectedNode(null);
        setFocusedNode(null);
        setMaxLevel(0);
        toast.warning('No multi-tier network data available for this project.');
        return;
      }
      
      console.log('📡 Fetching multi-tier network data via service for project:', globalSelectedProjectId);
      
      // Try primary method first
      let multiTierData;
      try {
        multiTierData = await fetchMultiTierNetworkData(
          globalSelectedProjectId,
          user.id,
          user.email
        );
      } catch (primaryError) {
        console.warn('🔄 Primary fetch failed, trying RPC fallback:', primaryError);
        
        // Fallback to RPC call with explicit context
        try {
          const { data, error } = await supabase.rpc('get_multi_tier_network_data', {
            p_project_id: globalSelectedProjectId,
            p_user_id: user.id,
            p_user_email: user.email
          });
          
          if (error) throw error;
          multiTierData = data;
        } catch (rpcError) {
          console.error('🔄 RPC fallback also failed:', rpcError);
          throw new Error(`Data loading failed: ${primaryError.message || 'Unknown error'}`);
        }
      }

      if (!multiTierData || multiTierData.length === 0) {
        console.log('⚠️ No multi-tier network data for selected project');
        
        setDataError('No network data found for this project. Please ensure your datasets are properly combined.');
        setNodes([]);
        setEdges([]);
        setAllNodes([]);
        setAllEdges([]);
        setLevelCounts({});
        setEchelonCounts({});
        setSelectedNode(null);
        setFocusedNode(null);
        setMaxLevel(0);
        
        toast.info('No network data available. Please upload and combine your project datasets.');
        return;
      }

      console.log('✅ Multi-tier data response:', { 
        recordCount: multiTierData.length,
        sample: multiTierData.slice(0, 3),
        levels: [...new Set(multiTierData.map(d => d.level))].sort((a: number, b: number) => a - b),
        dataSources: [...new Set(multiTierData.map(d => d.data_source))]
      });

      console.log('🔄 Processing nodes and edges from multi-tier data...');

      const nodeMap: { [key: string]: NodeData } = {};
      const edgeMap: { [key: string]: Edge } = {};
      const levelNodeCounts: Record<number, number> = {};

      // Type, depth and position from ONE rule shared with `/process-level-network`
      // (audit 2026-09-22 · F-09): echelon from the lane roles, depth from
      // `bom_multi_level` (never from the lane's `level`, §4 D140), customers at -1,
      // suppliers one step beyond the deepest material they feed.
      const projectPlant =
        projects.find((pr) => pr.id === globalSelectedProjectId)?.plant_name ?? null;
      const { data: bomDepthRows, error: bomDepthError } = await supabase
        .from('bom_multi_level')
        .select('material_id,higher_level_component_id,level')
        .eq('project_id', globalSelectedProjectId);
      if (bomDepthError) {
        // SAID, not swallowed (T2): an unread depth renders as unknown, not as 0.
        console.error('[InteractiveNetworkSpace] bom_multi_level read failed:', bomDepthError.message);
        toast.warning(
          'Could not read the bill of materials, so BOM depth is shown as unknown. ' +
            'The graph is still correct about what connects to what.',
        );
      }
      const placed = placeLaneNodes(multiTierData, bomDepthRows ?? [], projectPlant);

      // One pass over BOTH endpoints: a BOM target that is never a source still gets
      // a node, and the first record naming a node wins deterministically (§4 D128).
      const addNode = (rawId: string | null | undefined, record: MultiTierData) => {
        const nodeId = (rawId ?? '').trim();
        if (!nodeId || nodeMap[nodeId]) return;
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
          mappingConfidence: echelon === 'unknown' ? 0 : 1,
        };
      };
      for (const record of multiTierData) {
        addNode(record.from_location, record);
        addNode(record.to_location, record);
      }

      console.log('📍 Created', Object.keys(nodeMap).length, 'unique nodes using corrected logic');
      console.log('📊 Level distribution:', levelNodeCounts);

      // Create edges
      const edgeSet = new Set<string>();
      
      multiTierData.forEach((record) => {
        const fromNode = record.from_location;
        const toNode = record.to_location;
        
        if (fromNode && toNode && fromNode !== toNode && nodeMap[fromNode] && nodeMap[toNode]) {
          const edgeKey = `${fromNode}-${toNode}`;
          
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            
            nodeMap[fromNode].outgoing++;
            nodeMap[toNode].incoming++;
            
            const weightedValue = record.weighted || 0;
            const consumptionRate = record.material_consumption_rate || 0;
            
            nodeMap[fromNode].flowVolume += weightedValue;
            nodeMap[toNode].flowVolume += weightedValue;
            nodeMap[fromNode].consumptionRate += consumptionRate;
            nodeMap[toNode].consumptionRate += consumptionRate;

            const strokeColor = GRAPH_INK.edge;
            const strokeWidth = 1.5;

            edgeMap[edgeKey] = {
              id: edgeKey,
              source: fromNode,
              target: toNode,
              label: '',
              style: {
                stroke: strokeColor,
                strokeWidth,
                strokeOpacity: 0.6,
              },
              animated: false,
              type: 'straight',
              data: { 
                consumptionRate: consumptionRate,
                flowVolume: weightedValue,
                dataSource: record.data_source,
                connectionType: record.data_source,
                isConnected: true,
                mappingConfidence: 1.0,
                originalLabel: weightedValue > 0 ? `${Math.round(weightedValue)}` : 
                               consumptionRate > 0 ? `${consumptionRate.toFixed(1)}` : ''
              },
            };
          }
        }
      });

      console.log('📊 Created', Object.keys(edgeMap).length, 'edges using corrected logic');

      setLevelCounts(levelNodeCounts);
      setEchelonCounts(
        Object.values(nodeMap).reduce<Partial<Record<Echelon, number>>>((acc, n) => {
          acc[n.echelon] = (acc[n.echelon] ?? 0) + 1;
          return acc;
        }, {}),
      );
      setMaxLevel(Math.max(...Object.keys(levelNodeCounts).map(Number)));

      console.log('📊 Level distribution:', levelNodeCounts);
      
      // Layout positioning logic
      
      const nodesByLevel: Record<number, string[]> = {};
      Object.entries(nodeMap).forEach(([nodeId, nodeData]) => {
        const level = nodeData.level;
        if (!nodesByLevel[level]) nodesByLevel[level] = [];
        nodesByLevel[level].push(nodeId);
      });

      const nodeList: Node<NodeData>[] = [];
      const columnX = isCollapsed ? 150 : 220;
      const columnGap = 350;
      const baseRowGap = 60;
      const startY = 100;

      // One column per ordinate, deepest on the left and customers (-1) on the right.
      // The ordinate is the real BOM depth now (F-09), not the fixed six-step ladder
      // this map used to hard-code — which placed any BOM not exactly four deep wrong.
      const sortedLevels = Object.keys(nodesByLevel).map(Number).sort((a, b) => b - a);
      const deepest = sortedLevels[0] ?? 0;

      sortedLevels.forEach((level) => {
        const levelNodes = nodesByLevel[level];
        const columnIndex = deepest - level;
        const x = columnX + columnIndex * columnGap;
        
        const totalNodes = Object.keys(nodeMap).length;
        let baseNodeSize = Math.max(50 - Math.log(totalNodes) * 3, 30);
        
        if (level === 0) baseNodeSize *= 1.1;
        if (level === -1) baseNodeSize *= 1.2;

        const nodeCount = levelNodes.length;
        const dynamicRowGap = baseRowGap * Math.max(1, Math.log(nodeCount + 1) / 2);

        levelNodes.forEach((nodeId, index) => {
          const nodeData = nodeMap[nodeId];
          
          const subgroupSize = Math.ceil(Math.sqrt(nodeCount));
          const subgroupIndex = Math.floor(index / subgroupSize);
          const indexInSubgroup = index % subgroupSize;
          
          const isOffsetGroup = subgroupIndex % 2 === 1;
          const additionalY = isOffsetGroup ? dynamicRowGap * 0.5 : 0;
          const staggeredY = subgroupIndex * (dynamicRowGap * 0.3);
          
          const y = startY + indexInSubgroup * dynamicRowGap + additionalY + staggeredY;

          const color = colorForEchelon(nodeData.echelon);
          
          const reactFlowNode: Node<NodeData> = {
            id: nodeId,
            position: { x, y },
            data: nodeData,
            type: 'default',
            style: {
              backgroundColor: color,
              color: 'white',
              border: '1px solid #333',
              borderRadius: '8px',
              fontSize: '10px',
              width: baseNodeSize,
              height: baseNodeSize,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: '4px',
              wordWrap: 'break-word',
              overflow: 'hidden',
            },
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
          };
          
          nodeList.push(reactFlowNode);
        });
      });

      const edgeList = Object.values(edgeMap);
      
      setAllNodes(nodeList);
      setAllEdges(edgeList);
      setNodes(nodeList);
      setEdges(edgeList);

      console.log('✅ Created visualization with', nodeList.length, 'nodes and', edgeList.length, 'edges');
      
    } catch (error: any) {
      console.error('❌ Error in fetchData:', error);
      toast.error(`Failed to load network data: ${error.message}`);
      
      setNodes([]);
      setEdges([]);
      setAllNodes([]);
      setAllEdges([]);
    } finally {
      setLoading(false);
    }
  };

  // Handle search and filtering
  const handleSearch = useCallback(() => {
    if (!searchInput.trim()) {
      setNodes(allNodes);
      setEdges(allEdges);
      return;
    }

    const queryParams = parseAdvancedQuery(searchInput);
    const { nodes: filteredNodes, edges: filteredEdges } = extractSubgraph(
      allNodes,
      allEdges,
      queryParams
    );

    setNodes(filteredNodes);
    setEdges(filteredEdges);
    
    toast.success(`Found ${filteredNodes.length} nodes and ${filteredEdges.length} connections`);
  }, [searchInput, allNodes, allEdges]);

  // Help content
  const helpContent = `Feature: Find a node, fetch data to visualize its subgraph using reachability with terminal levels—we expand upstream (suppliers) and downstream (customers) from your selection, then stop at terminal tiers (e.g., suppliers L5/L6, customers L-1).

How to use: Type a name or ID, then refine with options:
• dir: both | up | down (direction of traversal)
• hops: N or ∞ (max steps; default ∞)
• stopUp: comma list (e.g., 5,6)
• stopDown: comma list (e.g., -1)
• minFlow: number (hide weak links)
• level: a..b (keep only these levels)
• includeTerminals: on | off (show end nodes but don't expand)

Examples:
• Model X dir:down stopDown:-1
• Cathode Mix dir:both hops:3 stopUp:5,6 minFlow:10
• ACME Plant dir:up includeTerminals:on

Result: We return the induced subgraph (nodes + edges) matching your filters, laid out automatically for quick inspection.`;

  useEffect(() => {
    if (user) {
      fetchProjects();
    }
  }, [user]);

  useEffect(() => {
    fetchData();
  }, [user, globalSelectedProjectId]);

  useEffect(() => {
    const updatedEdges = allEdges.map(edge => ({
      ...edge,
      label: showLabels ? (edge.data?.originalLabel as string) || '' : '',
    }));
    setEdges(updatedEdges);
  }, [showLabels, allEdges]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  const onNodeClick: NodeMouseHandler = useCallback((event, node) => {
    setSelectedNode(node as Node<NodeData>);
  }, []);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((event, node) => {
    setFocusedNode(node.id);
  }, []);

  if (!user) {
    return <div className="p-4 text-center">Please log in to access the Interactive Network Space.</div>;
  }

  return (
    <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
      <div className={PAGE_GUTTER}>
        {/* The three controls that sit in a "Controls" row under the search
            card are the bar's right slot from `md` up (handoff, Interactive
            Network Space row): Show Labels · Refresh · project select. Same
            handlers, same conditions — only their home and their height
            change, and the project select becomes the product-wide 200 × 36
            box instead of this page's one-off <ProjectSelector>.

            This page renders one tree at both widths and the handoff is
            desktop-only, so the move is a `md:contents` / `md:hidden` pair:
            above `md` these three are the header's slot and the Controls row
            is gone; below it the row is exactly what it was and the header is
            title-only. */}
        <PageHeader
          title="Interactive Network Space"
          rightContent={
            <span className="hidden md:contents">
              <Button
                onClick={() => setShowLabels(!showLabels)}
                variant="outline"
                size="sm"
                className={cn('gap-2', HDR_OUTLINE_BUTTON)}
              >
                <Tag className="h-4 w-4" />
                {showLabels ? 'Hide Labels' : 'Show Labels'}
              </Button>
              <Button
                onClick={fetchData}
                disabled={loading}
                variant="outline"
                size="sm"
                className={cn('gap-2', HDR_OUTLINE_BUTTON)}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Select
                value={globalSelectedProjectId || ''}
                onValueChange={setGlobalSelectedProjectId}
              >
                <SelectTrigger className={cn('h-11 md:h-9', HDR_PROJECT_SELECT)}>
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
            </span>
          }
        />

        <div className="flex gap-4 overflow-hidden">
          <div className="flex-1 flex flex-col gap-4 min-w-0">
            {/* Enhanced Search Bar */}
            <Card>
              <CardContent className="p-4">
                <div className="flex gap-2 items-center">
                  <div className="flex-1 relative">
                    <Input
                      type="text"
                      placeholder="Search components, products, suppliers… (type ? for options) or give hint or autocompletion"
                      value={searchInput}
                      onChange={(e) => {
                        setSearchInput(e.target.value);
                        if (e.target.value.includes('?')) {
                          setShowHelp(true);
                        }
                      }}
                      onFocus={() => setShowHelp(true)}
                      onBlur={() => setTimeout(() => setShowHelp(false), 200)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleSearch();
                        }
                      }}
                      className="pl-10"
                    />
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                  </div>
                  <Button onClick={handleSearch} size="sm">
                    <Target className="h-4 w-4 mr-2" />
                    Extract
                  </Button>
                  <Button 
                    onClick={() => {
                      setSearchInput('');
                      setNodes(allNodes);
                      setEdges(allEdges);
                    }} 
                    variant="outline" 
                    size="sm"
                  >
                    Reset
                  </Button>
                  <Button
                    onClick={() => setShowHelp(!showHelp)}
                    variant="ghost"
                    size="sm"
                  >
                    <HelpCircle className="h-4 w-4" />
                  </Button>
                </div>
                
                {/* Help Panel */}
                {showHelp && (
                  <div className="mt-4 p-4 bg-muted rounded-lg">
                    <pre className="text-sm whitespace-pre-wrap font-mono">{helpContent}</pre>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Controls — below `md` only; above it these three live in the
                page header (see PageHeader above). */}
            <div className="flex items-center gap-2 md:hidden">
              <ProjectSelector
                projects={projects}
                selectedProjectId={globalSelectedProjectId}
                onProjectSelect={setGlobalSelectedProjectId}
              />
              <Button
                onClick={fetchData}
                disabled={loading}
                variant="outline"
                size="sm"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button
                onClick={() => setShowLabels(!showLabels)}
                variant="outline"
                size="sm"
              >
                <Tag className="h-4 w-4 mr-2" />
                {showLabels ? 'Hide Labels' : 'Show Labels'}
              </Button>
            </div>

            {/* Network Visualization */}
            <Card className="flex-1 min-h-0">
              <CardContent className="p-0 h-full">
                {loading ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
                      <p>Loading interactive network space...</p>
                    </div>
                  </div>
                ) : nodes.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-center">
                    <div>
                      <Network className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                      <h3 className="text-lg font-semibold mb-2">No Network Data</h3>
                      <p className="text-muted-foreground mb-4">
                        Select a project and upload your supply chain data to start exploring.
                      </p>
                    </div>
                  </div>
                ) : (
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={onNodeClick}
                    onNodeDoubleClick={onNodeDoubleClick}
                    fitView
                    fitViewOptions={{ padding: 0.1 }}
                  >
                    <Background />
                    <Controls />
                    <MiniMap />
                  </ReactFlow>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="w-80 flex flex-col gap-4">
            {/* Search Results Summary */}
            {searchInput && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Search Results</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Query:</span>
                    <code className="bg-muted px-1 rounded text-xs">{searchInput}</code>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Nodes:</span>
                    <Badge variant="secondary">{nodes.length}</Badge>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Connections:</span>
                    <Badge variant="secondary">{edges.length}</Badge>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Selected node details */}
            {selectedNode && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Node Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div><strong>ID:</strong> {selectedNode.id}</div>
                  <div><strong>Label:</strong> {selectedNode.data.label}</div>
                  <div><strong>Type:</strong> {labelForEchelon(selectedNode.data.echelon)}</div>
                  <div><strong>BOM depth:</strong> {selectedNode.data.bomLevel ?? 'not in the BOM'}</div>
                  <div><strong>Column (level queries):</strong> {selectedNode.data.level}</div>
                  <div><strong>Incoming Edges:</strong> {selectedNode.data.incoming}</div>
                  <div><strong>Outgoing Edges:</strong> {selectedNode.data.outgoing}</div>
                  <div><strong>Flow Volume:</strong> {selectedNode.data.flowVolume.toFixed(2)}</div>
                  <div><strong>Consumption Rate:</strong> {selectedNode.data.consumptionRate?.toFixed(2)}</div>
                  <div><strong>Data Source:</strong> {selectedNode.data.dataSource}</div>
                </CardContent>
              </Card>
            )}

            {/* Network Legend */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Interactive Network Legend</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {ECHELONS.filter((e) => (echelonCounts[e] ?? 0) > 0).map((echelon) => (
                  <div key={echelon} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded border border-gray-400"
                        style={{ backgroundColor: colorForEchelon(echelon) }}
                      />
                      <span className="text-sm">{labelForEchelon(echelon)}</span>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {echelonCounts[echelon]}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Instructions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">How to Use</CardTitle>
              </CardHeader>
              <CardContent className="text-xs space-y-2">
                <p>• Type node names or IDs in the search bar</p>
                <p>• Use advanced parameters for precise filtering</p>
                <p>• Click "Extract" to visualize subgraphs</p>
                <p>• Double-click nodes to focus on them</p>
                <p>• Use "Reset" to return to full network view</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
