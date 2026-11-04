// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { listProjectsCached, invalidateProjectsCache } from '@/lib/projects/projectsCache';
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { Plus, CheckCircle, AlertCircle, Trash2, Copy, Pencil, Factory, GitBranch, Layers, Eye, Upload, X, RefreshCw, Download } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { StepwiseDatePicker } from '@/components/ui/stepwise-date-picker';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/useAuth';
import { useUserRole } from '@/hooks/useUserRole';
import { useGlobalProject } from '@/hooks/useGlobalProject';
import {
  PageLayout,
  PageHeader,
  PAGE_GUTTER,
  PAGE_GUTTER_SKIN,
  HDR_PRIMARY_BUTTON,
  HDR_PROJECT_SELECT,
} from '@/components/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MobileSheet } from '@/components/shared/MobileSheet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useRowBudget } from '@/hooks/useViewport';
import {
  M,
  MobileButton,
  MobileGroup,
  MobileHeaderSearch,
  MobilePageHeader,
  MobilePanel,
  MobileRow,
} from '@/components/mobile';
// import { cn } from '@/lib/utils';
import { Toggle } from '@/components/ui/toggle';
import ProjectDataViewer from '@/components/ProjectDataViewer';
import ItemMasterEditor from '@/components/ItemMasterEditor';
import { getDefaultSimulationDateRange, formatDateForDatabase, parseDateFromDatabase } from '@/utils/dateHelpers';
import { ProjectWindowLength } from '@/components/ProjectWindowLength';
import { projectWindow } from '@/lib/sim/projectWindow';
import UploadWizard from '@/components/UploadWizard';
import { ProjectCard } from '@/components/ProjectCard';
import { ErpConnectionsPanelForEditors } from '@/components/erp/ErpConnectionsPanel';
import { confirmProjectDeletion } from '@/lib/projects/projectDeletion';
import { useConfirm } from '@/components/shared/confirm/useConfirm';
import { planRefusal } from '@/lib/auth/organizationPlan';
import { useCapabilities } from '@/hooks/useCapabilities';
import { adminsProjectOrganization, projectCreationNote } from '@/lib/auth/projectCreation';

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
  organization_id?: string | null;
  simulation_start?: string | null;
  simulation_end?: string | null;
  deep_tier_enabled?: boolean;
  combine_status?: 'pending' | 'running' | 'completed' | 'failed';
  combine_timestamp?: string | null;
  data_type?: string;
}

interface DataManagerProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

// ── Mobile list redesign (v3 §2.1 / gap-close T5) ───────────────────────
//
// "Last opened" has no backing field — the project row carries no per-user
// view timestamp. Tracked locally instead, the same way the global project
// selection already persists itself (useGlobalProject.tsx): one localStorage
// entry, written whenever a project's detail is opened. New, additive state,
// sanctioned for this flow specifically (§0: v3 "changes three screens'
// information architecture", Projects among them) — not the general v1/v2
// "no new state" skin-only rule.
const LAST_OPENED_KEY = 'suresuite.dataManager.lastOpenedProject';

function recordLastOpened(projectId: string) {
  try {
    localStorage.setItem(LAST_OPENED_KEY, JSON.stringify({ id: projectId, ts: Date.now() }));
  } catch {
    // Private mode / storage disabled — Resume falls back to most-recent-created.
  }
}

function readLastOpened() {
  try {
    const raw = localStorage.getItem(LAST_OPENED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function relativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// The one status derivation both the Resume panel's urgent-state line and
// the Active rows' status dot read — real fields only (combine_status, the
// same bom/inbound/outbound completeness ProjectCard already computes).
// No run-rejection or data-gap language: that data isn't fetched here, and
// v3 §6 is explicit — do not invent counts, and a fabricated status line is
// the same defect in different clothing.
function projectStatus(project, completion) {
  if (project.combine_status === 'running') {
    return { dot: M.process, label: 'combining data…' };
  }
  if (project.combine_status === 'failed') {
    return { dot: M.blocking, label: 'combine failed — needs attention' };
  }
  const missing = [
    !completion.bom && 'BOM',
    !completion.inbound && 'inbound',
    !completion.outbound && 'outbound',
  ].filter(Boolean);
  if (missing.length > 0) {
    return { dot: M.firm, label: `draft — ${missing.join(', ')} missing` };
  }
  return { dot: M.idle, label: 'ready' };
}

const DataManager = ({ isCollapsed, setIsCollapsed }: DataManagerProps) => {
  const confirm = useConfirm();
  // Walk-to deep link (§8.2 findings → data): ?project=<id> expands the
  // project's data card; &item_master=<materials|products|suppliers> also
  // opens the Item Master editor on that tab (see fieldWalkToRoute).
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [uploadingProject, setUploadingProject] = useState<Project | null>(null);
  const [itemMasterProjectId, setItemMasterProjectId] = useState<string | null>(null);
  // Mobile list redesign (v3 §2.1): which project's full detail — the
  // existing <ProjectCard/> content, previously shown for every project at
  // once — is open below its compact row. Desktop is untouched; ProjectCard
  // there still renders unconditionally for every project, same as always.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  /** Set only when a sheet opened the project — see `openProject`. */
  const [revealProjectId, setRevealProjectId] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const [activeSheetOpen, setActiveSheetOpen] = useState(false);
  const [sharedSheetOpen, setSharedSheetOpen] = useState(false);
  const walkToTable = searchParams.get('item_master');
  useEffect(() => {
    const walkToProject = searchParams.get('project');
    if (!walkToProject) return;
    setExpandedProjectId(walkToProject);
    setOpenProjectId(walkToProject);
    if (walkToTable) setItemMasterProjectId(walkToProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const { globalSelectedProjectId, setGlobalSelectedProjectId, selectedProject, setSelectedProject } = useGlobalProject();
  const [newProjectName, setNewProjectName] = useState('');
  const [plantName, setPlantName] = useState('');
  const [dataType, setDataType] = useState('curated');
  const [supplyChainModel, setSupplyChainModel] = useState('Make-To-Order');
  const [bomLevel, setBomLevel] = useState('single');
  const [simulationStart, setSimulationStart] = useState<Date | undefined>(undefined);
  const [simulationEnd, setSimulationEnd] = useState<Date | undefined>(undefined);
  const [deepTierEnabled, setDeepTierEnabled] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editProjectName, setEditProjectName] = useState('');
  const [editPlantName, setEditPlantName] = useState('');
  const [editDataType, setEditDataType] = useState('curated');
  const [editSupplyChainModel, setEditSupplyChainModel] = useState('Make-To-Order');
  const [editBomLevel, setEditBomLevel] = useState('single');
  const [editSimulationStart, setEditSimulationStart] = useState<Date | undefined>(undefined);
  const [editSimulationEnd, setEditSimulationEnd] = useState<Date | undefined>(undefined);
  const [editDeepTierEnabled, setEditDeepTierEnabled] = useState(false);
  // toast is imported from sonner
  const { user } = useAuth();
  const { role, canModify } = useUserRole();
  // §4 D303 — creating a project is the database's answer (`project_creation_right`): the
  // account role, OR the Admin/Owner role in the organization being worked in. Everything
  // else on this page that `canModify` gates still reads the account role.
  const { capabilities } = useCapabilities();
  const projectCreation = capabilities?.project_creation ?? null;
  const canCreate = projectCreation ? projectCreation.allowed : canModify;
  const creationNote = projectCreationNote(projectCreation);
  // §4 D304 — an Owner/Admin of the project's organization may delete it and its data.
  const orgAdminOf = (p: Project) => adminsProjectOrganization(projectCreation, p.organization_id);

  const isDuplicateName = projects.some(
    (project) => project.name.toLowerCase() === newProjectName.trim().toLowerCase()
  );

  const handleOpenCreateForm = () => {
    const defaultDates = getDefaultSimulationDateRange();
    setSimulationStart(defaultDates.start);
    setSimulationEnd(defaultDates.end);
    setIsCreating(true);
  };

  const loadProjects = async () => {
    if (!user?.id) return;

    try {
      // This page changes projects, so it always reads fresh and, on leaving,
      // drops the shared copy for the pages that read it from memory.
      setProjects(await listProjectsCached(user, { force: true }));
    } catch (error) {
      console.error('Error loading projects:', error);
      toast.error(`Error loading projects: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    if (user?.id) {
      loadProjects();
    }
  }, [user?.id]);

  useEffect(() => () => invalidateProjectsCache(), []);

  // Check data completion for all projects when they load
  useEffect(() => {
    const checkAllProjects = async () => {
      if (projects.length === 0) return;
      
      const statusPromises = projects.map(async (project) => {
        const completion = await checkProjectDataCompletion(project.id);
        return { projectId: project.id, completion };
      });
      
      const results = await Promise.all(statusPromises);
      const statusMap = results.reduce((acc, { projectId, completion }) => {
        acc[projectId] = completion;
        return acc;
      }, {} as Record<string, any>);
      
      setProjectDataStatus(statusMap);
    };

    checkAllProjects();
  }, [projects]);

  // Refresh status for selected project when selection changes
  useEffect(() => {
    const refreshSelected = async () => {
      if (!selectedProject) return;
      const completion = await checkProjectDataCompletion(selectedProject.id);
      setProjectDataStatus((prev) => ({ ...prev, [selectedProject.id]: completion }));
    };
    void refreshSelected();
  }, [selectedProject?.id]);

  // Close any expanded project data when selection changes
  useEffect(() => {
    setExpandedProjectId(null);
    setUploadingProject(null);
  }, [selectedProject?.id]);

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !plantName.trim() || !user?.id) return;

    if (isDuplicateName) {
      toast.error('A project with this name already exists');
      return;
    }
    // PLAN.md §4 D318 — the window is the run's length; the engine's bounds apply.
    const windowRefusal = projectWindow(formatDateForDatabase(simulationStart), formatDateForDatabase(simulationEnd))?.boundReason;
    if (windowRefusal) {
      toast.error(`Simulation period: ${windowRefusal}`);
      return;
    }

    try {
      const { data, error } = await supabase.rpc('create_project', {
        p_name: newProjectName.trim(),
        p_plant: plantName.trim(),
        p_model: supplyChainModel,
        p_bom_level: bomLevel,
        p_user_id: user.id,
        p_user_email: user.email,
        p_user_name: user.name,
        p_simulation_start: formatDateForDatabase(simulationStart),
        p_simulation_end: formatDateForDatabase(simulationEnd),
        p_data_type: dataType,
        p_deep_tier_enabled: deepTierEnabled,
      });

      if (error) throw error;

      toast.success(`Project "${newProjectName}" has been created`);

      setNewProjectName('');
      setPlantName('');
      setDataType('curated');
      setSupplyChainModel('Make-To-Order');
      setBomLevel('single');
      // Reset to default dates for next project creation
      const defaultDates = getDefaultSimulationDateRange();
      setSimulationStart(defaultDates.start);
      setSimulationEnd(defaultDates.end);
      setDeepTierEnabled(false);
      setIsCreating(false);
      loadProjects();
    } catch (error: any) {
      console.error('Project creation error:', error);
      toast.error(error.message?.includes('uq_modeler_project') 
        ? 'A project with this name already exists for your account'
        : planRefusal(error.message) ?? (error.message || 'Unknown error'));
    }
  };

  // THE DELETION'S ANSWER IS THE DATABASE'S, AND IT IS SHOWN (§4 D170). This used to
  // toast "Deletion started" on a 202 the function sent before doing anything, then
  // poll the list and hope; production's function failed every time in the
  // background, after removing some of the project's rows. `delete-project` now
  // waits for `public.delete_project` — one transaction, all or nothing — and a
  // refusal or failure arrives here with its reason.
  const handleDeleteProject = async (project: Project) => {
    // The card shows Delete to whom `delete_project` admits; the database decides (D304).
    if (!user?.id) return;

    const { data, error } = await supabase.functions.invoke('delete-project', {
      body: { projectId: project.id, userId: user.id, userEmail: user.email ?? '' },
    });

    if (error || !data?.success) {
      // A non-2xx reaches supabase-js as an error whose body is on `context`; read it
      // so the person sees "may not delete" or "not found" rather than "non-2xx".
      let reason = data?.error as string | undefined;
      const ctx = (error as { context?: Response } | null)?.context;
      if (!reason && ctx && typeof ctx.json === 'function') {
        try { reason = (await ctx.json())?.error; } catch { /* keep the generic message */ }
      }
      console.error('Project deletion failed:', error ?? data);
      // supabase-js's FETCH error means no answer reached the browser at all. Usually
      // the request never left (§15 (7) logged no invocation for the one reported), but
      // a gateway that cut a slow call off would look the same, and the transaction may
      // still have committed — so say what is known and reload the list.
      if ((error as { name?: string } | null)?.name === 'FunctionsFetchError') {
        toast.error(`No answer from the server while deleting "${project.name}". Check your connection; the list has been reloaded — if the project is still there, nothing was deleted and you can try again.`);
        loadProjects();
        return;
      }
      toast.error(`Could not delete "${project.name}": ${reason || error?.message || 'unknown error'}. Nothing was deleted.`);
      return;
    }

    toast.success(`Project "${project.name}" deleted.`);
    if (selectedProject?.id === project.id) setSelectedProject(null);
    if (globalSelectedProjectId === project.id) setGlobalSelectedProjectId(null);
    loadProjects();
  };

  const handleDuplicateProject = async (project: Project) => {
    if (!user?.id || !user.email) return;

    try {
      const baseName = `${project.name} Copy`;
      let newName = baseName;
      let counter = 2;
      while (projects.some((p) => p.name.toLowerCase() === newName.toLowerCase())) {
        newName = `${baseName} ${counter}`;
        counter++;
      }

      const { error } = await supabase.rpc('create_project', {
        p_name: newName,
        p_plant: project.plant_name,
        p_model: project.supply_chain_model,
        p_bom_level: project.bom_level,
        p_user_id: user.id,
        p_user_email: user.email,
        p_user_name: user.name,
        p_simulation_start: project.simulation_start ?? null,
        p_simulation_end: project.simulation_end ?? null,
        p_data_type: project.data_type ?? null,
        p_deep_tier_enabled: project.deep_tier_enabled ?? false,
      });

      if (error) throw error;

      toast.success(`Project "${project.name}" duplicated as "${newName}"`);
      loadProjects();
    } catch (error) {
      const message = (error as { message?: string } | null)?.message;
      toast.error(planRefusal(message) ?? (error instanceof Error ? error.message : message || 'Unknown error'));
    }
  };

  const handleUpdateProject = async () => {
    if (!editingProject || !user?.id || !user.email) return;
    const windowRefusal = projectWindow(formatDateForDatabase(editSimulationStart), formatDateForDatabase(editSimulationEnd))?.boundReason;
    if (windowRefusal) {
      toast.error(`Simulation period: ${windowRefusal}`);
      return;
    }

    try {
      const { error } = await supabase.rpc('update_project', {
        p_project_id: editingProject.id,
        p_name: editProjectName.trim(),
        p_plant: editPlantName.trim(),
        p_model: editSupplyChainModel,
        p_bom_level: editBomLevel,
        p_user_id: user.id,
        p_user_email: user.email,
        p_simulation_start: formatDateForDatabase(editSimulationStart),
        p_simulation_end: formatDateForDatabase(editSimulationEnd),
        p_data_type: editDataType,
        p_deep_tier_enabled: editDeepTierEnabled,
      });

      if (error) throw error;

      toast.success(`Project "${editProjectName}" has been updated`);
      setEditingProject(null);
      loadProjects();
    } catch (error: any) {
      toast.error(error?.message?.includes('uq_modeler_project')
        ? 'A project with this name already exists'
        : (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const [projectDataStatus, setProjectDataStatus] = useState<Record<string, any>>({});

  const checkProjectDataCompletion = async (projectId: string) => {
    if (!user?.id || !user?.email) {
      return { bom: false, inbound: false, outbound: false, nodeList: false, deepNodes: false, deepEdges: false, deepSummary: false };
    }

    try {
      // Use the updated RPC function that includes deep tier checks
      const { data, error } = await supabase.rpc('get_project_dataset_status', {
        p_project_id: projectId,
        p_user_id: user.id,
        p_user_email: user.email
      });

      if (error) {
        console.error('Error checking project data:', error);
        return { bom: false, inbound: false, outbound: false, nodeList: false, deepNodes: false, deepEdges: false, deepSummary: false };
      }

      // Check node list separately since it's not in the RPC
      const { data: nodeListData, error: nodeListError } = await supabase.rpc('get_node_list', {
        p_project_id: projectId,
        p_plant_name: null,
        p_user_id: user.id,
        p_user_email: user.email,
      });

      const nodeListOk = !nodeListError && Array.isArray(nodeListData) && nodeListData.length > 0;

      const status = data as any;
      return {
        bom: status.has_bom,
        inbound: status.has_inbound,
        outbound: status.has_outbound,
        nodeList: nodeListOk,
        deepNodes: status.deep_tier_enabled ? status.has_deep_tier_nodes : undefined,
        deepEdges: status.deep_tier_enabled ? status.has_deep_tier_edges : undefined,
        deepSummary: status.deep_tier_enabled ? status.has_deep_tier_summary : undefined,
      };
    } catch (error) {
      console.error('Error checking project data:', error);
      return { bom: false, inbound: false, outbound: false, nodeList: false, deepNodes: false, deepEdges: false, deepSummary: false };
    }
  };

  const getCompletionInfo = (project: Project) => {
    return projectDataStatus[project.id] || { bom: false, inbound: false, outbound: false, nodeList: false };
  };
  const handleUploadData = () => {
    if (!selectedProject) {
      toast.error('Please select a project first');
      return;
    }
    // Close any expanded project view and toggle the upload wizard
    setExpandedProjectId(null);
    setUploadingProject((current) =>
      current?.id === selectedProject.id ? null : selectedProject
    );
  };

  const handleCombineProject = async (project: Project) => {
    if (!user?.id || !user?.email) return;

    // Update project status to running immediately
    setProjects(prevProjects => 
      prevProjects.map(p => 
        p.id === project.id 
          ? { ...p, combine_status: 'running' as const, combine_timestamp: new Date().toISOString() }
          : p
      )
    );

    try {
      // First update completion status
      const { data: statusResult, error: statusError } = await supabase.rpc('update_project_completion_status', {
        p_project_id: project.id,
        p_user_id: user.id,
        p_user_email: user.email
      });

      if (statusError) {
        console.error('Error updating project status:', statusError);
        // Update status to failed on error
        setProjects(prevProjects => 
          prevProjects.map(p => 
            p.id === project.id 
              ? { ...p, combine_status: 'failed' as const, combine_timestamp: new Date().toISOString() }
              : p
          )
        );
        toast.error('Failed to check project completion status.');
        return;
      }

      // If project is complete, start combine process
      if ((statusResult as any)?.completed) {
        // Call combine edge function in synchronous mode
        const { data: combineData, error: combineError } = await supabase.functions.invoke('combine-project', {
          body: {
            project_id: project.id,
            user_id: user.id,
            user_email: user.email,
            sync: true,
          }
        });

        if (combineError || (combineData as any)?.success === false) {
          // Extract detailed error from server response
          const errMsg = 
            (combineError as any)?.context?.error ||
            (combineData as any)?.error ||
            combineError?.message ||
            'Failed to combine project data.';
          
          setProjects(prevProjects => 
            prevProjects.map(p => 
              p.id === project.id 
                ? { ...p, combine_status: 'failed' as const, combine_timestamp: new Date().toISOString() }
                : p
            )
          );
          toast.error(errMsg);
          return;
        }

        // Poll node_list for readiness (up to ~20s)
        const start = Date.now();
        let populated = false;
        while (Date.now() - start < 20000) {
          const { data: nodeListData, error: nodeErr } = await supabase.rpc('get_node_list', {
            p_project_id: project.id,
            p_plant_name: null,
            p_user_id: user.id,
            p_user_email: user.email,
          });
          if (!nodeErr && Array.isArray(nodeListData) && nodeListData.length > 0) {
            populated = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 1000));
        }

        if (populated) {
          setProjects(prevProjects => 
            prevProjects.map(p => 
              p.id === project.id 
                ? { ...p, combine_status: 'completed' as const, combine_timestamp: new Date().toISOString() }
                : p
            )
          );
          {
            // WP 8.2 — TOTALS, NOT PER-LANE BREAKDOWNS. The breakdowns were
            // counters the edge function kept while it built the rows itself; it
            // no longer does (§4 D140 — one ETL, and it is the SQL one), so the
            // figures it returns are counted from the tables after the write.
            // Reporting a lane split the server did not measure would be a number
            // with no source, which is §5 T1.
            const total = (combineData as any)?.total_records;
            const mtTotal = (combineData as any)?.multi_tier_written;
            const details = typeof total === 'number'
              ? `${total} product-level edge(s), ${mtTotal ?? 0} deep-tier edge(s)`
              : '';
            toast.success(details ? `Data combined and node list is ready. ${details}` : 'Data combined and node list is ready.');

            // THE ETL'S WARNINGS REACH THE PERSON (WP 3.3, §5 T2).
            //
            // `combine-project` has returned a `warnings` array since WP 0.2 and
            // this screen dropped it on the floor: the degradations rode all the
            // way back from the server and then stopped one call short of the
            // only reader who could act on them. D46's reader half is the case
            // that made it matter — a lane row whose `time_unit` is `21` is read
            // as weekly, and "the substitution is always visible" is not met by a
            // field in a response nobody renders.
            //
            // One toast per warning, and they persist until dismissed: a
            // substitution the user must SEE is not something to auto-hide after
            // four seconds behind a success message.
            const etlWarnings: string[] = (combineData as any)?.warnings ?? [];
            for (const w of etlWarnings) {
              toast.warning(w, { duration: Infinity, closeButton: true });
            }
          }
        } else {
          setProjects(prevProjects => 
            prevProjects.map(p => 
              p.id === project.id 
                ? { ...p, combine_status: 'failed' as const, combine_timestamp: new Date().toISOString() }
                : p
            )
          );
          toast.error('Combine completed but node list not found yet. Please retry.');
        }

      } else {
        // Update status to failed if project not complete
        setProjects(prevProjects => 
          prevProjects.map(p => 
            p.id === project.id 
              ? { ...p, combine_status: 'failed' as const, combine_timestamp: new Date().toISOString() }
              : p
          )
        );
        toast.error('Project must have all required datasets uploaded first.');
      }
    } catch (error) {
      console.error('Error in handleCombineProject:', error);
      // Update status to failed on error
      setProjects(prevProjects => 
        prevProjects.map(p => 
          p.id === project.id 
            ? { ...p, combine_status: 'failed' as const, combine_timestamp: new Date().toISOString() }
            : p
        )
      );
      toast.error('An unexpected error occurred.');
    }
  };

  const handleViewData = () => {
    if (!selectedProject) {
      toast.error('Please select a project first');
      return;
    }
    setUploadingProject(null);
    setExpandedProjectId(expandedProjectId === selectedProject.id ? null : selectedProject.id);
  };

  const handleRefreshData = () => {
    if (!selectedProject) {
      toast.error('Please select a project first');
      return;
    }
    
    (async () => {
      try {
        await supabase.rpc('combine_project_into_supply_chain', {
          p_project_id: selectedProject.id,
          p_user_id: user?.id,
          p_user_email: user?.email
        });
        toast.success(`Project "${selectedProject.name}" combined successfully`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Unknown error');
      }
    })();
  };

  const handleEditProject = () => {
    if (!selectedProject) {
      toast.error('Please select a project first');
      return;
    }
    setEditingProject(selectedProject);
    setEditProjectName(selectedProject.name);
    setEditPlantName(selectedProject.plant_name);
    setEditSupplyChainModel(selectedProject.supply_chain_model);
    setEditBomLevel(selectedProject.bom_level);
    setEditSimulationStart(parseDateFromDatabase(selectedProject.simulation_start));
    setEditSimulationEnd(parseDateFromDatabase(selectedProject.simulation_end));
    setEditDeepTierEnabled(selectedProject.deep_tier_enabled || false);
  };

  const handleDeleteSelectedProject = async () => {
    if (!selectedProject) {
      toast.error('Please select a project first');
      return;
    }
    
    if (await confirmProjectDeletion(confirm, selectedProject.name)) {
      handleDeleteProject(selectedProject);
    }
  };

  const handleDuplicateSelectedProject = () => {
    if (!selectedProject) {
      toast.error('Please select a project first');
      return;
    }
    handleDuplicateProject(selectedProject);
  };

  const handleDeleteAllData = async (project: Project) => {
    if (!canModify || !user?.id || !user?.email) return;

    const lead = `Are you sure you want to delete ALL data for project "${project.name}"?`;
    const ok = await confirm({
      message: `${lead} This action cannot be undone.`,
      lead,
      title: `Delete all data for project "${project.name}"?`,
      actionLabel: 'Delete all data',
    });

    if (!ok) return;

    try {
      // Use secure RPC to delete all datasets
      const { data: deletedCount, error } = await supabase.rpc('delete_project_dataset', {
        p_project_id: project.id,
        p_dataset: 'all',
        p_user_id: user.id,
        p_user_email: user.email
      });

      if (error) throw error;

      toast.success(`All data for project "${project.name}" has been deleted (${deletedCount} records)`);

      // Refresh project data status
      const updatedStatus = await checkProjectDataCompletion(project.id);
      setProjectDataStatus(prev => ({ ...prev, [project.id]: updatedStatus }));

    } catch (error) {
      console.error('Error deleting project data:', error);
      toast.error(error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleDownloadNodeList = async (project: Project) => {
    if (!user?.id || !user?.email) return;

    try {
      const { data, error } = await supabase.rpc('get_node_list', {
        p_project_id: project.id,
        p_plant_name: null,
        p_user_id: user.id,
        p_user_email: user.email
      });

      if (error) throw error;

      if (!data || data.length === 0) {
        toast.error("This project doesn't have any node list data to download");
        return;
      }

      // Define columns for CSV
      const columns = [
        'node_id', 'plant_name', 'node_type', 'node_group', 'description_text', 
        'location_text', 'longitude', 'latitude', 'is_critical_node', 'critical_node_score'
      ];

      // Create CSV rows
      const rows = data.map((node: any) =>
        columns.map(col => {
          const value = node[col] ?? '';
          const stringValue = String(value).replace(/"/g, '""');
          return /[",\n]/.test(stringValue) ? `"${stringValue}"` : stringValue;
        }).join(',')
      );

      // Create and download CSV
      const csv = [columns.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.toLowerCase().replace(/\s+/g, '_')}_node_list.csv`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success(`Pre-combined node list for "${project.name}" downloaded. Add more attributes to this file and upload it back to enhance your project data.`);
    } catch (error) {
      console.error('Error downloading node list:', error);
      toast.error(error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleGenerateNodeList = async (project: Project) => {
    if (!user?.id || !user?.email) return;

    try {
      toast.loading(`Combining datasets and building node list for "${project.name}"`);

      // Ensure completion flag is up to date
      await supabase.rpc('update_project_completion_status', {
        p_project_id: project.id,
        p_user_id: user.id,
        p_user_email: user.email,
      });

      // Combine datasets then rebuild node list
      await supabase.rpc('combine_project_into_supply_chain', {
        p_project_id: project.id,
        p_user_id: user.id,
        p_user_email: user.email,
      });
      await supabase.rpc('rebuild_node_list', {
        p_project_id: project.id,
        p_user_id: user.id,
        p_user_email: user.email,
      });

      const finalStatus = await checkProjectDataCompletion(project.id);
      setProjectDataStatus((prev) => ({ ...prev, [project.id]: finalStatus }));
      await loadProjects();

      toast.success(`You can now download the node list for "${project.name}".`);
    } catch (error) {
      console.error('Error generating node list manually:', error);
      toast.error(error instanceof Error ? error.message : 'Unknown error');
    }
  };

  // The create form, hoisted so both chromes mount the same controls (§8).
  const isMobile = useIsMobile();

  // §13.4 — the numbers, as the one stat grid on the screen. Derived from the
  // list already in hand; no new query, no new state (v2 §7). Desktop only
  // now — §2.1 forbids KPI tiles on the mobile list.
  const completeCount = projects.filter((p) => {
    const c = getCompletionInfo(p);
    return c.bom && c.inbound && c.outbound;
  }).length;

  // v3 §2.1 — Resume · Active · Shared with me. "Archived" is not built: no
  // field in this data model marks a project archived (no status, no flag),
  // and inventing one to fill the band would be exactly what §6 rules out —
  // a count with nothing real behind it. Two real bands ship; Archived is
  // flagged in the commit, not faked here.
  //
  // "Active" / "Shared with me" read real ownership (modeler_id), the
  // closest real split to the two bands' intent — under a role that already
  // sees every project (admin), most will land in "Shared with me" even
  // though nothing was actually shared; that is the data model's limit, not
  // an invented one.
  const projectQueryLower = projectQuery.trim().toLowerCase();
  const matchesQuery = (p: Project) =>
    !projectQueryLower ||
    p.name.toLowerCase().includes(projectQueryLower) ||
    (p.plant_name ?? '').toLowerCase().includes(projectQueryLower);
  const visibleProjects = projects.filter(matchesQuery);

  // Resume reads visibleProjects too — "no filter chips, the three bands
  // are the filter" (§2.1) means search narrows all three, Resume included.
  const lastOpened = readLastOpened();
  const resumeProject =
    (lastOpened && visibleProjects.find((p) => p.id === lastOpened.id)) ||
    [...visibleProjects].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0] ||
    null;
  // The Resume panel is its own loud panel (§2.1: "the screen's one loud
  // panel") — pulled out of both other bands so it never shows twice.
  const activeProjects = visibleProjects.filter(
    (p) => p.modeler_id === user?.id && p.id !== resumeProject?.id,
  );
  const sharedProjects = visibleProjects.filter(
    (p) => p.modeler_id !== user?.id && p.id !== resumeProject?.id,
  );

  const activeRowBudget = useRowBudget(2, 3, 5);
  const budgetedActive = activeProjects.slice(0, activeRowBudget);
  // A project tapped in the All-N sheet is, by definition, usually PAST the
  // budgeted window — and the window was the only thing the band rendered, so
  // the sheet closed onto a list that never showed the project just chosen and
  // the tap read as "nothing happened". The budget is a rule about how much
  // shows at rest, not a rule that can drop a row the user just asked for (v2
  // §5.4: deferred into a sheet, never dropped), so the opened one rides along
  // under the budgeted rows until it is closed again.
  const openedBeyondBudget = activeProjects.find(
    (p) => p.id === openProjectId && !budgetedActive.some((b) => b.id === p.id),
  );
  const shownActive = openedBeyondBudget
    ? [...budgetedActive, openedBeyondBudget]
    : budgetedActive;
  // Same gap, one band down and total: "Shared with me" renders a single count
  // row, so a project opened from ITS sheet had nowhere at all to land.
  const openedShared = sharedProjects.find((p) => p.id === openProjectId) ?? null;

  // `reveal` is the sheet's flag: the row that opened the project is gone with
  // the sheet, so the block it opened has to bring itself into view or the
  // whole gesture ends on whatever part of the page happened to be scrolled
  // to. An inline row passes nothing — it is already on screen, and moving the
  // page under a finger that just tapped it is the worse behaviour.
  const openProject = (id: string, reveal = false) => {
    setOpenProjectId((cur) => (cur === id ? null : id));
    setActiveSheetOpen(false);
    setSharedSheetOpen(false);
    recordLastOpened(id);
    if (reveal) setRevealProjectId(id);
  };

  useEffect(() => {
    if (!revealProjectId) return;
    const el = document.getElementById(`m-project-${revealProjectId}`);
    // The block mounts in the same commit this effect runs after, so one
    // lookup is enough; the flag clears either way so a later re-render
    // cannot scroll the page a second time.
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setRevealProjectId(null);
  }, [revealProjectId]);

  // The project list, hoisted so the mobile group and the desktop stack
  // mount the SAME cards with the same handlers — <ProjectCard> is what
  // branches on the viewport, not this page (v2 §4B). A function now rather
  // than an inline map, so the mobile compact-row list (below) can render
  // the identical block for exactly the one project a row opened — the
  // owner/dates/datasets/KPI content v3 §2.1 says belongs "in the project",
  // not the list, is this block; it was always here, just always visible.
  const renderProjectBlock = (project: Project) => {
            const completion = getCompletionInfo(project);
            const isSelected = selectedProject?.id === project.id;

            return (
              <div key={project.id} id={`m-project-${project.id}`}>
                <ProjectCard
                  project={project}
                  completion={completion}
                  isSelected={isSelected}
                  isEditing={editingProject?.id === project.id}
                  globalSelectedProjectId={globalSelectedProjectId}
                  canModify={canModify}
                  orgAdmin={orgAdminOf(project)}
                  role={role}
                  userId={user?.id || ''}
                  editProjectName={editProjectName}
                  editPlantName={editPlantName}
                  editSupplyChainModel={editSupplyChainModel}
                  editBomLevel={editBomLevel}
                  editDataType={editDataType}
                  editSimulationStart={editSimulationStart}
                  editSimulationEnd={editSimulationEnd}
                  onSelect={setSelectedProject}
                  onGlobalSelect={setGlobalSelectedProjectId}
                  onDownloadNodeList={handleDownloadNodeList}
                  onGenerateNodeList={handleGenerateNodeList}
                  onViewData={(project) => {
                    setSelectedProject(project);
                    setUploadingProject(null);
                    setExpandedProjectId(expandedProjectId === project.id ? null : project.id);
                  }}
                  onUploadData={(project) => {
                    setSelectedProject(project);
                    setExpandedProjectId(null);
                    setUploadingProject((current) =>
                      current?.id === project.id ? null : project
                    );
                  }}
                  onEditItemMaster={(project) => {
                    setSelectedProject(project);
                    setItemMasterProjectId((current) =>
                      current === project.id ? null : project.id
                    );
                  }}
                  onEdit={(project) => {
                    setSelectedProject(project);
                    setEditingProject(project);
                    setEditProjectName(project.name);
                    setEditPlantName(project.plant_name);
                    setEditDataType(project.data_type || 'curated');
                    setEditSupplyChainModel(project.supply_chain_model);
                    setEditBomLevel(project.bom_level);
                    setEditSimulationStart(parseDateFromDatabase(project.simulation_start));
                    setEditSimulationEnd(parseDateFromDatabase(project.simulation_end));
                  }}
                  onDelete={handleDeleteProject}
                  onCombine={handleCombineProject}
                  onCancelEdit={() => setEditingProject(null)}
                  onUpdateProject={handleUpdateProject}
                  onEditProjectNameChange={setEditProjectName}
                  onEditPlantNameChange={setEditPlantName}
                  onEditSupplyChainModelChange={setEditSupplyChainModel}
                  onEditBomLevelChange={setEditBomLevel}
                  onEditDataTypeChange={setEditDataType}
                  onEditSimulationStartChange={setEditSimulationStart}
                  onEditSimulationEndChange={setEditSimulationEnd}
                  onEditDeepTierEnabledChange={setEditDeepTierEnabled}
                  editDeepTierEnabled={editDeepTierEnabled}
                />

                {expandedProjectId === project.id && (
                  <div className={cn(
                      'mt-4 space-y-4',
                      // The 32px indent is a third of a 320px gutter. Below `md` the
                      // relationship is carried by the 2px rule alone (v2 §2).
                      isMobile ? 'border-l-2 border-[#d4d4d4] pl-2.5' : 'ml-4 border-l-2 border-border pl-4',
                    )}>
                     <ProjectDataViewer
                       project={project}
                       orgAdmin={orgAdminOf(project)}
                       onClose={() => setExpandedProjectId(null)}
                       onDataDeleted={() => {
                         checkProjectDataCompletion(project.id).then((status) => {
                           setProjectDataStatus((prev) => ({ ...prev, [project.id]: status }));
                         });
                       }}
                     />
                     {/* Complementary to the Upload Wizard above, never a replacement —
                         docs/design/erp-mrp-integration-plan.md §2.0, §6c. Its
                         connect/sync/revoke/apply are writes, so it keeps the same
                         gate as Upload — "Edit Input Data" on this project (D230). */}
                     <ErpConnectionsPanelForEditors projectId={project.id} modelerId={project.modeler_id} />
                  </div>
                )}
                {itemMasterProjectId === project.id && (
                  <div className={cn(
                      'mt-4',
                      isMobile ? 'border-l-2 border-[#d4d4d4] pl-2.5' : 'ml-4 border-l-2 border-border pl-4',
                    )}>
                    <ItemMasterEditor
                      projectId={project.id}
                      initialTab={
                        walkToTable === 'materials' || walkToTable === 'products' || walkToTable === 'suppliers'
                          ? walkToTable
                          : undefined
                      }
                      onClose={() => setItemMasterProjectId(null)}
                    />
                  </div>
                )}
                {uploadingProject?.id === project.id && (
                  <div className={cn(
                      'mt-4',
                      isMobile ? 'border-l-2 border-[#d4d4d4] pl-2.5' : 'ml-4 border-l-2 border-border pl-4',
                    )}>
                    <UploadWizard
                      selectedProject={uploadingProject}
                      userId={user?.id || ''}
                      onUploadComplete={async () => {
                        console.log('🔄 Upload completion callback triggered for project:', project.name);
                        
                        try {
                          // Step 1: Clear upload state immediately to prevent UI issues
                          setUploadingProject(null);
                          
                          console.log('📊 Refreshing project status after upload...');
                          
                          // Step 2: Sequential async operations to prevent race conditions
                          await new Promise(resolve => setTimeout(resolve, 200)); // Brief delay to ensure upload transaction completes
                          
                          // Step 3: Reload projects and check completion status
                          await loadProjects();
                          const updatedStatus = await checkProjectDataCompletion(project.id);
                          setProjectDataStatus((prev) => ({ ...prev, [project.id]: updatedStatus }));
                          
                          console.log('📈 Updated project status:', updatedStatus);
                          
                          // Step 4: Check if project datasets are complete (excluding node list initially)
                          const isCompleteByData = updatedStatus.bom && updatedStatus.inbound && updatedStatus.outbound;
                          
                          if (isCompleteByData && !updatedStatus.nodeList) {
                            console.log('ℹ️ Core datasets complete. Skipping auto-completion to avoid timeouts in Multi Level BOM projects.');
                            toast.success(`All datasets uploaded. Click "Refresh Data" to finalize project "${project.name}".`);
                          } else {
                            console.log('ℹ️ Upload complete, no additional processing needed');
                          }
                          
                        } catch (completionError) {
                          console.error('❌ Upload completion callback failed:', completionError);
                          toast.error("Upload completed but status refresh failed. Please refresh the page.");
                        }
                      }}
                      onClose={() => setUploadingProject(null)}
                    />
                  </div>
                )}
              </div>
            );
  };
  const projectList = projects.map(renderProjectBlock);
  const createForm = (
    <>
            {creationNote && <p className="text-sm text-muted-foreground">{creationNote}</p>}
            <div>
              <Label htmlFor="projectName">Project Name</Label>
              <Input
                id="projectName"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Enter project name"
              />
              {isDuplicateName && (
                <p className="text-sm text-red-500 mt-1">A project with this name already exists</p>
              )}
            </div>
            <div>
              <Label htmlFor="plantName">Plant</Label>
              <Input
                id="plantName"
                value={plantName}
                onChange={(e) => setPlantName(e.target.value)}
                placeholder="Enter plant name"
              />
            </div>
            <div>
              <Label>Data</Label>
              <RadioGroup
                value={dataType}
                onValueChange={setDataType}
                className="flex gap-4 mt-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="curated" id="data-curated" />
                  <Label htmlFor="data-curated">Curated data</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="uncurated" id="data-uncurated" />
                  <Label htmlFor="data-uncurated">Uncurated data</Label>
                </div>
              </RadioGroup>
            </div>
            <div>
              <Label>Supply Chain Model</Label>
              <RadioGroup
                value={supplyChainModel}
                onValueChange={setSupplyChainModel}
                className="flex gap-4 mt-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="Make-To-Order" id="model-mto" />
                  <Label htmlFor="model-mto">Make-To-Order</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="Make-To-Stock" id="model-mts" />
                  <Label htmlFor="model-mts">Make-To-Stock</Label>
                </div>
              </RadioGroup>
            </div>
            <div>
              <Label>BOM Level</Label>
              <RadioGroup
                value={bomLevel}
                onValueChange={setBomLevel}
                className="flex gap-4 mt-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="single" id="bom-single" />
                  <Label htmlFor="bom-single">Single Level BOM</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="multi" id="bom-multi" />
                  <Label htmlFor="bom-multi">Multiple Level BOM</Label>
                </div>
              </RadioGroup>
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs font-medium">Deep Tier Network</Label>
              <div className="flex items-center space-x-3">
                <Switch
                  id="deep-tier-enabled"
                  checked={deepTierEnabled}
                  onCheckedChange={setDeepTierEnabled}
                />
                <Label htmlFor="deep-tier-enabled" className="text-xs">
                  Enable Deep Tier Network Analysis
                </Label>
              </div>
              {deepTierEnabled && (
                <p className="text-xs text-muted-foreground">
                  This will enable tier-2 and tier-3 supplier data collection for extended supply chain visibility.
                </p>
              )}
            </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Simulation Start Date</Label>
              <StepwiseDatePicker
                date={simulationStart}
                onSelect={setSimulationStart}
                placeholder="Pick start date"
              />
            </div>
            <div>
              <Label className="text-xs">Simulation End Date</Label>
              <StepwiseDatePicker
                date={simulationEnd}
                onSelect={setSimulationEnd}
                placeholder="Pick end date"
                disabled={(date) => simulationStart ? date < simulationStart : false}
              />
            </div>
          </div>
          <ProjectWindowLength
            idPrefix="new-project-window"
            start={simulationStart}
            end={simulationEnd}
            onEndChange={setSimulationEnd}
          />
            <div className="flex gap-2">
              <Button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim() || !plantName.trim() || isDuplicateName}
              >
                Create Project
              </Button>
              <Button variant="outline" onClick={() => setIsCreating(false)}>
                Cancel
              </Button>
            </div>
    </>
  );
  // Not a tab-bar root (isMobileRootRoute) — reached from More, so T2 hides
  // the tab bar here and the header's own back target is the only way out.
  const newProjectAction = canCreate && (
    <Button
      onClick={handleOpenCreateForm}
      disabled={isCreating}
      size="sm"
      className={cn('gap-2', HDR_PRIMARY_BUTTON)}
    >
      <Plus className="h-4 w-4" />
      New Project
    </Button>
  );

  return (
    <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
      {/* v3 §1.1/§2.1, D3-a: sibling before the padded content, root variant
          — Project Manager is a root with no tab of its own (D3-a names it
          explicitly), so it keeps the tab bar rather than a back arrow. The
          active-project badge doesn't fit the one-action meta slot, so it
          stays out; "New Project" moves into the gutter as the body's first
          band rather than the header, same move T4 makes for AdminLayout's
          actions. Search rides the second row — pinned, so it never scrolls
          away (§1.2) — matching name and plant name (the closest real field
          to "description"; this project shape carries no separate
          description text). */}
      {isMobile && (
        <MobilePageHeader variant="root" title="Your Projects">
          <MobileHeaderSearch value={projectQuery} onChange={setProjectQuery} placeholder="Find a project" />
        </MobilePageHeader>
      )}
      <div className={isMobile ? PAGE_GUTTER_SKIN : PAGE_GUTTER}>
        {!isMobile && (
          /* The selected-project BADGE becomes the standard project select
             (handoff, Project Manager row): the app now has one
             project-context control instead of four, and this page's read-only
             chip was the odd one out. Same selection, same store — it is the
             `setGlobalSelectedProjectId` every other header already calls, so
             the badge's bounded-width workaround goes with it: 200px is a
             fixed width, not a name-shaped one. */
          <PageHeader
            title="Your Projects"
            rightContent={
              <div className="flex items-center gap-2">
                <Select
                  value={globalSelectedProjectId || ''}
                  onValueChange={(v) => setGlobalSelectedProjectId(v || null)}
                >
                  <SelectTrigger className={cn('h-11 md:h-9', HDR_PROJECT_SELECT)}>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id} className="min-h-11 md:min-h-0">
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {newProjectAction}
              </div>
            }
          />
        )}
        {isMobile && newProjectAction && (
          <div className="mb-[var(--m-gap)]">{newProjectAction}</div>
        )}
        <div className={isMobile ? 'flex flex-col gap-[var(--m-gap)]' : 'space-y-4'}>
            {/* v3 §2.1: no KPI tiles on the mobile list — the numbers this
                grid carried move into the project (openProject's expanded
                <ProjectCard/> block already has them). Desktop never showed
                this grid either; MobileStatGrid is mobile-only by
                construction (`@/components/mobile`'s own boundary), so
                dropping it here is a removal, not a move. */}

            {/* Create New Project Form */}
        {isCreating && canCreate && (
          isMobile ? (
            // The dashed card is a second container style, which the skin does
            // not have (§12) — the form is the panel, with the touch floor on
            // every control it holds. Same fields, same handler, same copy.
            <MobilePanel tone="primary" label="Create new project">
              <div className="space-y-4 p-3 [&_input]:min-h-11 [&_button]:min-h-11">
                {createForm}
              </div>
            </MobilePanel>
          ) : (
          <Card className="border-dashed">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm">Create New Project</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {createForm}
            </CardContent>
          </Card>
          )
        )}


        {projects.length === 0 ? (
          isMobile ? (
            // One ink head per screen: with the create form open above, the
            // form is what changed and this steps back (v2 §2).
            <MobilePanel tone={isCreating ? 'secondary' : 'primary'} label="Projects" counter="none">
              <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
                <span className="text-[13px] leading-relaxed text-[#525252] [text-wrap:pretty]">
                  No projects yet — create your first one to get started.
                </span>
                {canCreate && (
                  <MobileButton weight="secondary" onClick={handleOpenCreateForm}>
                    New project
                  </MobileButton>
                )}
              </div>
            </MobilePanel>
          ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <div className="text-muted-foreground">
                <p className="text-lg font-medium mb-2">No projects found</p>
                <p className="text-sm">Create your first project to get started</p>
              </div>
            </CardContent>
          </Card>
          )
        ) : isMobile ? (
          // v3 §2.1: one Resume panel (the screen's one loud panel), Active
          // rows budgeted per device (v2 §5.4) with an All-N deferral sheet,
          // Shared with me as a single count row. No Archived band — see the
          // comment above `sharedProjects`. Tapping any row opens the SAME
          // <ProjectCard/> block desktop always shows, inline below it —
          // that block is where owner/dates/datasets/KPIs live now.
          <>
            {resumeProject && (() => {
              const completion = getCompletionInfo(resumeProject);
              const status = projectStatus(resumeProject, completion);
              return (
                <React.Fragment key={resumeProject.id}>
                  <MobilePanel
                    tone="primary"
                    label="Last opened"
                    counter={lastOpened ? relativeTime(lastOpened.ts) : 'new'}
                  >
                    <button
                      type="button"
                      onClick={() => openProject(resumeProject.id)}
                      className="flex w-full flex-col gap-1 px-3 py-3 text-left"
                    >
                      <span className="text-[17px] font-semibold leading-tight text-[#171717]">
                        {resumeProject.name}
                      </span>
                      <span
                        className="font-mono text-[10.5px] leading-[1.45] tracking-[0.04em]"
                        style={{ color: status.dot }}
                      >
                        {status.label}
                      </span>
                    </button>
                  </MobilePanel>
                  {openProjectId === resumeProject.id && renderProjectBlock(resumeProject)}
                </React.Fragment>
              );
            })()}

            {activeProjects.length > 0 && (
              // A panel, not a bare MobileGroup — MobileGroup is a canvas
              // label above a panel, not a container itself (v2 §2); every
              // list in the skin is still the one black-headed panel.
              <MobilePanel label="Active" counter={String(activeProjects.length)}>
                {shownActive.map((project) => {
                  const completion = getCompletionInfo(project);
                  const status = projectStatus(project, completion);
                  return (
                    <React.Fragment key={project.id}>
                      <MobileRow
                        dot={status.dot}
                        label={project.name}
                        sub={status.label}
                        onClick={() => openProject(project.id)}
                      />
                      {openProjectId === project.id && renderProjectBlock(project)}
                    </React.Fragment>
                  );
                })}
                {activeProjects.length > shownActive.length && (
                  <MobileRow
                    label={`All ${activeProjects.length} projects ›`}
                    onClick={() => setActiveSheetOpen(true)}
                  />
                )}
              </MobilePanel>
            )}

            {sharedProjects.length > 0 && (
              <MobilePanel label="Shared with me" counter={String(sharedProjects.length)}>
                {openedShared && (() => {
                  const completion = getCompletionInfo(openedShared);
                  const status = projectStatus(openedShared, completion);
                  return (
                    <React.Fragment key={openedShared.id}>
                      <MobileRow
                        dot={status.dot}
                        label={openedShared.name}
                        sub={`${openedShared.modeler_name} · ${status.label}`}
                        onClick={() => openProject(openedShared.id)}
                      />
                      {renderProjectBlock(openedShared)}
                    </React.Fragment>
                  );
                })()}
                <MobileRow
                  label="View shared projects"
                  onClick={() => setSharedSheetOpen(true)}
                />
              </MobilePanel>
            )}

            {visibleProjects.length === 0 && (
              <MobilePanel label="Projects" counter="0">
                <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
                  <span className="text-[13px] leading-relaxed text-[#525252] [text-wrap:pretty]">
                    No projects match “{projectQuery}”.
                  </span>
                  <MobileButton weight="secondary" onClick={() => setProjectQuery('')}>
                    Clear search
                  </MobileButton>
                </div>
              </MobilePanel>
            )}

            <MobileSheet
              open={activeSheetOpen}
              title={`Active · ${activeProjects.length}`}
              sub="Every active project — tap one to open it."
              onClose={() => setActiveSheetOpen(false)}
            >
              <div className="flex flex-col">
                {activeProjects.map((project) => {
                  const completion = getCompletionInfo(project);
                  const status = projectStatus(project, completion);
                  return (
                    <MobileRow
                      key={project.id}
                      dot={status.dot}
                      label={project.name}
                      sub={status.label}
                      onClick={() => openProject(project.id, true)}
                    />
                  );
                })}
              </div>
            </MobileSheet>

            <MobileSheet
              open={sharedSheetOpen}
              title={`Shared with me · ${sharedProjects.length}`}
              onClose={() => setSharedSheetOpen(false)}
            >
              <div className="flex flex-col">
                {sharedProjects.map((project) => {
                  const completion = getCompletionInfo(project);
                  const status = projectStatus(project, completion);
                  return (
                    <MobileRow
                      key={project.id}
                      dot={status.dot}
                      label={project.name}
                      sub={`${project.modeler_name} · ${status.label}`}
                      onClick={() => openProject(project.id, true)}
                    />
                  );
                })}
              </div>
            </MobileSheet>
          </>
        ) : (
          <div className="space-y-4">
            {projectList}
          </div>
        )}
          </div>
        </div>
    </PageLayout>
  );
};

export default DataManager;