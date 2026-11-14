// apps/models/__tests__/components/PropertyValueDropdown.test.tsx
//
// Task 24 — unit tests for the PropertyValueDropdown combobox.
//
// Coverage:
//   (a) renders empty state when no options
//   (b) renders options list when index has values
//   (c) filters options as user types
//   (d) click selects value (single mode)
//   (e) click adds chip (multi mode for `in` / `not_in`)
//   (f) keyboard: Arrow Down moves highlight
//   (g) keyboard: Enter selects highlighted
//   (h) keyboard: Escape closes dropdown
//   (i) disabled state for `is_empty` / `is_not_empty`
//   (j) aria-expanded reflects open state
//   (k) aria-activedescendant reflects highlighted option
//   (l) count display (e.g., "2HR (152)")
//   (m) sort: most common first, alphabetical tiebreak
//   (n) empty filter result: "no matches"
//   (o) no models loaded: falls back to text input
//   (p) no property selected: falls back to text input
//
// We pre-populate the Zustand `propertyIndexStore` with a
// synthetic index so the component renders in "full combobox"
// mode without needing a real IfcViewer.

// React 17+ JSX transform — no React import needed.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import PropertyValueDropdown from "../../src/components/PropertyValueDropdown";
import { usePropertyIndexStore } from "../../src/propertyIndexStore";
import { buildInvertedIndex } from "../../../../packages/ff-viewer-react/src/indexPropertyData";
import type { PropertyDataRow } from "../../../../packages/ff-viewer-react/src/indexPropertyData";
import type { FilterOperator } from "../../src/modelsToolStore";

afterEach(() => {
  usePropertyIndexStore.getState().clearIndices();
});

function seedIndex(rows: PropertyDataRow[]): void {
  const index = buildInvertedIndex(rows);
  const allIds = new Set(rows.map((r) => r.localId));
  usePropertyIndexStore.getState().setModelIndex("model-1", index, allIds);
}

const TEST_ID = "pv-dropdown-test";

function renderComp(
  props: Partial<{
    property: string;
    value: string;
    operator: FilterOperator;
    disabled: boolean;
  }> = {},
): ReturnType<typeof render> {
  return render(
    <PropertyValueDropdown
      property={props.property ?? "Pset_WallCommon.FireRating"}
      value={props.value ?? ""}
      onChange={() => {}}
      operator={props.operator ?? "equals"}
      disabled={props.disabled ?? false}
      testId={TEST_ID}
    />,
  );
}

// ── Tests ───────────────────────────────────────────────────────

describe("PropertyValueDropdown — fallback modes", () => {
  it("(o) renders a plain text input when no models had index built", () => {
    renderComp();
    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
    // No combobox role when in fallback mode.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("(p) renders a plain text input when property is empty", () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);
    render(
      <PropertyValueDropdown
        property=""
        value=""
        onChange={() => {}}
        operator="equals"
        testId={TEST_ID}
      />,
    );
    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("PropertyValueDropdown — rendering", () => {
  it("(a) renders empty dropdown when no values for the property", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.IsExternal": "TRUE" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    // The dropdown panel should show "No matches".
    await waitFor(() => {
      expect(screen.getByText(/No matches for/)).toBeInTheDocument();
    });
  });

  it("(b) renders options when index has values", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 3, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId(`${TEST_ID}-option-2HR`),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`${TEST_ID}-option-1HR`),
    ).toBeInTheDocument();
  });

  it("(l) shows counts in option labels", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 3, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      const opt2HR = screen.getByTestId(`${TEST_ID}-option-2HR`);
      expect(opt2HR.textContent).toContain("(2)");
      const opt1HR = screen.getByTestId(`${TEST_ID}-option-1HR`);
      expect(opt1HR.textContent).toContain("(1)");
    });
  });

  it("(m) sorts by count descending, alphabetical tiebreak", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 3, properties: { "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 4, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 5, properties: { "Pset_WallCommon.FireRating": "None" } },
      { localId: 6, properties: { "Pset_WallCommon.FireRating": "None" } },
      { localId: 7, properties: { "Pset_WallCommon.FireRating": "None" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      const options = screen.getAllByRole("option");
      // Count 3 each for "1HR" and "None", 1 for "2HR".
      // Tie: "1HR" < "None" alphabetically.
      expect(options[0].textContent).toContain("1HR");
      expect(options[1].textContent).toContain("None");
      expect(options[2].textContent).toContain("2HR");
    });
  });
});

describe("PropertyValueDropdown — filtering", () => {
  it("(c) filters options as user types", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 3, properties: { "Pset_WallCommon.FireRating": "None" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    await act(async () => {
      fireEvent.change(input, { target: { value: "2" } });
    });

    await waitFor(() => {
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toContain("2HR");
    });
  });

  it("(n) shows 'no matches' when filter returns empty", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await act(async () => {
      fireEvent.change(input, { target: { value: "zzzNOTFOUND" } });
    });

    await waitFor(() => {
      expect(screen.getByText(/No matches for/)).toBeInTheDocument();
    });
  });
});

describe("PropertyValueDropdown — selection", () => {
  it("(d) click selects value (single mode)", async () => {
    const onChange = vi.fn();
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);

    render(
      <PropertyValueDropdown
        property="Pset_WallCommon.FireRating"
        value=""
        onChange={onChange}
        operator="equals"
        testId={TEST_ID}
      />,
    );

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    const opt2HR = await screen.findByTestId(`${TEST_ID}-option-2HR`);
    await act(async () => {
      fireEvent.mouseDown(opt2HR);
    });

    expect(onChange).toHaveBeenCalledWith("2HR");
  });

  it("(e) click adds chip (multi mode for `in`)", async () => {
    const onChange = vi.fn();
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 3, properties: { "Pset_WallCommon.FireRating": "None" } },
    ]);

    render(
      <PropertyValueDropdown
        property="Pset_WallCommon.FireRating"
        value="2HR"
        onChange={onChange}
        operator="in"
        testId={TEST_ID}
      />,
    );

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    const opt1HR = await screen.findByTestId(`${TEST_ID}-option-1HR`);
    await act(async () => {
      fireEvent.mouseDown(opt1HR);
    });

    expect(onChange).toHaveBeenCalledWith("2HR, 1HR");
  });

  it("(e2) removing a chip updates the value", async () => {
    const onChange = vi.fn();
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);

    render(
      <PropertyValueDropdown
        property="Pset_WallCommon.FireRating"
        value="2HR, 1HR"
        onChange={onChange}
        operator="in"
        testId={TEST_ID}
      />,
    );

    const chipRemove = screen.getByTestId(`${TEST_ID}-chip-1HR`);
    await act(async () => {
      fireEvent.click(chipRemove);
    });

    expect(onChange).toHaveBeenCalledWith("2HR");
  });
});

describe("PropertyValueDropdown — keyboard navigation", () => {
  it("(f) Arrow Down moves highlight", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });

    const options = screen.getAllByRole("option");
    expect(options[0].className).toContain("optionHighlight");

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(options[1].className).toContain("optionHighlight");
  });

  it("(f2) Arrow Up wraps around to last option", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowUp" });
    });

    const options = screen.getAllByRole("option");
    expect(options[1].className).toContain("optionHighlight");
  });

  it("(g) Enter selects highlighted option", async () => {
    const onChange = vi.fn();
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 3, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);

    render(
      <PropertyValueDropdown
        property="Pset_WallCommon.FireRating"
        value=""
        onChange={onChange}
        operator="equals"
        testId={TEST_ID}
      />,
    );

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onChange).toHaveBeenCalledWith("2HR");
  });

  it("(h) Escape closes dropdown", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });
});

describe("PropertyValueDropdown — a11y", () => {
  it("(j) aria-expanded reflects open state", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const combobox = screen.getByRole("combobox");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });

    await waitFor(() => {
      expect(combobox.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("(k) aria-activedescendant reflects highlighted option", async () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { "Pset_WallCommon.FireRating": "1HR" } },
    ]);
    renderComp({ property: "Pset_WallCommon.FireRating" });

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
    });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });

    const combobox = screen.getByRole("combobox");
    expect(combobox.getAttribute("aria-activedescendant")).toMatch(
      /^pv-dropdown-option-/,
    );
  });
});

describe("PropertyValueDropdown — disabled state", () => {
  it("(i) disabled for is_empty operator", () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);

    render(
      <PropertyValueDropdown
        property="Pset_WallCommon.FireRating"
        value=""
        onChange={() => {}}
        operator="is_empty"
        testId={TEST_ID}
      />,
    );

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(
      screen.getByText(/This operator checks property presence only/),
    ).toBeInTheDocument();
  });

  it("(i2) disabled for is_not_empty operator", () => {
    seedIndex([
      { localId: 1, properties: { "Pset_WallCommon.FireRating": "2HR" } },
    ]);

    render(
      <PropertyValueDropdown
        property="Pset_WallCommon.FireRating"
        value=""
        onChange={() => {}}
        operator="is_not_empty"
        testId={TEST_ID}
      />,
    );

    const input = screen.getByTestId(TEST_ID) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
