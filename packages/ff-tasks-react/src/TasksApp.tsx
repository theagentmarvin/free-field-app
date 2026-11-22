import { useTaskBuildingIndex, withEffectiveBuilding } from "./taskBuilding";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requireProjectId, useCurrentProject, useProjectId } from "@ff/auth";
import {
  exportBcf as defaultExportBcf,
  type ExportBcf,
  buildActionPayload,
  clearDraft,
  isDualThumbLocation,
  normalizeLocationThumb2dPath,
  latestDraft,
  type TaskDraftFields,
  type TaskStatus,
  type TaskView,
} from "@ff/tasks";

import { draftTable, useTaskEngine } from "./useTaskEngine";
import { useTaskPeople } from "./useTaskPeople";
import { useTasksFirestore, useTasksSource } from "./tasksSource";
import { TaskComposeSheet } from "./TaskComposeSheet";
import { type ComposeFields } from "./composeModel";
import { restoreDraftCompose } from "./draftRestore";
import { TasksListPanel } from "./TasksListPanel";
import { TaskTablePanel } from "./TaskTablePanel";
import { TaskBoardPanel, BOARD_COLUMNS } from "./TaskBoardPanel";
import { useIsWide } from "./useIsWide";
import { useTaskCapabilities } from "./capabilities";
import { TaskBulkBar } from "./TaskBulkBar";
import { TaskToast } from "./TaskToast";
import { TaskConfirmDialog } from "./TaskConfirmDialog";
import { TaskShortcutsSheet } from "./TaskShortcutsSheet";
import { useTaskShortcuts, type ShortcutAction } from "./useTaskShortcuts";
import { bulkSummary, planBulk, type BulkOp, type BulkRowInput, type PlannedAction } from "./bulkLogic";
import { planBoardMove } from "./boardMove";
import {
  buildCsv,
  buildTasksReportHtml,
  downloadBlob,
  downloadText,
  exportFileName,
  REPORT_MAX_PHOTOS,
  REPORT_MAX_TASKS,
  type ReportTask,
} from "./exportTasks";
import { openPrintView } from "./printDocument";
import {
  BCF_MAX_TOPICS,
  bcfCapMessage,
  bcfDoneMessage,
  bcfProgressMessage,
  buildBcfBundles,
  buildBcfUserDirectory,
  selectBcfScope,
  type TasksBcfContext,
} from "./bcfExport";
import { convertToPng, fetchBinaryFromUrl } from "./bcfBrowser";
import { loadMemberEmails } from "./memberEmails";
import { loadSheetCatalog } from "./sheetCatalog";
import { TaskDetailHost } from "./TaskDetailHost";
import { TaskOutboxSheet } from "./TaskOutboxSheet";
import { TaskToolbar } from "./TaskToolbar";
import { TaskColumnPicker } from "./TaskColumnPicker";
import { loadVisibleColumns, saveVisibleColumns, type ColumnId, type TaskTableRow } from "./tableColumns";
import { applyColumnFilters, countActiveFilters, type ActiveFilters } from "./columnFilters";
import {
  SAVED_VIEWS,
  visibleTasks,
  loadSavedViewId,
  persistSavedViewId,
  scopeRowsToBuilding,
  applyQuickFilters,
  chipCounts,
  deadlineSignal,
  matchesChip,
  STATUS_LABELS,
  type QuickFilters,
  type Chip,
  type GroupKey,
  type ScopeMode,
  type SortKey,
  type ViewMode,
} from "./logic";
import { canvasAreaStyle, cardWrapperStyle } from "./formStyles";
import { useTaskPhotoResolver } from "./photoResolver";
import type { PhotoUrlResolver } from "./usePhotoUrl";
import { useOutboxRows } from "./useOutboxRows";

/**
 * Route component for `/tasks` (plan §7 screen 1, D1 package layout).
 * Cloud-first: the Firestore live query is the truth feed; the Dexie
 * outbox overlays queued/failed actions on top (D5 suppression inside
 * ff-tasks' merge). The single `useTasksSource()` switch resolves the
 * same live queries against the Dexie-backed demo source when there is
 * no auth/backend.
 */

export interface TasksAppProps {
  /** Rows fetched per page (plan §8 bounded live query). Pages grow on
   *  demand ("Load more" / scroll) instead of silently capping the list. */
  limit?: number;
  onOpenTask?: (task: TaskView) => void;
  /** host-supplied Storage resolver for the row photo thumbs; when
   *  omitted the built-in resolver is used (local demo store / Firebase). */
  resolvePhotoUrl?: PhotoUrlResolver;
  /**
   * UI refresh v1 §4 — host-agnostic building wiring (the package must
   * NOT import @free-field/models): the host (the /tasks shell route and
   * any TasksApp mount) reads the shared active-building store — exactly
   * how NavPanel receives buildingId — and passes it down.
   */
  buildingId?: string | null;
  buildingName?: string | null;
  buildings?: readonly { id: string; name: string }[];
  /** fired when the user flips This-building / All-buildings (host may
   *  mirror/persist; the toggle state itself lives in the module). */
  onScopeChange?: (scope: ScopeMode) => void;
  /** BCF export — host resolvers (IFC GlobalIds, base-model shift, deep
   *  link). Absent = BCF is exported without components and without a
   *  camera (snapshot only). See docs/integration/bcf-export-tasks-react.md. */
  bcfContext?: TasksBcfContext;
  /** BCF writer override (tests); defaults to @ff/tasks exportBcf. */
  bcfExporter?: ExportBcf;
}

const MOVE_WORDS: Record<string, string> = {
  assign: "started",
  complete: "submitted for approval",
  reject: "returned to work",
  followup: "approved · follow-up",
  approve: "approved",
  discontinue: "discontinued",
};

/** Default page size of the bounded live query. */
export const DEFAULT_PAGE_SIZE = 200;

export function TasksApp({
  limit = DEFAULT_PAGE_SIZE,
  onOpenTask,
  resolvePhotoUrl,
  buildingId = null,
  buildingName = null,
  buildings,
  onScopeChange,
  bcfContext,
  bcfExporter,
}: TasksAppProps): JSX.Element {
  const projectId = useProjectId();
  const currentProject = useCurrentProject();
  const projectName = currentProject?.name ?? null;
  const source = useTasksSource();
  const db = useTasksFirestore();

  // Server-side paging: the live query asks for `limit × pages` rows;
  // "Load more" widens it. Chips/search/filters are client-side, so a
  // narrow view can be empty while more pages exist — the footer says so.
  const [pages, setPages] = useState(1);
  const fetchLimit = limit * pages;
  const [cloud, setCloud] = useState<TaskView[]>([]);
  useEffect(() => {
    setPages(1);
  }, [projectId]);
  useEffect(() => {
    if (!projectId) {
      setCloud([]);
      return;
    }
    return source.watchTasks(projectId, null, (tasks) => setCloud(tasks as TaskView[]), fetchLimit);
  }, [source, projectId, fetchLimit]);
  const hasMoreRemote = cloud.length >= fetchLimit;
  const loadMoreRemote = useCallback(() => setPages((p) => p + 1), []);

  const rows = useOutboxRows(projectId);
  const queued = rows.filter((r) => r.state === "added" || r.state === "failed").length;

  const engine = useTaskEngine();
  const { actor, members, ensureMembers } = useTaskPeople(db, projectId);

  const [compose, setCompose] = useState<{ taskId: string; initial?: ComposeFields } | null>(null);
  const [draft, setDraft] = useState<{ id: string; fields: TaskDraftFields } | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [outboxOpen, setOutboxOpen] = useState(false);

  useEffect(() => {
    if (!engine || !projectId) {
      setDraft(null);
      return;
    }
    void latestDraft(draftTable, projectId).then((d) => setDraft(d ?? null));
  }, [engine, projectId]);

  function failedRowFor(taskId: string) {
    return rows.find(
      (r) => r.state === "failed" && (r.payload as { taskId?: string }).taskId === taskId
    );
  }

  const [chip, setChip] = useState<Chip>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");

  // UI refresh v1 — view tabs, building scope, grouping, saved views.
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [scope, setScope] = useState<ScopeMode>("building");
  const [groupBy, setGroupBy] = useState<GroupKey>("status");
  const [activeViewId, setActiveViewId] = useState<string | null>(() => loadSavedViewId());

  // A persisted saved view re-asserts its state on mount (spec §3 V8:
  // "choice survives" — localStorage first, Q3).
  useEffect(() => {
    const id = loadSavedViewId();
    if (!id) return;
    const preset = SAVED_VIEWS.find((v) => v.id === id);
    if (!preset) return;
    setChip(preset.apply.chip);
    setSort(preset.apply.sort);
    setScope(preset.apply.scope);
    setGroupBy(preset.apply.group);
    setActiveViewId(id);
  }, []);

  function applyView(id: string | null): void {
    setActiveViewId(id);
    persistSavedViewId(id);
    const preset = SAVED_VIEWS.find((v) => v.id === id);
    if (!preset) return;
    setChip(preset.apply.chip);
    setSort(preset.apply.sort);
    setScope(preset.apply.scope);
    setGroupBy(preset.apply.group);
  }

  function changeScope(next: ScopeMode): void {
    setScope(next);
    onScopeChange?.(next);
  }

  const activeView = SAVED_VIEWS.find((v) => v.id === activeViewId) ?? null;

  // Wave 11 — the toolbar hosts the Columns picker + Clear filters
  // (single coherent row). Column visibility and session filters live
  // here now and are handed to <TaskTablePanel> as controlled props;
  // the panel keeps its internal fallback for standalone consumers.
  const [columnsVisible, setColumnsVisible] = useState<ReadonlySet<ColumnId>>(() => loadVisibleColumns());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnFilters, setColumnFilters] = useState<ActiveFilters>({});
  const activeFilterCount = countActiveFilters(columnFilters);

  // ≥1100px: the toolbar fits its single-row layout (title · chips ·
  // actions). Narrower: chips keep their own scrollable row above an
  // intact action row — controls never clip or stray-wrap.
  const toolbarSingleRow = useIsWide("(min-width: 1100px)");

  // Row photo thumbs (VDC 2026-11-02): the host may hand in its own
  // resolver; otherwise the shared resolver is used (demo local store /
  // Firebase Storage), so demo rows now show their seeded/uploaded thumbs.
  const internalPhotoResolver = useTaskPhotoResolver();
  const photoResolver = resolvePhotoUrl ?? internalPhotoResolver;

  // w69 pipeline: merge + search + saved-view predicates (uncapped) →
  // building scope → quick filters → counts → status chip. Counting
  // BEFORE the chip makes every chip show what clicking it would yield.
  const [quick, setQuick] = useState<QuickFilters>({});
  const nowTs = Date.now();
  const merged = useMemo(
    () =>
      visibleTasks(cloud, rows, {
        chip: "all",
        search,
        sort,
        limit: Number.POSITIVE_INFINITY,
        overlaySending: source.overlaySending,
        // saved-view predicates (V8) — inert for the default "no view" state
        assigneeUid: activeView?.apply.myTasks ? actor.uid : undefined,
        overdueOnly: activeView?.apply.overdueOnly,
        overdueNow: nowTs,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cloud, rows, search, sort, source.overlaySending, activeView, actor.uid, Math.floor(nowTs / 60_000)]
  );
  // Old tasks without a stamped building show (and scope by) the building
  // they are pinned in.
  const buildingIndex = useTaskBuildingIndex();
  const mergedEff = useMemo(() => withEffectiveBuilding(merged, buildingIndex), [merged, buildingIndex]);
  const preQuick = useMemo(() => scopeRowsToBuilding(mergedEff, buildingId, scope), [mergedEff, buildingId, scope]);
  const quickCounts = useMemo(
    () => ({
      mine: preQuick.filter((t) => !!actor.uid && t.assigneeUid === actor.uid && matchesChip(t.status, "open")).length,
      overdue: preQuick.filter((t) => deadlineSignal(t.deadline, t.status, nowTs) === "overdue").length,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preQuick, actor.uid, Math.floor(nowTs / 60_000)]
  );
  const quickFiltered = useMemo(
    () => applyQuickFilters(preQuick, quick, actor.uid, nowTs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preQuick, quick, actor.uid, Math.floor(nowTs / 60_000)]
  );
  const counts = useMemo(() => chipCounts(quickFiltered), [quickFiltered]);
  const scoped = useMemo(() => quickFiltered.filter((t) => matchesChip(t.status, chip)), [quickFiltered, chip]);
  // Host-free enrichment: building + storey display names ride the row
  // (the package never touches the building store itself). Raw cloud
  // docs keep `location` via the merge passthrough — read structurally.
  const tableRows = useMemo<TaskTableRow[]>(
    () =>
      scoped.map((t) => {
        const raw = t as TaskView & { location?: { storeyName?: string | null } | null };
        const bid = t.buildingId ?? null;
        return {
          ...t,
          buildingName: bid ? (buildings?.find((b) => b.id === bid)?.name ?? null) : null,
          storeyName: raw.location?.storeyName ?? null,
        };
      }),
    [scoped, buildings]
  );

  // Board honours the same column filters as the table (chips + search are
  // already applied upstream in `view`).
  const boardRows = useMemo(
    () => applyColumnFilters(tableRows, columnFilters, Date.now()),
    [tableRows, columnFilters]
  );

  // Wave 5A: table on tablet+desktop, cards on phone (boss-approved).
  // Both share the same rows/now/resolver/onOpen/onRetry contract.
  const isWide = useIsWide();
  const caps = useTaskCapabilities();

  // ── w69: selection, bulk actions, undo, confirm, shortcuts, export ──
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const [displayedIds, setDisplayedIds] = useState<string[]>([]);
  const [detailEdit, setDetailEdit] = useState(false);
  const [toast, setToast] = useState<{ message: string; actionLabel?: string; onAction?: () => void } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body?: string; confirmLabel: string; run: () => void } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [cardLimit, setCardLimit] = useState(60);

  // Drop selected ids that left the visible set (filters, project switch).
  useEffect(() => {
    if (selected.size === 0) return;
    const live = new Set(boardRows.map((r) => r.id));
    const next = new Set([...selected].filter((id) => live.has(id)));
    if (next.size !== selected.size) setSelected(next);
  }, [boardRows, selected]);
  useEffect(() => {
    setSelected(new Set());
    setActiveId(null);
  }, [projectId]);
  const hasSelection = selected.size > 0;
  useEffect(() => {
    if (hasSelection) void ensureMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSelection]);

  const selectedRows = useMemo(
    () => boardRows.filter((r) => selected.has(r.id)),
    [boardRows, selected]
  );

  // The board has no table to report its on-screen order, so derive it.
  useEffect(() => {
    if (viewMode !== "board" || !isWide) return;
    const ids = BOARD_COLUMNS.flatMap((col) => boardRows.filter((t) => col.statuses.includes(t.status)).map((t) => t.id));
    // keep the old array when nothing changed so an unstable `boardRows`
    // identity can never feed back into a render loop
    setDisplayedIds((cur) => (cur.length === ids.length && cur.every((x, i) => x === ids[i]) ? cur : ids));
  }, [viewMode, isWide, boardRows]);

  const enqueuePlanned = useCallback(
    async (a: PlannedAction): Promise<boolean> => {
      if (!engine || !projectId) return false;
      try {
        await engine.enqueue(
          buildActionPayload({
            verb: a.verb,
            projectId: requireProjectId(projectId),
            taskId: a.taskId,
            statusFrom: a.statusFrom as TaskStatus,
            actor,
            title: a.title,
            text: a.text,
            patch: a.patch,
          })
        );
        return true;
      } catch {
        return false; // illegal from the state it is in now
      }
    },
    [engine, projectId, actor]
  );

  const runPlan = useCallback(
    async (label: string, plan: ReturnType<typeof planBulk>): Promise<void> => {
      let failed = 0;
      for (const a of plan.actions) if (!(await enqueuePlanned(a))) failed += 1;
      const undoable = plan.actions.filter((a) => a.undo);
      const msg = bulkSummary(label, plan) + (failed > 0 ? ` · ${failed} failed` : "");
      setToast({
        message: msg,
        actionLabel: undoable.length > 0 && failed === 0 ? "Undo" : undefined,
        onAction:
          undoable.length > 0 && failed === 0
            ? () => {
                setToast(null);
                void (async () => {
                  for (const a of undoable) if (a.undo) await enqueuePlanned(a.undo);
                  setToast({ message: `Undid ${undoable.length} change${undoable.length === 1 ? "" : "s"}` });
                })();
              }
            : undefined,
      });
    },
    [enqueuePlanned]
  );

  const bulkInputs = useMemo<BulkRowInput[]>(
    () => selectedRows.map((r) => r as unknown as BulkRowInput),
    [selectedRows]
  );

  function applyBulk(op: BulkOp): void {
    const plan = planBulk(bulkInputs, op);
    const label = op.kind === "status" ? "Updated status of" : "Updated";
    void runPlan(label, plan);
    if (op.kind === "status") setSelected(new Set());
  }

  function askBulkDiscontinue(): void {
    const plan = planBulk(bulkInputs, { kind: "status", verb: "discontinue" });
    if (plan.actions.length === 0) {
      setToast({ message: "None of the selected tasks can be discontinued" });
      return;
    }
    setConfirm({
      title: `Discontinue ${plan.actions.length} task${plan.actions.length === 1 ? "" : "s"}?`,
      body: "Discontinued tasks are closed for good and cannot be reopened. This can’t be undone.",
      confirmLabel: "Discontinue",
      run: () => {
        void runPlan("Discontinued", plan);
        setSelected(new Set());
      },
    });
  }

  function moveOnBoard(t: TaskView, column: string): void {
    const plan = planBoardMove(t.status, column);
    if (!plan) {
      setToast({ message: `${t.title}: that move isn’t allowed from ${STATUS_LABELS[t.status] ?? "this status"}` });
      return;
    }
    const act: PlannedAction = {
      taskId: t.id,
      title: t.title,
      verb: plan.verb,
      statusFrom: t.status,
      text: "",
      undo: null,
    };
    const go = () => {
      void enqueuePlanned(act).then((ok) => {
        setToast({ message: ok ? `${t.title}: ${MOVE_WORDS[plan.verb] ?? plan.verb}` : "Move failed" });
      });
    };
    if (plan.destructive) {
      setConfirm({
        title: plan.verb === "approve" ? "Approve this task?" : "Discontinue this task?",
        body: `“${t.title}” will be closed and cannot be reopened.`,
        confirmLabel: plan.verb === "approve" ? "Approve" : "Discontinue",
        run: go,
      });
    } else go();
  }

  const overlayOpen = !!(compose || detailTaskId || outboxOpen || shortcutsOpen || confirm);
  const onShortcut = (action: ShortcutAction, e: KeyboardEvent): void => {
    // J/K read the focused row from a ref that is updated synchronously,
    // so key-repeat faster than a React commit never loses a step.
    const step = (dir: 1 | -1) => {
      if (displayedIds.length === 0) return;
      const cur = activeIdRef.current;
      const i = cur ? displayedIds.indexOf(cur) : -1;
      const next = i < 0 ? (dir === 1 ? 0 : displayedIds.length - 1) : Math.min(displayedIds.length - 1, Math.max(0, i + dir));
      const id = displayedIds[next] ?? null;
      activeIdRef.current = id;
      setActiveId(id);
    };
    switch (action) {
      case "new":
        if (!engine) return;
        e.preventDefault();
        void ensureMembers();
        setDetailTaskId(null);
        setCompose({ taskId: crypto.randomUUID() });
        return;
      case "search": {
        e.preventDefault();
        const el = document.querySelector<HTMLInputElement>("input.ff-task-search");
        el?.focus();
        el?.select();
        return;
      }
      case "next":
        e.preventDefault();
        step(1);
        return;
      case "prev":
        e.preventDefault();
        step(-1);
        return;
      case "open":
        if (!activeId) return;
        e.preventDefault();
        setDetailEdit(false);
        setCompose(null);
        setDetailTaskId(activeId);
        return;
      case "edit":
        if (!activeId) return;
        e.preventDefault();
        setDetailEdit(true);
        setCompose(null);
        setDetailTaskId(activeId);
        return;
      case "toggle-select":
        if (!activeId || viewMode !== "table") return;
        e.preventDefault();
        setSelected((cur) => {
          const next = new Set(cur);
          if (next.has(activeId)) next.delete(activeId);
          else next.add(activeId);
          return next;
        });
        return;
      case "escape":
        if (selected.size > 0) setSelected(new Set());
        else if (activeId) setActiveId(null);
        return;
      case "help":
        e.preventDefault();
        setShortcutsOpen(true);
        return;
    }
  };
  useTaskShortcuts(onShortcut, { blocked: overlayOpen });

  // ── export of the current filtered view ──
  const exportRows = boardRows;
  function filterNote(): string {
    const bits: string[] = [];
    bits.push(`Status: ${chip === "all" ? "All" : chip === "open" ? "Open" : chip === "closed" ? "Closed" : (STATUS_LABELS[chip] ?? chip)}`);
    if (search.trim()) bits.push(`Search: “${search.trim()}”`);
    if (quick.mine) bits.push("My tasks");
    if (quick.overdue) bits.push("Overdue");
    if (scope === "building" && buildingName) bits.push(`Building: ${buildingName}`);
    if (activeFilterCount > 0) bits.push(`${activeFilterCount} column filter${activeFilterCount === 1 ? "" : "s"}`);
    return bits.join(" · ");
  }
  function exportCsv(): void {
    downloadText(exportFileName("tasks", "csv"), buildCsv(exportRows, Date.now()));
    setToast({ message: `Exported ${exportRows.length} task${exportRows.length === 1 ? "" : "s"} to CSV` });
  }
  const [bcfBusy, setBcfBusy] = useState(false);
  async function exportBcfFile(version: "2.1" | "3.0"): Promise<void> {
    if (bcfBusy || !projectId) return;
    const scoped = selectBcfScope(selectedRows, exportRows);
    if (scoped.rows.length === 0) return;
    setBcfBusy(true);
    try {
      const total = scoped.rows.length;
      setToast({ message: bcfProgressMessage(0, total) });
      const resolve = photoResolver;
      const fetchBinary = async (path: string, opts: { mime?: string; measure?: boolean }) => {
        if (!resolve) return null;
        const url = await resolve(path);
        return url ? fetchBinaryFromUrl(url, opts) : null;
      };
      let sheetNames: ReadonlyMap<string, { name: string }> | null = null;
      try {
        sheetNames = (await loadSheetCatalog(projectId)).files;
      } catch {
        sheetNames = null;
      }
      const built = await buildBcfBundles(scoped.rows, {
        projectId,
        source,
        fetchBinary,
        sheetName: (id) => sheetNames?.get(id)?.name,
        context: bcfContext,
        onProgress: (d, n) => setToast({ message: bcfProgressMessage(d, n) }),
      });
      const people = [
        ...(db ? await loadMemberEmails(db, projectId) : []),
        ...(members ?? []).map((m) => ({ uid: m.uid, name: m.name })),
        { uid: actor.uid, name: actor.name },
      ];
      const result = await (bcfExporter ?? defaultExportBcf)(built.bundles, {
        version,
        project: { id: projectId, name: projectName },
        users: buildBcfUserDirectory(people),
        baseShift: (taskId) => built.shifts.get(taskId) ?? null,
        taskUrl: bcfContext?.taskUrl,
        convertToPng,
      });
      downloadBlob(result.filename, result.blob);
      if (result.warnings.length > 0) console.info("[bcf-export] warnings", result.warnings);
      setToast({
        message: bcfDoneMessage(result.topicCount, version, result.warnings, { skipped: built.skippedPhotos, budgetSkipped: built.budgetSkippedPhotos }) + (scoped.capped ? ` · ${bcfCapMessage(scoped.total, BCF_MAX_TOPICS)}` : ""),
      });
    } catch (e) {
      console.error("[bcf-export] failed", e);
      setToast({ message: "BCF export failed" });
    } finally {
      setBcfBusy(false);
    }
  }
  async function exportPdf(): Promise<void> {
    const picked = exportRows.slice(0, REPORT_MAX_TASKS);
    setToast({ message: `Preparing report for ${picked.length} task${picked.length === 1 ? "" : "s"}…` });
    const resolve = photoResolver;
    const urlFor = async (path: string | null | undefined): Promise<string | null> => {
      if (!path || !resolve) return null;
      try {
        return await resolve(path);
      } catch {
        return null;
      }
    };
    const items: ReportTask[] = [];
    for (let i = 0; i < picked.length; i += 20) {
      const chunk = picked.slice(i, i + 20);
      items.push(
        ...(await Promise.all(
          chunk.map(async (row) => {
            const photoUrls = (
              await Promise.all((row.photos ?? []).slice(0, REPORT_MAX_PHOTOS).map((p) => urlFor(p.storagePath)))
            ).filter((u): u is string => !!u);
            const dual = isDualThumbLocation(row.location);
            return {
              row,
              photoUrls,
              locationThumbUrl: await urlFor(row.locationThumbPath),
              locationThumb2dUrl: dual ? await urlFor(normalizeLocationThumb2dPath(row.location)) : null,
            };
          })
        ))
      );
    }
    openPrintView(
      buildTasksReportHtml(items, {
        projectName,
        filterNote: filterNote(),
        printedBy: actor.name,
        now: Date.now(),
        totalInView: exportRows.length,
      })
    );
    setToast(null);
  }

  return (
    <section className="ff-tasks-app" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <TaskToolbar
        chip={chip}
        onChipChange={(c) => {
          setChip(c);
          if (activeViewId) applyView(null);
        }}
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
        queued={queued}
        onOpenOutbox={() => setOutboxOpen(true)}
        canCreate={!!engine}
        onCreate={() => {
          void ensureMembers();
          setDetailTaskId(null);
          setCompose({ taskId: crypto.randomUUID() });
        }}
        singleRow={toolbarSingleRow}
        showColumnTools={isWide && (scoped.length > 0 || activeFilterCount > 0)}
        showColumnsButton={viewMode === "table"}
        activeFilterCount={activeFilterCount}
        onClearFilters={() => setColumnFilters({})}
        columnsOpen={columnsOpen}
        onToggleColumns={() => setColumnsOpen((o) => !o)}
        columnsPicker={(anchor) => (
          <TaskColumnPicker
            anchor={anchor}
            visible={columnsVisible}
            onCommit={(next) => {
              setColumnsVisible(next);
              saveVisibleColumns(next);
              setColumnsOpen(false);
            }}
            onCancel={() => setColumnsOpen(false)}
            isWide
          />
        )}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        scope={scope}
        onScopeChange={changeScope}
        buildingName={buildingName}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        savedViews={SAVED_VIEWS}
        activeViewId={activeViewId}
        onSelectView={applyView}
        chipCounts={counts}
        quick={quick}
        onQuickChange={setQuick}
        quickCounts={quickCounts}
        onExportCsv={exportCsv}
        onExportPdf={() => void exportPdf()}
        exportCount={exportRows.length}
        onExportBcf={(v) => void exportBcfFile(v)}
        bcfExporting={bcfBusy}
        bcfScope={{ count: selectedRows.length > 0 ? selectedRows.length : exportRows.length, fromSelection: selectedRows.length > 0 }}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      {draft && engine && (
        <div role="status" className="ff-task-draft-banner" style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "#fff8e1", borderBottom: "1px solid #e6c94c" }}>
          <span style={{ fontSize: 13 }}>Unsent draft: “{draft.fields.title || "untitled"}”</span>
          <button
            type="button"
            onClick={() => {
              setDetailTaskId(null);
              const restoring = draft;
              setDraft(null);
              void restoreDraftCompose(restoring.fields).then((initial) =>
                setCompose({ taskId: restoring.id, initial }),
              );
            }}
            style={{ border: "1px solid #b8860b", background: "#fff", borderRadius: 6, padding: "2px 10px", cursor: "pointer" }}
          >
            Restore
          </button>
          <button
            type="button"
            onClick={() => {
              void clearDraft(draftTable, draft.id).then(() => setDraft(null));
            }}
            style={{ border: "none", background: "none", cursor: "pointer" }}
          >
            Discard
          </button>
        </div>
      )}
      {isWide ? (
        /* V1 — the module floats as a rounded card over `--canvas`,
           the Models NavPanel/PropertiesDrawer language. Board hidden on
           phone (spec §5) — phone keeps the useIsWide card branch. */
        <div className="ff-tasks-canvas" style={canvasAreaStyle}>
          <div className="ff-tasks-card" style={{ ...cardWrapperStyle, position: "relative" }}>
            {viewMode === "board" ? (
              <TaskBoardPanel
                rows={boardRows}
                now={Date.now()}
                groupBy={groupBy}
                activeId={activeId}
                resolvePhotoUrl={photoResolver}
                onMove={moveOnBoard}
                hasMoreRemote={hasMoreRemote}
                onLoadMore={loadMoreRemote}
                onOpen={(t) => {
                  onOpenTask?.(t);
                  setCompose(null);
                  setDetailTaskId(t.id);
                }}
                emptyLabel={
                  cloud.length === 0 && rows.length === 0
                    ? "No tasks yet — use “+ New task” to compose one."
                    : "No tasks match this filter."
                }
              />
            ) : (
              <TaskTablePanel
                rows={tableRows}
                now={Date.now()}
                resolvePhotoUrl={photoResolver}
                hostToolbar={isWide}
                columnsVisibility={columnsVisible}
                columnFilters={columnFilters}
                onColumnFiltersChange={setColumnFilters}
                groupBy={groupBy}
                selection={{ selected, onChange: (next) => setSelected(next) }}
                activeId={activeId}
                onDisplayedIdsChange={(ids) => setDisplayedIds((cur) => (cur.length === ids.length && cur.every((x, i) => x === ids[i]) ? cur : ids))}
                hasMoreRemote={hasMoreRemote}
                onLoadMore={loadMoreRemote}
                onLocate={onOpenTask ? (t) => onOpenTask(t) : undefined}
                onQuickAdvance={(t, verb) => {
                  if (!engine || !projectId) return; // no project: no write
                  try {
                    void engine.enqueue(
                      buildActionPayload({
                        verb,
                        projectId,
                        taskId: t.id,
                        statusFrom: t.status as TaskStatus,
                        actor,
                        title: t.title,
                      })
                    );
                  } catch {
                    /* illegal from this state — the button already hid */
                  }
                }}
                onOpen={(t) => {
                  onOpenTask?.(t);
                  setCompose(null);
                  setDetailTaskId(t.id);
                }}
                onRetry={(t) => {
                  const r = failedRowFor(t.id);
                  if (r && engine) void engine.retryNow(r.id);
                }}
                emptyLabel={
                  cloud.length === 0 && rows.length === 0
                    ? "No tasks yet — use “+ New task” to compose one."
                    : "No tasks match this filter."
                }
              />
            )}
            {selectedRows.length > 0 && viewMode === "table" && (
              <TaskBulkBar
                rows={bulkInputs}
                people={members ?? []}
                extendedFields={caps.extendedFields}
                onApply={applyBulk}
                onDiscontinue={askBulkDiscontinue}
                onClear={() => setSelected(new Set())}
              />
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <TasksListPanel
            rows={tableRows.slice(0, cardLimit)}
            now={Date.now()}
            resolvePhotoUrl={photoResolver}
            onOpen={(t) => {
              onOpenTask?.(t);
              setCompose(null);
              setDetailTaskId(t.id);
            }}
            onRetry={(t) => {
              const r = failedRowFor(t.id);
              if (r && engine) void engine.retryNow(r.id);
            }}
            emptyLabel={
              cloud.length === 0 && rows.length === 0
                ? "No tasks yet — use “+ New task” to compose one."
                : "No tasks match this filter."
            }
          />
          {(tableRows.length > cardLimit || hasMoreRemote) && (
            <div style={{ display: "flex", justifyContent: "center", padding: "12px 16px 20px" }}>
              <button
                type="button"
                data-testid="cards-load-more"
                onClick={() => (tableRows.length > cardLimit ? setCardLimit((n) => n + 60) : loadMoreRemote())}
                style={{ border: "1px solid #d6dbe1", background: "#fff", borderRadius: 12, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#2a5bb8" }}
              >
                Load more ({Math.min(cardLimit, tableRows.length)} of {tableRows.length}
                {hasMoreRemote ? "+" : ""})
              </button>
            </div>
          )}
        </div>
      )}
      {compose && engine && projectId && (
        <TaskComposeSheet
          projectId={requireProjectId(projectId)}
          taskId={compose.taskId}
          actor={actor}
          members={members ?? []}
          engine={engine}
          draftTable={draftTable}
          initial={compose.initial}
          projectName={projectName}
          buildingId={buildingId}
          buildings={buildings}
          onDone={() => setCompose(null)}
          onClose={() => setCompose(null)}
        />
      )}
      {detailTaskId && (
        <TaskDetailHost
          taskId={detailTaskId}
          projectName={projectName}
          buildings={buildings}
          resolvePhotoUrl={photoResolver}
          startEditing={detailEdit}
          onClose={() => {
            setDetailTaskId(null);
            setDetailEdit(false);
          }}
        />
      )}
      {toast && (
        <TaskToast
          message={toast.message}
          actionLabel={toast.actionLabel}
          lift={selectedRows.length > 0 && viewMode === "table"}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}
      {confirm && (
        <TaskConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
        />
      )}
      {shortcutsOpen && <TaskShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
      {outboxOpen && (
        <TaskOutboxSheet
          rows={rows}
          onRetry={(id) => {
            if (engine) void engine.retryNow(id);
          }}
          onDelete={(id) => {
            if (engine) void engine.remove(id);
          }}
          onClose={() => setOutboxOpen(false)}
        />
      )}
    </section>
  );
}