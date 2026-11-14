// apps/models/src/components/PropertyValueDropdown.tsx
//
// Task 24 — searchable combobox for property values in the
// CustomFilterBuilder. Sources distinct values from the in-memory
// inverted index (propertyIndexStore), shows element counts, and
// supports keyboard navigation (Arrow/Enter/Escape).
//
// Single-select mode (equals, not_equals, contains, etc.):
//   typing filters the dropdown; clicking an option fills the input.
//
// Multi-select mode (in, not_in):
//   chips appear inside the input area for each selected value,
//   plus a small text input for typing/filtering. Clicking an
//   option adds a chip; clicking a chip's × removes it. The
//   combined value is comma-separated in `onChange` output.
//
// Disabled state (is_empty, is_not_empty):
//   renders a plain disabled input with helper text.
//
// Fallback (no models loaded / index not built):
//   renders a plain text input — no dropdown, no error.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { usePropertyIndexStore, computeOptions } from "../propertyIndexStore";
import type { FilterOperator } from "../modelsToolStore";
import type { PropertyValueOption } from "../propertyIndexStore";

import styles from "./PropertyValueDropdown.module.css";

// Operators that ignore the value field — dropdown is disabled.
const VALUE_AGNOSTIC: ReadonlySet<string> = new Set([
  "is_empty",
  "is_not_empty",
]);

// Multi-select operators (chip-based).
const MULTI_SELECT_OPS: ReadonlySet<string> = new Set(["in", "not_in"]);

export interface PropertyValueDropdownProps {
  /** The selected property (e.g., "Pset_WallCommon.FireRating"). */
  property: string;
  /** Current value (single string, or comma-separated for in/not_in). */
  value: string;
  /** Called when the user picks/clears a value. */
  onChange: (value: string) => void;
  /** Operator determines single vs multi-select and disabled state. */
  operator: FilterOperator;
  /** Disabled when operator is is_empty / is_not_empty. */
  disabled?: boolean;
  /** Placeholder shown when input is empty. */
  placeholder?: string;
  /** Test ID for the input element. */
  testId?: string;
  /** Ref to focus the inner text input from the parent. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Parse comma-separated string into trimmed, non-empty tokens.
 */
function parseChips(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function PropertyValueDropdown({
  property,
  value,
  onChange,
  operator,
  disabled = false,
  placeholder,
  testId,
  inputRef,
}: PropertyValueDropdownProps): JSX.Element {
  // ── Read options from the store ──────────────────────────────────
  const storeIndices = usePropertyIndexStore((s) => s.indices);
  const options = useMemo<PropertyValueOption[]>(
    () => computeOptions(property, storeIndices),
    [property, storeIndices],
  );

  const hasIndex = storeIndices.size > 0;
  const hasProperty = property.length > 0;
  const isMulti = MULTI_SELECT_OPS.has(operator);
  const isDisabled = disabled || VALUE_AGNOSTIC.has(operator);

  // If no model index OR no property selected: plain text input.
  if (!hasIndex || !hasProperty) {
    return (
      <div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={isDisabled}
          placeholder={
            isDisabled
              ? "Value ignored for this operator"
              : placeholder ?? "Enter value..."
          }
          className={styles.plainInput}
          data-testid={testId}
        />
        {isDisabled && (
          <div className={styles.valHelper}>
            This operator checks property presence only — value is
            ignored.
          </div>
        )}
      </div>
    );
  }

  // ── Full combobox mode (has index + property) ─────────────────────
  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      isMulti={isMulti}
      isDisabled={isDisabled}
      placeholder={placeholder}
      testId={testId}
      inputRef={inputRef}
    />
  );
}

// ──────────────────────────────────────────────────────────────────────
// Combobox sub-component (extracted so the full-complex part is
// one rendering path — the fallback above is a simple branch).
// ──────────────────────────────────────────────────────────────────────

interface ComboboxProps {
  options: PropertyValueOption[];
  value: string;
  onChange: (value: string) => void;
  isMulti: boolean;
  isDisabled: boolean;
  placeholder?: string;
  testId?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const OPTION_ID_PREFIX = "pv-dropdown-option-";

function Combobox({
  options,
  value,
  onChange,
  isMulti,
  isDisabled,
  placeholder,
  testId,
  inputRef,
}: ComboboxProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const innerInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Merge the internal ref and the forwarded ref so both get updated.
  const setInputRefs = useCallback(
    (el: HTMLInputElement | null) => {
      (innerInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      if (inputRef) {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }
    },
    [inputRef],
  );

  // ── Filtered options ────────────────────────────────────────────
  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return options;
    return options.filter((o) => o.value.toLowerCase().includes(q));
  }, [options, search]);

  // ── Chips (multi mode) ──────────────────────────────────────────
  const chips = useMemo(
    () => (isMulti ? parseChips(value) : []),
    [isMulti, value],
  );
  const chipSet = useMemo(
    () => new Set(chips.map((c) => c.toLowerCase())),
    [chips],
  );

  // ── Highlight management ────────────────────────────────────────
  const clampHighlight = useCallback(
    (idx: number) => {
      if (filteredOptions.length === 0) return -1;
      if (idx < 0) return filteredOptions.length - 1;
      if (idx >= filteredOptions.length) return 0;
      return idx;
    },
    [filteredOptions.length],
  );

  // ── Scroll highlight into view ──────────────────────────────────
  useEffect(() => {
    if (!open || highlightIndex < 0) return;
    const el = listRef.current?.children[highlightIndex] as HTMLElement | undefined;
    try { el?.scrollIntoView?.({ block: "nearest" }); } catch { /* jsdom compat */ }
  }, [open, highlightIndex]);

  // Close on blur (after a short delay so option clicks fire first).
  // Using blur instead of mousedown on document avoids a scrollbar
  // bug: clicking the native scrollbar on the listbox does NOT blur
  // the input, so the dropdown stays open while scrolling.
  function handleBlur(e: React.FocusEvent): void {
    // If focus is moving to a descendant of this container (e.g.,
    // clicking an option in the listbox), stay open.
    const relatedTarget = e.relatedTarget as Node | null;
    if (
      relatedTarget &&
      containerRef.current?.contains(relatedTarget)
    ) {
      return;
    }
    // Delayed close — gives the option click handler time to run
    // before the blur fires.
    setTimeout(() => {
      if (
        containerRef.current &&
        !containerRef.current.contains(document.activeElement)
      ) {
        setOpen(false);
        setSearch("");
      }
    }, 150);
  }

  // ── Handlers ────────────────────────────────────────────────────

  function openDropdown(): void {
    if (isDisabled) return;
    setOpen(true);
    setHighlightIndex(-1);
  }

  function closeDropdown(): void {
    setOpen(false);
    setHighlightIndex(-1);
  }

  function selectOption(optValue: string): void {
    if (isMulti) {
      const existing = parseChips(value);
      if (!existing.includes(optValue)) {
        onChange([...existing, optValue].join(", "));
      }
      setSearch("");
      innerInputRef.current?.focus();
      // Keep dropdown open for additional selections.
    } else {
      onChange(optValue);
      setOpen(false);
      setSearch("");
    }
  }

  function removeChip(chip: string): void {
    const remaining = parseChips(value).filter((c) => c !== chip);
    onChange(remaining.join(", "));
    innerInputRef.current?.focus();
  }

  function handleKeyDown(e: ReactKeyboardEvent): void {
    if (isDisabled) return;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        if (!open) {
          openDropdown();
          return;
        }
        setHighlightIndex((prev) => clampHighlight(prev + 1));
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        if (!open) {
          openDropdown();
          return;
        }
        setHighlightIndex((prev) => clampHighlight(prev - 1));
        break;
      }
      case "Enter": {
        if (!open) {
          e.preventDefault();
          openDropdown();
          return;
        }
        if (highlightIndex >= 0 && highlightIndex < filteredOptions.length) {
          e.preventDefault();
          const opt = filteredOptions[highlightIndex]!;
          selectOption(opt.value);
        }
        break;
      }
      case "Escape": {
        if (open) {
          e.preventDefault();
          closeDropdown();
        }
        break;
      }
      case "Tab": {
        if (open) {
          closeDropdown();
        }
        break;
      }
      default:
        break;
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const val = e.target.value;
    if (isMulti) {
      setSearch(val);
    } else {
      // In single-select, user may type a custom value.
      onChange(val);
      setSearch(val);
    }
    if (!open) setOpen(true);
    setHighlightIndex(-1);
  }

  function handleInputFocus(): void {
    if (!isDisabled) openDropdown();
  }

  function handleOptionMouseDown(
    e: ReactMouseEvent,
    optValue: string,
  ): void {
    e.preventDefault(); // Prevent input blur before click fires.
    selectOption(optValue);
  }

  // ── Active descendant id ────────────────────────────────────────
  const activeDescendant =
    open && highlightIndex >= 0 && highlightIndex < filteredOptions.length
      ? `${OPTION_ID_PREFIX}${highlightIndex}`
      : undefined;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className={styles.comboboxContainer}>
      {/* ------------------------------------------------------------------
          Disabled input for value-agnostic operators
          ------------------------------------------------------------------ */}
      {isDisabled ? (
        <div>
          <input
            type="text"
            value=""
            disabled
            placeholder="Value ignored for this operator"
            className={styles.plainInput}
            data-testid={testId}
          />
          <div className={styles.valHelper}>
            This operator checks property presence only — value is
            ignored.
          </div>
        </div>
      ) : (
        /* ----------------------------------------------------------------
           Active combobox
           ---------------------------------------------------------------- */
        <div
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-owns="pv-dropdown-listbox"
          aria-activedescendant={activeDescendant}
          className={styles.combobox}
        >
          <div className={styles.inputArea}>
            {/* Chips (multi mode) */}
            {isMulti &&
              chips.map((chip) => (
                <span key={chip} className={styles.chip}>
                  <span className={styles.chipText}>{chip}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={() => removeChip(chip)}
                    aria-label={`Remove ${chip}`}
                    data-testid={`${testId}-chip-${chip}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            {/* Text input */}
            <input
              ref={setInputRefs}
              type="text"
              value={isMulti ? search : value}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={handleInputFocus}
              onBlur={handleBlur}
              placeholder={
                chips.length > 0
                  ? "Add another..."
                  : placeholder ?? "Pick a value or type..."
              }
              className={styles.comboboxInput}
              autoComplete="off"
              aria-autocomplete="list"
              aria-controls="pv-dropdown-listbox"
              data-testid={testId}
            />
          </div>

          {/* Dropdown list */}
          {open && (
            <div className={styles.dropdownPanel}>
              {filteredOptions.length === 0 ? (
                <div className={styles.noMatches}>No matches for &ldquo;{search}&rdquo;</div>
              ) : (
                <>
                  <div className={styles.dropdownFooter}>
                    {filteredOptions.length} value
                    {filteredOptions.length !== 1 ? "s" : ""}
                  </div>
                  <ul
                    id="pv-dropdown-listbox"
                    ref={listRef}
                    role="listbox"
                    className={styles.listbox}
                  >
                    {filteredOptions.map((opt, i) => {
                      const isSelected = isMulti
                        ? chipSet.has(opt.value.toLowerCase())
                        : opt.value === value;
                      return (
                        <li
                          key={opt.value}
                          id={`${OPTION_ID_PREFIX}${i}`}
                          role="option"
                          aria-selected={isSelected}
                          className={`${styles.option} ${
                            i === highlightIndex ? styles.optionHighlight : ""
                          } ${isSelected ? styles.optionSelected : ""}`}
                          onMouseDown={(e) => handleOptionMouseDown(e, opt.value)}
                          onMouseEnter={() => setHighlightIndex(i)}
                          data-testid={`${testId}-option-${opt.value}`}
                        >
                          <span className={styles.optionValue}>{opt.value}</span>
                          <span className={styles.optionCount}>({opt.count})</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
