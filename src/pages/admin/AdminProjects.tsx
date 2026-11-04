// Projects (/admin/projects) — SuReSuite "Ledger" redesign.
// Data flow, RPCs (admin_list_projects/organizations/users_basic, copy/rename/
// update_meta/transfer/delete) and search unchanged. Transfer also changes the
// owner in place and offers only members of the target organization (D212).
// "Members & access" lists who is on the project and what each may do (D215).
// Model column shows a mono BOM/data chip pair; status is an outlined chip; row
// actions live in a menu.
import { invalidateProjectsCache } from '@/lib/projects/projectsCache';
import { projectWindow } from '@/lib/sim/projectWindow';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { AdminMobileList, AdminMobileRow, SURFACE, TH, TD, ROW_HOVER, MonoChip, StatusDot, EmptyRow, LoadingRow, useTableSort, useColumnFilters } from '@/components/admin/adminUi';
import { M, MobileButton } from '@/components/mobile';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfirm } from '@/components/shared/confirm/useConfirm';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/shared/ResponsiveDialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ArrowRightLeft, Copy, Loader2, MoreHorizontal, Pencil, Settings2, Trash2, Users } from 'lucide-react';
import { ProjectAccessDialog } from '@/components/admin/ProjectAccess';
import { toast } from 'sonner';
import { DIALOG_AS_SHEET, HDR_SEARCH_INPUT } from '@/components/shared';
import { cn } from '@/lib/utils';

interface Props { isCollapsed: boolean; setIsCollapsed: (v: boolean) => void; }
interface ProjectRow { id: string; name: string; organization_id: string | null; organization: string | null; modeler_id: string; owner_name: string | null; owner_email: string | null; plant_name: string; supply_chain_model: string; bom_level: string; data_type: string; completed: boolean; simulation_start: string | null; simulation_end: string | null; created_at: string; updated_at: string; }
interface OrgOption { id: string; name: string; }
interface UserOption { id: string; name: string | null; email: string | null; organization_id: string | null; is_active: boolean | null; org_ids: string[] | null; }
type DialogKind = 'access' | 'copy' | 'rename' | 'meta' | 'transfer' | null;

const db = supabase as any;
const NONE = '__none__';
const userLabel = (u: UserOption) => (u.name ? `${u.name} (${u.email})` : u.email || u.id);

export default function AdminProjects({ isCollapsed, setIsCollapsed }: Props) {
  const isMobile = useIsMobile();
  const { user: actor } = useAuth();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [target, setTarget] = useState<ProjectRow | null>(null);
  const actorArgs = () => ({ p_actor_id: actor?.id, p_actor_email: actor?.email });

  const load = async () => {
    setLoading(true);
    const [projRes, orgRes, userRes] = await Promise.all([
      db.rpc('admin_list_projects', actorArgs()),
      db.rpc('admin_list_organizations', actorArgs()),
      db.rpc('admin_list_users_basic', actorArgs()),
    ]);
    if (projRes.error) toast.error(projRes.error.message);
    setRows((projRes.data ?? []) as ProjectRow[]);
    setOrgs(((orgRes.data ?? []) as any[]).map((o) => ({ id: o.id, name: o.name })));
    setUsers((userRes.data ?? []) as UserOption[]);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  // Admin edits (rename, copy, transfer, delete) change what list_projects returns.
  useEffect(() => () => invalidateProjectsCache(), []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(s) || (r.organization || '').toLowerCase().includes(s) || (r.owner_name || '').toLowerCase().includes(s) || (r.owner_email || '').toLowerCase().includes(s) || (r.plant_name || '').toLowerCase().includes(s));
  }, [rows, q]);

  const colFilterGetters = useMemo(() => ({
    name: (p: ProjectRow) => p.name, org: (p: ProjectRow) => p.organization || '', owner: (p: ProjectRow) => `${p.owner_name || ''} ${p.owner_email || ''}`,
    plant: (p: ProjectRow) => p.plant_name || '', model: (p: ProjectRow) => p.supply_chain_model, status: (p: ProjectRow) => (p.completed ? 'completed' : 'draft'),
    updated: (p: ProjectRow) => new Date(p.updated_at).toLocaleDateString(),
  }), []);
  const { filtered: colFiltered, FilterTH } = useColumnFilters(filtered, colFilterGetters);
  const sortGetters = useMemo(() => ({
    name: (p: ProjectRow) => p.name.toLowerCase(), org: (p: ProjectRow) => (p.organization || '').toLowerCase(),
    owner: (p: ProjectRow) => (p.owner_name || p.owner_email || '').toLowerCase(), plant: (p: ProjectRow) => (p.plant_name || '').toLowerCase(),
    model: (p: ProjectRow) => p.supply_chain_model.toLowerCase(),
    status: (p: ProjectRow) => (p.completed ? 1 : 0), updated: (p: ProjectRow) => p.updated_at,
  }), []);
  const { sorted, SortTH } = useTableSort(colFiltered, sortGetters);

  const openDialog = (kind: DialogKind, row: ProjectRow) => { setTarget(row); setDialog(kind); };
  const closeDialog = () => { setDialog(null); setTarget(null); };

  const confirm = useConfirm();
  const remove = async (row: ProjectRow) => {
    const title = `Delete project "${row.name}"?`;
    if (!(await confirm({ message: `${title} All its data will be removed. This cannot be undone.`, title, actionLabel: 'Delete project' }))) return;
    const { error } = await db.rpc('admin_delete_project', { ...actorArgs(), p_project_id: row.id });
    if (error) return toast.error(error.message);
    toast.success(`Project "${row.name}" deleted`); load();
  };

  return (
    <AdminLayout
      isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} title="Projects"
      onRefresh={load} refreshLoading={loading}
      /* Same fixed-width overflow as /admin/users: the clamp reaches the 256px
         desktop width at 610px, so `md:w-64` is what actually renders there.
         `search` rather than `actions` so it lands before the refresh button,
         which is the handoff's order for this section. */
      search={
        <Input
          placeholder="Search name, org, owner, plant…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={cn('h-8 min-h-11 w-[clamp(130px,42vw,256px)] rounded-sm md:w-64', HDR_SEARCH_INPUT)}
        />
      }
    >
      {isMobile ? (
        <AdminMobileList
          label="Projects"
          counter={`${sorted.length}`}
          loading={loading}
          empty={sorted.length === 0 ? (q ? 'No projects match these filters.' : 'No projects yet.') : undefined}
          emptyAction={
            q ? (
              <MobileButton weight="secondary" onClick={() => setQ('')}>
                Clear search
              </MobileButton>
            ) : undefined
          }
        >
          {sorted.map((p) => (
            <AdminMobileRow
              key={p.id}
              label={p.name}
              dot={p.completed ? M.process : M.idle}
              sub={`${p.organization || '—'} · ${p.owner_name || p.owner_email || '—'} · ${p.plant_name || '—'} · ${p.supply_chain_model} · ${
                p.bom_level === 'multi_level' ? 'multi-level BOM' : 'single BOM'
              } · ${p.data_type} · updated ${new Date(p.updated_at).toLocaleDateString()}`}
              value={p.completed ? 'done' : 'draft'}
              actions={[
                { label: 'Members & access…', onClick: () => openDialog('access', p) },
                { label: 'Copy…', onClick: () => openDialog('copy', p) },
                { label: 'Rename…', onClick: () => openDialog('rename', p) },
                { label: 'Edit metadata…', onClick: () => openDialog('meta', p) },
                { label: 'Transfer or change owner…', onClick: () => openDialog('transfer', p) },
                { label: 'Delete', tone: 'danger', onClick: () => remove(p) },
              ]}
            />
          ))}
        </AdminMobileList>
      ) : (
      <div className={`${SURFACE} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <SortTH sortKey="name">Name</SortTH><SortTH sortKey="org">Organization</SortTH><SortTH sortKey="owner">Owner</SortTH>
              <SortTH sortKey="plant">Plant</SortTH><SortTH sortKey="model">Model</SortTH><SortTH sortKey="status">Status</SortTH>
              <SortTH sortKey="updated">Last activity</SortTH><th className={`${TH} w-[1%]`} />
            </tr>
            <tr>
              <FilterTH filterKey="name" /><FilterTH filterKey="org" /><FilterTH filterKey="owner" />
              <FilterTH filterKey="plant" /><FilterTH filterKey="model" /><FilterTH filterKey="status" /><FilterTH filterKey="updated" /><th className="border-b border-[--hair-border] bg-white" />
            </tr></thead>
            <tbody>
              {loading ? <LoadingRow colSpan={8} /> : sorted.length === 0 ? (
                <EmptyRow colSpan={8} message={q ? 'No projects match these filters.' : 'No projects yet.'}
                  action={q ? <Button variant="ghost" size="sm" onClick={() => setQ('')}>Clear search</Button> : undefined} />
              ) : sorted.map((p) => (
                <tr key={p.id} className={ROW_HOVER}>
                  <td className={`${TD} max-w-[240px] truncate text-[13px] font-medium`}>{p.name}</td>
                  <td className={`${TD} text-[13px]`}>{p.organization || '—'}</td>
                  <td className={TD}><div className="text-[13px]">{p.owner_name || '—'}</div>{p.owner_email && <div className="text-[11px] text-muted-foreground">{p.owner_email}</div>}</td>
                  <td className={`${TD} text-[13px]`}>{p.plant_name || '—'}</td>
                  <td className={TD}>
                    <div className="text-[12px]">{p.supply_chain_model}</div>
                    <div className="mt-1 flex gap-1">
                      <MonoChip>{p.bom_level === 'multi_level' ? 'multi-level BOM' : 'single BOM'}</MonoChip>
                      <MonoChip>{p.data_type}</MonoChip>
                    </div>
                  </td>
                  <td className={TD}>
                    <span className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${p.completed ? 'border-[#d4d4d4] text-foreground' : 'border-[--zinc-border] text-muted-foreground'}`}>{p.completed ? 'completed' : 'draft'}</span>
                  </td>
                  <td className={`${TD} text-[12px] text-muted-foreground`}>{new Date(p.updated_at).toLocaleDateString()}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Members & access" aria-label={`Members and access of ${p.name}`} onClick={() => openDialog('access', p)}><Users className="h-4 w-4" /></Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="min-h-11 md:min-h-0" onClick={() => openDialog('access', p)}><Users className="mr-2 h-4 w-4" /> Members &amp; access…</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="min-h-11 md:min-h-0" onClick={() => openDialog('copy', p)}><Copy className="mr-2 h-4 w-4" /> Copy…</DropdownMenuItem>
                        <DropdownMenuItem className="min-h-11 md:min-h-0" onClick={() => openDialog('rename', p)}><Pencil className="mr-2 h-4 w-4" /> Rename…</DropdownMenuItem>
                        <DropdownMenuItem className="min-h-11 md:min-h-0" onClick={() => openDialog('meta', p)}><Settings2 className="mr-2 h-4 w-4" /> Edit metadata…</DropdownMenuItem>
                        <DropdownMenuItem className="min-h-11 md:min-h-0" onClick={() => openDialog('transfer', p)}><ArrowRightLeft className="mr-2 h-4 w-4" /> Transfer or change owner…</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="min-h-11 text-[#bf2330] focus:text-[#bf2330] md:min-h-0" onClick={() => remove(p)}><Trash2 className="mr-2 h-4 w-4" /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {target && dialog === 'access' && <ProjectAccessDialog projectId={target.id} projectName={target.name} users={users} actorId={actor?.id} actorEmail={actor?.email} onClose={closeDialog} />}
      {target && dialog === 'copy' && <CopyDialog project={target} orgs={orgs} users={users} actorArgs={actorArgs} onClose={closeDialog} onDone={load} />}
      {target && dialog === 'rename' && <RenameDialog project={target} actorArgs={actorArgs} onClose={closeDialog} onDone={load} />}
      {target && dialog === 'meta' && <MetaDialog project={target} actorArgs={actorArgs} onClose={closeDialog} onDone={load} />}
      {target && dialog === 'transfer' && <TransferDialog project={target} orgs={orgs} users={users} actorArgs={actorArgs} onClose={closeDialog} onDone={load} />}
    </AdminLayout>
  );
}

type ActorArgs = () => { p_actor_id?: string; p_actor_email?: string };

function CopyDialog({ project, orgs, users, actorArgs, onClose, onDone }: { project: ProjectRow; orgs: OrgOption[]; users: UserOption[]; actorArgs: ActorArgs; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(`${project.name} (copy)`);
  const [orgId, setOrgId] = useState<string>(project.organization_id ?? NONE);
  const [ownerId, setOwnerId] = useState<string>(project.modeler_id ?? NONE);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast.error('Name is required');
    setSaving(true);
    const { error } = await db.rpc('admin_copy_project', { ...actorArgs(), p_project_id: project.id, p_new_name: name.trim(), p_target_org_id: orgId === NONE || orgId === project.organization_id ? null : orgId, p_new_owner_id: ownerId === NONE || ownerId === project.modeler_id ? null : ownerId });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(`Project copied as "${name.trim()}"`); onClose(); onDone();
  };
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()}>
      <ResponsiveDialogContent className={cn(DIALOG_AS_SHEET, 'md:max-w-lg md:rounded-sm')}>
        <ResponsiveDialogHeader><ResponsiveDialogTitle>Copy “{project.name}”</ResponsiveDialogTitle><ResponsiveDialogDescription>Copies the project and its model data (item master, logistics, BOM, network, policies). Simulation runs and version history are not copied.</ResponsiveDialogDescription></ResponsiveDialogHeader>
        <div className="grid gap-3">
          <div><Label className="text-xs">New name</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 rounded-sm" /></div>
          <div><Label className="text-xs">Organization</Label>
            <Select value={orgId} onValueChange={setOrgId}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>Keep current ({project.organization || '—'})</SelectItem>{orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent></Select></div>
          <div><Label className="text-xs">Owner</Label>
            <Select value={ownerId} onValueChange={setOwnerId}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>Keep current ({project.owner_name || project.owner_email || '—'})</SelectItem>{users.map((u) => <SelectItem key={u.id} value={u.id}>{userLabel(u)}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="rounded-sm" onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Copy project</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function RenameDialog({ project, actorArgs, onClose, onDone }: { project: ProjectRow; actorArgs: ActorArgs; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast.error('Name is required');
    setSaving(true);
    const { error } = await db.rpc('admin_rename_project', { ...actorArgs(), p_project_id: project.id, p_name: name.trim() });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(`Renamed to "${name.trim()}"`); onClose(); onDone();
  };
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()}>
      <ResponsiveDialogContent className={cn(DIALOG_AS_SHEET, 'md:max-w-lg md:rounded-sm')}>
        <ResponsiveDialogHeader><ResponsiveDialogTitle>Rename “{project.name}”</ResponsiveDialogTitle></ResponsiveDialogHeader>
        <div><Label className="text-xs">New name</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 rounded-sm" autoFocus /></div>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="rounded-sm" onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Rename</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function MetaDialog({ project, actorArgs, onClose, onDone }: { project: ProjectRow; actorArgs: ActorArgs; onClose: () => void; onDone: () => void }) {
  const [plant, setPlant] = useState(project.plant_name || '');
  const [model, setModel] = useState(project.supply_chain_model);
  const [bomLevel, setBomLevel] = useState(project.bom_level || 'single');
  const [dataType, setDataType] = useState(project.data_type || 'curated');
  const [simStart, setSimStart] = useState(project.simulation_start || '');
  const [simEnd, setSimEnd] = useState(project.simulation_end || '');
  const [completed, setCompleted] = useState(project.completed);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    // PLAN.md §4 D318 — the window is the run's length; the engine's bounds apply.
    const windowRefusal = projectWindow(simStart || null, simEnd || null)?.boundReason;
    if (windowRefusal) return toast.error(`Simulation period: ${windowRefusal}`);
    setSaving(true);
    const { error } = await db.rpc('admin_update_project_meta', { ...actorArgs(), p_project_id: project.id, p_plant: plant.trim() || null, p_model: model, p_bom_level: bomLevel, p_data_type: dataType, p_simulation_start: simStart || null, p_simulation_end: simEnd || null, p_completed: completed });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(`Metadata updated for "${project.name}"`); onClose(); onDone();
  };
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()}>
      <ResponsiveDialogContent className={cn(DIALOG_AS_SHEET, 'md:max-w-lg md:rounded-sm')}>
        <ResponsiveDialogHeader><ResponsiveDialogTitle>Edit metadata — “{project.name}”</ResponsiveDialogTitle><ResponsiveDialogDescription>Model settings of the project itself.</ResponsiveDialogDescription></ResponsiveDialogHeader>
        <div className="grid gap-3">
          <div><Label className="text-xs">Plant</Label><Input value={plant} onChange={(e) => setPlant(e.target.value)} className="mt-1 rounded-sm" /></div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
            <div><Label className="text-xs">Supply chain model</Label>
              <Select value={model} onValueChange={setModel}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Make-To-Order">Make-To-Order</SelectItem><SelectItem value="Make-To-Stock">Make-To-Stock</SelectItem></SelectContent></Select></div>
            <div><Label className="text-xs">BOM level</Label>
              <Select value={bomLevel} onValueChange={setBomLevel}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single">Single level</SelectItem><SelectItem value="multi_level">Multi level</SelectItem></SelectContent></Select></div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
            <div><Label className="text-xs">Data type</Label>
              <Select value={dataType} onValueChange={setDataType}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="curated">Curated</SelectItem><SelectItem value="uncurated">Uncurated</SelectItem></SelectContent></Select></div>
            <div className="flex items-end gap-2 pb-1"><Switch checked={completed} onCheckedChange={setCompleted} id="proj-completed"
                className="-my-[10px] box-content border-y-[10px] border-transparent bg-clip-content md:my-0 md:border-y-0 md:bg-clip-border" /><Label htmlFor="proj-completed" className="text-xs">Completed</Label></div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
            <div><Label className="text-xs">Simulation start</Label><Input type="date" value={simStart} onChange={(e) => setSimStart(e.target.value)} className="mt-1 rounded-sm" /></div>
            <div><Label className="text-xs">Simulation end</Label><Input type="date" value={simEnd} onChange={(e) => setSimEnd(e.target.value)} className="mt-1 rounded-sm" /></div>
          </div>
        </div>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="rounded-sm" onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save changes</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function TransferDialog({ project, orgs, users, actorArgs, onClose, onDone }: { project: ProjectRow; orgs: OrgOption[]; users: UserOption[]; actorArgs: ActorArgs; onClose: () => void; onDone: () => void }) {
  // D212 — the owner must belong to the target organization (any of the account's
  // memberships, not only the one it is working in), so the picker offers only those.
  const [orgId, setOrgId] = useState<string>(project.organization_id ?? '');
  const [ownerId, setOwnerId] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? 'the organization';
  const inOrg = (u: UserOption) => !!orgId && (u.org_ids ?? []).includes(orgId);
  const eligible = useMemo(() => users.filter((u) => u.is_active !== false && !!orgId && (u.org_ids ?? []).includes(orgId)), [users, orgId]);
  const currentOwner = users.find((u) => u.id === project.modeler_id);
  const canKeepOwner = !!currentOwner && currentOwner.is_active !== false && inOrg(currentOwner);
  const sameOrg = orgId === project.organization_id;
  const effectiveOwnerId = ownerId === NONE ? (canKeepOwner ? project.modeler_id : '') : ownerId;
  const nothingToChange = sameOrg && effectiveOwnerId === project.modeler_id;
  const chosenOwner = users.find((u) => u.id === effectiveOwnerId);
  const mustSwitch = !!chosenOwner && chosenOwner.organization_id !== orgId;

  const save = async () => {
    if (!orgId) return toast.error('Pick a target organization');
    if (!effectiveOwnerId) return toast.error(`Pick a new owner who belongs to ${orgName}`);
    if (nothingToChange) return toast.error('Pick another organization or another owner');
    setSaving(true);
    const { data, error } = await db.rpc('admin_transfer_project', { ...actorArgs(), p_project_id: project.id, p_org_id: orgId, p_new_owner_id: ownerId === NONE ? null : ownerId });
    setSaving(false);
    if (error) return toast.error(error.message);
    const r = (data ?? {}) as { owner_name?: string; organization_changed?: boolean; owner_active_org_is_target?: boolean; memberships_removed?: unknown[]; delegations_revoked?: unknown[] };
    const removed = r.memberships_removed?.length ?? 0;
    const revoked = r.delegations_revoked?.length ?? 0;
    const lines = [
      r.organization_changed ? `"${project.name}" moved to ${orgName}, owned by ${r.owner_name}.` : `"${project.name}" is now owned by ${r.owner_name}.`,
      removed || revoked ? `${removed} project membership(s) removed, ${revoked} delegation(s) revoked.` : '',
      r.owner_active_org_is_target === false ? `${r.owner_name} is working in another organization and will see the project after switching to ${orgName}.` : '',
    ].filter(Boolean);
    toast.success(lines[0], lines.length > 1 ? { description: lines.slice(1).join(' ') } : undefined);
    onClose(); onDone();
  };
  return (
    <ResponsiveDialog open onOpenChange={(v) => !v && onClose()}>
      <ResponsiveDialogContent className={cn(DIALOG_AS_SHEET, 'md:max-w-lg md:rounded-sm')}>
        <ResponsiveDialogHeader><ResponsiveDialogTitle>Transfer or change owner — “{project.name}”</ResponsiveDialogTitle><ResponsiveDialogDescription>Moves the project (and all its data) from <span className="font-medium">{project.organization || 'no organization'}</span> to another organization, hands it to a new owner, or both.</ResponsiveDialogDescription></ResponsiveDialogHeader>
        <div className="grid gap-3">
          <div><Label className="text-xs">Organization</Label>
            <Select value={orgId} onValueChange={(v) => { setOrgId(v); setOwnerId(NONE); }}><SelectTrigger className="mt-1 rounded-sm"><SelectValue placeholder="Select organization…" /></SelectTrigger>
              <SelectContent>{orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}{o.id === project.organization_id ? ' (current)' : ''}</SelectItem>)}</SelectContent></Select></div>
          <div><Label className="text-xs">Owner</Label>
            <Select value={ownerId} onValueChange={setOwnerId} disabled={!orgId}><SelectTrigger className="mt-1 rounded-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{canKeepOwner ? `Keep current owner (${project.owner_name || project.owner_email || '—'})` : 'Select a new owner…'}</SelectItem>
                {eligible.filter((u) => u.id !== project.modeler_id).map((u) => <SelectItem key={u.id} value={u.id}>{userLabel(u)}</SelectItem>)}
              </SelectContent></Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {orgId && !canKeepOwner && currentOwner ? `The current owner does not belong to ${orgName}, so a new owner is required. ` : ''}
              {orgId ? `Only active accounts that belong to ${orgName} are listed — add someone to it on their user page first.` : ''}
              {eligible.length === 0 && orgId ? ` ${orgName} has no eligible account yet.` : ''}
            </p>
          </div>
          <div className="rounded-sm border border-[--hair-border] p-2 text-[11px] text-muted-foreground">
            The owner becomes the project's standing owner. The previous owner's project membership and the delegations they granted are removed{sameOrg ? '' : `, and members who do not belong to ${orgName} lose their role on the project`}.
            {mustSwitch ? ` ${chosenOwner ? userLabel(chosenOwner) : 'The owner'} is working in another organization and will see the project after switching to ${orgName}.` : ''}
          </div>
        </div>
        <ResponsiveDialogFooter>
          <Button variant="outline" className="rounded-sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="rounded-sm" onClick={save} disabled={saving || !orgId || !effectiveOwnerId || nothingToChange}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{sameOrg ? 'Change owner' : 'Transfer project'}</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
