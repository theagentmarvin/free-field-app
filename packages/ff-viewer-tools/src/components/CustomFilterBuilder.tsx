// apps/models/src/components/CustomFilterBuilder.tsx
//
// Modal dialog for building and saving an IFC property filter
// (search-set style). Structural reference is the
// ifc-excel-updater's CustomFilterBuilder; styling is Free Field
// tokens, not Tailwind.
//
// The component is presentational — it derives a `FilterPreset` and
// hands it to `onSubmit`. The caller (FiltersPanel) is responsible
// for actually inserting it into the modelsToolStore and persisting
// to Dexie via `useFilterPresetsForBuilding.save`.
//
// Per the spec (Task 20C-Part 2 + Task 20D):
//   - Property autocomplete sources from `usePropertyCatalog(fileId)`
//   - Single-string value input (no multi-value selector this session)
//   - `in` / `not_in` operators accept comma-separated values
//   - Live match count is STUBBED ("N rules pending evaluation")
//   - Task 20D: filter authoring is now `groups: ConditionGroup[]`.
//     The user can stack rules within one AND group, or click "+ OR
//     group" to add an additional group whose rules join by OR. The
//     preset-level combinator (above the rules block) controls how
//     the groups themselves join.
//   - Task 20D: when `editingPreset` is passed, the modal hydrates
//     from it and the save button label flips to "Update filter".

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { usePropertyCatalog } from "../hooks/usePropertyCatalog";

import type {
  Combinator,
  ConditionGroup,
  FilterOperator,
  FilterPreset,
  FilterRule,
} from "../modelsToolStore";

import styles from "./CustomFilterBuilder.module.css";
import PropertyValueDropdown from "./PropertyValueDropdown";

const OPERATORS: Array<{ value: FilterOperator; label: string }> = [
  { value: "equals",                label: "equals" },
  { value: "not_equals",            label: "not equals" },
  { value: "contains",              label: "contains" },
  { value: "does_not_contain",      label: "does not contain" },
  { value: "in",                    label: "in" },
  { value: "not_in",                label: "not in" },
  { value: "greater_than",          label: "greater than (>)" },
  { value: "less_than",             label: "less than (<)" },
  { value: "greater_than_or_equal", label: "greater than or equal (≥)" },
  { value: "less_than_or_equal",    label: "less than or equal (≤)" },
  { value: "is_empty",              label: "is empty" },
  { value: "is_not_empty",          label: "is not empty" },
];

/**
 * Operators whose `value` field is meaningless — they check property
 * presence only. `CustomFilterBuilder.handleAdd` skips the value-
 * required guard for these so the user can build a rule without
 * filling the value input. The saved `FilterRule.value` is always
 * the empty string for these operators (Task 19's evaluation engine
 * ignores it).
 */
const VALUE_AGNOSTIC: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  "is_empty",
  "is_not_empty",
]);

// ---------------------------------------------------------------------------
// Component API
// ---------------------------------------------------------------------------

export interface CustomFilterBuilderProps {
  /** Whether the modal is open. When false, the component renders null. */
  open: boolean;
  /**
   * File whose property catalog drives the property autocomplete.
   * Pass `null` when no file is selected; the modal will then show
   * the "no properties cataloged" empty state.
   */
  fileId: string | null;
  /**
   * Called with the built preset when the user clicks "Save filter"
   * (create) or "Update filter" (edit). The caller is responsible
   * for `upsertCustomFilter` (create) or `updateCustomFilter`
   * (edit) + `useFilterPresetsForBuilding.save` (Dexie persist).
   */
  onSubmit: (preset: FilterPreset) => void;
  /** Called when the user dismisses the modal (Cancel / Escape / backdrop). */
  onCancel: () => void;
  /**
   * Task 20D — when supplied, the modal opens in EDIT mode:
   *   - `activeGroups` is seeded from `editingPreset.groups`
   *   - `presetCombinator` is seeded from `editingPreset.combinator`
   *   - `presetName` is seeded from `editingPreset.name`
   *   - Header text reads "Edit filter"
   *   - Save button label reads "Update filter"
   *   - The submitted preset's `id` is preserved (`editingPreset.id`)
   *
   * When null/undefined, the modal opens in CREATE mode and the
   * submitted preset gets a fresh uuid.
   */
  editingPreset?: FilterPreset | null;
}

export default function CustomFilterBuilder({
  open,
  fileId,
  onSubmit,
  onCancel,
  editingPreset = null,
}: CustomFilterBuilderProps): JSX.Element | null {
  const { byPset, loading, count } = usePropertyCatalog(fileId);
  const isEditing = editingPreset !== null;

  // ── Local form state ────────────────────────────────────────────────
  // Task 20D: track groups (not flat rules) so the OR-group UI can
  // render and the submit payload matches the new `FilterPreset` shape.
  const [activeGroups, setActiveGroups] = useState<ConditionGroup[]>(() => {
    if (editingPreset && editingPreset.groups.length > 0) {
      return editingPreset.groups.map(cloneGroup);
    }
    return [makeEmptyGroup("AND")];
  });
  const [presetCombinator, setPresetCombinator] = useState<Combinator>(
    editingPreset?.combinator ?? "AND",
  );
  const [selProp, setSelProp] = useState<string>("");
  const [selOp, setSelOp] = useState<FilterOperator>("equals");
  const [selVal, setSelVal] = useState<string>("");
  const [presetName, setPresetName] = useState<string>(
    editingPreset?.name ?? "",
  );
  const [propSearch, setPropSearch] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState<boolean>(false);
  /** Which group receives the next Add Condition. Default: 0 (first group). */
  const [activeGroupIndex, setActiveGroupIndex] = useState<number>(0);

  // Refs for focus management.
  const valueInputRef = useRef<HTMLInputElement>(null);

  // Reset form state when the modal closes (or the fileId changes).
  // When opening, hydrate from editingPreset if supplied.
  useEffect(() => {
    if (!open) {
      setActiveGroups([makeEmptyGroup("AND")]);
      setPresetCombinator("AND");
      setSelProp("");
      setSelOp("equals");
      setSelVal("");
      setPresetName("");
      setPropSearch("");
      setDropdownOpen(false);
      setActiveGroupIndex(0);
      return;
    }
    if (editingPreset) {
      setActiveGroups(editingPreset.groups.map(cloneGroup));
      setPresetCombinator(editingPreset.combinator);
      setPresetName(editingPreset.name);
    } else {
      setActiveGroups([makeEmptyGroup("AND")]);
      setPresetCombinator("AND");
      setPresetName("");
    }
    setSelProp("");
    setSelOp("equals");
    setSelVal("");
    setPropSearch("");
    setDropdownOpen(false);
    setActiveGroupIndex(0);
  }, [open, fileId, editingPreset]);

  // Escape key closes the modal.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  // ── Property autocomplete options ───────────────────────────────────
  const propOptions = useMemo(() => {
    const out: Array<{ pset: string; name: string; qualified: string }> = [];
    for (const [pset, names] of byPset) {
      for (const name of names) {
        out.push({ pset, name, qualified: `${pset}.${name}` });
      }
    }
    // Sort by qualified name for stable order.
    out.sort((a, b) => a.qualified.localeCompare(b.qualified));
    return out;
  }, [byPset]);

  const filteredOptions = useMemo(() => {
    const q = propSearch.trim().toLowerCase();
    if (q === "") return propOptions;
    return propOptions.filter(
      (o) =>
        o.qualified.toLowerCase().includes(q) ||
        o.pset.toLowerCase().includes(q) ||
        o.name.toLowerCase().includes(q),
    );
  }, [propOptions, propSearch]);

  // Group filtered options by pset for the dropdown render.
  const groupedOptions = useMemo(() => {
    const groups = new Map<string, Array<{ name: string; qualified: string }>>();
    for (const o of filteredOptions) {
      const list = groups.get(o.pset) ?? [];
      list.push({ name: o.name, qualified: o.qualified });
      groups.set(o.pset, list);
    }
    return groups;
  }, [filteredOptions]);

  // ── Auto-name derivation ────────────────────────────────────────────
  // Matches the previous flat-rule logic for the single-group case so
  // existing snapshots stay readable; multi-group names use the
  // first rule + "+ N-1 more across M groups" hint.
  const flatRules = useMemo<FilterRule[]>(
    () => activeGroups.flatMap((g) => g.rules),
    [activeGroups],
  );
  const autoName = useMemo<string>(() => {
    if (flatRules.length === 0) return "";
    if (flatRules.length === 1) {
      const r = flatRules[0]!;
      const prop = r.property.split(".").pop() ?? r.property;
      return `${prop} ${r.operator.replaceAll("_", " ")} ${r.value}`;
    }
    if (activeGroups.length === 1) {
      const firstProp =
        flatRules[0]!.property.split(".").pop() ?? flatRules[0]!.property;
      return `${firstProp} + ${flatRules.length - 1} more`;
    }
    const firstProp =
      flatRules[0]!.property.split(".").pop() ?? flatRules[0]!.property;
    return `${firstProp} + ${flatRules.length - 1} more across ${activeGroups.length} groups`;
  }, [flatRules, activeGroups]);

  // ── AND/OR same-property warning ────────────────────────────────────
  // Counts how many times each property appears within EACH group
  // independently. A rule duplicated across two groups is intentional
  // (it's an OR-of-ANDs composition), not a bug; we only warn when
  // the same property is AND-joined twice in the same group.
  const samePropertyRules = useMemo<string[]>(() => {
    const out: string[] = [];
    for (const g of activeGroups) {
      if (g.combinator !== "AND") continue; // OR groups allow repeats
      const counts = new Map<string, number>();
      for (const r of g.rules) {
        counts.set(r.property, (counts.get(r.property) ?? 0) + 1);
      }
      for (const [prop, n] of counts) {
        if (n >= 2 && !out.includes(prop)) out.push(prop);
      }
    }
    return out;
  }, [activeGroups]);

  // ── Handlers ────────────────────────────────────────────────────────

  function handleAdd(): void {
    if (!selProp) return;
    if (!VALUE_AGNOSTIC.has(selOp) && !selVal.trim()) return;
    const rule: FilterRule = {
      id: makeId(),
      property: selProp,
      operator: selOp,
      value: VALUE_AGNOSTIC.has(selOp) ? "" : selVal.trim(),
    };
    setActiveGroups((prev) => {
      if (prev.length === 0) {
        return [{ id: makeId(), combinator: "AND", rules: [rule] }];
      }
      const idx = Math.min(activeGroupIndex, prev.length - 1);
      return prev.map((g, i) =>
        i === idx ? { ...g, rules: [...g.rules, rule] } : g,
      );
    });
    setSelProp("");
    setSelOp("equals");
    setSelVal("");
    setPropSearch("");
    setDropdownOpen(false);
    valueInputRef.current?.focus();
  }

  function handleRemoveRule(groupIndex: number, ruleId: string): void {
    setActiveGroups((prev) =>
      prev.map((g, i) =>
        i === groupIndex
          ? { ...g, rules: g.rules.filter((r) => r.id !== ruleId) }
          : g,
      ),
    );
  }

  function handleRemoveGroup(groupIndex: number): void {
    setActiveGroups((prev) => prev.filter((_, i) => i !== groupIndex));
    setActiveGroupIndex((prev) =>
      prev >= groupIndex ? Math.max(0, prev - 1) : prev,
    );
  }

  function handleClear(): void {
    setActiveGroups([makeEmptyGroup("AND")]);
    setActiveGroupIndex(0);
  }

  function handleAddGroup(combinator: Combinator): void {
    setActiveGroups((prev) => [
      ...prev,
      makeEmptyGroup(combinator),
    ]);
    setActiveGroupIndex(activeGroups.length);
  }

  function handleToggleGroupCombinator(groupIndex: number): void {
    setActiveGroups((prev) =>
      prev.map((g, i) =>
        i === groupIndex
          ? { ...g, combinator: g.combinator === "AND" ? "OR" : "AND" }
          : g,
      ),
    );
  }

  function handleTogglePresetCombinator(): void {
    setPresetCombinator((p) => (p === "AND" ? "OR" : "AND"));
  }

  function handleSave(): void {
    if (flatRules.length === 0) return;
    const name = presetName.trim() || autoName;
    if (!name) return;
    // Drop empty trailing groups so the saved preset doesn't carry a
    // dangling empty OR group (only relevant for users who added a
    // group then changed their mind without adding rules).
    const groups = activeGroups.filter((g) => g.rules.length > 0);
    if (groups.length === 0) return;
    const preset: FilterPreset = {
      id: editingPreset?.id ?? makeId(),
      name,
      combinator: presetCombinator,
      groups: groups.map(cloneGroup),
    };
    onSubmit(preset);
  }

  function handleSelectProperty(qualified: string): void {
    setSelProp(qualified);
    setPropSearch(qualified);
    setDropdownOpen(false);
    valueInputRef.current?.focus();
  }

  function handleNameKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }

  function handleBackdropClick(e: ReactMouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onCancel();
  }

  if (!open) return null;

  // ── Render ──────────────────────────────────────────────────────────

  const canAdd =
    selProp.length > 0 &&
    (VALUE_AGNOSTIC.has(selOp) || selVal.trim().length > 0);
  const canSave = flatRules.length > 0;
  const hasCatalog = count > 0;

  return (
    <div
      style={backdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label={isEditing ? "Edit filter" : "New filter"}
      data-testid="custom-filter-builder"
      onClick={handleBackdropClick}
    >
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle} data-testid="custom-filter-builder-header">
          <div style={headerTitleStyle}>
            <FilterIcon />
            <span data-testid="custom-filter-builder-title">
              {isEditing ? "Edit filter" : "New filter"}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            style={closeBtnStyle}
            data-testid="custom-filter-builder-close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {/* PROPERTY */}
          <div>
            <label className={styles.sectionLabel}>Property</label>
            <div style={{ position: "relative" }}>
              <input
                type="text"
                value={propSearch}
                onChange={(e) => {
                  setPropSearch(e.target.value);
                  setSelProp("");
                  setDropdownOpen(true);
                }}
                onFocus={() => setDropdownOpen(true)}
                onBlur={() => {
                  // Delay so option onClick fires before blur closes the panel.
                  window.setTimeout(() => setDropdownOpen(false), 120);
                }}
                placeholder={
                  hasCatalog
                    ? "Search properties..."
                    : "No properties cataloged"
                }
                disabled={!hasCatalog && !loading}
                style={inputStyle}
                data-testid="custom-filter-builder-prop-input"
              />
              {dropdownOpen && hasCatalog && (
                <div
                  className={styles.dropdown}
                  data-testid="custom-filter-builder-prop-dropdown"
                >
                  {filteredOptions.length === 0 ? (
                    <div className={styles.dropdownEmpty}>
                      No matches for &ldquo;{propSearch}&rdquo;
                    </div>
                  ) : (
                    Array.from(groupedOptions.entries()).map(([pset, list]) => (
                      <div key={pset} className={styles.dropdownGroup}>
                        <div className={styles.dropdownGroupHeader}>{pset}</div>
                        {list.map((o) => (
                          <button
                            key={o.qualified}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleSelectProperty(o.qualified)}
                            className={styles.dropdownItem}
                            data-testid={`custom-filter-builder-prop-option-${o.qualified}`}
                          >
                            {o.name}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              )}
              {!hasCatalog && !loading && (
                <div className={styles.emptyHint} data-testid="custom-filter-builder-empty">
                  No properties cataloged. Re-upload the IFC to extract its property catalog.
                </div>
              )}
            </div>
          </div>

          {/* OPERATOR */}
          <div>
            <label className={styles.sectionLabel}>Operator</label>
            <select
              value={selOp}
              onChange={(e) => setSelOp(e.target.value as FilterOperator)}
              style={selectStyle}
              data-testid="custom-filter-builder-op-select"
            >
              {OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* VALUE */}
          <div>
            <label className={styles.sectionLabel}>Value</label>
            <PropertyValueDropdown
              property={selProp}
              value={selVal}
              onChange={setSelVal}
              operator={selOp}
              disabled={VALUE_AGNOSTIC.has(selOp)}
              placeholder={
                selOp === "in" || selOp === "not_in"
                  ? "Pick one or more values"
                  : "Pick a value or type..."
              }
              testId="custom-filter-builder-val-input"
              inputRef={valueInputRef}
            />
            {VALUE_AGNOSTIC.has(selOp) && (
              <div
                className={styles.valHelper}
                data-testid="custom-filter-builder-val-helper"
              >
                This operator checks property presence only — value is
                ignored.
              </div>
            )}
          </div>

          {/* ADD CONDITION */}
          <button
            type="button"
            onClick={handleAdd}
            disabled={!canAdd}
            style={{
              ...addBtnStyle,
              opacity: canAdd ? 1 : 0.4,
              cursor: canAdd ? "pointer" : "not-allowed",
            }}
            data-testid="custom-filter-builder-add"
          >
            <PlusIcon />
            <span>Add Condition</span>
          </button>

          {/* Current groups + rules */}
          {activeGroups.length > 0 && flatRules.length > 0 && (
            <div
              className={styles.rulesBlock}
              data-testid="custom-filter-builder-rules"
            >
              <div className={styles.rulesHeader}>
                <span className={styles.rulesHeaderLabel}>
                  Filter ({flatRules.length}{" "}
                  {flatRules.length === 1 ? "rule" : "rules"} ·{" "}
                  {activeGroups.length}{" "}
                  {activeGroups.length === 1 ? "group" : "groups"})
                </span>
                <button
                  type="button"
                  onClick={handleClear}
                  className={styles.rulesClear}
                  data-testid="custom-filter-builder-clear"
                >
                  Clear
                </button>
              </div>

              {activeGroups.map((g, gi) => (
                <div
                  key={g.id}
                  className={styles.groupCard}
                  data-testid={`custom-filter-builder-group-${gi}`}
                  data-combinator={g.combinator}
                  onClick={() => setActiveGroupIndex(gi)}
                >
                  <div className={styles.groupHeader}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleGroupCombinator(gi);
                      }}
                      className={`${styles.combinatorPill} ${
                        g.combinator === "AND"
                          ? styles.combinatorPillAnd
                          : styles.combinatorPillOr
                      }`}
                      data-testid={`custom-filter-builder-group-${gi}-combinator`}
                      aria-label={`Group combinator (${g.combinator})`}
                      title="Click to toggle AND / OR"
                    >
                      {g.combinator}
                    </button>
                    <span className={styles.groupLabel}>
                      Group {gi + 1}
                      {gi > 0 && (
                        <span className={styles.groupJoiner}>
                          {" "}
                          (joined by{" "}
                          <strong>{presetCombinator}</strong>)
                        </span>
                      )}
                    </span>
                    {activeGroups.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveGroup(gi);
                        }}
                        aria-label="Remove group"
                        className={styles.groupRemove}
                        data-testid={`custom-filter-builder-group-${gi}-remove`}
                      >
                        <CloseIcon size={12} />
                      </button>
                    )}
                  </div>
                  {g.rules.length === 0 ? (
                    <div className={styles.groupEmpty}>No rules yet.</div>
                  ) : (
                    g.rules.map((r) => (
                      <div
                        key={r.id}
                        className={styles.rulePill}
                        data-testid={`custom-filter-builder-rule-${r.id}`}
                      >
                        <FilterIcon size={12} />
                        <span className={styles.rulePillText}>
                          {r.property.split(".").pop()}{" "}
                          {r.operator.replaceAll("_", " ")} {r.value}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveRule(gi, r.id)}
                          aria-label="Remove rule"
                          className={styles.rulePillRemove}
                          data-testid={`custom-filter-builder-rule-${r.id}-remove`}
                        >
                          <CloseIcon size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              ))}

              {/* "+ OR group" / "+ AND group" affordances */}
              <div
                className={styles.groupAddRow}
                data-testid="custom-filter-builder-group-add"
              >
                <button
                  type="button"
                  onClick={() => handleAddGroup("OR")}
                  className={styles.groupAddBtn}
                  data-testid="custom-filter-builder-add-or-group"
                >
                  <PlusIcon /> + OR group
                </button>
                <button
                  type="button"
                  onClick={() => handleAddGroup("AND")}
                  className={styles.groupAddBtn}
                  data-testid="custom-filter-builder-add-and-group"
                >
                  <PlusIcon /> + AND group
                </button>
              </div>

              {/* STUB: live match count */}
              <div
                className={styles.stubBadge}
                data-testid="custom-filter-builder-stub-count"
              >
                {flatRules.length}{" "}
                {flatRules.length === 1 ? "rule" : "rules"} pending evaluation
              </div>

              {/* Preset-level combinator selector (above the save block) */}
              {activeGroups.length > 1 && (
                <div
                  className={styles.presetCombinator}
                  data-testid="custom-filter-builder-preset-combinator"
                >
                  <span className={styles.presetCombinatorLabel}>
                    Join groups by
                  </span>
                  <div
                    className={styles.segmentedControl}
                    role="group"
                    aria-label="Join groups by"
                  >
                    <button
                      type="button"
                      onClick={() => setPresetCombinator("AND")}
                      className={`${styles.segmentedOption} ${
                        presetCombinator === "AND"
                          ? styles.segmentedOptionActive
                          : ""
                      }`}
                      data-testid="custom-filter-builder-preset-combinator-and"
                      aria-pressed={presetCombinator === "AND"}
                    >
                      AND
                    </button>
                    <button
                      type="button"
                      onClick={() => setPresetCombinator("OR")}
                      className={`${styles.segmentedOption} ${
                        presetCombinator === "OR"
                          ? styles.segmentedOptionActive
                          : ""
                      }`}
                      data-testid="custom-filter-builder-preset-combinator-or"
                      aria-pressed={presetCombinator === "OR"}
                    >
                      OR
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleTogglePresetCombinator}
                    className={styles.combinatorSwap}
                    aria-label="Toggle join groups by"
                    title="Toggle AND / OR"
                    data-testid="custom-filter-builder-preset-combinator-toggle"
                  >
                    ⇄
                  </button>
                </div>
              )}

              {/* AND/OR same-property warning (Task 20D — updated copy).
                  Renders only when 2+ rules in the SAME AND-group
                  target the same property. Suggests the OR-group or
                  `in`-operator work-arounds. We don't force OR
                  (modal is user-driven). */}
              {samePropertyRules.length > 0 && (
                <div
                  className={styles.warningChip}
                  data-testid="same-property-warning"
                  role="status"
                >
                  <span aria-hidden="true">⚠</span>
                  <span>
                    Multiple rules in the same AND-group target the same
                    property. To match any of several values, add a
                    <strong> + OR group</strong> or use the <code>in</code>{" "}
                    operator with comma-separated values instead.
                  </span>
                </div>
              )}

              {/* Save block */}
              <div className={styles.saveBlock}>
                <label className={styles.sectionLabel}>Filter name</label>
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  placeholder={autoName || "Filter name..."}
                  style={inputStyle}
                  data-testid="custom-filter-builder-name-input"
                />
                <div className={styles.saveRow}>
                  <button
                    type="button"
                    onClick={onCancel}
                    style={cancelBtnStyle}
                    data-testid="custom-filter-builder-cancel"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!canSave}
                    style={{
                      ...saveBtnStyle,
                      opacity: canSave ? 1 : 0.4,
                      cursor: canSave ? "pointer" : "not-allowed",
                    }}
                    data-testid="custom-filter-builder-save"
                  >
                    {isEditing ? "Update filter" : "Save filter"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return (
    "f-" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function makeEmptyGroup(combinator: Combinator): ConditionGroup {
  return {
    id: makeId(),
    combinator,
    rules: [],
  };
}

/** Defensive deep clone of a `ConditionGroup` for state transitions. */
function cloneGroup(g: ConditionGroup): ConditionGroup {
  return {
    id: g.id,
    combinator: g.combinator,
    rules: g.rules.map((r) => ({ ...r })),
  };
}

// ---------------------------------------------------------------------------
// Styles (Free Field tokens)
// ---------------------------------------------------------------------------

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  fontFamily: "var(--ff-font-stack)",
};

const cardStyle: CSSProperties = {
  background: "var(--ff-bg-app)",
  border: "1px solid var(--ff-border)",
  borderRadius: "var(--ff-radius-control)",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.25)",
  width: 380,
  maxWidth: "94vw",
  height: "72vh",
  maxHeight: "94vh",
  display: "flex",
  flexDirection: "column",
  color: "var(--ff-text-primary)",
  fontSize: "var(--ff-font-size-base)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 20px 0 20px",
  height: 40,
  borderBottom: "1px solid var(--ff-divider)",
};

const headerTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
  color: "var(--ff-text-primary)",
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--ff-text-muted)",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const bodyStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "16px 20px 16px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid var(--ff-border)",
  borderRadius: 4,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  boxSizing: "border-box",
  fontFamily: "var(--ff-font-stack)",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  cursor: "pointer",
  paddingRight: 24,
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 8px center",
};

const addBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  width: "100%",
  padding: "8px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ff-blue-active)",
  background: "rgba(37, 99, 235, 0.08)",
  border: "1px solid rgba(37, 99, 235, 0.18)",
  borderRadius: "var(--ff-radius-control)",
  transition: "background 120ms ease",
};

const cancelBtnStyle: CSSProperties = {
  flex: 1,
  padding: "6px 12px",
  fontSize: 12,
  borderRadius: 4,
  cursor: "pointer",
  border: "1px solid var(--ff-border)",
  background: "transparent",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
};

const saveBtnStyle: CSSProperties = {
  flex: 1,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 4,
  border: "1px solid var(--ff-blue-active)",
  background: "var(--ff-blue-active)",
  color: "white",
  fontFamily: "var(--ff-font-stack)",
};

// ---------------------------------------------------------------------------
// Icons (inline SVGs)
// ---------------------------------------------------------------------------

function FilterIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4h18l-7 9v6l-4 2v-8z" />
    </svg>
  );
}

function CloseIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M6 18L18 6" />
    </svg>
  );
}

function PlusIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
