// supply-chain schema tables aren't in the generated DB types yet.
/**
 * Project Intelligence (SuReSuite visual language).
 *
 * Same data flow as the current page — useChatThreads for the thread store,
 * useProjectChat inside the workspace, list_projects RPC for the project
 * picker, route ↔ active-thread sync via ?thread=. What changed is the shell:
 *
 *  - PageHeader with NO subtitle (AdminLayout pattern).
 *  - The chat panel is a resizable/collapsible grid: drag the 5px handle
 *    (200–460px) or collapse to a 48px rail to reclaim workspace. The three
 *    tracks are constant — `<rail>px 5px minmax(0,1fr)` — and so is the
 *    divider element, because it carries the panel's ONE vertical rule. A
 *    track count that changes with the state while the divider is unmounted
 *    squeezes the workspace into the rail column; a divider that unmounts
 *    while the tracks stay leaves the rail with no rule at all.
 *  - Sidebar file/memory panels are layer-tinted disclosures (teal #14b8c4 /
 *    purple #7c3aed) so they cost 36px when closed.
 *  - The panel FILLS the gutter column instead of measuring itself against
 *    the viewport with `calc(100vh - 150px)`: the column is a flex column of
 *    a known height, the header is shrink-0 and the panel is `flex-1
 *    min-h-0`. That is what lets ChatWorkspace pin its composer to the bottom
 *    edge at every desktop size (see its own bottom-pin contract) — a panel
 *    whose height is guessed from the viewport is either short of the fold or
 *    past it at every size the guess was not measured at.
 *  - Window mode: in-app (default) or full screen, the panel promoted to
 *    `fixed inset-0`. The control lives in the workspace chrome band; the
 *    state lives here because positioning the panel is the page's job.
 *
 * Below md this shell is not used at all. The phone composition is a different
 * tree (MobileIntelligence) — PAGES.md 16: the page title, agent strip, memory
 * strip and suggestion chips fold into a chat header, a ⋯ menu and a composer
 * lightbulb, reclaiming ~150px for the conversation. Everything it renders
 * comes from the props and hooks below, so the two platforms share one data
 * flow and one message stream.
 */
import { listProjectsCached } from "@/lib/projects/projectsCache";
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageLayout } from "@/components/shared/PageLayout";
import { PageHeader } from "@/components/shared/PageHeader";
import { PAGE_GUTTER } from "@/components/shared/PageBody";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useGlobalProject, type Project } from "@/hooks/useGlobalProject";
import { useAuth } from "@/hooks/useAuth";
import { useCapabilities } from "@/hooks/useCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ChatSidebar } from "@/components/intelligence/ChatSidebar";
import { ChatWorkspace } from "@/components/intelligence/ChatWorkspace";
import { ScIntelMobile } from "@/components/intelligence/mobile/ScIntelMobile";
import { useChatThreads, QUICK_THREAD_ID } from "@/hooks/useChatThreads";
import { getStoredModel, setStoredModel } from "@/components/chat/ModelPicker";
import { fileWorkspaceUiEnabled, useUserFiles, expiryCountdown } from "@/hooks/useUserFiles";
import { useProjectMemory } from "@/hooks/useProjectMemory";
import { cn } from "@/lib/utils";

interface ProjectIntelligenceProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

/** list_projects returns the same shape the global project selection stores,
 * which is why `match` can be handed straight to setSelectedProject. The RPC
 * postdates the generated Supabase types — that mismatch is what the
 * file-wide `@ts-nocheck` used to paper over, along with every real type
 * error in the file. Loosen only the one call that needs it. */
type ProjectRow = Project;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 460;
const SIDEBAR_DEFAULT = 264;
const KEY_SIDEBAR_W = "projectIntelligence.sidebarWidth.v1";
const KEY_SIDEBAR_COLLAPSED = "projectIntelligence.sidebarCollapsed.v1";
const KEY_FULLSCREEN = "projectIntelligence.fullScreen.v1";
/** The rail's collapsed width. The handle track stays at 5px either way. */
const SIDEBAR_COLLAPSED_W = 48;

const ProjectIntelligence: React.FC<ProjectIntelligenceProps> = ({ isCollapsed, setIsCollapsed }) => {
  const { user } = useAuth();
  const { can } = useCapabilities();
  const { globalSelectedProjectId, setGlobalSelectedProjectId, setSelectedProject } = useGlobalProject();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(() => getStoredModel());
  const [searchParams, setSearchParams] = useSearchParams();

  // Chat-panel geometry (persisted so the working space survives reloads).
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY_SIDEBAR_W) : null;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)) : SIDEBAR_DEFAULT;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => (typeof window !== "undefined" ? window.localStorage.getItem(KEY_SIDEBAR_COLLAPSED) === "1" : false),
  );
  const [resizing, setResizing] = useState(false);
  // Window mode, persisted alongside the other panel prefs.
  const [fullScreen, setFullScreenState] = useState<boolean>(
    () => (typeof window !== "undefined" ? window.localStorage.getItem(KEY_FULLSCREEN) === "1" : false),
  );

  // Below md the three-column grid cannot work: at 390px a 264px sidebar plus
  // the 5px handle leaves the workspace ~120px, and the handle is mouse-only so
  // it can never be collapsed by touch. The phone gets its own tree instead.
  const isMobile = useIsMobile();

  const {
    threads,
    activeThread,
    activeThreadId,
    setActiveThread,
    newThread,
    deleteThread,
    updateThread,
    syncEnabled,
    folders,
    createFolder,
    deleteFolder,
    moveThreadToFolder,
    setPinned,
    setArchived,
    searchMessages,
    setThreadMode,
    clearThreadSummary,
    bulkSetThreadFlags,
    bulkMoveToFolder,
    bulkDeleteThreads,
    getServerThreadId,
  } = useChatThreads();

  const memoryProjectId = activeThread?.projectId ?? null;

  // Files / memory sources for the sidebar's two bottom panels. Files load for
  // ALL projects (projectId=null) so the panel's Project/All toggle can filter
  // client-side — projectId must be populated on each row or Project scopes to
  // nothing (see SidebarPanels.UserFile).
  const { files: rawFiles, keep: keepFile, download: downloadFile } = useUserFiles(null);
  const { entries: rawMemory, save: saveMemory, archive: archiveMemory } = useProjectMemory(memoryProjectId);

  const sidebarFiles = useMemo(
    () =>
      rawFiles.map((f) => ({
        id: f.id,
        projectId: f.project_id,
        name: f.name,
        kind: f.kind,
        expiresLabel: f.retained ? "kept" : expiryCountdown(f.expires_at),
        retained: f.retained,
      })),
    [rawFiles],
  );

  const sidebarMemory = useMemo(
    () => rawMemory.map((m) => ({ id: m.id, kindLabel: m.kind, content: m.content })),
    [rawMemory],
  );

  const handleDownloadFile = async (id: string) => {
    const err = await downloadFile(id);
    if (err) toast.error(err);
  };

  const handleKeepFile = async (id: string) => {
    const f = rawFiles.find((x) => x.id === id);
    if (!f) return;
    const err = await keepFile(id, !f.retained);
    if (err) toast.error(err);
  };

  const handleAddMemory = async (content: string) => {
    const err = await saveMemory({ content, kind: "fact", sourceThreadId: activeThreadId });
    if (err) toast.error(err);
  };

  const handleArchiveMemory = async (id: string) => {
    const err = await archiveMemory(id);
    if (err) toast.error(err);
  };

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setProjects((await listProjectsCached(user)) as ProjectRow[]);
      } catch (e) {
        console.error(e);
        toast.error("Failed to load projects");
      }
    })();
  }, [user]);

  // Route ↔ active thread sync. Without a ?thread=, fall back to the most
  // recent real chat — the Quick chat pseudo-thread is no longer listed here
  // (it backs the floating bubble only) and is never selected by default.
  //
  // Desktop only: the SC Intelligences mobile tree has no "active thread"
  // driving the whole page (its root lists threads rather than opening one),
  // and its own nested routes own which thread is on screen — running this
  // there would fight the ProjectChip's project scope with whatever thread
  // this picks as "most recent".
  useEffect(() => {
    if (isMobile) return;
    const urlThread = searchParams.get("thread");
    if (urlThread) {
      if (urlThread !== activeThreadId) setActiveThread(urlThread);
      return;
    }
    if (activeThreadId && activeThreadId !== QUICK_THREAD_ID) return;
    const mostRecent = threads.find((t) => !t.archived && t.id !== QUICK_THREAD_ID);
    if (mostRecent) setActiveThread(mostRecent.id);
    else if (activeThreadId) setActiveThread(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, searchParams, threads]);

  // Keep the global project selector in sync with the active thread's project
  // (desktop only — see above).
  useEffect(() => {
    if (isMobile) return;
    if (!activeThread?.projectId) return;
    const match = projects.find((p) => p.id === activeThread.projectId);
    if (match) {
      setGlobalSelectedProjectId(activeThread.projectId);
      setSelectedProject(match);
    }
  }, [isMobile, activeThread?.projectId, projects, setGlobalSelectedProjectId, setSelectedProject]);

  const persistWidth = (w: number) => {
    setSidebarWidth(w);
    try {
      window.localStorage.setItem(KEY_SIDEBAR_W, String(w));
    } catch {
      /* ignore */
    }
  };

  const setFullScreen = (v: boolean) => {
    setFullScreenState(v);
    try {
      window.localStorage.setItem(KEY_FULLSCREEN, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  // Escape leaves full screen. It is the only way out that does not need the
  // pointer, and the panel covers the nav and the header while it is on.
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen]);

  const setCollapsed = (v: boolean) => {
    setSidebarCollapsed(v);
    try {
      window.localStorage.setItem(KEY_SIDEBAR_COLLAPSED, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    setResizing(true);
    const move = (ev: MouseEvent) => {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
    };
    const up = (ev: MouseEvent) => {
      setResizing(false);
      persistWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX))));
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const handleSelectThread = (id: string) => {
    setActiveThread(id);
    setSearchParams({ thread: id }, { replace: true });
  };

  const handleNewThread = () => {
    const id = newThread();
    if (id) setSearchParams({ thread: id }, { replace: true });
  };

  const handleModelChange = (id: string) => {
    setModel(id);
    setStoredModel(id);
  };

  const handleAgentChange = (agentId: string) => {
    if (!activeThreadId) return;
    updateThread(activeThreadId, { agentId: agentId || null });
  };

  const handleProjectChange = (projectId: string | null) => {
    if (!activeThreadId) return;
    updateThread(activeThreadId, { projectId });
  };

  // SC Intelligences (mobile): the root's ProjectChip scopes the whole
  // surface, not a single thread — there is no "active thread" on that
  // screen to attach a project to, unlike the desktop/legacy chip above.
  const handleGlobalProjectChange = (projectId: string | null) => {
    setGlobalSelectedProjectId(projectId);
    setSelectedProject(projects.find((p) => p.id === projectId) ?? null);
  };

  // The single ChatSidebar prop set. The desktop grid child and the mobile
  // Chats sheet both spread this, so the two instances can never drift apart;
  // only the collapse trio differs, because only the desktop one collapses.
  const sidebarProps = {
    projects,
    threads,
    activeThreadId,
    onSelectThread: handleSelectThread,
    onNewThread: handleNewThread,
    onDeleteThread: deleteThread,
    onRenameThread: (id: string, title: string) => updateThread(id, { title }),
    onAttachProject: (id: string, projectId: string | null) => updateThread(id, { projectId }),
    syncEnabled,
    folders,
    onCreateFolder: createFolder,
    onDeleteFolder: deleteFolder,
    onMoveToFolder: moveThreadToFolder,
    onTogglePin: setPinned,
    onToggleArchive: setArchived,
    onSearchMessages: searchMessages,
    memoryEnabled: can("project_memory"),
    memoryProjectId,
    filesEnabled: fileWorkspaceUiEnabled() && can("reports"),
    onBulkSetFlags: bulkSetThreadFlags,
    onBulkMoveToFolder: bulkMoveToFolder,
    onBulkDelete: bulkDeleteThreads,
    files: sidebarFiles,
    memoryEntries: sidebarMemory,
    onDownloadFile: handleDownloadFile,
    onKeepFile: handleKeepFile,
    onAddMemory: handleAddMemory,
    onArchiveMemory: handleArchiveMemory,
  };

  // full_name is Supabase auth user_metadata, absent from the generated User type.
  const fullName = (user as { user_metadata?: { full_name?: string } } | null)?.user_metadata?.full_name;
  const firstName = (fullName ?? user?.email ?? "").split(/[ @]/)[0];

  // Below md the desktop three-column grid is not reflowed, it is replaced:
  // MobileIntelligence is the phone composition (PAGES.md 16). Both trees are
  // fed from the same state above, and the branch sits below every hook so the
  // hook order is identical on either platform.
  if (isMobile) {
    return (
      <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
        {/* No PAGE_GUTTER: on a phone this surface IS the screen, edge to edge
            from the header rule to the composer, exactly as the demo has it.
            A gutter here would inset the conversation in a card and cost ~31px
            of the line length the whole composition exists to reclaim. */}
        <ScIntelMobile
          projects={projects}
          projectId={globalSelectedProjectId}
          onProjectChange={handleGlobalProjectChange}
          threads={threads}
          model={model}
          onModelChange={handleModelChange}
          newThread={newThread}
          updateThread={updateThread}
          // The same prop set the desktop ChatSidebar spreads (see
          // `sidebarProps`'s own comment) — carries a few desktop-only fields
          // (onSelectThread, syncEnabled, …) the mobile Chats screen's own
          // prop type just doesn't name, which a spread onto it is free to
          // ignore.
          chat={sidebarProps}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed}>
      {/* The gutter column is a flex column of a known height, so the panel
          below can be its flexible child. `100dvh` less PageLayout's own
          `md:pb-10` credit-bar reservation: the gutter's `py-6` and that 40px
          are what sits under the composer, and both are load-bearing (the
          header bleeds out of this wrapper with `-mx-12 -mt-6`). */}
      <div className={cn(PAGE_GUTTER, "flex min-h-0 flex-col md:h-[calc(100dvh-2.5rem)]")}>
        {/* No subtitle — AdminLayout header pattern. */}
        <PageHeader title="Project Intelligence" />

        <div
          className={cn(
            "grid overflow-hidden bg-background",
            fullScreen
              // Over the nav (z-[60], earlier in the DOM), the sticky header
              // (z-40) and the fixed credit bar (z-30). Same element, same
              // React position — only the positioning changes, so the thread,
              // the scroll and the draft all survive the switch.
              ? "fixed inset-0 z-[60]"
              // min-h-[420px] is the floor the bottom-pin contract needs: below
              // it the stream would be shorter than one turn and the composer
              // would be pushed out of the panel instead of the stream scrolling.
              : "min-h-[420px] flex-1 rounded-sm border border-[--hair-border]",
          )}
          style={{
            gridTemplateColumns:
              (sidebarCollapsed ? SIDEBAR_COLLAPSED_W : sidebarWidth) + "px 5px minmax(0,1fr)",
          }}
        >
          {/* display:contents keeps this a DIRECT grid child; a plain wrapper
              would collapse the three tracks into one cell and squeeze the
              workspace into the sidebar column. */}
          <div className="contents">
            <ChatSidebar
              collapsed={sidebarCollapsed}
              onCollapse={() => setCollapsed(true)}
              onExpand={() => setCollapsed(false)}
              {...sidebarProps}
            />
          </div>

          {/* THE panel's one vertical rule, and the resize target.
              `border-l`, not `border-r`: the rule belongs against the rail,
              where the drag target is, and the aside no longer draws its own
              (ChatSidebar). Rendered in both states so the collapsed rail is
              still separated from the workspace; only the drag is dropped,
              since there is nothing to size while the rail is collapsed.
              6 · the handle is onMouseDown-only. */}
          <div
            onMouseDown={sidebarCollapsed ? undefined : startResize}
            title={sidebarCollapsed ? undefined : "Drag to resize"}
            className={cn(
              "border-l border-[--hair-border]",
              !sidebarCollapsed && "cursor-col-resize",
            )}
            style={{ background: resizing ? "var(--hair-border)" : "transparent" }}
          />

          <ChatWorkspace
            threadId={activeThreadId}
            projectId={activeThread?.projectId ?? null}
            agentId={activeThread?.agentId ?? null}
            onAgentChange={handleAgentChange}
            onProjectChange={handleProjectChange}
            projects={projects}
            userName={firstName}
            input={input}
            onInputChange={setInput}
            model={model}
            onModelChange={handleModelChange}
            threadMode={activeThread?.mode ?? "review"}
            onModeChange={(m) => activeThreadId && setThreadMode(activeThreadId, m)}
            serverThreadId={activeThreadId ? getServerThreadId(activeThreadId) : null}
            threadSummary={activeThread?.summary ?? null}
            onDeleteSummary={() => activeThreadId && clearThreadSummary(activeThreadId)}
            fullScreen={fullScreen}
            onFullScreenChange={setFullScreen}
          />
        </div>
      </div>
    </PageLayout>
  );
};

export default ProjectIntelligence;
