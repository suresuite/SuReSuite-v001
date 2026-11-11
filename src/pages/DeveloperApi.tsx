// @ts-nocheck — schema mismatch: uses the api-key RPCs from migration
// 20260711000001 which are not in the generated types yet. Remove once
// types are regenerated.
//
// Developer API page — API Phase 0 / G15 / §12 (developer experience).
// Self-service key management for the public /v1 gateway: create (show-once),
// list, rotate, revoke, per-key usage, and copy-paste quickstarts. Backed
// entirely by the SECURITY DEFINER RPCs (create/list/rotate/revoke_api_key);
// the plaintext secret exists only in this browser tab, once.
//
// ── SuReSuite redesign (2026-07) ────────────────────────────────────────────
// This page carries the SuReSuite visual language rather than raw shadcn
// defaults: one 4px corner radius, 1px --hair-border rules, JetBrains-mono
// UPPERCASE table headers + kicker labels, a black-pill active tab
// (bg-foreground text-background), teal/red status dots, a bespoke red-kicker
// "Key hygiene" card ABOVE the table, "Create API key" living in the
// Organization-keys card header (not the PageHeader), and a two-column notebook
// config panel under the notebook series, each notebook with "Open in Colab" +
// a "Download" button. Local class constants below hold the shared
// treatment so every table/card is consistent. All data flow, RPCs, hooks and
// interactive primitives (Button/Dialog/Select/Input/Checkbox) are unchanged.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { PageLayout } from '@/components/shared/PageLayout';
import { PageHeader } from '@/components/shared/PageHeader';
import { ApiCodeBlock, InlineCode, TableBlock, PAGE_GUTTER, PAGE_GUTTER_SKIN } from '@/components/shared';
import { MobileSheet } from '@/components/shared/MobileSheet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useRowBudget } from '@/hooks/useViewport';
import {
  M,
  MobileActionBar,
  MobileButton,
  MobileButtonRow,
  MobileChip,
  MobileGroup,
  MobileNote,
  MobilePageHeader,
  MobilePanel,
  MobileRow,
  MobileSegmented,
  MobileStatGrid,
} from '@/components/mobile';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/shared/ResponsiveDialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertTriangle, Check, Copy, Download, ExternalLink, KeyRound, Loader2,
  NotebookText, Plus, RefreshCcw, ShieldOff,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { FROZEN_CELL, FROZEN_CELL_ON_TINT } from '@/components/shared';
import { tupleNumbers, tupleText } from '@/lib/trust/graphLevels';

interface Props {
  isCollapsed: boolean;
  setIsCollapsed: (v: boolean) => void;
}

interface ApiKeyRow {
  id: string;
  key_prefix: string;
  org_id: string;
  org_name: string;
  name: string;
  scopes: string[];
  project_ids: string[] | null;
  env: 'live' | 'test';
  status: 'active' | 'revoked';
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  created_by_email: string | null;
  /** WP 12.3 — `personal` acts as its creator; `org` acts for the organization. */
  principal?: 'org' | 'personal';
}

interface UsageRow {
  api_key_id: string;
  requests_24h: number;
  requests_30d: number;
  errors_30d: number;
  last_request_at: string | null;
}

interface NbScenario {
  id: string;
  name: string;
  disruption_schedule?: unknown[] | null;
  horizon_days: number;
  warmup_days: number;
  replications: number;
  seed: number;
  primary_kpi: string;
  created_at: string;
}

interface NbPolicyVersion {
  id: string;
  label: string | null;
  policy_hash: string | null;
  created_at: string;
  run_count: number;
}

interface NbDatasetVersion {
  id: string;
  label: string | null;
  graph_hash: string | null;
  created_at: string;
  /** WP 11.3 — the snapshot's own number and its level-version tuple. */
  version_no?: number | null;
  tuple?: unknown;
}

/** "v9 · P3 · R2 · F5 · S4" — a snapshot is its level versions (WP 11.3, §4 D258). */
const snapshotTuple = (v: NbDatasetVersion) => {
  const t = tupleNumbers(v.tuple);
  return `${v.version_no != null ? `v${v.version_no}` : 'v?'} · ${tupleText(t)}`;
};

const db = supabase as any;
const SUPABASE_URL: string =
  (supabase as any).supabaseUrl ?? 'https://wckdrutwkytwcomrlpib.supabase.co';
const API_BASE = `${SUPABASE_URL}/functions/v1/api/v1`;

// The notebook series, shipped as static assets and BUILT from notebooks/src by
// scripts/notebooks/build-notebooks.mjs — whose --check fails when this list and
// the built files disagree, or when the CONFIG lines `nbConfigCell` writes stop
// matching the notebooks' own CONFIG cell. A download patches that cell with the
// selected project's ids. "Open in Colab" downloads the same patched copy and
// opens Colab's start page for upload. It must NOT use a
// colab.research.google.com/github/... link: the source repository is private,
// so Colab 404s and its error page prints the repo's owner, name, branch and
// path to every customer who clicks it.
const NOTEBOOKS = [
  { path: '/notebooks/suresuite_00_quickstart.ipynb', title: '00 · Quickstart', mirrors: 'Simulation Lab: set up a run, run it, read the results', minutes: 10 },
  { path: '/notebooks/suresuite_01_policy_experiment.ipynb', title: '01 · Policy experiment', mirrors: '/policies edit → Save version → Lab Compare, paired by replication', minutes: 15 },
  { path: '/notebooks/suresuite_02_disruption_resilience.ipynb', title: '02 · Disruption and resilience', mirrors: 'Lab stress tests: plant shutdown, supplier outage, recovery times', minutes: 15 },
  { path: '/notebooks/suresuite_03_local_simulation.ipynb', title: '03 · Simulate on your own machine', mirrors: 'Pull a dataset and policy version, run the engine locally, sweep for free', minutes: 15 },
  { path: '/notebooks/suresuite_04_component_inventory.ipynb', title: '04 · Component inventory: trace materials week by week', mirrors: 'Policies → Run & validate → Single (Inspection mode): pick the versions, run or pull the baseline, knock out suppliers, and follow the materials you choose week by week with and without the disruption', minutes: 10 },
  { path: '/notebooks/suresuite_05_available_to_promise.ipynb', title: '05 · Available to promise', mirrors: 'For the materials you choose: stock position, available to promise, and whether a quantity can leave stock by a week — yes, partial, or the nearest week that works', minutes: 5 },
] as const;
type NotebookPath = (typeof NOTEBOOKS)[number]['path'];
const COLAB_START_URL = 'https://colab.research.google.com/';

// ── Shared SuReSuite treatment (sharp corners, thin borders, mono labels) ────
const SURFACE = 'rounded-sm border border-[--hair-border] bg-white';
const KX = 'font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground';
// L2 — the column row as an ink block. Mono/uppercase/11px/0.04em unchanged;
// the ground and label colour changed, and the bottom border is gone because
// the ink block ends where the data begins.
const TH = 'text-left font-mono text-[11px] uppercase tracking-[0.04em] font-medium text-white bg-[--brand-ink] border-r border-r-[rgba(255,255,255,0.22)] last:border-r-0 px-4 py-2 whitespace-nowrap';
const TD = 'px-4 py-[11px] border-b border-[--hair-divider] align-middle';
// Brand-yellow accent for the "download a template" action — flags a starter
// artifact without competing with the black primary used elsewhere.
const TEMPLATE_BTN =
  'bg-[#F8D448] text-foreground border border-[#e6c02f] shadow-sm hover:bg-[#f0c93a] active:bg-[#e9c22f]';

const SCOPES: { id: string; label: string; hint: string }[] = [
  { id: 'read:data', label: 'read:data', hint: 'List/read projects, item masters, dataset versions' },
  { id: 'write:data', label: 'write:data', hint: 'Freeze dataset versions' },
  { id: 'read:policies', label: 'read:policies', hint: 'Policy catalog, configs, saved versions' },
  { id: 'write:policies', label: 'write:policies', hint: 'Edit policies, snapshot policy versions' },
  { id: 'read:runs', label: 'read:runs', hint: 'Run status, KPIs, replications, validation' },
  { id: 'write:runs', label: 'write:runs', hint: 'Dispatch, cancel, extend simulation runs' },
  { id: 'admin:keys', label: 'admin:keys', hint: 'List/revoke keys over the API (rarely needed)' },
];

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never expires' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

const ENDPOINTS: [string, string, string][] = [
  ['GET /projects · GET /projects/{id}', 'read:data', 'List / read projects'],
  ['POST /projects/{id}/datasets:freeze', 'write:data', 'Freeze an immutable dataset version (graph_hash)'],
  ['GET /projects/{id}/dataset-versions', 'read:data', 'Dataset provenance history'],
  ['GET /projects/{id}/policy-catalog', 'read:policies', 'Engine policy catalog (registry export)'],
  ['GET · PUT /projects/{id}/policies', 'read/write:policies', 'Read / edit policy defaults & overrides'],
  ['GET · POST /projects/{id}/policy-versions', 'read/write:policies', 'List / snapshot immutable policy versions'],
  ['GET · POST /projects/{id}/scenarios', 'read/write:runs', 'List / create scenarios'],
  ['POST /projects/{id}/runs', 'write:runs', 'Dispatch a run (Idempotency-Key supported)'],
  ['GET /runs/{id} · /replications · /validation', 'read:runs', 'Status, KPIs, per-rep rows, credibility badge'],
  ['POST /runs/{id}:cancel · :add-reps', 'write:runs', 'Cancel or extend an in-flight run'],
  ['GET /key', 'any key', 'The calling key: the scopes it may use now, its projects'],
  ['GET /keys · POST /keys/{id}:revoke', 'admin:keys', 'Key inventory / kill switch over the API'],
];

/** Rows a reference table shows before "Show all" — the rest are not hidden silently. */
const NB_TABLE_ROWS = 8;
/** A reference table scrolls inside its own box, so its column row can stay pinned. */
const NB_TABLE_SCROLL = 'max-h-[26rem] overflow-auto';
const NB_TABLE_HEAD = '[&_th]:sticky [&_th]:top-0 [&_th]:z-10';

function ShowAllFooter({ shown, total, all, onToggle }: {
  shown: number; total: number; all: boolean; onToggle: () => void;
}) {
  if (total <= NB_TABLE_ROWS) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[--hair-border] px-4 py-2 text-[11px] text-muted-foreground">
      <span>Showing {shown} of {total}, newest first</span>
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onToggle}>
        {all ? 'Show fewer' : `Show all ${total}`}
      </button>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="rounded-sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {label && <span className="ml-1.5">{label}</span>}
    </Button>
  );
}

function IdCell({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy id"
      className="group inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {value}
      {copied
        ? <Check className="h-3 w-3 shrink-0" />
        : <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

export default function DeveloperApi({ isCollapsed, setIsCollapsed }: Props) {
  const { user, demo } = useAuth();
  const { toast } = useToast();

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [usage, setUsage] = useState<Record<string, UsageRow>>({});
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // create-dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [env, setEnv] = useState<'live' | 'test'>('test');
  const [principal, setPrincipal] = useState<'personal' | 'org'>('personal');
  const [scopes, setScopes] = useState<string[]>(['read:data', 'read:runs']);
  const [allProjects, setAllProjects] = useState(true);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('never');

  // WP 12.7 — what the database will let this caller mint. Every user may create
  // a PERSONAL key with the self-service (read) scopes; admins and modelers also
  // create organization keys and any scope. Read from `api_key_caller`, so the
  // page offers exactly what `create_api_key` accepts. Until it answers, the page
  // assumes the narrower standing.
  const [canManage, setCanManage] = useState(false);
  const [selfServiceScopes, setSelfServiceScopes] = useState<string[]>(['read:data', 'read:policies', 'read:runs']);
  const offeredScopes = canManage ? SCOPES : SCOPES.filter((s) => selfServiceScopes.includes(s.id));

  // show-once state
  const [mintedKey, setMintedKey] = useState<{ plaintext: string; name: string } | null>(null);

  // rotate / revoke targets
  const [rotateTarget, setRotateTarget] = useState<ApiKeyRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [mutating, setMutating] = useState(false);

  // notebook tab: selected project + the ids the notebook's CONFIG cell needs
  const [nbProjectId, setNbProjectId] = useState('');
  const [nbLoading, setNbLoading] = useState(false);
  const [nbDownloading, setNbDownloading] = useState(false);
  const [nbScenarios, setNbScenarios] = useState<NbScenario[]>([]);
  const [nbPolicyVersions, setNbPolicyVersions] = useState<NbPolicyVersion[]>([]);
  const [nbDatasetVersions, setNbDatasetVersions] = useState<NbDatasetVersion[]>([]);
  const [nbShowAllPolicies, setNbShowAllPolicies] = useState(false);
  const [nbShowAllDatasets, setNbShowAllDatasets] = useState(false);

  const rpcAuth = useMemo(
    () => ({ p_user_id: user?.id, p_user_email: user?.email }),
    [user?.id, user?.email],
  );

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    // A demo session reads the project list for the notebook tab and nothing about keys:
    // the demo account has none, and the page must not invite a visitor to make one.
    if (demo) {
      const { data } = await db.rpc('list_projects', rpcAuth);
      setProjects(((data ?? []) as any[]).map((p) => ({ id: p.id, name: p.name })));
      setLoading(false);
      return;
    }
    const [keysRes, usageRes, projectsRes, callerRes] = await Promise.all([
      db.rpc('list_api_keys', rpcAuth),
      db.rpc('api_key_usage', rpcAuth),
      db.rpc('list_projects', rpcAuth),
      db.rpc('api_key_caller', rpcAuth),
    ]);
    const caller = Array.isArray(callerRes.data) ? callerRes.data[0] : callerRes.data;
    if (caller) {
      setCanManage(!!caller.can_manage);
      if (Array.isArray(caller.self_service_scopes)) setSelfServiceScopes(caller.self_service_scopes);
      if (!caller.can_manage) setPrincipal('personal');
    }
    if (keysRes.error) {
      // 'forbidden' = an inactive account or one with no organization.
      const msg = String(keysRes.error.message ?? '');
      toast({
        title: msg.includes('forbidden')
          ? 'Your account cannot use API keys'
          : 'Could not load API keys',
        description: msg.includes('forbidden')
          ? 'API keys need an active account in an organization. Ask your administrator.'
          : msg,
        variant: 'destructive',
      });
      setKeys([]);
    } else {
      setKeys((keysRes.data ?? []) as ApiKeyRow[]);
    }
    setUsage(
      Object.fromEntries(((usageRes.data ?? []) as UsageRow[]).map((u) => [u.api_key_id, u])),
    );
    setProjects(
      ((projectsRes.data ?? []) as any[]).map((p) => ({ id: p.id, name: p.name })),
    );
    setLoading(false);
  }, [user?.id, rpcAuth, toast, demo]);

  useEffect(() => { load(); }, [load]);

  // Load the selected project's ids for the notebook config panel — the same
  // reads the app's own pages use (scenarios table + list_* RPCs), so what the
  // panel shows is exactly what the API will accept.
  useEffect(() => {
    if (!nbProjectId) {
      setNbScenarios([]);
      setNbPolicyVersions([]);
      setNbDatasetVersions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setNbLoading(true);
      const [sc, pv, dv] = await Promise.all([
        db.from('scenarios')
          .select('id,name,horizon_days,warmup_days,replications,seed,primary_kpi,disruption_schedule,created_at')
          .eq('project_id', nbProjectId)
          .order('created_at', { ascending: false }),
        db.rpc('list_policy_versions', { p_project_id: nbProjectId }),
        db.rpc('list_dataset_versions', { p_project_id: nbProjectId }),
      ]);
      if (cancelled) return;
      setNbScenarios((sc.data ?? []) as NbScenario[]);
      setNbPolicyVersions((pv.data ?? []) as NbPolicyVersion[]);
      setNbDatasetVersions((dv.data ?? []) as NbDatasetVersion[]);
      setNbLoading(false);
    })();
    return () => { cancelled = true; };
  }, [nbProjectId]);

  const nbProject = projects.find((p) => p.id === nbProjectId) ?? null;

  // Mirrors the notebook's CONFIG cell exactly (same "# ── CONFIG" marker the
  // download patcher and the .ipynb template share). The PROJECT is the one selected
  // here; the scenario and the policy version are the reader's choice, so they are
  // left blank — the tables on this tab list them, and blank picks a baseline /
  // snapshots the current policies.
  const nbConfigCell = useMemo(() => {
    if (!nbProject) return '';
    return [
      '# ── CONFIG ──────────────────────────────────────────────────────────────────',
      `# Filled from /developer → Notebook for project “${nbProject.name}”.`,
      `BASE_URL = "${API_BASE}"`,
      `PROJECT_ID = "${nbProject.id}"`,
      'SCENARIO_ID = ""         # choose one from the Scenarios table on /developer; "" = pick a baseline (or create one)',
      'POLICY_VERSION_ID = ""   # choose one from the Policy versions table; "" = snapshot the current policies',
      'SUPPLIER_ID = ""         # a supplier id from your own data, for the disruption examples',
      'MODE = "auto"            # "auto" = live when an API key is found, else the offline demo; "live"; "demo"',
      'ACKNOWLEDGE_WARNINGS = False  # True = run anyway when the pre-run data check only warns (missing values use the platform defaults)',
    ].join('\n');
  }, [nbProject]);

  const downloadNotebook = async (path: NotebookPath = NOTEBOOKS[0].path) => {
    setNbDownloading(true);
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`could not load notebook template (${res.status})`);
      const nb = await res.json();
      if (nbConfigCell) {
        const idx = (nb.cells ?? []).findIndex((c: { cell_type: string; source: string | string[] }) =>
          c.cell_type === 'code' &&
          (Array.isArray(c.source) ? c.source.join('') : String(c.source)).startsWith('# ── CONFIG'));
        if (idx >= 0) {
          const lines = nbConfigCell.split('\n');
          nb.cells[idx].source = lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l));
        }
      }
      const slug = nbProject
        ? `_${nbProject.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
        : '';
      const blob = new Blob([JSON.stringify(nb, null, 1)], { type: 'application/x-ipynb+json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${path.split('/').pop()!.replace(/\.ipynb$/, '')}${slug}.ipynb`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    } catch (e) {
      toast({
        title: 'Notebook download failed',
        description: String((e as Error)?.message ?? e),
        variant: 'destructive',
      });
    } finally {
      setNbDownloading(false);
    }
    return false;
  };

  // Colab cannot read the private repository, so hand it the downloaded file.
  // The tab opens before the await so a popup blocker still treats it as the
  // click's own window.
  const openInColab = async (path: NotebookPath = NOTEBOOKS[0].path) => {
    window.open(COLAB_START_URL, '_blank', 'noopener,noreferrer');
    if (await downloadNotebook(path)) {
      toast({
        title: 'Notebook downloaded',
        description: 'In the Colab tab choose File → Upload notebook and pick the downloaded .ipynb.',
      });
    }
  };

  const resetCreateForm = () => {
    setName('');
    setEnv('test');
    setPrincipal('personal');
    setScopes(['read:data', 'read:runs']);
    setAllProjects(true);
    setProjectIds([]);
    setExpiry('never');
  };

  const onCreate = async () => {
    if (!scopes.length) {
      toast({ title: 'Pick at least one scope', variant: 'destructive' });
      return;
    }
    setCreating(true);
    const expiresAt = expiry === 'never'
      ? null
      : new Date(Date.now() + Number(expiry) * 86400_000).toISOString();
    const { data, error } = await db.rpc('create_api_key', {
      ...rpcAuth,
      p_name: name || 'API key',
      p_scopes: scopes,
      p_env: env,
      p_project_ids: allProjects || projectIds.length === 0 ? null : projectIds,
      p_expires_at: expiresAt,
      p_principal: principal,
    });
    setCreating(false);
    if (error) {
      toast({ title: 'Could not create key', description: error.message, variant: 'destructive' });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setCreateOpen(false);
    resetCreateForm();
    setMintedKey({ plaintext: row.plaintext_key, name: name || 'API key' });
    load();
  };

  const onRotate = async () => {
    if (!rotateTarget) return;
    setMutating(true);
    const { data, error } = await db.rpc('rotate_api_key', {
      ...rpcAuth,
      p_key_id: rotateTarget.id,
      p_overlap_hours: 72,
    });
    setMutating(false);
    setRotateTarget(null);
    if (error) {
      toast({ title: 'Could not rotate key', description: error.message, variant: 'destructive' });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setMintedKey({ plaintext: row.plaintext_key, name: `${rotateTarget.name} (rotated)` });
    load();
  };

  const onRevoke = async () => {
    if (!revokeTarget) return;
    setMutating(true);
    const { error } = await db.rpc('revoke_api_key', { ...rpcAuth, p_key_id: revokeTarget.id });
    setMutating(false);
    setRevokeTarget(null);
    if (error) {
      toast({ title: 'Could not revoke key', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Key revoked', description: 'It stops working on the next request.' });
    load();
  };

  // active | expired | revoked → dot color + label, matching the prototype.
  /* ── the phone tree (v2 §4B) ─────────────────────────────────────────────
     WHY A BRANCH. Below 768px this page is three ledgers, a nine-column key
     table and a two-column notebook layout. §10 says a dense table
     summarises with the ledger deferred, and §9.5 forbids sideways scroll
     outside a deliberate table sheet — so each ledger becomes a panel of rows
     whose sub-line carries the columns the row cannot show, and the full
     record is one tap away in a sheet with every column intact.

     NOTHING IS REMOVED. Rotate and revoke keep their own rows rather than
     hiding behind two 14px icons; the create dialog is the same dialog; the
     `#F8D448` template download keeps its "begin here" fill, which is the one
     place in the skin that colour is allowed (§3). */
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<'keys' | 'quickstart' | 'notebook'>(demo ? 'quickstart' : 'keys');
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);
  const [endpointsOpen, setEndpointsOpen] = useState(false);
  const endpointBudget = useRowBudget(4, 6, 9);

  const keyStatus = (k: ApiKeyRow): { label: string; dot: string; text: string } => {
    if (k.status === 'revoked') return { label: 'revoked', dot: '#bf2330', text: 'text-[#bf2330]' };
    if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) {
      return { label: 'expired', dot: '#a3a3a3', text: 'text-muted-foreground' };
    }
    return { label: 'active', dot: '#14b8c4', text: 'text-foreground' };
  };

  const activeCount = keys.filter((k) => keyStatus(k).label === 'active').length;

  const exampleKey = 'sk_live_1a2b3c4d_…your-key…';
  const curlList = `curl -s ${API_BASE}/projects \\
  -H "Authorization: Bearer ${exampleKey}"`;
  const curlRun = `curl -s -X POST ${API_BASE}/projects/PROJECT_ID/runs \\
  -H "Authorization: Bearer ${exampleKey}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-run-2026-07-11" \\
  -d '{"scenario_id":"SCENARIO_ID","policy_version_id":"POLICY_VERSION_ID"}'`;
  const curlPoll = `curl -s ${API_BASE}/runs/RUN_ID \\
  -H "Authorization: Bearer ${exampleKey}"`;
  const pythonSnippet = `import os, time, requests

BASE = "${API_BASE}"
HEADERS = {"Authorization": f"Bearer {os.environ['SURESUITE_API_KEY']}"}

# 1. pick a project
projects = requests.get(f"{BASE}/projects", headers=HEADERS).json()["data"]
project_id = projects[0]["id"]

# 2. snapshot the current policy configuration
version = requests.post(
    f"{BASE}/projects/{project_id}/policy-versions",
    headers=HEADERS, json={"label": "api run"},
).json()

# 3. dispatch a run against an existing scenario
scenarios = requests.get(f"{BASE}/projects/{project_id}/scenarios", headers=HEADERS).json()["data"]
run = requests.post(
    f"{BASE}/projects/{project_id}/runs",
    headers={**HEADERS, "Idempotency-Key": "notebook-demo-1"},
    json={"scenario_id": scenarios[0]["id"], "policy_version_id": version["id"]},
).json()

# 4. poll until finished, then read replications
while True:
    r = requests.get(f"{BASE}/runs/{run['run_id']}", headers=HEADERS).json()
    if r["status"] in ("done", "failed", "cancelled"):
        break
    time.sleep(5)
reps = requests.get(f"{BASE}/runs/{run['run_id']}/replications", headers=HEADERS).json()["data"]
print(r["aggregate_kpis"], len(reps))`;
  const shortageSnippet = `import os, time, requests

BASE = "${API_BASE}"
HEADERS = {"Authorization": f"Bearer {os.environ['SURESUITE_API_KEY']}"}
PROJECT_ID = "your-project-id"
SOLE_SUPPLIER = "S2"  # a supplier_id of YOUR project that is the only source of a material

def run_and_wait(scenario_id, policy_version_id):
    submitted = requests.post(
        f"{BASE}/projects/{PROJECT_ID}/runs", headers={**HEADERS, "Idempotency-Key": f"{scenario_id}:{policy_version_id}"},
        json={"scenario_id": scenario_id, "policy_version_id": policy_version_id},
    ).json()
    while True:
        run = requests.get(f"{BASE}/runs/{submitted['run_id']}", headers=HEADERS).json()
        if run["status"] in ("done", "failed", "cancelled"):  # a finished run is "done"
            return run
        time.sleep(5)

version = requests.post(f"{BASE}/projects/{PROJECT_ID}/policy-versions", headers=HEADERS,
                        json={"label": "shortage study"}).json()
frame = {"horizon_days": 364, "replications": 10, "seed": 42, "crn": True}  # 52 weeks: the engine's minimum

# A material runs short when its suppliers stop: the engine disrupts suppliers and
# the plant (a material target is skipped), so starve the material via its only source.
baseline = requests.post(f"{BASE}/projects/{PROJECT_ID}/scenarios", headers=HEADERS,
                         json={"name": "Shortage study — baseline", **frame}).json()
shortage = requests.post(f"{BASE}/projects/{PROJECT_ID}/scenarios", headers=HEADERS, json={
    "name": f"Shortage study — {SOLE_SUPPLIER} 6-week outage", **frame,
    "disruption_schedule": [{"target": SOLE_SUPPLIER, "start_day": 140, "duration_days": 42, "magnitude_pct": 100}],
}).json()

a = run_and_wait(baseline["id"], version["id"])
b = run_and_wait(shortage["id"], version["id"])
for kpi in ("fill_rate", "lost_units", "lost_sales_value", "max_backlog", "ttr_weeks", "cost_of_resilience"):
    print(f"{kpi:20s} baseline={a['aggregate_kpis'].get(kpi)}  shortage={b['aggregate_kpis'].get(kpi)}")`;

  // The three dialogs are the REAL editors and both chromes mount them
  // unchanged (§8). Below `md` they take the touch floor on every control;
  // nothing else about them moves.
  const dialogs = (
    <>
    {/* ── Create key dialog ─────────────────────────────────────────────── */}
    <ResponsiveDialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetCreateForm(); }}>
      <ResponsiveDialogContent className="max-w-lg rounded-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Create API key</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            The key is scoped to your organization. You'll see the secret once, right after creation.
            {!canManage && (
              <> Your key acts as you and is read-only: it can pull the projects, datasets, policies
              and runs you can see, and install the engine to simulate on your own machine.</>
            )}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              className="rounded-sm"
              placeholder="e.g. CI pipeline, analyst notebook"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <Select value={env} onValueChange={(v) => setEnv(v as 'live' | 'test')}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="test">test — stricter limits, 1 concurrent run (recommended to start)</SelectItem>
                <SelectItem value="live">live — production traffic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {canManage && (
          <div className="space-y-1.5">
            <Label>Acts as</Label>
            <Select value={principal} onValueChange={(v) => setPrincipal(v as 'personal' | 'org')}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">you — stops working if you leave the organization; requests name you</SelectItem>
                <SelectItem value="org">the organization — for shared services; requests name no person</SelectItem>
              </SelectContent>
            </Select>
          </div>
          )}
          <div className="space-y-1.5">
            <Label>Scopes (least privilege: pick only what the caller needs)</Label>
            <div className="grid grid-cols-1 gap-1.5 rounded-sm border border-[--hair-border] p-3 md:max-h-48 md:overflow-y-auto">
              {offeredScopes.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    checked={scopes.includes(s.id)}
                    onCheckedChange={(c) =>
                      setScopes((prev) => (c ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-mono text-xs">{s.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Project access</Label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={allProjects} onCheckedChange={(c) => setAllProjects(!!c)} />
              All projects in my organization
            </label>
            {!allProjects && (
              <div className="space-y-1.5 rounded-sm border border-[--hair-border] p-3 md:max-h-36 md:overflow-y-auto">
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No projects found.</p>
                ) : (
                  projects.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={projectIds.includes(p.id)}
                        onCheckedChange={(c) =>
                          setProjectIds((prev) => (c ? [...prev, p.id] : prev.filter((x) => x !== p.id)))}
                      />
                      {p.name}
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Expiry</Label>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger className="rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button className="rounded-sm" onClick={onCreate} disabled={creating}>
            {creating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Create key
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>

    {/* ── Show-once secret dialog ───────────────────────────────────────── */}
    <ResponsiveDialog open={!!mintedKey} onOpenChange={(o) => { if (!o) setMintedKey(null); }}>
      <ResponsiveDialogContent className="max-w-lg rounded-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Copy your API key now</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            This is the only time the secret for “{mintedKey?.name}” is shown. Only a hash is
            stored — if you lose it, rotate the key to get a new one.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex items-center gap-2">
          <InlineCode className="flex-1 break-all rounded-sm border-[--hair-border] px-3 py-2 text-xs">
            {mintedKey?.plaintext}
          </InlineCode>
          <CopyButton text={mintedKey?.plaintext ?? ''} />
        </div>
        <div className={`${SURFACE} flex gap-3 px-4 py-3`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#bf2330]" />
          <div className="text-xs leading-[1.5] text-[#525252]">
            Store it in a secret manager or environment variable (e.g.{' '}
            <span className="font-mono">SURESUITE_API_KEY</span>). Never commit it to source control.
          </div>
        </div>
        <ResponsiveDialogFooter>
          <Button className="rounded-sm" onClick={() => setMintedKey(null)}>I've stored it safely</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>

    {/* ── Rotate confirm ────────────────────────────────────────────────── */}
    <ResponsiveDialog open={!!rotateTarget} onOpenChange={(o) => { if (!o) setRotateTarget(null); }}>
      <ResponsiveDialogContent className="rounded-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Rotate “{rotateTarget?.name}”?</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A new secret is minted and shown once. The current secret keeps working for a 72-hour
            overlap so you can roll it out, then stops automatically.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={() => setRotateTarget(null)}>Cancel</Button>
          <Button className="rounded-sm" onClick={onRotate} disabled={mutating}>
            {mutating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Rotate key
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>

    {/* ── Revoke confirm ────────────────────────────────────────────────── */}
    <ResponsiveDialog open={!!revokeTarget} onOpenChange={(o) => { if (!o) setRevokeTarget(null); }}>
      <ResponsiveDialogContent className="rounded-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Revoke “{revokeTarget?.name}”?</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            This is immediate and cannot be undone — the key stops working on its next request.
            Any system still using it will start getting 401s.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={() => setRevokeTarget(null)}>Cancel</Button>
          <Button variant="destructive" className="rounded-sm" onClick={onRevoke} disabled={mutating}>
            {mutating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Revoke key
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
    </>
  );
  const openKey = keys.find((k) => k.id === openKeyId) ?? null;

  const mobileKeys = (
    <>
      <MobileGroup>
        {/* §13.3 — the thing that needs attention, and the screen's one ink
            head: a key is a credential and hygiene is what goes wrong. */}
        <MobilePanel tone="primary" label="Key hygiene" counter="read first">
          <p className="px-3 py-3 text-[12.5px] leading-[1.55] text-[#3f3f46] [text-wrap:pretty]">
            Store keys in a secret manager, never in source control. Start on{' '}
            <span className="font-mono">test</span> keys, give each system its own key with the
            narrowest scopes that work — a leaked key is one click to revoke.
          </p>
        </MobilePanel>
      </MobileGroup>

      <MobileGroup label={canManage ? "Organization keys" : "Your keys"}>
        {keys.length > 0 && (
          <MobileStatGrid
            stats={[
              { label: 'Keys', value: String(keys.length) },
              {
                label: 'Active',
                value: String(activeCount),
                dot: activeCount > 0 ? M.process : M.idle,
              },
              {
                label: 'Req 30d',
                value: Object.values(usage)
                  .reduce((n, u) => n + Number(u.requests_30d ?? 0), 0)
                  .toLocaleString(),
              },
            ]}
          />
        )}

        <MobilePanel label="Keys" counter={`${activeCount} / ${keys.length} active`}>
          {loading ? (
            <p className="px-3 py-8 text-center text-[13px] text-[#525252]">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
              <span className="max-w-[250px] text-[13px] leading-relaxed text-[#525252] [text-wrap:pretty]">
                No API keys yet. Create one to call the API from scripts, notebooks or CI — the
                secret is shown once.
              </span>
            </div>
          ) : (
            keys.map((k) => {
              const st = keyStatus(k);
              const u = usage[k.id];
              return (
                <MobileRow
                  key={k.id}
                  dot={st.dot}
                  label={k.name}
                  sub={`sk_${k.env}_${k.key_prefix}_•••• · ${st.label}${k.principal === 'personal' ? ' · personal' : ''} · ${
                    k.project_ids ? `${k.project_ids.length} projects` : 'all projects'
                  }`}
                  value={u ? Number(u.requests_30d).toLocaleString() : '0'}
                  onClick={() => setOpenKeyId(k.id)}
                />
              );
            })
          )}
        </MobilePanel>
      </MobileGroup>

      {/* The full record — every column the nine-column ledger has, plus the
          two actions that were icon-only on desktop. */}
      <MobileSheet
        open={openKey != null}
        title={openKey?.name ?? ''}
        sub="The whole record, and everything you can do to this key."
        onClose={() => setOpenKeyId(null)}
      >
        {openKey && (
          <div className="flex flex-col">
            <MobileRow chevron={false} label="Key" sub={`sk_${openKey.env}_${openKey.key_prefix}_••••`} />
            <MobileRow chevron={false} label="Environment" value={openKey.env} />
            <MobileRow
              chevron={false}
              dot={keyStatus(openKey).dot}
              label="Status"
              value={keyStatus(openKey).label}
            />
            <MobileRow
              chevron={false}
              label="Scopes"
              sub={openKey.scopes.join(' · ')}
              value={String(openKey.scopes.length)}
            />
            <MobileRow
              chevron={false}
              label="Projects"
              value={openKey.project_ids ? `${openKey.project_ids.length} selected` : 'All'}
            />
            <MobileRow
              chevron={false}
              label="Requests 30d"
              sub={
                usage[openKey.id]?.errors_30d
                  ? `${usage[openKey.id].errors_30d} errors`
                  : undefined
              }
              value={
                usage[openKey.id] ? Number(usage[openKey.id].requests_30d).toLocaleString() : '0'
              }
            />
            <MobileRow
              chevron={false}
              label="Last used"
              value={openKey.last_used_at ? new Date(openKey.last_used_at).toLocaleDateString() : 'never'}
            />
            <div className="p-3">
              <MobileButtonRow>
                <MobileButton
                  weight="secondary"
                  disabled={openKey.status !== 'active'}
                  title="Rotate: mints a new secret; the old one keeps working for 72 h"
                  onClick={() => {
                    setRotateTarget(openKey);
                    setOpenKeyId(null);
                  }}
                >
                  Rotate
                </MobileButton>
                <MobileButton
                  weight="secondary"
                  disabled={openKey.status !== 'active'}
                  title="Revoke immediately"
                  onClick={() => {
                    setRevokeTarget(openKey);
                    setOpenKeyId(null);
                  }}
                >
                  Revoke
                </MobileButton>
              </MobileButtonRow>
              {openKey.status !== 'active' && (
                <p className="mt-1.5 text-[12px] leading-[1.4] text-[#525252] [text-wrap:pretty]">
                  This key is {keyStatus(openKey).label} — there is nothing left to rotate or revoke.
                </p>
              )}
            </div>
          </div>
        )}
      </MobileSheet>
    </>
  );

  const mobileQuickstart = (
    <>
      <MobileGroup label="Base URL">
        <MobilePanel label="Gateway" counter="/v1">
          <MobileRow
            chevron={false}
            label={API_BASE}
            sub="Authorization: Bearer sk_…"
            className="[&_span]:[word-break:break-all]"
          />
          <div className="p-3">
            <MobileButton weight="secondary" block onClick={() => navigator.clipboard?.writeText(API_BASE)}>
              Copy base URL
            </MobileButton>
          </div>
          <p className="px-3 py-3 text-[12.5px] leading-[1.5] text-[#3f3f46] [text-wrap:pretty]">
            All endpoints are versioned under <span className="font-mono">/v1</span>. Errors use a
            consistent <span className="font-mono">{'{"error":{"code","message"}}'}</span> envelope;
            rate-limit state is returned in <span className="font-mono">X-RateLimit-*</span> headers.
          </p>
        </MobilePanel>
      </MobileGroup>

      {/* A code block is one of the two places §9.5 allows sideways scroll. */}
      <MobileGroup label="Calls">
        <ApiCodeBlock title="List your projects" code={curlList} />
        <ApiCodeBlock title="Dispatch a run (202 → run_id)" code={curlRun} />
        <ApiCodeBlock title="Poll a run until it finishes" code={curlPoll} />
        <ApiCodeBlock title="Python: end-to-end" code={pythonSnippet} />
        <ApiCodeBlock title="Python: material shortage — a sole-source supplier outage" code={shortageSnippet} />
      </MobileGroup>

      <MobileGroup label="Reference">
        <MobilePanel label="Endpoints · v1" counter={`${ENDPOINTS.length}`}>
          {ENDPOINTS.slice(0, endpointBudget).map(([ep, scope, what]) => (
            <MobileRow key={ep} chevron={false} label={ep} sub={`${scope} · ${what}`} />
          ))}
          {ENDPOINTS.length > endpointBudget && (
            <MobileRow
              label={`All ${ENDPOINTS.length} endpoints`}
              sub={`${ENDPOINTS.length - endpointBudget} more`}
              onClick={() => setEndpointsOpen(true)}
            />
          )}
          <p className="px-3 py-3 text-[12px] leading-[1.45] text-[#525252]">
            Full reference: <span className="font-mono">docs/api/README.md</span> in the repository.
          </p>
        </MobilePanel>
      </MobileGroup>

      <MobileSheet
        open={endpointsOpen}
        title="Endpoints · v1"
        sub="Every endpoint, its scope and what it does."
        onClose={() => setEndpointsOpen(false)}
      >
        <div className="flex flex-col">
          {ENDPOINTS.map(([ep, scope, what]) => (
            <MobileRow key={ep} chevron={false} label={ep} sub={`${scope} · ${what}`} />
          ))}
        </div>
      </MobileSheet>
    </>
  );

  const mobileNotebook = (
    <>
      <MobileGroup label="Notebooks">
        <MobilePanel label="The notebook series" counter={`${NOTEBOOKS.length}`}>
          <p className="px-3 py-3 text-[12.5px] leading-[1.55] text-[#3f3f46] [text-wrap:pretty]">
            Each notebook is the Python version of one workflow in the app. Without a key it runs
            in demo mode on recorded engine output; pick your project below first and a download
            fills in its project id. Choose the scenario and policy version yourself.
          </p>
          {NOTEBOOKS.map((nb, i) => (
            <div key={nb.path} className="border-t border-[#e5e5e5] p-3">
              <p className="text-[13px] font-semibold text-[#171717]">{nb.title}</p>
              <p className="pb-2 text-[12px] leading-[1.5] text-[#525252]">
                {nb.mirrors} · about {nb.minutes} min
              </p>
              <MobileButtonRow>
                <MobileButton weight="secondary" onClick={() => openInColab(nb.path)} disabled={nbDownloading}>
                  Open in Colab
                </MobileButton>
                {/* "Begin here" — the one #F8D448 the skin allows, reserved for
                    the template download (§3): the quickstart is where to begin. */}
                <MobileButton
                  weight={i === 0 ? 'begin' : 'secondary'}
                  onClick={() => downloadNotebook(nb.path)}
                  disabled={nbDownloading}
                >
                  {nbDownloading ? 'Preparing…' : 'Download'}
                </MobileButton>
              </MobileButtonRow>
            </div>
          ))}
        </MobilePanel>
      </MobileGroup>

      <MobileGroup label="Project">
        <MobilePanel label="Notebook project" counter={nbProject ? '1' : 'none'}>
          <MobileRow
            chevron={false}
            label="Project"
            trailing={
              <select
                className="h-11 min-w-0 max-w-[52vw] shrink rounded-[6px] border border-[#d4d4d4] bg-white px-2 text-[length:var(--fs-row)] text-[#171717] focus:border-[#18181b] focus:outline-none"
                value={nbProjectId}
                onChange={(e) => setNbProjectId(e.target.value)}
                aria-label="Notebook project"
              >
                <option value="">
                  {projects.length ? 'Select a project…' : 'No projects available'}
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            }
          />
          {nbProject && (
            <MobileRow chevron={false} label="Project ID" sub={nbProject.id} />
          )}
        </MobilePanel>

        <ApiCodeBlock
          title="Notebook CONFIG cell (project filled in)"
          code={nbConfigCell || '# Select a project to fill in BASE_URL, PROJECT_ID, SCENARIO_ID, POLICY_VERSION_ID'}
        />
      </MobileGroup>

      {nbProject && !nbLoading && (
        <MobileGroup label="Ids the notebook needs">
          <MobilePanel label="Scenarios · SCENARIO_ID" counter={`${nbScenarios.length}`}>
            {nbScenarios.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] leading-[1.45] text-[#525252]">
                None yet — §3 of the Quickstart creates one via{' '}
                <span className="font-mono">POST …/scenarios</span>.
              </p>
            ) : (
              nbScenarios.map((sc) => (
                <MobileRow
                  key={sc.id}
                  chevron={false}
                  label={sc.name}
                  sub={`${sc.id} · ${sc.horizon_days} d (+${sc.warmup_days}) · ${sc.replications} reps · ${sc.primary_kpi}`}
                />
              ))
            )}
          </MobilePanel>

          <MobilePanel label="Policy versions · POLICY_VERSION_ID" counter={`${nbPolicyVersions.length}`}>
            {nbPolicyVersions.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] leading-[1.45] text-[#525252]">
                None yet — §2 of the Quickstart snapshots one via{' '}
                <span className="font-mono">POST …/policy-versions</span>.
              </p>
            ) : (
              nbPolicyVersions.map((v) => (
                <MobileRow
                  key={v.id}
                  chevron={false}
                  label={v.label ?? 'unlabelled'}
                  sub={`${v.id} · policy ${(v.policy_hash ?? '').slice(0, 12)}… · ${new Date(v.created_at).toLocaleDateString()}`}
                  value={String(v.run_count)}
                />
              ))
            )}
          </MobilePanel>

          <MobilePanel label="Dataset versions · provenance" counter={`${nbDatasetVersions.length}`}>
            {nbDatasetVersions.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] leading-[1.45] text-[#525252]">
                None yet — §2 of the Quickstart freezes one via{' '}
                <span className="font-mono">POST …/datasets:freeze</span>.
              </p>
            ) : (
              nbDatasetVersions.map((v) => (
                <MobileRow
                  key={v.id}
                  chevron={false}
                  label={v.label ?? 'unlabelled'}
                  sub={`${snapshotTuple(v)} · ${v.id} · graph ${(v.graph_hash ?? '').slice(0, 12)}… · ${new Date(v.created_at).toLocaleDateString()}`}
                />
              ))
            )}
          </MobilePanel>
        </MobileGroup>
      )}

      {nbLoading && (
        <MobilePanel label="Ids the notebook needs">
          <p className="px-3 py-8 text-center text-[13px] text-[#525252]">Loading…</p>
        </MobilePanel>
      )}

      {/* §13.6 — one consequence line, and this is the one that matters. */}
      <MobileNote>
        Never paste your API key into a notebook cell. In Colab store it once in the Secrets panel
        as <span className="font-mono">SURESUITE_API_KEY</span>.
      </MobileNote>
    </>
  );

  if (isMobile) {
    return (
      <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
        {/* v3 §1.1, D3-a: sibling before the gutter, root variant — Developer
            API is a root with no tab of its own (D3-a names it explicitly),
            so it keeps the tab bar (no item active) rather than a back
            arrow. The three-view segmented is exactly the "peer views" case
            the second row is for; refresh takes the one meta-slot action. */}
        <MobilePageHeader
          variant="root"
          title="Developer API"
          meta={
            <button
              type="button"
              onClick={load}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
              className="relative -mr-1 grid h-[32px] w-[32px] shrink-0 place-items-center text-[#18181b] after:absolute after:-inset-1.5 after:content-['']"
            >
              <RefreshCcw className={cn('h-[16px] w-[16px]', loading && 'animate-spin')} />
            </button>
          }
        >
          <MobileSegmented
            ariaLabel="Developer API views"
            value={tab}
            onChange={setTab}
            items={[
              ...(demo ? [] : [{ value: 'keys', label: 'API keys', count: keys.length || undefined }]),
              { value: 'quickstart', label: 'Quickstart' },
              { value: 'notebook', label: 'Notebook' },
            ]}
          />
        </MobilePageHeader>
        <div className={PAGE_GUTTER_SKIN}>
          <div className="flex flex-col gap-[var(--m-gap)]">
            {tab === 'keys' ? mobileKeys : tab === 'quickstart' ? mobileQuickstart : mobileNotebook}
          </div>

          {tab === 'keys' && (
            <MobileActionBar primary={{ label: 'Create API key', onClick: () => setCreateOpen(true) }} />
          )}
        </div>
        {dialogs}
      </PageLayout>
    );
  }

  return (
    <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
      <div className={PAGE_GUTTER}>
        <PageHeader title="Developer API" onRefresh={load} refreshLoading={loading} />

        <Tabs defaultValue={demo ? 'quickstart' : 'keys'} className="space-y-4">
          {/* Black-pill active tab (bg-foreground text-background), sharp corners */}
          <TabsList className="inline-flex h-auto items-center gap-0.5 rounded-sm border border-[--hair-border] bg-white p-[3px]">
            {!demo && (
              <TabsTrigger
                value="keys"
                className="rounded-[2px] px-[15px] py-[7px] text-[12.5px] font-medium text-muted-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none"
              >
                API keys
              </TabsTrigger>
            )}
            <TabsTrigger
              value="quickstart"
              className="rounded-[2px] px-[15px] py-[7px] text-[12.5px] font-medium text-muted-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none"
            >
              Quickstart
            </TabsTrigger>
            <TabsTrigger
              value="notebook"
              className="rounded-[2px] px-[15px] py-[7px] text-[12.5px] font-medium text-muted-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none"
            >
              Notebook
            </TabsTrigger>
          </TabsList>

          {/* ── Keys ─────────────────────────────────────────────────────── */}
          <TabsContent value="keys" className="space-y-3.5">
            {/* Key hygiene — bespoke red-kicker card, ABOVE the table */}
            <div className={`${SURFACE} flex gap-3 px-4 py-3.5`}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#bf2330]" />
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#bf2330]">
                  Key hygiene
                </div>
                <div className="mt-1.5 max-w-3xl text-[12.5px] leading-[1.55] text-[#525252]">
                  Store keys in a secret manager, never in source control. Start on{' '}
                  <span className="font-mono">test</span> keys, give each system its own key with the
                  narrowest scopes that work — a leaked key is one click to revoke.
                </div>
              </div>
            </div>

            {/* L1: the table's name reads on the canvas, above the shell. */}
            <TableBlock
              name={canManage ? "Organization keys" : "Your keys"}
              count={keys.length}
              meta={`${activeCount} active`}
              actions={
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Create API key
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={`${TH} ${FROZEN_CELL_ON_TINT}`}>Name</th>
                      <th className={TH}>Key</th>
                      <th className={TH}>Env</th>
                      <th className={TH}>Scopes</th>
                      <th className={TH}>Projects</th>
                      <th className={TH}>Status</th>
                      <th className={`${TH} text-right`}>Req 30d</th>
                      <th className={TH}>Last used</th>
                      <th className={`${TH} w-[1%]`} />
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-12 text-center">
                          <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                        </td>
                      </tr>
                    ) : keys.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-14">
                          <div className="mx-auto flex max-w-sm flex-col items-center text-center">
                            <div className="grid h-11 w-11 place-items-center rounded-md border border-[--hair-border] text-muted-foreground">
                              <KeyRound className="h-[18px] w-[18px]" />
                            </div>
                            <div className="mt-4 text-[15px] font-semibold">No API keys yet</div>
                            <div className="mt-1.5 text-[13px] leading-[1.5] text-muted-foreground">
                              Create one to call the API from scripts, notebooks, or CI. The secret is
                              shown once.
                            </div>
                            <Button size="sm" className="mt-[18px] rounded-sm" onClick={() => setCreateOpen(true)}>
                              <Plus className="mr-1.5 h-3.5 w-3.5" /> Create API key
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      keys.map((k) => {
                        const st = keyStatus(k);
                        const u = usage[k.id];
                        return (
                          <tr key={k.id} className="hover:bg-[#fcfcfc]">
                            <td className={`${TD} whitespace-nowrap text-[13px] font-medium`}>{k.name}</td>
                            <td className={`${TD} font-mono text-[11px] text-muted-foreground`}>
                              sk_{k.env}_{k.key_prefix}_••••
                            </td>
                            <td className={TD}>
                              {k.env === 'test' ? (
                                <span className="rounded-sm bg-[#f0f0f0] px-[7px] py-0.5 font-mono text-[10px] text-[#525252]">
                                  test
                                </span>
                              ) : (
                                <span className="rounded-sm border border-[#d4d4d4] px-[7px] py-0.5 font-mono text-[10px] text-foreground">
                                  live
                                </span>
                              )}
                              {k.principal === 'personal' && (
                                <span className="ml-1 rounded-sm bg-[#f0f0f0] px-[7px] py-0.5 font-mono text-[10px] text-[#525252]">
                                  personal
                                </span>
                              )}
                            </td>
                            <td className={`${TD} max-w-[220px]`}>
                              <div className="flex flex-wrap gap-1">
                                {k.scopes.map((s) => (
                                  <span
                                    key={s}
                                    className="rounded-sm border border-[--zinc-border] px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                                  >
                                    {s}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className={`${TD} text-xs text-muted-foreground`}>
                              {k.project_ids ? `${k.project_ids.length} selected` : 'All'}
                            </td>
                            <td className={TD}>
                              <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${st.text}`}>
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ background: st.dot }}
                                />
                                {st.label}
                              </span>
                            </td>
                            <td className={`${TD} whitespace-nowrap text-right font-mono text-xs tabular-nums`}>
                              {u ? (
                                <>
                                  {Number(u.requests_30d).toLocaleString()}
                                  {u.errors_30d > 0 && (
                                    <span className="text-[#bf2330]"> · {u.errors_30d} err</span>
                                  )}
                                </>
                              ) : '0'}
                            </td>
                            <td className={`${TD} whitespace-nowrap text-xs text-muted-foreground`}>
                              {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                            </td>
                            <td className={`${TD} whitespace-nowrap text-right`}>
                              {k.status === 'active' && (
                                <div className="inline-flex items-center gap-2 text-[#a3a3a3]">
                                  <button
                                    type="button"
                                    title="Rotate: mints a new secret; the old one keeps working for 72 h"
                                    className="hover:text-foreground"
                                    onClick={() => setRotateTarget(k)}
                                  >
                                    <RefreshCcw className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    title="Revoke immediately"
                                    className="hover:text-[#bf2330]"
                                    onClick={() => setRevokeTarget(k)}
                                  >
                                    <ShieldOff className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </TableBlock>
          </TabsContent>

          {/* ── Quickstart ───────────────────────────────────────────────── */}
          <TabsContent value="quickstart" className="space-y-4">
            <div>
              <div className="text-[14px] font-semibold">Base URL</div>
              <div className="mt-2 flex items-center gap-2.5">
                <InlineCode className="min-w-0 flex-1 truncate rounded-sm border-[--hair-border] text-[11.5px]">
                  {API_BASE}
                </InlineCode>
                <CopyButton text={API_BASE} label="Copy" />
              </div>
              <p className="mt-2 text-xs leading-[1.5] text-muted-foreground">
                All endpoints are versioned under <span className="font-mono">/v1</span> and
                authenticated with <span className="font-mono">Authorization: Bearer sk_…</span>.
                Errors use a consistent{' '}
                <span className="font-mono">{'{"error":{"code","message"}}'}</span> envelope;
                rate-limit state is returned in <span className="font-mono">X-RateLimit-*</span> headers.
              </p>
            </div>

            <div className="grid gap-3.5 md:grid-cols-2">
              <ApiCodeBlock title="List your projects" code={curlList} />
              <ApiCodeBlock title="Dispatch a run (202 → run_id; a retried submit with the same Idempotency-Key returns the same run)" code={curlRun} />
              <ApiCodeBlock title="Poll a run until it finishes" code={curlPoll} />
              <ApiCodeBlock title="Python: end-to-end (snapshot → dispatch → poll → replications)" code={pythonSnippet} />
            </div>

            <div>
              <div className="text-[14px] font-semibold">Example: material shortage on Project AA (Version 3)</div>
              <p className="mt-2 text-xs leading-[1.5] text-muted-foreground">
                Resolves a real project and policy snapshot by name, runs a baseline and a
                supplier/material capacity-cut scenario, then compares the shortage KPIs
                (<span className="font-mono">fill_rate</span>,{' '}
                <span className="font-mono">lost_sales_value</span>,{' '}
                <span className="font-mono">max_backlog</span>) driven by policy{' '}
                <span className="font-mono">P-C.1 unmet_demand_handling</span>. The full
                version — with baseline vs. shortage charts and a weekly fill-rate
                trajectory plot — is §13 of the{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => {
                    const tab = document.querySelector<HTMLButtonElement>('[value="notebook"]');
                    tab?.click();
                  }}
                >
                  Notebook tab
                </button>{' '}
                quickstart.
              </p>
            </div>
            <ApiCodeBlock title="Python: material shortage — a sole-source supplier outage" code={shortageSnippet} />

            {/* L1: the table's name reads on the canvas, above the shell. */}
            <TableBlock name="Endpoints · v1" count={ENDPOINTS.length}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <tbody>
                    {ENDPOINTS.map(([ep, scope, what]) => (
                      <tr key={ep} className="hover:bg-[#fcfcfc]">
                        <td className={`${TD} whitespace-nowrap font-mono text-[11px] text-foreground`}>{ep}</td>
                        <td className={`${TD} whitespace-nowrap font-mono text-[11px] text-muted-foreground`}>{scope}</td>
                        <td className={`${TD} text-xs text-[#525252]`}>{what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-[--hair-border] px-4 py-2.5 text-[11px] text-muted-foreground">
                Full reference: <span className="font-mono">docs/api/README.md</span> in the repository.
              </div>
            </TableBlock>
          </TabsContent>

          {/* ── Notebook ─────────────────────────────────────────────────── */}
          <TabsContent value="notebook" className="space-y-4">
            <div className="space-y-2">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-[14px] font-semibold">
                  <NotebookText className="h-3.5 w-3.5" /> Notebook series
                </div>
                <p className="text-xs text-muted-foreground">
                  Each notebook is the Python version of one workflow in the app, for Google Colab or
                  a local Jupyter. Without a key it runs in demo mode on recorded engine output for
                  the Example project; with one it works on your project. Pick a project below first —
                  a download fills in its project id{nbProject ? ` (now: “${nbProject.name}”)` : ''}. The
                  scenario and the policy version are yours to choose from the tables below.
                </p>
              </div>
              <div className={`${SURFACE} divide-y divide-[--hair-border]`}>
                {NOTEBOOKS.map((nb, i) => (
                  <div key={nb.path} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{nb.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {nb.mirrors} · about {nb.minutes} min
                      </div>
                    </div>
                    <div className="flex flex-none gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-sm"
                        onClick={() => openInColab(nb.path)}
                        disabled={nbDownloading}
                      >
                        <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open in Colab
                      </Button>
                      <Button
                        size="sm"
                        variant={i === 0 ? 'default' : 'outline'}
                        className={cn('rounded-sm', i === 0 && TEMPLATE_BTN)}
                        onClick={() => downloadNotebook(nb.path)}
                        disabled={nbDownloading}
                      >
                        {nbDownloading
                          ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          : <Download className="mr-1.5 h-3.5 w-3.5" />}
                        Download (.ipynb)
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:items-start">
              {/* Project + CONFIG cell */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-[#404040]">Project</Label>
                  <Select value={nbProjectId} onValueChange={setNbProjectId}>
                    <SelectTrigger className="rounded-sm">
                      <SelectValue placeholder={projects.length ? 'Select a project…' : 'No projects available'} />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {nbProject && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Project ID</p>
                    <div className="flex items-center gap-2">
                      <InlineCode className="min-w-0 flex-1 truncate rounded-sm border-[--hair-border]">{nbProject.id}</InlineCode>
                      <CopyButton text={nbProject.id} />
                    </div>
                  </div>
                )}

                <ApiCodeBlock
                  title="Notebook CONFIG cell (project filled in every download — or paste it over a notebook's CONFIG cell)"
                  code={nbConfigCell || '# Select a project to fill in BASE_URL, PROJECT_ID, SCENARIO_ID, POLICY_VERSION_ID'}
                />
              </div>

              {/* Id reference tables */}
              <div className="space-y-3.5">
                {!nbProject ? (
                  <div className={`${SURFACE} px-4 py-10 text-center text-sm text-muted-foreground`}>
                    Select a project to see every id the notebook needs.
                  </div>
                ) : nbLoading ? (
                  <div className={`${SURFACE} px-4 py-10 text-center`}>
                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <>
                    <div>
                      <div className={`${KX} mb-1.5 tracking-[0.06em]`}>
                        Scenarios ({nbScenarios.length}) · SCENARIO_ID
                      </div>
                      {nbScenarios.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          None yet — §3 of the Quickstart creates one via{' '}
                          <span className="font-mono">POST …/scenarios</span>.
                        </p>
                      ) : (
                        <div className={`${SURFACE} overflow-hidden`}>
                          <div className={NB_TABLE_SCROLL}>
                            <table className="w-full border-collapse">
                              <thead className={NB_TABLE_HEAD}>
                                <tr>
                                  <th className={TH}>Name</th>
                                  <th className={TH}>ID</th>
                                  <th className={TH}>Horizon</th>
                                  <th className={TH}>Reps</th>
                                  <th className={TH}>Primary KPI</th>
                                </tr>
                              </thead>
                              <tbody>
                                {nbScenarios.map((s) => (
                                  <tr key={s.id} className="hover:bg-[#fcfcfc]">
                                    <td className={`${TD} ${FROZEN_CELL} text-xs font-medium`}>{s.name}</td>
                                    <td className={TD}><IdCell value={s.id} /></td>
                                    <td className={`${TD} text-xs`}>{s.horizon_days} d (+{s.warmup_days})</td>
                                    <td className={`${TD} text-xs`}>{s.replications}</td>
                                    <td className={`${TD} font-mono text-[11px]`}>{s.primary_kpi}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className={`${KX} mb-1.5 tracking-[0.06em]`}>
                        Policy versions ({nbPolicyVersions.length}) · POLICY_VERSION_ID
                      </div>
                      {nbPolicyVersions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          None yet — §2 of the Quickstart snapshots one via{' '}
                          <span className="font-mono">POST …/policy-versions</span>.
                        </p>
                      ) : (
                        <div className={`${SURFACE} overflow-hidden`}>
                          <div className={NB_TABLE_SCROLL}>
                            <table className="w-full border-collapse">
                              <thead className={NB_TABLE_HEAD}>
                                <tr>
                                  <th className={TH}>Label</th>
                                  <th className={TH} title="The snapshot's number and its level versions: Product · pRocess · Firm · Simulation inputs">Version</th>
                                  <th className={TH}>ID</th>
                                  <th className={TH}>policy_hash</th>
                                  <th className={TH}>Runs</th>
                                  <th className={TH}>Created</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(nbShowAllPolicies ? nbPolicyVersions : nbPolicyVersions.slice(0, NB_TABLE_ROWS)).map((v) => (
                                  <tr key={v.id} className="hover:bg-[#fcfcfc]">
                                    <td className={`${TD} text-xs font-medium`}>{v.label ?? 'unlabelled'}</td>
                                    <td className={`${TD} whitespace-nowrap font-mono text-[11px]`}>{snapshotTuple(v)}</td>
                                    <td className={TD}><IdCell value={v.id} /></td>
                                    <td className={`${TD} font-mono text-[11px] text-muted-foreground`}>{(v.policy_hash ?? '').slice(0, 12)}…</td>
                                    <td className={`${TD} text-xs`}>{v.run_count}</td>
                                    <td className={`${TD} whitespace-nowrap text-xs text-muted-foreground`}>{new Date(v.created_at).toLocaleDateString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <ShowAllFooter
                            shown={nbShowAllPolicies ? nbPolicyVersions.length : Math.min(NB_TABLE_ROWS, nbPolicyVersions.length)}
                            total={nbPolicyVersions.length}
                            all={nbShowAllPolicies}
                            onToggle={() => setNbShowAllPolicies((v) => !v)}
                          />
                        </div>
                      )}
                    </div>

                    <div>
                      <div className={`${KX} mb-1.5 tracking-[0.06em]`}>
                        Dataset versions ({nbDatasetVersions.length}) · input-data provenance
                      </div>
                      {nbDatasetVersions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          None yet — §2 of the Quickstart freezes one via{' '}
                          <span className="font-mono">POST …/datasets:freeze</span>.
                        </p>
                      ) : (
                        <div className={`${SURFACE} overflow-hidden`}>
                          <div className={NB_TABLE_SCROLL}>
                            <table className="w-full border-collapse">
                              <thead className={NB_TABLE_HEAD}>
                                <tr>
                                  <th className={TH}>Label</th>
                                  <th className={TH}>ID</th>
                                  <th className={TH}>graph_hash</th>
                                  <th className={TH}>Created</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(nbShowAllDatasets ? nbDatasetVersions : nbDatasetVersions.slice(0, NB_TABLE_ROWS)).map((v) => (
                                  <tr key={v.id} className="hover:bg-[#fcfcfc]">
                                    <td className={`${TD} text-xs font-medium`}>{v.label ?? 'unlabelled'}</td>
                                    <td className={TD}><IdCell value={v.id} /></td>
                                    <td className={`${TD} font-mono text-[11px] text-muted-foreground`}>{(v.graph_hash ?? '').slice(0, 12)}…</td>
                                    <td className={`${TD} whitespace-nowrap text-xs text-muted-foreground`}>{new Date(v.created_at).toLocaleDateString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <ShowAllFooter
                            shown={nbShowAllDatasets ? nbDatasetVersions.length : Math.min(NB_TABLE_ROWS, nbDatasetVersions.length)}
                            total={nbDatasetVersions.length}
                            all={nbShowAllDatasets}
                            onToggle={() => setNbShowAllDatasets((v) => !v)}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className={`${SURFACE} flex gap-3 px-4 py-3.5`}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#bf2330]" />
              <div className="text-xs leading-[1.55] text-[#525252]">
                Never paste your API key into a notebook cell. In Colab, store it once in the{' '}
                <span className="font-medium">Secrets</span> panel as{' '}
                <span className="font-mono">SURESUITE_API_KEY</span> — the notebook reads it from
                there (or from the environment / a hidden prompt when run locally). Open in Colab
                downloads your copy (project filled in) and opens Colab — load it with{' '}
                <span className="font-medium">File → Upload notebook</span>.
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {dialogs}
    </PageLayout>
  );
}
