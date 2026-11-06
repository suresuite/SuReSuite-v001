// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Download, FileText, AlertTriangle, X, FileUp, Database } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
// The ONE unit table (PLAN.md §4 D10, invariant I3). Never restate it here.
import { unitDays } from '../../supabase/functions/_shared/grading.ts';
// The CSV ingestion spec, GENERATED from the data contract (WP 3.2). The wizard
// reads it to know which datasets go through `ingest-file`'s landing; it never
// restates a header, a required flag or a rule.
import { INGEST_DATASETS } from '../../supabase/functions/_shared/ingestSpec.generated.ts';
// WP 3.4 — the wizard lands a file and then hands the RUN to the review screen.
// The same component serves an MRP sync; nothing here branches on source_kind.
import { edgeErrorMessage } from '@/lib/ingest/edgeError';
import { IngestRunReview } from '@/components/ingest/IngestRunReview';
import { useIngestRun } from '@/hooks/useIngestRun';

const SMALL_TXT = 'text-[11px] leading-tight';
const CELL_PAD = 'py-1 px-2';       // compact body cells
const HEAD_CELL_PAD = 'py-1 px-2';   // ultra-compact header cells

interface BaseRow {
  plant_name?: string;
  project_id?: string;
}

interface BomSingleLevelRow extends BaseRow {
  product_id: string;
  material_id: string;
  consumption_rate: number;
}

interface BomMultiLevelRow extends BaseRow {
  material_id: string;
  level: number;
  higher_level_component_id: string | null;
  consumption_rate: number;
}

interface InboundLogisticsRow extends BaseRow {
  supplier_id: string;
  material_id: string;
  volume: number;
  time_unit: string;
  lead_time: number;
  unit_price: number;
}

interface OutboundLogisticsRow extends BaseRow {
  customer_id: string;
  product_id: string;
  volume: number;
  time_unit: string;
  expected_lead_time: number;
  unit_price: number;
}


interface NodeListRow extends BaseRow {
  node_id: string;
  description_text?: string;
  location_text?: string;
  longitude?: number;
  latitude?: number;
}


interface DeepNodeRow extends BaseRow {
  uid: string;
  depth?: number;
  name?: string;
  country?: string;
  industry?: string;
  website?: string;
  traded_as?: string;
  number_of_employees?: number;
  revenue?: number;
  lat?: number;
  long?: number;
  is_seed?: boolean;
}

interface DeepEdgeRow extends BaseRow {
  src_uid: string;
  dst_uid: string;
  relation_type?: string;
  relative_revenue?: number;
  relative_revenue_percentage?: number;
  depth?: number;
  direction?: string;
}


type DataRow =
  | BomSingleLevelRow
  | BomMultiLevelRow
  | InboundLogisticsRow
  | OutboundLogisticsRow
  | NodeListRow
  | DeepNodeRow
  | DeepEdgeRow;

interface TemplateType {
  id: string;
  name: string;
  description: string;
  templateFile: string;
  guideFile: string;
  expectedHeaders: string[];
  /**
   * Columns the parser keeps and the template offers but does NOT require.
   * `expectedHeaders` is the required-column gate — a column added there rejects
   * every file that predates it — so an optional column belongs here instead.
   */
  optionalHeaders?: string[];
  category: string;
}

interface Project {
  id: string;
  name: string;
  plant_name: string;
  supply_chain_model: string;
  bom_level: string;
  completed: boolean;
  created_at: string;
  modeler_id: string;
  modeler_name: string;
  simulation_start?: string | null;
  simulation_end?: string | null;
  deep_tier_enabled?: boolean;
}

/** `ingest_runs.mapping_warnings`' shape, and scsim's MappingWarning's. */
interface ParseFinding {
  level: 'error' | 'warn' | 'info';
  field: string | null;
  code: string;
  message: string;
  row?: number;
}

/**
 * What `ingest-file` reports after a landing. WP 3.4 REMOVED `rows_promoted`
 * from it, and the absence is the change: the landing no longer promotes. It
 * stages the rows, computes the diff against the project's current data, and
 * returns a run for somebody to look at — because §10's design point is that
 * the diff exists BEFORE the decision, and because the role gate is unreachable
 * while the upload itself writes tier 2.
 */
interface IngestRunSummary {
  run_id: string;
  file_id: string;
  content_sha256: string;
  target: string;
  rows_read: number;
  rows_staged: number;
  rows_new: number | null;
  rows_changed: number | null;
  rows_unchanged: number | null;
  rows_superseded: number | null;
  rows_held: number | null;
  /** False when the diff did not run: every row reads "not compared", never "new". */
  diffed: boolean;
  findings: ParseFinding[];
  findings_truncated: number;
}

interface UploadWizardProps {
  onUploadComplete: () => void;
  userId: string;
  selectedProject: Project | null;
  onClose: () => void;
}

/**
 * The review screen bound to one run. A component rather than three hooks in
 * the wizard's body, so that the run's own loading state does not entangle the
 * upload form's — and so the same panel can be mounted anywhere a run id is
 * known (an MRP sync's status page is the obvious second caller).
 */
function IngestRunPanel({
  runId,
  userId,
  onPromoted,
}: {
  runId: string;
  userId: string | null;
  onPromoted: () => void;
}) {
  const { run, file, rows, actorRole, canPromote, busy, error, recompute, promote } =
    useIngestRun(runId, userId);
  const { toast } = useToast();

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription className={SMALL_TXT}>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!run) return null;

  return (
    <IngestRunReview
      run={run}
      file={file}
      rows={rows}
      canPromote={canPromote}
      roleLabel={actorRole}
      busy={busy}
      onRecompute={() => void recompute()}
      onPromote={async () => {
        const applied = await promote();
        if (!applied) return;
        toast({
          title: `${applied.rows_promoted} row(s) promoted`,
          description:
            `${applied.rows_new} new · ${applied.rows_changed} changed · ` +
            `${applied.rows_unchanged} rewritten unchanged` +
            (Number(applied.rows_held) > 0 ? ` · ${applied.rows_held} still held back` : ''),
        });
        onPromoted();
      }}
    />
  );
}

const UploadWizard = ({
  onUploadComplete,
  userId,
  selectedProject,
  onClose,
}: UploadWizardProps) => {
  const [selectedDataset, setSelectedDataset] = useState<string>('bom');
  const [file, setFile] = useState<File | null>(null);
  const [csvData, setCsvData] = useState<DataRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  // Row findings at level `warn`: the row lands, and the person is told why it
  // is worth a second look (a zero `unit_price` is read by the engine as 1.0).
  // Shown beside the errors, never blocking the upload the way an error does.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  // The parse is a network round trip now, so the button has to say so.
  const [isParsing, setIsParsing] = useState(false);
  // WP 3.2: the wizard is an uploader and a STATUS VIEW. This is the status.
  const [lastRun, setLastRun] = useState<IngestRunSummary | null>(null);
  const [deepTierFormat, setDeepTierFormat] = useState<'csv' | 'json'>('csv');
  const [itemMasterType, setItemMasterType] =
    useState<'materials' | 'products' | 'suppliers' | 'customers'>('materials');
  
  // Deep tier CSV specific states
  const [nodesFile, setNodesFile] = useState<File | null>(null);
  const [edgesFile, setEdgesFile] = useState<File | null>(null);
  const [nodesData, setNodesData] = useState<DeepNodeRow[]>([]);
  const [edgesData, setEdgesData] = useState<DeepEdgeRow[]>([]);
  const [nodesErrors, setNodesErrors] = useState<string[]>([]);
  const [edgesErrors, setEdgesErrors] = useState<string[]>([]);

  const { toast } = useToast();
  const { user } = useAuth();

  const templateTypes: TemplateType[] = [
    {
      id: 'bom_single_level',
      name: 'BOM Single Level',
      description: 'Single-level Bill of Materials data',
      templateFile: '/template/bom_single_level.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['product_id', 'material_id', 'consumption_rate'],
      category: 'bom',
    },
    {
      id: 'bom_multi_level',
      name: 'BOM Multi Level',
      description: 'Multi-level Bill of Materials data with hierarchy',
      templateFile: '/template/bom_multi_level.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: [
        'material_id',
        'level',
        'consumption_rate',
      ],
      category: 'bom',
    },
    {
      id: 'inbound_logistics',
      name: 'Inbound Logistics',
      description: 'Inbound supply network data from suppliers',
      templateFile: '/template/inbound_logistic.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: [
        'supplier_id',
        'material_id',
        'volume',
        'time_unit',
        'lead_time',
        'unit_price',
      ],
      // D9: `lead_time_unit` is OPTIONAL and therefore not in expectedHeaders —
      // that list is the required-column gate, and putting it there would reject
      // every CSV anyone has ever uploaded. Blank means weeks, which is what the
      // engine has always assumed (project_map.py::_duration_to_weeks); supplying
      // it is how a lead time quoted in days stops being read as weeks.
      // PLAN.md §26 WP 16.2 — the lane's own lead-time shape: a distribution and
      // only the parameters it reads, the bounds in `lead_time_unit` like the
      // lead time. All optional; a lane with none follows its material's shape.
      optionalHeaders: ['lead_time_unit', 'lead_time_dist', 'lead_time_cv', 'lead_time_min', 'lead_time_mode', 'lead_time_max'],
      category: 'inbound',
    },
    {
      id: 'outbound_logistics',
      name: 'Outbound Logistics',
      description: 'Outbound distribution data to customers',
      templateFile: '/template/outbound_logistic.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: [
        'customer_id',
        'product_id',
        'volume',
        'time_unit',
        'expected_lead_time',
        'unit_price',
      ],
      // PLAN.md §24 WP 14.2 — the row's own demand spec. OPTIONAL, like
      // `lead_time_unit` inbound: a file without them is today's file, and the
      // row keeps its product's distribution scaled by its share. The rates are
      // in the row's `time_unit` and land weekly (normalized at promotion).
      optionalHeaders: ['demand_distribution', 'demand_mean', 'demand_variation', 'demand_min', 'demand_max'],
      category: 'outbound',
    },
    {
      // PLAN.md §24 WP 14.2 — the forecast series per customer × product. One
      // row per week or calendar month; a month is spread evenly over its own
      // days at promotion (ADR 0002 decision 7) and the review screen says so.
      id: 'demand_forecasts',
      name: 'Demand Forecast',
      description: 'Forecast quantity per customer × product, per week or per month — the centre the run draws demand around',
      templateFile: '/template/demand_forecasts.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['customer_id', 'product_id', 'period_start', 'quantity'],
      optionalHeaders: ['time_unit'],
      category: 'outbound',
    },
    {
      id: 'item_master_materials',
      name: 'Materials Master',
      description: 'Per-material economics the simulation reads (cost, MOQ, holding, lead-time shape)',
      templateFile: '/template/materials.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: [
        'material_id',
        'name',
        'cost',
        'holding_cost_pct',
        'moq',
        'initial_on_hand',
        'lead_time_dist',
        'lead_time_cv',
      ],
      category: 'item-master',
    },
    {
      id: 'item_master_products',
      name: 'Products Master',
      description: 'Per-product economics the simulation reads (price, capacity, demand shape, fulfillment mode)',
      templateFile: '/template/products.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: [
        'product_id',
        'name',
        'sell_price',
        'production_capacity',
        'fulfillment_mode',
        'demand_distribution',
        'demand_mean',
        'demand_cv',
      ],
      // PLAN.md §24 WP 14.4 — the FG policy and levels of an MTS product, and its
      // FG opening stock (engine RFC 4). Optional: an MTO product leaves them blank.
      // PLAN.md §26 WP 16.5 — P-P.13 production lead time: a duration in
      // `production_lead_time_unit` (blank = weeks), its shape and parameters.
      optionalHeaders: [
        'fg_policy', 'fg_base_stock', 'fg_reorder_point', 'fg_cover_days', 'fg_initial_on_hand',
        'production_lead_time', 'production_lead_time_unit', 'production_lead_time_dist',
        'production_lead_time_cv', 'production_lead_time_min', 'production_lead_time_mode', 'production_lead_time_max',
      ],
      category: 'item-master',
    },
    {
      id: 'item_master_suppliers',
      name: 'Suppliers Master',
      description: 'Per-supplier capacity and reliability the simulation reads',
      templateFile: '/template/suppliers.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['supplier_id', 'name', 'capacity_per_week', 'reliability_score'],
      category: 'item-master',
    },
    {
      // §4 D108 — the demand-side counterpart of the suppliers master, and the
      // surface §4 D94's declaration forced. `P-C.2 customer_allocation` reads
      // `segment` and `priority_weight` on every run and nothing in this product
      // could set either, so WP 6.1's G4 gate ("no engine-read field is
      // unreachable by both the grid and every upload") fired on the commit that
      // declared them. It was right: this is the missing surface, not a gate to
      // relax.
      //
      // `sla_fill_floor_pct` was deliberately NOT offered until PLAN.md §24 WP
      // 14.3: no engine field carried it (§4 D95), so a header for it would have
      // been a column that changes nothing (§4 D18). The engine has somewhere to
      // put it now — `Customer.sla_fill_floor_pct`, each of the customer's rows'
      // default service target under the sla_tier rule — so it is offered.
      id: 'item_master_customers',
      name: 'Customers Master',
      description: 'Per-customer segment, allocation priority and contracted fill floor the simulation reads under scarcity',
      templateFile: '/template/customers.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['customer_id'],
      optionalHeaders: ['name', 'segment', 'priority_weight', 'sla_fill_floor_pct'],
      category: 'item-master',
    },
    {
      id: 'node_list',
      name: 'Node List',
      description: 'Node list data with locations and descriptions',
      templateFile: '', // No template file, users work with downloaded data
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['node_id'],
      category: 'node-list',
    },
    {
      id: 'tier2_suppliers',
      name: 'Tier-2 Suppliers',
      description: 'Tier-2 supplier relationship data',
      templateFile: '/template/tier2_suppliers.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['supplier_id', 'upstream_supplier_id', 'material_id', 'relationship_type'],
      category: 'tier2',
    },
    {
      id: 'tier3_suppliers',
      name: 'Tier-3 Suppliers',
      description: 'Tier-3 supplier relationship data',
      templateFile: '/template/tier3_suppliers.csv',
      guideFile: '/docs/csv-upload-guide.md',
      expectedHeaders: ['supplier_id', 'upstream_supplier_id', 'material_id', 'relationship_type'],
      category: 'tier3',
    },
    {
      id: 'network_nodes',
      name: 'Deep Tier Nodes',
      description: 'Firm-level network nodes (deep tiers)',
      templateFile: '/template/nodes.csv',
      guideFile: '/docs/location-dataset-guide.md',
      expectedHeaders: ['uid'],
      category: 'deep',
    },
    {
      id: 'network_edges',
      name: 'Deep Tier Edges',
      description: 'Firm-level network edges (deep tiers)',
      templateFile: '/template/edges.csv',
      guideFile: '/docs/location-dataset-guide.md',
      expectedHeaders: ['src_uid','dst_uid'],
      category: 'deep',
    },
    {
      id: 'deep_tier_json',
      name: 'Deep Tier Network (JSON)',
      description: 'Complete network data in single JSON file',
      templateFile: '/template/summary.json',
      guideFile: '/docs/nexus-node.md',
      expectedHeaders: [],
      category: 'deep',
    },
  ];

  const datasetTabs = [
    { id: 'bom', name: 'BOM' },
    { id: 'inbound', name: 'Inbound' },
    { id: 'outbound', name: 'Outbound' },
    { id: 'item-master', name: 'Item Master' },
    { id: 'node-list', name: 'Node List' },
    ...(selectedProject?.deep_tier_enabled ? [
      { id: 'deep_tier', name: 'Deep Tier Network' }
    ] : [])
  ];

  const getSelectedTemplate = () => {
    if (selectedDataset === 'bom') {
      return selectedProject?.bom_level === 'single' ? 'bom_single_level' : 'bom_multi_level';
    } else if (selectedDataset === 'inbound') {
      return 'inbound_logistics';
    } else if (selectedDataset === 'outbound') {
      return 'outbound_logistics';
    } else if (selectedDataset === 'item-master') {
      return `item_master_${itemMasterType}`;
    } else if (selectedDataset === 'node-list') {
      return 'node_list';
    } else if (selectedDataset === 'tier2') {
      return 'tier2_suppliers';
    } else if (selectedDataset === 'tier3') {
      return 'tier3_suppliers';
    } else if (selectedDataset === 'deep_tier') {
      return deepTierFormat === 'csv' ? 'network_nodes' : 'deep_tier_json';
    }
    return '';
  };

  const selectedTemplate = getSelectedTemplate();

  const validateData = async (
    data: DataRow[],
    template: TemplateType
  ): Promise<string[]> => {
    const errors: string[] = [];

    // Item masters: only the id column is required — economics columns may be
    // left empty (empty = engine default / unlimited). Enum columns must hold
    // values the engine accepts (scsim/scsim/io/project_map.py).
    const ITEM_MASTER_ENUMS: Record<string, string[]> = {
      fulfillment_mode: ['mto', 'mts'],
      demand_distribution: ['triangular', 'deterministic', 'poisson', 'negbin'],
      lead_time_dist: ['deterministic', 'lognormal', 'gamma'],
    };
    const requiredHeaders =
      template.category === 'item-master'
        ? [template.expectedHeaders[0]] // material_id / product_id / supplier_id
        : template.expectedHeaders;

    data.forEach((row, index) => {
      requiredHeaders.forEach((header) => {
        if (row[header as keyof DataRow] === undefined || row[header as keyof DataRow] === '') {
          errors.push(`Row ${index + 2}: Missing required field "${header}"`);
        }
      });

      // D9/D10: the unit must be one the ONE unit table knows. The list is not
      // restated here — `unitDays` is the canonical table's own lookup, so this
      // check cannot drift from the engine or from the column's CHECK constraint.
      const leadUnit = (row as Record<string, unknown>).lead_time_unit;
      if (leadUnit != null && leadUnit !== '' && unitDays(String(leadUnit)) === undefined) {
        errors.push(
          `Row ${index + 2}: Invalid lead_time_unit "${leadUnit}" — use day, week, ` +
          `month, quarter or year. Leave it blank to mean weeks.`
        );
      }

      if (template.category === 'item-master') {
        Object.entries(ITEM_MASTER_ENUMS).forEach(([field, allowed]) => {
          const value = (row as Record<string, unknown>)[field];
          if (value && !allowed.includes(String(value).toLowerCase())) {
            errors.push(
              `Row ${index + 2}: Invalid ${field} "${value}" — allowed: ${allowed.join(', ')}`
            );
          }
        });
      }

      // Special validation for multi-level BOM
      if (template.id === 'bom_multi_level') {
        const bomRow = row as BomMultiLevelRow;
        // higher_level_component_id is optional for root components (level 0)
        if (bomRow.level !== 0 && (!bomRow.higher_level_component_id || bomRow.higher_level_component_id === '')) {
          errors.push(`Row ${index + 2}: Non-root components (level > 0) must have a higher_level_component_id`);
        }
      }

      if (template.id === 'bom_single_level' || template.id === 'bom_multi_level') {
        const bomRow = row as BomSingleLevelRow | BomMultiLevelRow;
        if (bomRow.consumption_rate && bomRow.consumption_rate <= 0) {
          errors.push(`Row ${index + 2}: Consumption rate must be positive`);
        }
      }

      if (template.id === 'bom_multi_level') {
        const bomRow = row as BomMultiLevelRow;
        if (bomRow.level && bomRow.level < 0) {
          errors.push(`Row ${index + 2}: Level must be non-negative`);
        }
      }

      if (template.id === 'inbound_logistics' || template.id === 'outbound_logistics') {
        const logRow = row as InboundLogisticsRow | OutboundLogisticsRow;
        if (logRow.volume && logRow.volume < 0) {
          errors.push(`Row ${index + 2}: Volume must be non-negative`);
        }
        if (logRow.unit_price && logRow.unit_price < 0) {
          errors.push(`Row ${index + 2}: Unit price must be non-negative`);
        }
      }
    });

    return errors;
  };

  const parseJSON = (content: string): { nodes: DeepNodeRow[], edges: DeepEdgeRow[] } => {
    try {
      const data = JSON.parse(content);
      
      if (!data.nodes || !data.edges) {
        throw new Error('JSON must contain "nodes" and "edges" arrays');
      }

      const nodes: DeepNodeRow[] = data.nodes.map((node: any) => ({
        ...node,
        plant_name: selectedProject?.plant_name,
        project_id: selectedProject?.id,
      }));

      const edges: DeepEdgeRow[] = data.edges.map((edge: any) => ({
        ...edge,
        plant_name: selectedProject?.plant_name,
        project_id: selectedProject?.id,
      }));

      return { nodes, edges };
    } catch (error) {
      throw new Error(`Invalid JSON format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  /**
   * THE CLIENT DOES NOT PARSE CSV ANY MORE (Phase 3 / WP 3.2, D6/D7/D8/D46).
   *
   * What used to be here was `content.split('\n')` and `line.split(',')`, three
   * times over — once for the main file and once each for the deep-tier nodes and
   * edges. A quoted comma split a field in half and shifted every column after it
   * left; a CRLF file left a carriage return on the last value of every row; a BOM
   * made the first header unrecognisable. All three copies are gone. `ingest-file`
   * parses the bytes with a real RFC 4180 parser and, for a dataset the data
   * contract describes, validates them against the contract's own rules before a
   * single row is landed.
   *
   * This is the DRY RUN: nothing is stored and no run is opened. It exists so
   * that choosing a file still shows a preview and its problems immediately,
   * which is what the client-side parse bought and what deleting it must not cost.
   */
  const parseOnServer = async (
    uploadedFile: File,
    datasetId: string,
  ): Promise<{ rows: Record<string, string>[]; findings: ParseFinding[]; described: boolean }> => {
    if (!selectedProject?.id) throw new Error('Select a project before uploading a file.');
    if (!user?.id) throw new Error('You must be signed in to upload a file.');

    const body = new FormData();
    body.append('file', uploadedFile);
    body.append('dataset', datasetId);
    body.append('project_id', selectedProject.id);
    body.append('user_id', user.id);
    body.append('mode', 'parse');

    const { data, error } = await supabase.functions.invoke('ingest-file', { body });
    if (error) throw new Error(await edgeErrorMessage(error, 'The file could not be read.'));
    if (!data?.success) {
      const findings: ParseFinding[] = data?.findings ?? [];
      throw new Error(findings.map((f) => f.message).join('\n') || data?.error || 'The file could not be read.');
    }
    return { rows: data.rows ?? [], findings: data.findings ?? [], described: Boolean(data.described) };
  };

  /**
   * The typing the datasets this package does NOT land still expect.
   *
   * For the six datasets the contract describes, the server types every cell from
   * `ingest.rule` and this function is never reached. For the item masters, the
   * node list and the two deep-tier network tables it is, because their bulk RPCs
   * take numbers where the file has text, and their tables are not described yet
   * (they are deferred to WP 4.2). It is the old coercion, kept verbatim so that
   * moving the PARSE server-side does not also change what those paths insert —
   * and it moves into the contract when those tables are described.
   */
  const LEGACY_NUMERIC_HEADERS = [
    'consumption_rate','level','volume','lead_time','unit_price','expected_lead_time','longitude','latitude',
    'depth','relative_revenue','relative_revenue_percentage','lat','long','number_of_employees','revenue',
    'cost','holding_cost_pct','moq','initial_on_hand','lead_time_cv',
    'sell_price','production_capacity','demand_mean','demand_cv',
    'capacity_per_week','reliability_score',
  ];

  const applyLegacyTyping = (row: Record<string, string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === '__line') continue;
      if (LEGACY_NUMERIC_HEADERS.includes(key)) {
        if (value === '') { out[key] = null; continue; }
        const num = Number(value);
        out[key] = Number.isFinite(num) ? num : null;
      } else if (key === 'is_seed') {
        out[key] = ['true', '1', 'yes'].includes(String(value).toLowerCase());
      } else if ((key === 'higher_level_component_id' || key === 'lead_time_unit') && value === '') {
        // D9: blank `lead_time_unit` means weeks, and NULL is how that is spelled.
        out[key] = null;
      } else {
        out[key] = value;
      }
    }
    out.plant_name = selectedProject?.plant_name;
    out.project_id = selectedProject?.id;
    return out;
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (!uploadedFile) return;

    setIsParsing(true);
    setLastRun(null);
    setWarnings([]);
    try {
      if (selectedDataset === 'deep_tier' && deepTierFormat === 'json') {
        // JSON, not CSV. `JSON.parse` is a real parser and was never the defect;
        // the deep-tier tables are WP 4.2's to describe, so this path is
        // unchanged (§16).
        if (!uploadedFile.name.endsWith('.json')) {
          setErrors(['Please upload a JSON file']);
          return;
        }
        const content = await uploadedFile.text();
        const { nodes, edges } = parseJSON(content);
        setFile(uploadedFile);
        setCsvData([...nodes, ...edges] as DataRow[]);
        setErrors([]);
        setWarnings([]);
        return;
      }

      if (!uploadedFile.name.endsWith('.csv')) {
        setErrors(['Please upload a CSV file']);
        return;
      }

      const targetTemplate = templateTypes.find((t) => t.id === selectedTemplate);
      if (!targetTemplate) return;

      const { rows, findings, described } = await parseOnServer(uploadedFile, selectedTemplate);
      const data = rows.map(applyLegacyTyping) as DataRow[];

      setFile(uploadedFile);
      setCsvData(data);

      if (described) {
        // The server validated against the contract. Re-checking here would be a
        // second copy of the rules, which is the defect the contract exists to
        // end — so the findings are shown as they came back.
        setErrors(findings.filter((f) => f.level === 'error').map((f) => f.message));
        setWarnings(findings.filter((f) => f.level === 'warn' && f.row != null).map((f) => f.message));
      } else {
        setErrors(await validateData(data, targetTemplate));
      }
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Failed to read the file']);
    } finally {
      setIsParsing(false);
    }
  };

  const handleNodesFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (!uploadedFile) return;
    if (!uploadedFile.name.endsWith('.csv')) {
      setNodesErrors(['Please upload a CSV file']);
      return;
    }
    setIsParsing(true);
    try {
      const { rows } = await parseOnServer(uploadedFile, 'network_nodes');
      setNodesFile(uploadedFile);
      setNodesData(rows.map(applyLegacyTyping) as DeepNodeRow[]);
      setNodesErrors([]);
    } catch (error) {
      setNodesErrors([error instanceof Error ? error.message : 'Failed to read the nodes file']);
    } finally {
      setIsParsing(false);
    }
  };

  const handleEdgesFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0];
    if (!uploadedFile) return;
    if (!uploadedFile.name.endsWith('.csv')) {
      setEdgesErrors(['Please upload a CSV file']);
      return;
    }
    setIsParsing(true);
    try {
      const { rows } = await parseOnServer(uploadedFile, 'network_edges');
      setEdgesFile(uploadedFile);
      setEdgesData(rows.map(applyLegacyTyping) as DeepEdgeRow[]);
      setEdgesErrors([]);
    } catch (error) {
      setEdgesErrors([error instanceof Error ? error.message : 'Failed to read the edges file']);
    } finally {
      setIsParsing(false);
    }
  };

  const getPreviewHeaders = () => {
    const template = templateTypes.find((t) => t.id === selectedTemplate);
    if (!template) return [];

    if (template.id === 'bom_single_level') {
      return ['Product ID', 'Material ID', 'Consumption Rate', 'Plant Name'];
    } else if (template.id === 'bom_multi_level') {
      return ['Material ID', 'Level', 'Higher Level Component ID', 'Consumption Rate', 'Plant Name'];
    } else if (template.id === 'inbound_logistics') {
      return ['Supplier ID', 'Material ID', 'Volume', 'Unit Price', 'Lead Time', 'Time Unit', 'Plant Name'];
    } else if (template.id === 'outbound_logistics') {
      return ['Customer ID', 'Product ID', 'Volume', 'Unit Price', 'Expected Lead Time', 'Time Unit', 'Plant Name'];
    } else if (template.id === 'node_list') {
      return ['Node ID', 'Description', 'Location', 'Longitude', 'Latitude', 'Plant Name'];
    } else if (template.id === 'tier2_suppliers') {
      return ['Supplier ID', 'Upstream Supplier ID', 'Material ID', 'Relationship Type', 'Volume', 'Unit Price', 'Lead Time', 'Time Unit', 'Plant Name'];
    } else if (template.id === 'tier3_suppliers') {
      return ['Supplier ID', 'Upstream Supplier ID', 'Material ID', 'Relationship Type', 'Volume', 'Unit Price', 'Lead Time', 'Time Unit', 'Plant Name'];
    } else if (template.id === 'network_nodes') {
      return ['UID', 'Depth', 'Name', 'Country', 'Industry', 'Website', 'Traded As', 'Employees', 'Revenue', 'Lat', 'Long', 'Is Seed', 'Plant Name'];
    } else if (template.id === 'network_edges') {
      return ['Src UID', 'Dst UID', 'Relation Type', 'Relative Revenue', 'Relative Revenue %', 'Depth', 'Direction', 'Plant Name'];
    }
    return [];
  };

  const getPreviewCells = (row: DataRow) => {
    const template = templateTypes.find((t) => t.id === selectedTemplate);
    if (!template) return [];

    if (template.id === 'bom_single_level') {
      const bomRow = row as BomSingleLevelRow;
      return [bomRow.product_id, bomRow.material_id, bomRow.consumption_rate, bomRow.plant_name];
    } else if (template.id === 'bom_multi_level') {
      const bomRow = row as BomMultiLevelRow;
      return [bomRow.material_id, bomRow.level, bomRow.higher_level_component_id || 'N/A', bomRow.consumption_rate, bomRow.plant_name];
    } else if (template.id === 'inbound_logistics') {
      const inboundRow = row as InboundLogisticsRow;
      return [inboundRow.supplier_id, inboundRow.material_id, inboundRow.volume, inboundRow.unit_price, inboundRow.lead_time, inboundRow.time_unit, inboundRow.plant_name];
    } else if (template.id === 'outbound_logistics') {
      const outboundRow = row as OutboundLogisticsRow;
      return [outboundRow.customer_id, outboundRow.product_id, outboundRow.volume, outboundRow.unit_price, outboundRow.expected_lead_time, outboundRow.time_unit, outboundRow.plant_name];
    } else if (template.id === 'node_list') {
      const nodeRow = row as NodeListRow;
      return [nodeRow.node_id, nodeRow.description_text || 'N/A', nodeRow.location_text || 'N/A', nodeRow.longitude || 'N/A', nodeRow.latitude || 'N/A', nodeRow.plant_name];
    } else if (template.id === 'tier2_suppliers' || template.id === 'tier3_suppliers') {
      const tierRow = row as any;
      return [tierRow.supplier_id, tierRow.upstream_supplier_id, tierRow.material_id, tierRow.relationship_type, tierRow.volume || 'N/A', tierRow.unit_price || 'N/A', tierRow.lead_time || 'N/A', tierRow.time_unit || 'N/A', tierRow.plant_name];
    } else if (template.id === 'network_nodes') {
      const n = row as any;
      return [n.uid, n.depth ?? 'N/A', n.name ?? 'N/A', n.country ?? 'N/A', n.industry ?? 'N/A', n.website ?? 'N/A', n.traded_as ?? 'N/A', n.number_of_employees ?? 'N/A', n.revenue ?? 'N/A', n.lat ?? 'N/A', n.long ?? 'N/A', String(n.is_seed ?? false), n.plant_name];
    } else if (template.id === 'network_edges') {
      const e = row as any;
      return [e.src_uid, e.dst_uid, e.relation_type ?? 'N/A', e.relative_revenue ?? 'N/A', e.relative_revenue_percentage ?? 'N/A', e.depth ?? 'N/A', e.direction ?? 'N/A', e.plant_name];
    }
    return [];
  };

  const handleUpload = async () => {
    console.log('🔄 Upload initiated:', {
      template: selectedTemplate,
      dataset: selectedDataset,
      project: selectedProject?.name,
      dataRows: csvData.length,
      timestamp: new Date().toISOString()
    });
    
    setIsUploading(true);

    try {
      const template = templateTypes.find((t) => t.id === selectedTemplate);
      
      if (!template) {
        console.error('❌ No template found for:', selectedTemplate);
        throw new Error(`Template not found: ${selectedTemplate}`);
      }
      if (!user?.id) {
        console.error('❌ Missing user ID');
        throw new Error('User authentication required');
      }
      if (!user?.email) {
        console.error('❌ Missing user email');
        throw new Error('User email required');
      }
      if (!selectedProject?.id) {
        console.error('❌ Missing selected project');
        throw new Error('Project selection required');
      }

      const dataToInsert = csvData.map((row, index) => {
        const mappedRow = {
          ...row,
          project_id: selectedProject?.id,
          plant_name: selectedProject?.plant_name,
        };

        // Enhanced logging for outbound logistics data transformation
        if (selectedTemplate === 'outbound_logistics') {
          const outboundRow = mappedRow as any; // Type assertion for logging
          console.log(`📋 Outbound logistics row ${index + 1} transformation:`, {
            original: row,
            mapped: mappedRow,
            requiredFields: {
              customer_id: outboundRow.customer_id,
              product_id: outboundRow.product_id,
              volume: outboundRow.volume,
              time_unit: outboundRow.time_unit,
              expected_lead_time: outboundRow.expected_lead_time,
              unit_price: outboundRow.unit_price,
              plant_name: outboundRow.plant_name,
              project_id: outboundRow.project_id
            },
            fieldTypes: {
              volume: typeof outboundRow.volume,
              expected_lead_time: typeof outboundRow.expected_lead_time, 
              unit_price: typeof outboundRow.unit_price,
              customer_id: typeof outboundRow.customer_id,
              product_id: typeof outboundRow.product_id
            }
          });
        }
        
        return mappedRow;
      });

      // Enhanced data validation function
      const validateDataStructure = (data: any[], templateId: string) => {
        console.log(`🔍 Validating data structure for ${templateId}:`, {
          recordCount: data.length,
          firstRecord: data[0],
          sampleFields: Object.keys(data[0] || {})
        });

        // Specific validation for outbound logistics
        if (templateId === 'outbound_logistics') {
          data.forEach((row, index) => {
            const requiredFields = ['customer_id', 'product_id', 'volume', 'time_unit', 'expected_lead_time', 'unit_price'];
            const missing = requiredFields.filter(field => row[field] === undefined || row[field] === null || row[field] === '');
            if (missing.length > 0) {
              console.warn(`⚠️ Row ${index + 1} missing fields:`, missing);
            }
            
            // Log numeric field validation
            const numericFields = ['volume', 'expected_lead_time', 'unit_price'];
            numericFields.forEach(field => {
              if (row[field] !== null && row[field] !== undefined && row[field] !== '') {
                const num = Number(row[field]);
                if (!Number.isFinite(num)) {
                  console.warn(`⚠️ Row ${index + 1} invalid numeric value for ${field}:`, row[field]);
                }
              }
            });
          });
        }

        return data;
      };

      // Enhanced batch processing with better error handling and transaction safety
      const processBatches = async (rpcFunction: string, data: any[], params: any = {}) => {
        // Much smaller batch size for Multi Level BOM to prevent timeouts
        const BATCH_SIZE = rpcFunction === 'bulk_insert_bom_multi_level' ? 25 : 50;
        let totalInserted = 0;
        const failedBatches: { batchNumber: number, error: string, records: any[] }[] = [];
        
        console.log(`🚀 Starting batch processing for ${rpcFunction} with ${data.length} records`);
        console.log(`📊 Batch configuration: size=${BATCH_SIZE}, totalBatches=${Math.ceil(data.length / BATCH_SIZE)}`);
        
        // Validate data structure before processing
        const validatedData = validateDataStructure(data, selectedTemplate);
        
        for (let i = 0; i < validatedData.length; i += BATCH_SIZE) {
          const batch = validatedData.slice(i, i + BATCH_SIZE);
          const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(validatedData.length / BATCH_SIZE);
          
          console.log(`📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} records)`);
          console.log(`📋 Batch ${batchNumber} sample data:`, {
            firstRecord: batch[0],
            lastRecord: batch[batch.length - 1],
            recordCount: batch.length
          });
          
          try {
            const batchParams = { ...params };
            if (batchParams.p_rows) batchParams.p_rows = batch;
            if (batchParams.p_data) batchParams.p_data = batch;
            
            console.log(`🔄 Calling ${rpcFunction} with params:`, {
              ...batchParams,
              p_rows: `[${batch.length} records]` // Don't log full data, just count
            });
            
            const result = await (supabase as any).rpc(rpcFunction, batchParams);
            
            if (result.error) {
              console.error(`❌ Batch ${batchNumber} failed:`, {
                code: result.error.code,
                message: result.error.message,
                details: result.error.details,
                hint: result.error.hint
              });
              
              failedBatches.push({
                batchNumber,
                error: result.error.message || result.error.code || 'Unknown error',
                records: batch
              });
              continue; // Continue with next batch instead of throwing
            }
            
            const batchInsertCount = result.data || batch.length;
            totalInserted += batchInsertCount;
            
            console.log(`✅ Batch ${batchNumber} completed successfully:`, {
              recordsProcessed: batch.length,
              recordsInserted: batchInsertCount,
              totalInserted: totalInserted
            });
            
            // Longer delay between batches for Multi Level BOM to ensure database stability
            if (i + BATCH_SIZE < validatedData.length) {
              const delayMs = rpcFunction === 'bulk_insert_bom_multi_level' ? 1000 : 500;
              console.log(`⏳ Waiting ${delayMs}ms before next batch...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown batch error';
            console.error(`❌ Batch ${batchNumber} exception:`, errorMsg);
            failedBatches.push({
              batchNumber,
              error: errorMsg,
              records: batch
            });
          }
        }
        
        // Report results
        if (failedBatches.length > 0) {
          console.error(`⚠️ Upload completed with errors:`, {
            totalRecords: data.length,
            successfulInserts: totalInserted,
            failedBatches: failedBatches.length,
            failureDetails: failedBatches.map(fb => ({
              batch: fb.batchNumber,
              error: fb.error,
              recordCount: fb.records.length
            }))
          });
          
          // Show detailed error message
          const errorSummary = failedBatches.map(fb => 
            `Batch ${fb.batchNumber}: ${fb.error} (${fb.records.length} records)`
          ).join('\n');
          
          throw new Error(`Upload partially failed:\nSuccessful: ${totalInserted}/${data.length} records\nErrors:\n${errorSummary}`);
        }
        
        console.log(`🎉 All batches completed successfully: ${totalInserted}/${data.length} records inserted`);
        return { insertedCount: totalInserted };
      };

      // Batch processing for deep tier network nodes
      const uploadNetworkNodesBatch = async (rows: any[]) => {
        const BATCH_SIZE = 200; // Optimal batch size for network nodes
        let totalInserted = 0;
        const failedBatches: { batchNumber: number; error: string }[] = [];
        const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
        
        console.log(`🚀 Starting network nodes batch upload: ${rows.length} records, ${totalBatches} batches`);
        
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
          
          try {
            console.log(`📦 Processing nodes batch ${batchNumber}/${totalBatches} (${batch.length} records)`);
            
            const { data, error } = await supabase.rpc('bulk_insert_network_nodes', {
              p_project_id: selectedProject?.id,
              p_plant_name: selectedProject?.plant_name,
              p_user_id: user.id,
              p_user_email: user.email,
              p_rows: JSON.parse(JSON.stringify(batch)),
            });
            
            if (error) {
              const errorMsg = `Database error: ${error.message || error}`;
              console.error(`❌ Nodes batch ${batchNumber} failed:`, errorMsg);
              failedBatches.push({ batchNumber, error: errorMsg });
              continue;
            }
            
            const insertedInBatch = data || 0;
            totalInserted += insertedInBatch;
            console.log(`✅ Nodes batch ${batchNumber} completed: ${insertedInBatch} records inserted`);
            
            // Add delay between batches to prevent overwhelming the database
            if (i + BATCH_SIZE < rows.length) {
              await new Promise((r) => setTimeout(r, 250));
            }
          } catch (e: any) {
            const errorMsg = `Upload error: ${e?.message || e}`;
            console.error(`❌ Nodes batch ${batchNumber} failed:`, errorMsg);
            failedBatches.push({ batchNumber, error: errorMsg });
          }
        }
        
        if (failedBatches.length > 0) {
          const summary = failedBatches.map((f) => `Batch ${f.batchNumber}: ${f.error}`).join('\n');
          throw new Error(`Network nodes upload partially failed:\n${summary}`);
        }
        
        console.log(`✅ Network nodes batch upload completed: ${totalInserted} total records`);
        return { insertedCount: totalInserted };
      };

      // Batch processing for deep tier network edges
      const uploadNetworkEdgesBatch = async (rows: any[]) => {
        const BATCH_SIZE = 200; // Optimal batch size for network edges
        let totalInserted = 0;
        const failedBatches: { batchNumber: number; error: string }[] = [];
        const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
        
        console.log(`🚀 Starting network edges batch upload: ${rows.length} records, ${totalBatches} batches`);
        
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
          
          try {
            console.log(`📦 Processing edges batch ${batchNumber}/${totalBatches} (${batch.length} records)`);
            
            const { data, error } = await supabase.rpc('bulk_insert_network_edges', {
              p_project_id: selectedProject?.id,
              p_plant_name: selectedProject?.plant_name,
              p_user_id: user.id,
              p_user_email: user.email,
              p_rows: JSON.parse(JSON.stringify(batch)),
            });
            
            if (error) {
              const errorMsg = `Database error: ${error.message || error}`;
              console.error(`❌ Edges batch ${batchNumber} failed:`, errorMsg);
              failedBatches.push({ batchNumber, error: errorMsg });
              continue;
            }
            
            const insertedInBatch = data || 0;
            totalInserted += insertedInBatch;
            console.log(`✅ Edges batch ${batchNumber} completed: ${insertedInBatch} records inserted`);
            
            // Add delay between batches to prevent overwhelming the database
            if (i + BATCH_SIZE < rows.length) {
              await new Promise((r) => setTimeout(r, 250));
            }
          } catch (e: any) {
            const errorMsg = `Upload error: ${e?.message || e}`;
            console.error(`❌ Edges batch ${batchNumber} failed:`, errorMsg);
            failedBatches.push({ batchNumber, error: errorMsg });
          }
        }
        
        if (failedBatches.length > 0) {
          const summary = failedBatches.map((f) => `Batch ${f.batchNumber}: ${f.error}`).join('\n');
          throw new Error(`Network edges upload partially failed:\n${summary}`);
        }
        
        console.log(`✅ Network edges batch upload completed: ${totalInserted} total records`);
        return { insertedCount: totalInserted };
      };


      // ── THE LANDING (Phase 3 / WP 3.2) ─────────────────────────────────
      // For every dataset the data contract describes, the FILE goes to the
      // server and nothing else does. `ingest-file` hashes the bytes, stores
      // them, opens a run, stages every row in tier 1 with its findings, writes
      // the audit row that names the uploader, and promotes the rows that
      // passed. The browser sends a file and reads a report.
      //
      // `INGEST_DATASETS` is generated from the contract, so this branch widens
      // by describing a table rather than by editing this component.
      if (INGEST_DATASETS[template.id]) {
        if (!file) throw new Error('Choose a file first.');
        const body = new FormData();
        body.append('file', file);
        body.append('dataset', template.id);
        body.append('project_id', selectedProject.id);
        body.append('user_id', user.id);
        body.append('mode', 'land');

        const { data, error } = await supabase.functions.invoke('ingest-file', { body });
        if (error) throw new Error(await edgeErrorMessage(error, 'The upload failed.'));
        if (!data?.success) {
          const findings: ParseFinding[] = data?.findings ?? [];
          throw new Error(
            findings.filter((f) => f.level === 'error').map((f) => f.message).join('\n') ||
            data?.error || 'The upload failed.',
          );
        }

        const summary = data as IngestRunSummary;
        setLastRun(summary);
        setFile(null);
        setCsvData([]);
        setErrors([]);
        setWarnings([]);
        // NOTHING HAS BEEN WRITTEN YET, so the toast must not say it has. The
        // old one said "N records uploaded" the moment the bytes arrived, which
        // was true while the landing promoted and would be a lie now.
        const willWrite =
          (summary.rows_new ?? 0) + (summary.rows_changed ?? 0) + (summary.rows_unchanged ?? 0);
        toast({
          title: `${summary.rows_staged} row(s) staged — review before promoting`,
          description: summary.diffed
            ? `${willWrite} row(s) will be written` +
              (summary.rows_held ? ` · ${summary.rows_held} held back with a reason attached` : '') +
              '. Nothing has changed in the project yet.'
            : 'The comparison with your current data did not run; open the review and re-compare.',
        });
        return;
      }

      let result;
      const uploadStartTime = Date.now();
      
      console.log('🚀 Starting bulk insert for:', template.id, 'with', dataToInsert.length, 'records');
      
      // THE ITEM-MASTER BRANCH IS GONE (WP 3.3, D55), not flagged off. It called
      // `bulk_upsert_materials` / `_products` / `_suppliers` straight from the
      // browser into tier 2 — the last CSV path in the system that skipped tiers
      // 0 and 1. All three templates are now in `INGEST_DATASETS`, so the landing
      // branch above catches them and returns before reaching here; leaving the
      // dead code would have left a second write path one edit away from being
      // reachable again. The RPCs themselves are untouched and still exist for
      // any caller outside this component.
      if (template.id === 'node_list') {
        const batchResult = await processBatches('upload_node_list_data', dataToInsert, {
          p_project_id: selectedProject?.id,
          p_user_id: user.id,
          p_user_email: user.email,
          p_rows: dataToInsert // Will be replaced per batch
        });
        result = { insertedCount: batchResult.insertedCount };
      } else if (template.id === 'deep_tier_json') {
        // Handle JSON format for deep tier data with batch processing
        const content = await file.text();
        const { nodes, edges } = parseJSON(content);
        
        console.log(`📊 Deep tier JSON parsed: ${nodes.length} nodes, ${edges.length} edges`);
        
        let totalInserted = 0;
        
        // Upload nodes first with batch processing
        if (nodes.length > 0) {
          console.log('📦 Starting batch upload of nodes...');
          const nodesResult = await uploadNetworkNodesBatch(nodes);
          totalInserted += nodesResult.insertedCount;
          console.log(`✅ Nodes upload completed: ${nodesResult.insertedCount} records`);
        }

        // Upload edges second with batch processing
        if (edges.length > 0) {
          console.log('🔗 Starting batch upload of edges...');
          const edgesResult = await uploadNetworkEdgesBatch(edges);
          totalInserted += edgesResult.insertedCount;
          console.log(`✅ Edges upload completed: ${edgesResult.insertedCount} records`);
        }

        result = { data: totalInserted };
        
      } else if (selectedDataset === 'deep_tier' && deepTierFormat === 'csv') {
        // Handle deep tier CSV format with batch processing - upload both nodes and edges
        if (!nodesFile || !edgesFile || nodesData.length === 0 || edgesData.length === 0) {
          throw new Error('Please upload both nodes and edges CSV files');
        }

        console.log(`📊 Deep tier CSV loaded: ${nodesData.length} nodes, ${edgesData.length} edges`);
        
        let totalInserted = 0;

        // Upload nodes first with batch processing
        console.log('📦 Starting batch upload of CSV nodes...');
        const nodesResult = await uploadNetworkNodesBatch(nodesData);
        totalInserted += nodesResult.insertedCount;
        console.log(`✅ CSV nodes upload completed: ${nodesResult.insertedCount} records`);

        // Upload edges second with batch processing
        console.log('🔗 Starting batch upload of CSV edges...');
        const edgesResult = await uploadNetworkEdgesBatch(edgesData);
        totalInserted += edgesResult.insertedCount;
        console.log(`✅ CSV edges upload completed: ${edgesResult.insertedCount} records`);

        result = { data: totalInserted };

      } else if (template.id === 'network_nodes') {
        // Use batch processing for individual network nodes upload
        console.log('📦 Starting batch upload of network nodes...');
        const batchResult = await uploadNetworkNodesBatch(dataToInsert);
        result = { data: batchResult.insertedCount };
      } else if (template.id === 'network_edges') {
        // Use batch processing for individual network edges upload  
        console.log('🔗 Starting batch upload of network edges...');
        const batchResult = await uploadNetworkEdgesBatch(dataToInsert);
        result = { data: batchResult.insertedCount };
      }

      const uploadDuration = Date.now() - uploadStartTime;
      console.log('⏱️ Upload completed in:', uploadDuration, 'ms');
      
      if (result?.error) {
        console.error('❌ Upload RPC error:', result.error);
        throw new Error(`Database upload failed: ${result.error.message || result.error}`);
      }

      const insertedCount = result?.data || result?.insertedCount || 0;
      
      // Enhanced validation of insertion results
      if (insertedCount === 0 && dataToInsert.length > 0) {
        console.error('⚠️ CRITICAL: Upload appeared successful but 0 records were inserted!', {
          template: selectedTemplate,
          dataset: selectedDataset, 
          originalRecords: csvData.length,
          processedRecords: dataToInsert.length,
          resultData: result?.data,
          resultError: result?.error,
          sampleRecord: dataToInsert[0]
        });
        throw new Error(`Upload failed: Expected to insert ${dataToInsert.length} records but got ${insertedCount}. This usually indicates a data validation or mapping issue.`);
      }
      
      if (insertedCount < dataToInsert.length) {
        console.warn('⚠️ Partial insertion detected:', {
          expected: dataToInsert.length,
          actual: insertedCount,
          template: selectedTemplate
        });
      }
      
      console.log('✅ Successfully inserted:', insertedCount, 'records for', template.id);

      // Auto-calculate prominence after successful deep tier uploads
      if (template.id === 'network_nodes' || template.id === 'network_edges' || template.id === 'deep_tier_json' || (selectedDataset === 'deep_tier' && deepTierFormat === 'csv')) {
        // WP 10.1 · §4 D234 — the uploaded world gets a graph version, ONCE, after
        // the last chunk: a version per chunk would number half-uploaded graphs.
        // Promotions and combines take theirs in the database; the deep tier lands
        // through chunked RPCs, so its single capture is here.
        try {
          const { data: gv, error: gvError } = await supabase.rpc('capture_graph_version', {
            p_project_id: selectedProject?.id,
            _actor_user_id: user?.id,
            p_label: `After deep-tier upload ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          });
          if (gvError) console.warn('Graph version capture failed:', gvError.message);
          else console.log('Graph version after upload:', gv);
        } catch (gvErr) {
          console.warn('Graph version capture failed:', gvErr);
        }
        try {
          console.log('🔄 Auto-calculating prominence after', template.id, 'upload');
          // WP 4.3 · the analyzer writes tier 3 through an RPC that takes the
          // actor, so the actor travels with the request (invariant audit-actor).
          const prominenceResult = await supabase.functions.invoke('calculate-node-prominence', {
            body: { project_id: selectedProject?.id, uploaded_by: user?.id }
          });
          
          if (prominenceResult.error) {
            console.warn('⚠️ Auto-prominence calculation failed:', prominenceResult.error);
            toast({
              title: 'Upload successful, but prominence calculation failed',
              description: `${insertedCount} records uploaded. You can manually recalculate prominence from the network view.`,
              variant: 'default',
            });
          } else {
            console.log('✅ Auto-prominence calculation completed:', prominenceResult.data);
            toast({
              title: 'Upload successful',
              description: `${insertedCount} records uploaded and prominence calculated for ${prominenceResult.data.updated_count} nodes`,
            });
          }
        } catch (prominenceError) {
          console.warn('⚠️ Auto-prominence calculation error:', prominenceError);
          toast({
            title: 'Upload successful',
            description: `${insertedCount} records uploaded. Prominence calculation will be available shortly.`,
          });
        }
      } else {
        toast({
          title: 'Upload successful',
          description: `${insertedCount} records uploaded`,
        });
      }
      
      // Clear form data after successful upload
      setFile(null);
      setCsvData([]);
      setErrors([]);
      setWarnings([]);
      // Clear deep tier data as well
      setNodesFile(null);
      setEdgesFile(null);
      setNodesData([]);
      setEdgesData([]);
      setNodesErrors([]);
      setEdgesErrors([]);
      
      console.log('🎉 Upload process completed successfully, triggering onUploadComplete callback');
      
      // Use setTimeout to ensure upload completion callback runs after current execution
      setTimeout(() => {
        onUploadComplete();
      }, 100);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('❌ Upload failed:', {
        error: errorMessage,
        template: selectedTemplate,
        dataset: selectedDataset,
        timestamp: new Date().toISOString(),
        projectId: selectedProject?.id,
        userId: user?.id,
        recordCount: csvData.length,
        errorStack: error instanceof Error ? error.stack : undefined
      });
      
      // Enhanced error messages for common issues
      let userFriendlyMessage = errorMessage;
      
      if (errorMessage.includes('statement timeout') || errorMessage.includes('timeout')) {
        userFriendlyMessage = `Upload timeout: Your dataset (${csvData.length || (nodesData?.length || 0) + (edgesData?.length || 0)} records) is too large for single processing. The system now uses batch processing to handle large files - please try again.`;
      } else if (errorMessage.includes('batch') && errorMessage.includes('failed')) {
        userFriendlyMessage = `Batch upload partially failed: Some batches couldn't be processed. This may be due to data validation issues or temporary database unavailability. Please check your data format and try again.`;
      } else if (errorMessage.includes('Network nodes upload') || errorMessage.includes('Network edges upload')) {
        userFriendlyMessage = `Deep tier data upload failed: ${errorMessage.includes('partially') ? 'Some batches failed during processing.' : 'Upload encountered errors.'} Please verify your JSON/CSV format matches the template exactly.`;
      } else if (errorMessage.includes('violates')) {
        userFriendlyMessage = `Data validation error: Some records don't meet the required format. Please check your CSV file against the template.`;
      } else if (errorMessage.includes('duplicate')) {
        userFriendlyMessage = `Duplicate data detected: Some records already exist. Please check for duplicate entries in your file.`;
      } else if (errorMessage.includes('0 records')) {
        userFriendlyMessage = `No records were imported. This usually means:\n• Column names don't match the template exactly\n• Required fields are missing\n• Data format issues\n\nPlease verify your CSV matches the downloaded template.`;
      } else if (errorMessage.includes('Unknown error occurred')) {
        userFriendlyMessage = `Upload failed with unknown error. This may be due to:\n• File too large (try smaller batches)\n• Network connectivity issues\n• Server timeout\n\nPlease try again or contact support if the issue persists.`;
      }
      
      toast({
        title: 'Upload failed',
        description: userFriendlyMessage,
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Card className="relative">
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b">
        <Tabs value={selectedDataset} onValueChange={setSelectedDataset} className="flex-1">
          <TabsList
            className="inline-flex justify-start gap-1 h-9 rounded-sm bg-muted p-1"
            style={{ width: 'fit-content' }}
          >
            {datasetTabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className={`${SMALL_TXT} px-3 h-7 rounded-md transition-colors
                  data-[state=inactive]:text-muted-foreground
                  data-[state=active]:bg-background data-[state=active]:text-foreground
                  data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-border`}
                onClick={() => {
                  setFile(null);
                  setErrors([]);
                  setWarnings([]);
                  // Clear deep tier states as well
                  setNodesFile(null);
                  setEdgesFile(null);
                  setNodesData([]);
                  setEdgesData([]);
                  setNodesErrors([]);
                  setEdgesErrors([]);
                }}
              >
                {tab.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Dynamic Template and Guide buttons - now using selectedTemplate */}
        <div className="flex gap-2 ml-4">
          {selectedDataset !== 'deep_tier' || deepTierFormat === 'csv' ? (
            <Button 
              variant="outline" 
              size="sm" 
              asChild 
              className={`${SMALL_TXT} h-7`}
              disabled={!selectedTemplate || templateTypes.find((t) => t.id === selectedTemplate)?.templateFile === ''}
            >
              <a
                href={templateTypes.find((t) => t.id === selectedTemplate)?.templateFile}
                download
              >
                <Download className="h-3 w-3 mr-1" />
                Template
              </a>
            </Button>
          ) : (
            <Button 
              variant="outline" 
              size="sm" 
              asChild 
              className={`${SMALL_TXT} h-7`}
            >
              <a
                href={templateTypes.find((t) => t.id === selectedTemplate)?.templateFile}
                download
              >
                <Download className="h-3 w-3 mr-1" />
                JSON Example
              </a>
            </Button>
          )}
          <Button 
            variant="outline" 
            size="sm" 
            asChild 
            className={`${SMALL_TXT} h-7`}
            disabled={!selectedTemplate}
          >
            <a
              href={templateTypes.find((t) => t.id === selectedTemplate)?.guideFile}
              target="_blank"
              rel="noreferrer"
            >
              <FileText className="h-3 w-3 mr-1" />
              Guide
            </a>
          </Button>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-7 w-7 ml-2"
          title="Close"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <CardContent className="p-3 pt-2">
        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label className={SMALL_TXT}>
                {templateTypes.find((t) => t.id === selectedTemplate)?.name}
              </Label>
            </div>

            {/* Item Master type selection */}
            {selectedDataset === 'item-master' && (
              <Card className="border-dashed">
                <CardContent className="p-4 space-y-3">
                  <Label className="text-xs font-medium">Item Master Table</Label>
                  <RadioGroup
                    value={itemMasterType}
                    onValueChange={(value: 'materials' | 'products' | 'suppliers' | 'customers') => {
                      setItemMasterType(value);
                      setFile(null);
                      setCsvData([]);
                      setErrors([]);
                      setWarnings([]);
                    }}
                    className="flex gap-6"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="materials" id="im-materials" />
                      <Label htmlFor="im-materials" className="text-xs cursor-pointer">
                        Materials (cost, MOQ, holding, lead-time shape)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="products" id="im-products" />
                      <Label htmlFor="im-products" className="text-xs cursor-pointer">
                        Products (price, capacity, demand)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="suppliers" id="im-suppliers" />
                      <Label htmlFor="im-suppliers" className="text-xs cursor-pointer">
                        Suppliers (capacity, reliability)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="customers" id="im-customers" />
                      <Label htmlFor="im-customers" className="text-xs cursor-pointer">
                        Customers (segment, allocation priority)
                      </Label>
                    </div>
                  </RadioGroup>
                </CardContent>
              </Card>
            )}

            {/* Deep Tier Format Selection */}
            {selectedDataset === 'deep_tier' && (
              <Card className="border-dashed">
                <CardContent className="p-4 space-y-3">
                  <Label className="text-xs font-medium">Upload Format</Label>
                  <RadioGroup 
                    value={deepTierFormat} 
                    onValueChange={(value: 'csv' | 'json') => {
                      setDeepTierFormat(value);
                      // Clear all file states when changing format
                      setFile(null);
                      setCsvData([]);
                      setErrors([]);
                      setWarnings([]);
                      setNodesFile(null);
                      setEdgesFile(null);
                      setNodesData([]);
                      setEdgesData([]);
                      setNodesErrors([]);
                      setEdgesErrors([]);
                    }}
                    className="flex gap-6"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="csv" id="format-csv" />
                      <Label htmlFor="format-csv" className="text-xs cursor-pointer">
                        CSV Files (2 files: nodes + edges)
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="json" id="format-json" />
                      <Label htmlFor="format-json" className="text-xs cursor-pointer">
                        JSON File (single combined file)
                      </Label>
                    </div>
                  </RadioGroup>
                  {deepTierFormat === 'csv' && (
                    <div className="text-xs text-muted-foreground">
                      Upload nodes and edges separately using the CSV templates
                    </div>
                  )}
                  {deepTierFormat === 'json' && (
                    <div className="text-xs text-muted-foreground">
                      Upload a single JSON file containing both nodes and edges arrays
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <div className="space-y-3">
                {selectedDataset === 'deep_tier' && deepTierFormat === 'csv' ? (
                  // Deep tier CSV: separate file inputs for nodes and edges
                  <div className="space-y-4">
                    <Card>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <Database className="h-4 w-4 text-muted-foreground" />
                          <Label className="text-xs font-medium">
                            Network Nodes CSV File
                          </Label>
                        </div>
                        <Input
                          type="file"
                          accept=".csv"
                          onChange={handleNodesFileSelect}
                          className="
                            border-0 bg-transparent shadow-none
                            h-8 text-xs
                            file:mr-2 file:rounded-md file:border file:border-input
                            file:bg-muted file:px-2 file:py-0.5
                            file:text-xs file:font-medium file:text-foreground
                            file:hover:bg-muted/70
                          "
                        />
                        {nodesFile && nodesData.length > 0 && (
                          <div className="flex items-center gap-2 text-xs text-green-600">
                            <div className="h-2 w-2 bg-green-500 rounded-full"></div>
                            <span>{nodesData.length} nodes loaded from {nodesFile.name}</span>
                          </div>
                        )}
                        {nodesErrors.length > 0 && (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertDescription className="text-xs">
                              {nodesErrors.map((error, index) => (
                                <div key={index}>{error}</div>
                              ))}
                            </AlertDescription>
                          </Alert>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <Database className="h-4 w-4 text-muted-foreground" />
                          <Label className="text-xs font-medium">
                            Network Edges CSV File
                          </Label>
                        </div>
                        <Input
                          type="file"
                          accept=".csv"
                          onChange={handleEdgesFileSelect}
                          className="
                            border-0 bg-transparent shadow-none
                            h-8 text-xs
                            file:mr-2 file:rounded-md file:border file:border-input
                            file:bg-muted file:px-2 file:py-0.5
                            file:text-xs file:font-medium file:text-foreground
                            file:hover:bg-muted/70
                          "
                        />
                        {edgesFile && edgesData.length > 0 && (
                          <div className="flex items-center gap-2 text-xs text-green-600">
                            <div className="h-2 w-2 bg-green-500 rounded-full"></div>
                            <span>{edgesData.length} edges loaded from {edgesFile.name}</span>
                          </div>
                        )}
                        {edgesErrors.length > 0 && (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertDescription className="text-xs">
                              {edgesErrors.map((error, index) => (
                                <div key={index}>{error}</div>
                              ))}
                            </AlertDescription>
                          </Alert>
                        )}
                      </CardContent>
                    </Card>
                  </div>
              ) : (
                // Standard single file input for all other cases
                <Input
                  type="file"
                  accept={selectedDataset === 'deep_tier' && deepTierFormat === 'json' ? '.json' : '.csv'}
                  onChange={handleFileSelect}
                  className="
                    border-0 bg-transparent shadow-none
                    h-8 text-xs
                    file:mr-2 file:rounded-md file:border file:border-input
                    file:bg-muted file:px-2 file:py-0.5
                    file:text-xs file:font-medium file:text-foreground
                    file:hover:bg-muted/70
                  "
                />
              )}

              {/* Preview Tables */}
              {selectedDataset === 'deep_tier' && deepTierFormat === 'csv' ? (
                // Deep tier CSV: show preview for both nodes and edges
                <div className="space-y-4">
                  {nodesFile && nodesData.length > 0 && (
                    <Card>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className={`${SMALL_TXT} font-medium text-foreground`}>
                            Nodes Preview
                          </div>
                          <div className={`${SMALL_TXT} text-muted-foreground`}>
                            {nodesData.length} total rows
                          </div>
                        </div>
                        <div className="border rounded-md overflow-hidden">
                          <div className="max-h-48 overflow-auto">
                            <Table className={SMALL_TXT}>
                              <TableHeader className="sticky top-0 z-10">
                                <TableRow className="h-7">
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>UID</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Name</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Country</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Revenue</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Is Seed</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {nodesData.slice(0, 3).map((row, idx) => (
                                  <TableRow key={idx} className="hover:bg-muted/40">
                                    <TableCell className={CELL_PAD}>{row.uid}</TableCell>
                                    <TableCell className={CELL_PAD}>{row.name || 'N/A'}</TableCell>
                                    <TableCell className={CELL_PAD}>{row.country || 'N/A'}</TableCell>
                                    <TableCell className={CELL_PAD}>{row.revenue || 'N/A'}</TableCell>
                                    <TableCell className={CELL_PAD}>{String(row.is_seed || false)}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  
                  {edgesFile && edgesData.length > 0 && (
                    <Card>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className={`${SMALL_TXT} font-medium text-foreground`}>
                            Edges Preview
                          </div>
                          <div className={`${SMALL_TXT} text-muted-foreground`}>
                            {edgesData.length} total rows
                          </div>
                        </div>
                        <div className="border rounded-md overflow-hidden">
                          <div className="max-h-48 overflow-auto">
                            <Table className={SMALL_TXT}>
                              <TableHeader className="sticky top-0 z-10">
                                <TableRow className="h-7">
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Src UID</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Dst UID</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Relation Type</TableHead>
                                  <TableHead className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>Revenue</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {edgesData.slice(0, 3).map((row, idx) => (
                                  <TableRow key={idx} className="hover:bg-muted/40">
                                    <TableCell className={CELL_PAD}>{row.src_uid}</TableCell>
                                    <TableCell className={CELL_PAD}>{row.dst_uid}</TableCell>
                                    <TableCell className={CELL_PAD}>{row.relation_type || 'N/A'}</TableCell>
                                    <TableCell className={CELL_PAD}>{row.relative_revenue || 'N/A'}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              ) : (
                // Standard preview for all other cases
                file && csvData.length > 0 && (
                  <div className="space-y-2">
                    <div className={`${SMALL_TXT} text-muted-foreground`}>
                      Preview (showing 5 of {csvData.length} rows)
                    </div>
                    <div className="border rounded-md overflow-hidden">
                      <div className="max-h-64 overflow-auto">
                        <Table className={SMALL_TXT}>
                          <TableHeader className="sticky top-0 z-10">
                            <TableRow className="h-7">
                              {getPreviewHeaders().map((header) => (
                                <TableHead key={header} className={`${HEAD_CELL_PAD} ${SMALL_TXT}`}>
                                  {header}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {csvData.slice(0, 5).map((row, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/40">
                                {getPreviewCells(row).map((cell, cellIdx) => (
                                  <TableCell key={cellIdx} className={CELL_PAD}>
                                    {cell}
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>

            {warnings.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className={SMALL_TXT}>
                  <div className="font-medium">
                    {warnings.length} warning(s) — these rows will still be uploaded
                  </div>
                  {warnings.map((warning, index) => (
                    <div key={index}>{warning}</div>
                  ))}
                </AlertDescription>
              </Alert>
            )}

            {errors.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className={SMALL_TXT}>
                  {errors.map((error, index) => (
                    <div key={index}>{error}</div>
                  ))}
                </AlertDescription>
              </Alert>
            )}

            {/* THE REVIEW SCREEN (Phase 3 / WP 3.4, §10).
                WP 3.2 made this a status view of a run that had already been
                promoted. It is a REVIEW now: the run is `staged`, nothing has
                reached the project, and `IngestRunReview` shows the diff, the
                findings and the three row states so a person can decide. The
                same component renders an MRP sync — §10's gap check for this
                package is that any branch on `source_kind` beyond a label means
                WP 3.1 was incomplete, and there is none. */}
            {lastRun && (
              <IngestRunPanel
                runId={lastRun.run_id}
                userId={user?.id ?? null}
                onPromoted={() => { onUploadComplete(); }}
              />
            )}

            {/* Upload button logic */}
            {selectedDataset === 'deep_tier' && deepTierFormat === 'csv' ? (
              // Deep tier CSV: upload button for both files
              nodesFile && edgesFile && nodesErrors.length === 0 && edgesErrors.length === 0 && (
                <Card className="border-green-200 bg-green-50/50">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse"></div>
                        <span className={`${SMALL_TXT} text-green-700 font-medium`}>
                          {nodesData.length} nodes + {edgesData.length} edges ready for upload
                        </span>
                      </div>
                      <Button
                        onClick={handleUpload}
                        disabled={isUploading}
                        size="sm"
                        className={`${SMALL_TXT} bg-green-600 hover:bg-green-700`}
                      >
                        <FileUp className="h-3 w-3 mr-1" />
                        {isUploading ? 'Uploading...' : 'Upload Network Data'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            ) : (
              // Standard upload button for all other cases
              file && errors.length === 0 && (
                <Card className="border-green-200 bg-green-50/50">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse"></div>
                        <span className={`${SMALL_TXT} text-green-700 font-medium`}>
                          {csvData.length} rows ready for upload
                        </span>
                      </div>
                      <Button
                        onClick={handleUpload}
                        disabled={isUploading}
                        size="sm"
                        className={`${SMALL_TXT} bg-green-600 hover:bg-green-700`}
                      >
                        <FileUp className="h-3 w-3 mr-1" />
                        {isUploading ? 'Uploading...' : 'Upload'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default UploadWizard;
