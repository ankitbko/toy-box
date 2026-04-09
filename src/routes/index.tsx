import { useHotkey } from "@tanstack/react-hotkeys";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { PanelLeft } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { destroySession } from "@/functions/sessions";
import { getRuntimeConfig, setAgentUrl } from "@/functions/config";
import { modelQueries } from "@/lib/queries";
import { getSettings } from "@/lib/settings";
import { useAutomations } from "@/hooks/automations/useAutomations";
import { useLocalStorage } from "@/hooks/browser/useLocalStorage";
import { useSessions } from "@/hooks/session/useSessions";
import { useViewport } from "@/hooks/browser/ViewportContext";
import { generateUUID } from "@/lib/utils";
import type { SessionMetadata } from "@/types";
import { Sidebar, SidebarProps } from "@/components/sidebar/Sidebar";
import { SessionView } from "@/components/session/SessionView";
import { SessionGrid } from "@/components/session/SessionGrid";
import { SessionPlaceholder } from "@/components/session/SessionPlaceholder";
import {
  normalizeSessionDirectoryOptions,
  type SessionDirectoryOption,
} from "@/components/session/sessionDirectoryOptions";
import {
  AUTOMATIONS_EXPANDED_COOKIE,
  buildLayoutCookie,
  parseLayoutPrefs,
  resolveLayoutPrefs,
  SIDEBAR_OPEN_COOKIE,
  SIDEBAR_SIZE_COOKIE,
} from "@/lib/config/layoutPrefs";
import {
  cancelSessionsState,
  getSessionsStateSnapshot,
  prependSessionIfMissing,
  removeSessionFromState,
  replaceSessionsState,
} from "@/lib/session/sessionsCache";

/** Session ID prefix for sessions created by this web app */
const SESSION_ID_PREFIX = "toy-box-";

const SELECTED_MODEL_KEY = "selected-model";
const SESSION_SOURCE_FILTER_KEY = "session-source-filter";

const searchSchema = z.object({
  sessionIds: z.array(z.string()).max(4).optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: zodValidator(searchSchema),
  loader: async () => {
    const [layoutPrefs, runtimeConfig] = await Promise.all([loadLayoutPrefs(), getRuntimeConfig()]);
    return { ...layoutPrefs, runtimeConfig };
  },
  component: SessionsPage,
});

const EMPTY_SESSION_IDS: string[] = [];

async function loadLayoutPrefs() {
  if (import.meta.env.SSR) {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    const cookieHeader = getRequestHeader("cookie") ?? getRequestHeader("Cookie");
    return resolveLayoutPrefs(parseLayoutPrefs(cookieHeader));
  }

  return resolveLayoutPrefs(parseLayoutPrefs(document.cookie));
}

function SessionsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const sessionIds = search?.sessionIds ?? EMPTY_SESSION_IDS;
  const {
    sidebarSize: initialSidebarSize,
    sidebarOpen: initialSidebarOpen,
    automationsExpanded: initialAutomationsExpanded,
    runtimeConfig,
  } = Route.useLoaderData();

  // Bootstrap agent URL on load: settings override > env fallback
  useEffect(() => {
    const settings = getSettings();
    const effectiveUrl = settings.agentBaseUrl || runtimeConfig?.agentBaseUrl;
    if (effectiveUrl) {
      setAgentUrl({ data: { agentBaseUrl: effectiveUrl } });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    allSessions,
    sessions,
    isLoading,
    streamingSessionIds,
    unreadSessionIds,
    worktreeSessionIds,
  } = useSessions({
    openSessionIds: sessionIds,
  });
  const {
    automations,
    isLoading: isAutomationsLoading,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomation,
    isCreatingAutomation,
    updatingAutomationId,
    deletingAutomationId,
    runningAutomationIds,
  } = useAutomations({
    onUserRunRequested: (sessionId) => {
      navigate({ to: "/", search: { sessionIds: [sessionId] } });
    },
    streamingSessionIds,
  });
  const availableSessionIds = useMemo(() => {
    const ids = new Set(allSessions.map((session) => session.sessionId));
    for (const automation of automations) {
      if (!automation.lastRunSessionId) continue;
      ids.add(automation.lastRunSessionId);
    }
    return ids;
  }, [allSessions, automations]);
  const { data: models = [] } = useQuery(modelQueries.list());

  // Persisted state (synced with localStorage)
  const [selectedModel, setSelectedModel] = useLocalStorage<string>(SELECTED_MODEL_KEY, "");
  const [sourceFilter, setSourceFilter] = useLocalStorage(SESSION_SOURCE_FILTER_KEY, "toy-box");

  // Default to first model if none selected
  useEffect(() => {
    if (models.length > 0 && !selectedModel) {
      setSelectedModel(models[0].id);
    }
  }, [models, selectedModel, setSelectedModel]);

  const [sidebarSize, setSidebarSize] = useState(initialSidebarSize);
  const [isSidebarOpen, setIsSidebarOpen] = useState(initialSidebarOpen);

  const [isAutomationsExpanded, setIsAutomationsExpanded] = useState(initialAutomationsExpanded);

  const { isMobile: isMobileLayout, hydrated } = useViewport();

  // Draft session state - tracks a session that hasn't been created on the server yet
  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);

  // Create a new draft session (client-side only until first message)
  // With modifier key (Cmd/Ctrl), adds to the grid instead of replacing
  const handleCreateSession = useCallback(
    (e?: React.MouseEvent) => {
      const id = `${SESSION_ID_PREFIX}${generateUUID()}`;
      setDraftSessionId(id);

      const hasModifier = e?.metaKey || e?.ctrlKey;
      if (hasModifier && sessionIds.length > 0 && sessionIds.length < 4) {
        // Add to grid
        navigate({ to: "/", search: { sessionIds: [...sessionIds, id] } });
      } else {
        // Replace current view
        navigate({ to: "/", search: { sessionIds: [id] } });
      }
    },
    [navigate, sessionIds],
  );

  // Called when draft session is created on server (after first message)
  // Don't clear draftSessionId here - let the draftSession memo handle the
  // transition naturally when the server session appears in the list
  const handleDraftSessionCreated = useCallback(
    (sessionId: string) => {
      if (sessionId !== draftSessionId) return;

      // Immediately add the new session to the cache so it persists across navigation.
      // This ensures the session remains visible even if the user navigates back
      // before the next automatic refetch.
      prependSessionIfMissing(queryClient, {
        sessionId,
        startTime: new Date(),
        modifiedTime: new Date(),
        summary: "",
        isRemote: false,
      });
    },
    [draftSessionId, queryClient],
  );

  // Create draft session object (separate from sessions list for animation)
  // Returns null if draft is already in server list, enabling smooth handoff
  const draftSession = useMemo<SessionMetadata | null>(() => {
    if (!draftSessionId) return null;
    // Don't show draft if it's already in the server list - this enables
    // a smooth transition where the server session renders before draft unmounts
    if (sessions.some((s) => s.sessionId === draftSessionId)) return null;
    return {
      sessionId: draftSessionId,
      startTime: new Date(),
      modifiedTime: new Date(),
      summary: "",
      isRemote: false,
    };
  }, [draftSessionId, sessions]);

  // Clear stale draftSessionId once session is in server list
  useEffect(() => {
    if (draftSessionId && sessions.some((s) => s.sessionId === draftSessionId)) {
      setDraftSessionId(null);
    }
  }, [draftSessionId, sessions]);

  // Keep URL session IDs aligned with available sessions.
  // This prevents stale open panes when another client deletes a session.
  useEffect(() => {
    if (isLoading) return;
    if (sessionIds.length === 0) return;

    const validSessionIds = sessionIds.filter((sessionId) => {
      if (sessionId === draftSessionId) return true;
      return availableSessionIds.has(sessionId);
    });

    if (validSessionIds.length === sessionIds.length) return;

    navigate({
      to: "/",
      search: validSessionIds.length > 0 ? { sessionIds: validSessionIds } : {},
      replace: true,
    });
  }, [availableSessionIds, draftSessionId, isLoading, navigate, sessionIds]);

  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [isSidebarDragging, setIsSidebarDragging] = useState(false);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarSizeRef = useRef(sidebarSize);
  const isSidebarDraggingRef = useRef(false);

  useEffect(() => {
    sidebarSizeRef.current = sidebarSize;
  }, [sidebarSize]);

  useEffect(() => {
    document.cookie = buildLayoutCookie(SIDEBAR_OPEN_COOKIE, isSidebarOpen);
  }, [isSidebarOpen]);

  useEffect(() => {
    if (!Number.isFinite(sidebarSize)) return;
    document.cookie = buildLayoutCookie(SIDEBAR_SIZE_COOKIE, sidebarSize);
  }, [sidebarSize]);

  useEffect(() => {
    document.cookie = buildLayoutCookie(AUTOMATIONS_EXPANDED_COOKIE, isAutomationsExpanded);
  }, [isAutomationsExpanded]);

  const handleSidebarResize = useCallback(
    (size: number) => {
      if (size > 0) {
        sidebarSizeRef.current = size;
        if (!isSidebarDraggingRef.current) {
          setSidebarSize(size);
        }
      }
    },
    [setSidebarSize],
  );

  const handleSidebarDragging = useCallback(
    (dragging: boolean) => {
      isSidebarDraggingRef.current = dragging;
      setIsSidebarDragging(dragging);
      if (!dragging) {
        setSidebarSize(sidebarSizeRef.current);
      }
    },
    [setSidebarSize],
  );

  const isCollapsed = !isSidebarOpen;

  // Delay showing expand button until collapse animation completes
  const [showExpandButton, setShowExpandButton] = useState(isCollapsed);
  useEffect(() => {
    if (isCollapsed) {
      const timer = setTimeout(() => setShowExpandButton(true), 150);
      return () => clearTimeout(timer);
    } else {
      setShowExpandButton(false);
    }
  }, [isCollapsed]);

  const toggleSidebar = () => {
    const panel = sidebarPanelRef.current;
    if (panel) {
      if (panel.isCollapsed()) {
        if (Number.isFinite(sidebarSize)) {
          panel.resize(sidebarSize);
        } else {
          panel.expand();
        }
        setIsSidebarOpen(true);
      } else {
        panel.collapse();
        setIsSidebarOpen(false);
      }
    }
  };

  // Global keyboard shortcuts
  useHotkey("Mod+B", toggleSidebar);
  useHotkey({ key: "N", ctrl: true }, () => handleCreateSession());

  // Hide reusable automation sessions from the main session list, then apply source/text filters.
  const filteredSessions = useMemo(() => {
    const hiddenReusableAutomationSessionIds = new Set<string>();
    for (const automation of automations) {
      if (!automation.reuseSession || !automation.lastRunSessionId) continue;
      hiddenReusableAutomationSessionIds.add(automation.lastRunSessionId);
    }

    let result = sessions.filter(
      (session) => !hiddenReusableAutomationSessionIds.has(session.sessionId),
    );

    // Then apply the source filter (Toy Box vs All)
    if (sourceFilter === "toy-box") {
      result = result.filter((session) => session.sessionId.startsWith(SESSION_ID_PREFIX));
    }

    // Finally apply the text filter on summary.
    const lowerFilter = filter.trim().toLowerCase();
    if (!lowerFilter) return result;

    return result.filter((session) => session.summary?.toLowerCase().includes(lowerFilter));
  }, [sessions, automations, filter, sourceFilter]);

  const directoryOptions = useMemo<SessionDirectoryOption[]>(() => {
    const rawOptions = sessions.reduce<SessionDirectoryOption[]>((acc, session) => {
      const cwd = session.context?.cwd?.trim();
      if (!cwd) return acc;

      acc.push({
        cwd,
        repository: session.context?.repository,
        gitRoot: session.context?.gitRoot,
      });
      return acc;
    }, []);

    return normalizeSessionDirectoryOptions(rawOptions);
  }, [sessions]);

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => destroySession({ data: { sessionId } }),
    onMutate: async (sessionId) => {
      setDeletingSessionId(sessionId);

      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await cancelSessionsState(queryClient);

      // Snapshot the previous value for rollback
      const previousSessionsState = getSessionsStateSnapshot(queryClient);

      // Optimistically remove from cache
      removeSessionFromState(queryClient, sessionId);

      // Return context with the snapshot for rollback
      return { previousSessionsState };
    },
    onError: (_err, _sessionId, context) => {
      // Rollback to the previous value on error
      if (context?.previousSessionsState) {
        replaceSessionsState(queryClient, context.previousSessionsState);
      }
    },
    onSettled: () => {
      setDeletingSessionId(null);
    },
  });

  const handleSessionSelect = useCallback(
    (selectedSessionId: string | null, modifierKey: boolean = false) => {
      if (selectedSessionId === null) {
        navigate({ to: "/", search: {} });
        return;
      }

      // Normal click: Always reset to single session (ephemeral grids)
      if (!modifierKey) {
        navigate({ to: "/", search: { sessionIds: [selectedSessionId] } });
        return;
      }

      // Cmd/Ctrl+click: Add to or remove from grid (desktop only)
      // Note: Mobile behavior unchanged - modifier keys not supported
      const currentSessionIds = sessionIds;
      if (currentSessionIds.includes(selectedSessionId)) {
        // Remove from grid
        const updated = currentSessionIds.filter((id) => id !== selectedSessionId);
        navigate({ to: "/", search: updated.length > 0 ? { sessionIds: updated } : {} });
      } else if (currentSessionIds.length < 4) {
        // Add to grid (max 4)
        navigate({ to: "/", search: { sessionIds: [...currentSessionIds, selectedSessionId] } });
      }
    },
    [navigate, sessionIds],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      // If deleting a draft session, just clear the draft state (no server call)
      if (sessionIdToDelete === draftSessionId) {
        setDraftSessionId(null);
      } else {
        deleteMutation.mutate(sessionIdToDelete);
      }

      // If deleting an open session, remove it from the grid
      if (sessionIds.includes(sessionIdToDelete)) {
        const updated = sessionIds.filter((id) => id !== sessionIdToDelete);
        navigate({ to: "/", search: updated.length > 0 ? { sessionIds: updated } : {} });
      }
    },
    [draftSessionId, deleteMutation, sessionIds, navigate],
  );

  const hasSelectedSession = sessionIds.length > 0;

  // Mobile view state: 'sidebar' | 'session'
  const baseMobileView = hasSelectedSession ? "session" : "sidebar";
  const mobileTrackIndex = baseMobileView === "sidebar" ? 0 : 1;
  const mobileContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mobileContainerRef.current) {
      mobileContainerRef.current.scrollLeft = 0;
    }
  }, [baseMobileView]);

  // Shared sidebar props for both mobile and desktop
  const sidebarProps = {
    filter,
    onFilterChange: setFilter,
    sourceFilter,
    onSourceFilterChange: setSourceFilter,
    sessions: filteredSessions,
    isLoading,
    onSessionSelect: handleSessionSelect,
    onSessionDelete: handleSessionDelete,
    deletingSessionId,
    activeSessionIds: sessionIds,
    streamingSessionIds,
    unreadSessionIds,
    worktreeSessionIds,
    emptyMessage: filter ? "No sessions match your filter" : undefined,
    draftSession,
    directoryOptions,
    automations,
    isAutomationsLoading,
    models,
    defaultAutomationModelId: selectedModel,
    isAutomationsExpanded,
    onAutomationsExpandedChange: setIsAutomationsExpanded,
    onCreateAutomation: createAutomation,
    onUpdateAutomation: updateAutomation,
    onDeleteAutomation: async (automationId: string) => {
      await deleteAutomation(automationId);
    },
    onRunAutomation: runAutomation,
    creatingAutomation: isCreatingAutomation,
    updatingAutomationId,
    deletingAutomationId,
    runningAutomationIds,
    onCreateSession: handleCreateSession,
  } as SidebarProps;

  // Mobile layout - sidebar and session views
  const mobileLayout = (
    <div ref={mobileContainerRef} className="relative h-full md:hidden overflow-hidden">
      {/* Slide track - shifts between sidebar and session */}
      <div
        className={`flex h-full w-full ${hydrated ? "transition-transform duration-300 ease-in-out" : ""}`}
        style={{ transform: `translateX(-${mobileTrackIndex * 100}%)` }}
      >
        {/* Sidebar */}
        <div className="h-full w-full shrink-0">
          <Sidebar {...sidebarProps} />
        </div>

        {/* Session View */}
        <div className="h-full w-full shrink-0">
          {sessionIds[0] && (
            <SessionView
              sessionId={sessionIds[0]}
              isSessionRunning={streamingSessionIds.includes(sessionIds[0])}
              isSessionUnread={unreadSessionIds.includes(sessionIds[0])}
              onBack={() => handleSessionSelect(null)}
              models={models}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              draftSessionId={draftSessionId}
              onDraftSessionCreated={handleDraftSessionCreated}
            />
          )}
        </div>
      </div>
    </div>
  );

  // Desktop layout - resizable panels
  const desktopLayout = (
    <div className="h-full hidden md:block">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        {/* Left Sidebar - Sessions List */}
        <ResizablePanel
          ref={sidebarPanelRef}
          id="sidebar"
          order={1}
          defaultSize={isSidebarOpen ? sidebarSize : 0}
          minSize={8}
          maxSize={40}
          collapsible
          collapsedSize={0}
          onResize={handleSidebarResize}
          onCollapse={() => setIsSidebarOpen(false)}
          onExpand={() => setIsSidebarOpen(true)}
          className={!isSidebarDragging ? "panel-transition" : ""}
        >
          <div className={`h-full border-r ${isCollapsed ? "hidden" : ""}`}>
            <Sidebar {...sidebarProps} onCollapse={toggleSidebar} />
          </div>
        </ResizablePanel>

        <ResizableHandle
          onDragging={handleSidebarDragging}
          className={isCollapsed ? "hidden" : ""}
        />

        {/* Right Panel - Chat View */}
        <ResizablePanel
          order={2}
          defaultSize={isSidebarOpen ? 100 - sidebarSize : 100}
          className={!isSidebarDragging ? "panel-transition" : ""}
        >
          <div className="h-full overflow-hidden relative">
            {/* Expand button when collapsed */}
            {showExpandButton && (
              <button
                onClick={toggleSidebar}
                className="absolute top-3 left-3 z-10 text-muted-foreground hover:text-foreground"
                aria-label="Expand sidebar"
              >
                <PanelLeft className="h-5 w-5" />
              </button>
            )}
            {sessionIds.length > 0 ? (
              <SessionGrid
                sessionIds={sessionIds}
                streamingSessionIds={streamingSessionIds}
                unreadSessionIds={unreadSessionIds}
                onRemoveSession={(sessionIdToRemove) => {
                  const updated = sessionIds.filter((id) => id !== sessionIdToRemove);
                  navigate({
                    to: "/",
                    search: updated.length > 0 ? { sessionIds: updated } : {},
                  });
                }}
                models={models}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                draftSessionId={draftSessionId}
                onDraftSessionCreated={handleDraftSessionCreated}
              />
            ) : (
              <SessionPlaceholder />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );

  return (
    <div className="h-full overflow-hidden">
      {!hydrated ? (
        <>
          {mobileLayout}
          {desktopLayout}
        </>
      ) : isMobileLayout ? (
        mobileLayout
      ) : (
        desktopLayout
      )}
    </div>
  );
}
