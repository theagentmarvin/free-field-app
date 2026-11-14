// apps/models/src/components/PropertiesDrawer.tsx
//
// Task 19 — Properties Drawer for the Models module. Subscribes
// to the viewer handle's `setOnElementPick` callback and renders
// a side panel with the picked element's metadata.
//
// Current MVP scope (per Task 19 §"Properties Drawer wiring"):
//   - On `ElementPickEvent { modelId, expressId, point }`, populate
//     `selectedElement` state and render a panel showing:
//       * Model id + express id
//       * IFC class (resolved via the `_IfcClass` pset in the
//         property catalog for the picked model)
//       * World-space point (x, y, z) — the pick ray's hit
//       * The property catalog schema for that model (which
//         psets exist and which properties each one carries) so
//         the user can see what's available.
//
// The drawer is intentionally schema-aware today: per-element
// VALUES aren't indexed yet (see Task 20C-Part 1 §"Open
// questions" for the future value-extraction work). When that
// lands, this component swaps the schema list for a real
// `Pset.X = Value` table.
//
// The drawer is rendered as a fixed-position side panel anchored
// to the right edge of the Models viewport. It has a close (×)
// button that clears the selection. Empty when no element is
// picked.
//
// Lifecycle: subscribes in a useEffect on mount, unsubscribes
// (by passing `null`) on unmount. React 18 strict-mode safe —
// the subscription installs/cleans symmetrically, so the strict
// double-mount doesn't double-subscribe.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import { useLiveQuery } from "dexie-react-hooks";

import type { IfcViewerHandle } from "@ff/viewer-react";
import { groupElementProperties } from "./groupElementProperties";

import { useViewerToolsDataSource } from "../dataSource";

import { usePropertyCatalog } from "../hooks/usePropertyCatalog";
import { useModelsToolStore, type SelectedElement } from "../modelsToolStore";

/**
 * Re-export of the store's SelectedElement so existing imports
 * (`import type { SelectedElement } from "../components/PropertiesDrawer"`)
 * keep working. The shape is now `{ modelId, expressId }` only —
 * the world-space `point` was dropped because the visual
 * highlight takes over (no UI element needs the pick point). If
 * a future feature needs the pick location, add it back as an
 * optional field.
 */
export type { SelectedElement } from "../modelsToolStore";

export interface PropertiesDrawerProps {
  /** Imperative handle to the <IfcViewer>. */
  viewerRef: RefObject<IfcViewerHandle>;
  /**
   * Wave 35 (toolbar-nav redesign) — the surface this component
   * renders into:
   *
   *  - `"drawer"` (default): the legacy fixed side panel (Linkview's
   *    right-hand sidebar).
   *  - `"body"`: the body of the ONE floating nav panel in the Models
   *    module. In this mode the component renders NOTHING when there
   *    is no selection — but it STAYS MOUNTED. That is deliberate:
   *    the `setOnElementPick` subscription is installed on mount and
   *    must survive every tenant swap of the panel, otherwise a pick
   *    that lands while another panel is open would be missed.
   */
  variant?: "drawer" | "body";
}

/**
 * Side panel that renders the picked element's metadata.
 *
 * The drawer is always mounted (even with no selection) so the
 * subscription to `setOnElementPick` is stable across the
 * Models session — the alternative (mount on first pick) would
 * miss clicks if the user picks an element while the drawer
 * isn't mounted yet, and we don't want to force a remount on
 * every pick.
 */
export default function PropertiesDrawer({
  viewerRef,
  variant = "drawer",
}: PropertiesDrawerProps): JSX.Element | null {
  const selected = useModelsToolStore((s) => s.selection);

  // The expanded/collapsed state is fully user-controlled.
  // It persists across element picks.
  const [expanded, setExpanded] = useState(false);

  // Resizable drawer height. null = auto (content-based, max 50%).
  // When set, overrides with a fixed pixel height.
  const [drawerHeight, setDrawerHeight] = useState<number | null>(null);

  // Per-element property values. Cleared on selection change so
  // the body shows a loading indicator at a stable height — avoids
  // the "old element data at old height → new data at new height"
  // resize glitch between element picks.
  const [elementData, setElementData] = useState<
    Record<string, string> | null
  >(null);
  const [dataLoading, setDataLoading] = useState(false);
  // Which element `elementData` belongs to — a render between a new
  // pick and the effect clearing/refetching must not label the NEW id
  // with the PREVIOUS element's class.
  const [dataKey, setDataKey] = useState<string | null>(null);
  useEffect(() => {
    if (selected === null) {
      setElementData(null);
      setDataLoading(false);
      return;
    }
    let cancelled = false;
    setDataLoading(true);
    const handle = viewerRef.current;
    if (!handle) {
      setElementData(null);
      setDataLoading(false);
      return;
    }
    handle
      .getElementData(selected.modelId, selected.expressId)
      .then((data) => {
        if (cancelled) return;
        setElementData(data);
        setDataKey(`${selected.modelId}:${selected.expressId}`);
        setDataLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setElementData(null);
        setDataKey(`${selected.modelId}:${selected.expressId}`);
        setDataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.modelId, selected?.expressId, viewerRef]);

  // Parse the flat ItemData into pset → property → value struct.
  const dataFresh =
    selected !== null &&
    dataKey === `${selected.modelId}:${selected.expressId}`;
  const parsedData = useMemo(
    () => groupElementProperties(dataFresh ? elementData : null),
    [elementData, dataFresh],
  );

  // Subscribe to picks on mount; unsubscribe on unmount. The
  // pick callback writes to the store (the source of truth) and
  // the viewer Highlighter follows via the sync hook. There is
  // no local copy of `selected` in this component — every render
  // reads from the store.
  useEffect(() => {
    // Polling subscription: the IfcViewer handle may not be
    // available yet when this effect first runs (StrictMode
    // mount/unmount/remount, or normal render-order races
    // where PropertiesDrawer mounts before IfcViewer's
    // useImperativeHandle fires). We poll via
    // requestAnimationFrame until the handle appears, then
    // install the pick subscription. Cleared on unmount.
    //
    // Task 21 update: the pick callback may receive `null`
    // (when the Highlighter clears on empty-space click). We
    // forward that to the store's clearSelection action so
    // the drawer state stays in sync with the visual highlight.
    let cancelled = false;
    let installedHandle: IfcViewerHandle | null = null;
    let rafHandle: number | null = null;
    function trySubscribe(): void {
      if (cancelled) return;
      const handle = viewerRef.current;
      if (!handle) {
        rafHandle = requestAnimationFrame(trySubscribe);
        return;
      }
      installedHandle = handle;
      const store = useModelsToolStore.getState();
      handle.setOnElementPick((e) => {
        // Empty-space click → clear selection. The drawer now
        // shows "No element selected" instead of disappearing,
        // so there's no visual flinch between picks.
        if (e === null) {
          store.clearSelection();
          // Wave 35: an empty-canvas click ALSO closes the floating
          // nav panel (the panel and the selection share one slot).
          store.setActiveNavPanel(null);
        } else {
          store.selectElement({
            modelId: e.modelId,
            expressId: e.expressId,
          });
        }
      });
    }
    trySubscribe();
    return () => {
      cancelled = true;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      if (installedHandle) {
        installedHandle.setOnElementPick(null);
      }
    };
  }, [viewerRef]);

  // × button: clears the store. `useViewerSelectionSync`
  // observes the store change and calls `viewer.clearSelection()`,
  // which dispatches to the Highlighter. The drawer's local
  // `selected` selector sees `null` and renders the empty state.
  const onClose = useCallback(() => {
    useModelsToolStore.getState().clearSelection();
  }, []);

  // Resolve the picked model's display name via the injected data
  // source. The adapter reads `db.ifcFiles.get(modelId)` inside the
  // querier, so Dexie's global observation keeps this live. Returns
  // null when the model id is unknown (name falls back to the id).
  const ds = useViewerToolsDataSource();
  const fileName = useLiveQuery(
    async () => {
      if (!selected) return null;
      return ds.queryFileName(selected.modelId);
    },
    [selected?.modelId, ds],
    null,
  );

  // Resolve the property catalog for the picked file. When the
  // user picks an element, we read the catalog schema and
  // surface the available psets — the same source the
  // CustomFilterBuilder's property autocomplete consumes. The
  // catalog is keyed by the logical file id, which equals
  // `selected.modelId` when the file is known (fileName != null).
  const catalog = usePropertyCatalog(
    selected && fileName !== null ? selected.modelId : null,
  );

  // The picked element's OWN class comes from its item data
  // (`flattenItemData` mirrors the entity category into `_IfcClass`,
  // e.g. "IFCWALL"). The property catalog only knows the file-level
  // SCHEMA (every class present in the file, sorted — so its first
  // entry is always "IfcBuilding"), which is NOT the element's class;
  // it is used only as a fallback when no element data is available,
  // and to restore the mixed-case spelling ("IfcWall") of the class.
  const ifcClassNames = useMemo(() => {
    const catalogList = [...(catalog.byPset.get("_IfcClass") ?? [])].sort();
    const fresh = dataFresh;
    const raw = fresh
      ? (elementData?._IfcClass ?? elementData?._category)
      : undefined;
    if (raw) {
      const cased = catalogList.find(
        (c) => c.toUpperCase() === raw.toUpperCase(),
      );
      return [cased ?? raw];
    }
    // Element data still loading: no class yet (avoid flashing the
    // file-level list as if it were the element's class).
    if (dataLoading || !fresh) return selected === null ? catalogList : [];
    return catalogList;
  }, [catalog.byPset, elementData, dataLoading, dataFresh, selected]);

  // ── Resize drag ────────────────────────────────────────────
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const h = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().height ?? 200;
    resizeRef.current = { startY: e.clientY, startH: h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const dy = resizeRef.current.startY - e.clientY;
    setDrawerHeight(Math.max(40, Math.min(800, resizeRef.current.startH + dy)));
  }, []);
  const onResizeUp = useCallback(() => { resizeRef.current = null; }, []);

  const drawerFinalStyle = useMemo<CSSProperties>(() => {
    const s = { ...drawerStyle };
    if (drawerHeight !== null) { s.height = drawerHeight; s.maxHeight = "none"; }
    return s;
  }, [drawerHeight]);

  // ── Wave 35: the panel-BODY variant ──────────────────────────
  // The component STAYS MOUNTED (the pick subscription above is
  // installed once, on mount) — it only renders nothing while there
  // is no selection. The nav panel hides it in that case anyway.
  if (variant === "body") {
    if (selected === null) return null;
    return (
      <div
        style={bodyVariantStyle}
        data-testid="properties-body"
        data-has-selection="true"
        aria-label="Properties"
      >
        <PropertiesMetaRow
          selected={selected}
          fileName={fileName ?? selected.modelId}
          ifcClassNames={ifcClassNames}
        />
        <PropertiesBodyContent
          selected={selected}
          fileName={fileName ?? selected.modelId}
          ifcClassNames={ifcClassNames}
          parsedData={parsedData}
          dataLoading={dataLoading}
          psetCount={parsedData.size}
        />
      </div>
    );
  }

  return (
    <aside
      style={drawerFinalStyle}
      aria-label="Properties drawer"
      data-testid="properties-drawer"
      data-has-selection={selected !== null ? "true" : "false"}
    >
      <div
        role="separator"
        aria-label="Resize properties panel"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        style={{ height: 5, flexShrink: 0, cursor: "row-resize", touchAction: "none", borderTop: "1px solid var(--ff-divider)" }}
      />
      {selected === null ? (
        <NoSelectionBar />
      ) : expanded ? (
        <ElementView
          selected={selected}
          fileName={fileName ?? selected.modelId}
          ifcClassNames={ifcClassNames}
          parsedData={parsedData}
          dataLoading={dataLoading}
          psetCount={parsedData.size}
          onClose={onClose}
          onCollapse={() => setExpanded(false)}
        />
      ) : (
        <CollapsedHeader
          selected={selected}
          fileName={fileName ?? selected.modelId}
          ifcClassNames={ifcClassNames}
          psetCount={parsedData.size || catalog.byPset.size}
          onExpand={() => setExpanded(true)}
          onClose={onClose}
        />
      )}
    </aside>
  );
}

// -----------------------------------------------------------------------------
// No-selection bar — shown when no element is selected
// -----------------------------------------------------------------------------

function NoSelectionBar(): JSX.Element {
  return (
    <div
      style={{
        padding: "6px 10px",
        borderBottom: "1px solid var(--ff-divider)",
        fontSize: 11,
        color: "var(--ff-text-muted)",
        fontStyle: "italic",
      }}
    >
      No element selected
    </div>
  );
}

// -----------------------------------------------------------------------------
// Collapsed header
// -----------------------------------------------------------------------------

interface CollapsedHeaderProps {
  selected: SelectedElement;
  fileName: string;
  ifcClassNames: string[];
  psetCount: number;
  onExpand: () => void;
  onClose: () => void;
}

function CollapsedHeader({
  selected,
  fileName,
  ifcClassNames,
  psetCount,
  onExpand,
  onClose,
}: CollapsedHeaderProps): JSX.Element {
  const label =
    ifcClassNames.length > 0
      ? `${ifcClassNames[0]} (#${selected.expressId})`
      : `${fileName} #${selected.expressId}`;

  const barStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    cursor: "pointer",
    background: "var(--ff-bg-panel)",
    borderBottom: "1px solid var(--ff-divider)",
    userSelect: "none",
  };

  return (
    <>
      <div
        style={barStyle}
        onClick={onExpand}
        aria-label="Expand properties"
        data-testid="properties-collapsed-header"
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12 }}>🏷️</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ff-text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={label}
          >
            {label}
          </span>
          <span style={{ fontSize: 10, color: "var(--ff-text-muted)", flexShrink: 0, marginLeft: 8 }}>
            {psetCount} psets
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            aria-label="Expand properties"
            onClick={(ev) => { ev.stopPropagation(); onExpand(); }}
            title="Expand"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 12,
              color: "var(--ff-text-muted)",
              cursor: "pointer",
              padding: "2px 4px",
              borderRadius: 3,
            }}
          >
            ▴
          </button>
          <button
            type="button"
            aria-label="Close selection"
            onClick={(ev) => {
              ev.stopPropagation();
              onClose();
            }}
            title="Clear selection"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 14,
              color: "var(--ff-text-muted)",
              cursor: "pointer",
              padding: "2px 4px",
              borderRadius: 3,
            }}
          >
            ×
          </button>
        </div>
      </div>
    </>
  );
}

// Element view — renders the picked element's metadata (drawer variant).

interface ElementViewProps {
  selected: SelectedElement;
  fileName: string;
  ifcClassNames: string[];
  parsedData: Map<string, Array<[string, string]>>;
  dataLoading: boolean;
  psetCount: number;
  onClose: () => void;
  onCollapse: () => void;
}

function ElementView({
  selected,
  fileName,
  ifcClassNames,
  parsedData,
  dataLoading,
  psetCount,
  onClose,
  onCollapse,
}: ElementViewProps): JSX.Element {
  const headerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    borderBottom: "1px solid var(--ff-divider)",
  };

  const headerRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
  };

  const titleStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--ff-text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  };

  return (
    <>
      <header style={headerStyle}>
        <div style={headerRowStyle}>
          <span
            style={titleStyle}
            title={
              ifcClassNames.length > 0
                ? `${ifcClassNames[0]} #${selected.expressId}`
                : `${fileName} #${selected.expressId}`
            }
          >
            {ifcClassNames.length > 0
              ? `${ifcClassNames[0]} (#${selected.expressId})`
              : `${fileName} #${selected.expressId}`}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <button
              type="button"
              aria-label="Collapse properties"
              onClick={onCollapse}
              title="Collapse"
              style={{
                background: "transparent",
                border: "none",
                fontSize: 14,
                color: "var(--ff-text-muted)",
                cursor: "pointer",
                padding: "2px 4px",
                borderRadius: 3,
              }}
            >
              ▾
            </button>
            <button
              type="button"
              aria-label="Close properties drawer"
              onClick={onClose}
              style={{
                background: "transparent",
                border: "none",
                fontSize: 18,
                color: "var(--ff-text-muted)",
                cursor: "pointer",
                padding: "2px 6px",
                borderRadius: 4,
              }}
              data-testid="properties-drawer-close"
            >
              ×
            </button>
          </div>
        </div>
      </header>
      <PropertiesBodyContent
        selected={selected}
        fileName={fileName}
        ifcClassNames={ifcClassNames}
        parsedData={parsedData}
        dataLoading={dataLoading}
        psetCount={psetCount}
        scroll
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// Wave 35 — the panel-BODY flavour of the properties content.
//
// The nav panel owns the scroll surface, so this variant renders the
// content WITHOUT its own overflow (the panel body scrolls). The
// drawer variant keeps its own scroll area.
// -----------------------------------------------------------------------------

interface PropertiesMetaRowProps {
  selected: SelectedElement;
  fileName: string;
  ifcClassNames: string[];
}

/** The element name + the model file it came from. */
function PropertiesMetaRow({
  selected,
  fileName,
  ifcClassNames,
}: PropertiesMetaRowProps): JSX.Element {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 10px 2px",
  };

  const nameStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--ff-text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  };

  const fileStyle: CSSProperties = {
    marginLeft: "auto",
    fontSize: 11,
    color: "var(--ff-text-muted)",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "45%",
  };

  const label =
    ifcClassNames.length > 0
      ? `${ifcClassNames[0]} (#${selected.expressId})`
      : `${fileName} #${selected.expressId}`;

  return (
    <div style={rowStyle} data-testid="properties-meta">
      <span style={nameStyle} title={label}>
        {label}
      </span>
      <span style={fileStyle} title={fileName}>
        {fileName}
      </span>
    </div>
  );
}

interface PropertiesBodyContentProps {
  selected: SelectedElement;
  fileName: string;
  ifcClassNames: string[];
  parsedData: Map<string, Array<[string, string]>>;
  dataLoading: boolean;
  psetCount: number;
  /** Drawer variant: own scroll area. Panel variant: the panel scrolls. */
  scroll?: boolean;
}

/** Search field + the property sections — shared by both variants. */
function PropertiesBodyContent({
  selected,
  fileName,
  ifcClassNames,
  parsedData,
  dataLoading,
  psetCount,
  scroll = false,
}: PropertiesBodyContentProps): JSX.Element {
  const [search, setSearch] = useState("");
  const searchLower = search.toLowerCase().trim();
  const psets = Array.from(parsedData.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const filteredPsets =
    searchLower.length === 0
      ? psets
      : psets
          .map(
            ([pset, props]) =>
              [
                pset,
                pset.toLowerCase().includes(searchLower)
                  ? props
                  : props.filter(([p]) =>
                      p.toLowerCase().includes(searchLower),
                    ),
              ] as [string, Array<[string, string]>],
          )
          .filter(([, props]) => props.length > 0);

  const bodyStyle: CSSProperties = scroll
    ? {
        flex: 1,
        overflowY: "auto",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }
    : {
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "2px 10px 12px",
      };

  return (
    <>
      <div style={{ padding: scroll ? "0 10px 6px" : "8px 10px 0" }}>
        <input
          type="text"
          placeholder="Search properties…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "4px 8px",
            fontSize: 11,
            border: "1px solid var(--ff-border)",
            borderRadius: 4,
            background: "var(--ff-bg-input)",
            color: "var(--ff-text-primary)",
            outline: "none",
          }}
          data-testid="properties-search"
        />
      </div>
      <div
        style={bodyStyle}
        data-testid="properties-drawer-body"
        data-model-id={selected.modelId}
        data-express-id={String(selected.expressId)}
      >
        <Section label="Model">
          <KeyValue label="File" value={fileName} />
          <KeyValue label="File id" value={selected.modelId} mono />
          <KeyValue
            label="Express id"
            value={String(selected.expressId)}
            mono
          />
        </Section>
        <Section label="IFC class">
          {dataLoading ? (
            <Hint>Loading element data…</Hint>
          ) : ifcClassNames.length === 0 ? (
            <Hint>No IFC class information available.</Hint>
          ) : (
            <ul style={listStyle} data-testid="properties-drawer-classes">
              {ifcClassNames.map((c) => (
                <li key={c} style={listItemStyle}>
                  {c}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section label={`Property catalog — ${psetCount} psets`}>
          {dataLoading ? (
            <Hint>Loading element data…</Hint>
          ) : filteredPsets.length === 0 ? (
            <Hint>
              {search
                ? "No properties matching your search."
                : "No property values available for this element."}
            </Hint>
          ) : (
            <div data-testid="properties-drawer-psets">
              {filteredPsets.map(([pset, props]) => (
                <PsetBlock
                  key={pset}
                  pset={pset}
                  props={props}
                />
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

interface SectionProps {
  label: string;
  children: ReactNode;
}

function Section({ label, children }: SectionProps): JSX.Element {
  const labelStyle: CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    color: "var(--ff-text-muted)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    marginBottom: 6,
  };
  return (
    <section>
      <div style={labelStyle}>{label}</div>
      {children}
    </section>
  );
}

interface KeyValueProps {
  label: string;
  value: string;
  mono?: boolean;
}

function KeyValue({ label, value, mono = false }: KeyValueProps): JSX.Element {
  const rowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    padding: "2px 0",
    fontSize: 12,
    color: "var(--ff-text-primary)",
  };
  const labelStyle: CSSProperties = {
    color: "var(--ff-text-muted)",
    flexShrink: 0,
  };
  const valueStyle: CSSProperties = mono
    ? {
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
        textAlign: "right",
        wordBreak: "break-all",
      }
    : { textAlign: "right" };
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle} title={value}>
        {value}
      </span>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  const style: CSSProperties = {
    color: "var(--ff-text-muted)",
    fontStyle: "italic",
    fontSize: 11,
    lineHeight: 1.5,
  };
  return <div style={style}>{children}</div>;
}

interface PsetBlockProps {
  pset: string;
  props: Array<[string, string]>;
}

function PsetBlock({ pset, props }: PsetBlockProps): JSX.Element {
  const headerStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--ff-text-primary)",
    marginBottom: 4,
    marginTop: 6,
  };
  const rowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    padding: "1px 0",
    fontSize: 11,
  };
  const propStyle: CSSProperties = {
    color: "var(--ff-text-muted)",
    flexShrink: 0,
    maxWidth: "45%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const valueStyle: CSSProperties = {
    color: "var(--ff-text-primary)",
    textAlign: "right",
    wordBreak: "break-word",
    maxWidth: "55%",
  };
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={headerStyle}>{pset}</div>
      {props.map(([prop, value]) => (
        <div key={prop} style={rowStyle} title={`${prop}: ${value}`}>
          <span style={propStyle}>{prop}</span>
          <span style={valueStyle}>{value}</span>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles (kept inline to avoid a sibling CSS file for a single component).
// -----------------------------------------------------------------------------

const drawerStyle: CSSProperties = {
  width: "100%",
  maxHeight: "50%",
  background: "var(--ff-bg-app)",
  borderTop: "1px solid var(--ff-border)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flexShrink: 0,
  overflow: "hidden",
};

/**
 * Wave 35 — the panel-body flavour of the properties surface. The nav
 * panel owns the chrome (title + ✕) and the scroll area, so the body
 * only lays out its content.
 */
const bodyVariantStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const listItemStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  fontSize: 11,
  color: "var(--ff-text-secondary)",
  padding: "1px 0",
};
