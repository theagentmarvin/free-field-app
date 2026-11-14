// apps/models/__tests__/CustomFilterBuilder.test.tsx
//
// Unit tests for CustomFilterBuilder (Task 20C-Part 2).
//
// Coverage (per spec §8 criterion 1):
//   (a) property autocomplete renders empty state when byPset is empty
//   (b) property autocomplete renders entries when byPset has data
//   (c) Add Condition button is disabled until selProp + selVal are both non-empty
//   (d) auto-name derives correctly for 1 rule and for N rules
//   (e) Save button is disabled when activeRules.length === 0
//   (f) Escape key closes the modal and calls onCancel
//   (g) is_empty rule adds without requiring a value (Task 20C-Part 2 §1)
//   (h) value input is disabled when is_empty / is_not_empty is selected
//   (i) auto-name for greater_than_or_equal formats correctly
//   (j) handleAdd rejects non-value-agnostic operators with empty value
//   (k) AND/OR same-property warning renders when 2+ rules share a property
//
// We render the component in isolation and seed the Dexie
// `propertyCatalog` table per test so the live query inside the
// hook resolves to our data.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";

import { testDb, type TestPropertyCatalogEntry } from "./support/testDb";
import { renderWithDataSource } from "./support/renderWithDataSource";

import CustomFilterBuilder from "../src/components/CustomFilterBuilder";

afterEach(async () => {
  await testDb.propertyCatalog.clear();
});

function entries(
  fileId: string,
  pairs: Array<[string, string]>,
): TestPropertyCatalogEntry[] {
  return pairs.map(([pset, name]) => ({ fileId, pset, name }));
}
describe("CustomFilterBuilder — property autocomplete", () => {
  it("(a) renders the empty-state hint when byPset is empty", async () => {
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-empty"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // The empty hint is unconditional in the markup; it renders as
    // soon as the byPset.size === 0 branch resolves. We assert on
    // its data-testid (more robust than text matching).
    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-empty"),
      ).toBeInTheDocument();
    });
    // Property input is also disabled in this case.
    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    expect(propInput.disabled).toBe(true);
  });

  it("(b) renders pset-grouped options when byPset has data", async () => {
    const fileId = "file-pop";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [
        ["Pset_WallCommon", "FireRating"],
        ["Pset_WallCommon", "IsExternal"],
        ["Pset_DoorCommon", "FireRating"],
      ]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Open the dropdown by focusing the input.
    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(propInput);
    });

    // Two pset groups → 3 options rendered (one per (pset, name) pair).
    await waitFor(() => {
      expect(
        screen.getByTestId(
          "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.IsExternal",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_DoorCommon.FireRating",
      ),
    ).toBeInTheDocument();
  });
});

describe("CustomFilterBuilder — Add Condition button gating", () => {
  it("(c) is disabled until selProp + selVal are both non-empty", async () => {
    const fileId = "file-gate";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const addBtn = screen.getByTestId("custom-filter-builder-add");
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;

    // Both empty → disabled.
    expect(addBtn).toBeDisabled();

    // Type a value but no property selected → still disabled.
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "60" } });
    });
    expect(addBtn).toBeDisabled();

    // Select a property from the dropdown (typing into the text
    // input alone sets `propSearch` but NOT `selProp` — the user
    // must commit a choice via the dropdown for `selProp` to be
    // populated, per the autocomplete contract).
    await act(async () => {
      fireEvent.focus(propInput);
    });
    const option = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(option);
    });
    expect(addBtn).not.toBeDisabled();

    // Clear the value → disabled again.
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "" } });
    });
    expect(addBtn).toBeDisabled();
  });
});

describe("CustomFilterBuilder — auto-name derivation", () => {
  it("(d1) for 1 rule, autoName is '<propLastSegment> <operator> <value>'", async () => {
    const fileId = "file-auto1";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    // Focus to open the dropdown, then click the option (this is
    // the only way `selProp` is populated, per the autocomplete
    // contract).
    await act(async () => {
      fireEvent.focus(propInput);
    });
    const option = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(option);
    });
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "60" } });
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // After the rule is added, the rules block + save block render.
    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-rules"),
      ).toBeInTheDocument();
    });

    const nameInput = screen.getByTestId(
      "custom-filter-builder-name-input",
    ) as HTMLInputElement;
    // The input's `placeholder` is the autoName (it's used as a
    // placeholder hint per the ifc-excel-updater pattern).
    expect(nameInput.placeholder).toBe("FireRating equals 60");
  });

  it("(d2) for N rules, autoName is '<firstProp> + N-1 more'", async () => {
    const fileId = "file-autoN";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [
        ["Pset_WallCommon", "FireRating"],
        ["Pset_WallCommon", "IsExternal"],
      ]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    // Helper: open the dropdown, click a property, fill the value,
    // click Add. Returns when the new rule pill is rendered.
    async function addRule(qualified: string, value: string): Promise<void> {
      await act(async () => {
        fireEvent.focus(propInput);
      });
      const opt = await waitFor(() =>
        screen.getByTestId(
          `custom-filter-builder-prop-option-${qualified}`,
        ),
      );
      await act(async () => {
        fireEvent.click(opt);
      });
      await act(async () => {
        fireEvent.change(valInput, { target: { value } });
      });
      await act(async () => {
        fireEvent.click(addBtn);
      });
    }

    await addRule("Pset_WallCommon.FireRating", "60");
    await addRule("Pset_WallCommon.IsExternal", "true");

    const nameInput = screen.getByTestId(
      "custom-filter-builder-name-input",
    ) as HTMLInputElement;
    expect(nameInput.placeholder).toBe("FireRating + 1 more");
  });
});

describe("CustomFilterBuilder — Save button gating", () => {
  it("(e) is disabled when activeRules.length === 0", async () => {
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-save"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // The save button lives INSIDE the save block which only renders
    // when there is at least one rule. So with zero rules, the save
    // button doesn't exist at all (this is the strictest disabled
    // state — the user can't even click it).
    expect(
      screen.queryByTestId("custom-filter-builder-save"),
    ).not.toBeInTheDocument();
  });
});

describe("CustomFilterBuilder — Escape closes", () => {
  it("(f) Escape key calls onCancel", async () => {
    const onCancel = vi.fn();
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-esc"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );

    // The Escape handler is attached to window when open=true. Fire
    // a keydown on the document/window.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Task 20C-Part 2 polish (§1: 6 new operators; §3: AND/OR warning)
// ---------------------------------------------------------------------------

describe("CustomFilterBuilder — value-agnostic operators (Task 20C-Part 2 §1)", () => {
  it("(g) is_empty rule adds without requiring a value", async () => {
    const fileId = "file-isempty";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    const onSubmit = vi.fn();
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const opSelect = screen.getByTestId(
      "custom-filter-builder-op-select",
    ) as HTMLSelectElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    // Pick a property from the dropdown.
    await act(async () => {
      fireEvent.focus(propInput);
    });
    const option = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(option);
    });

    // Switch operator to is_empty.
    await act(async () => {
      fireEvent.change(opSelect, { target: { value: "is_empty" } });
    });

    // Value input is disabled and empty.
    expect(valInput.disabled).toBe(true);
    expect(valInput.value).toBe("");

    // Add Condition is enabled because selProp is set and the
    // operator is value-agnostic.
    expect(addBtn).not.toBeDisabled();

    // Click Add — the rule should be created with value="" and the
    // rules block should render.
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-rules"),
      ).toBeInTheDocument();
    });

    // onSubmit is NOT called yet (Save filter is what triggers it).
    expect(onSubmit).not.toHaveBeenCalled();

    // The Save button is enabled because activeRules.length >= 1.
    const saveBtn = screen.getByTestId("custom-filter-builder-save");
    expect(saveBtn).not.toBeDisabled();
  });

  it("(h) value input is disabled when is_empty / is_not_empty is selected", async () => {
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-empty-h"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const opSelect = screen.getByTestId(
      "custom-filter-builder-op-select",
    ) as HTMLSelectElement;

    // Default op is "equals" — value input enabled.
    expect(valInput.disabled).toBe(false);

    await act(async () => {
      fireEvent.change(opSelect, { target: { value: "is_empty" } });
    });
    expect(valInput.disabled).toBe(true);

    // Helper text appears.
    expect(
      screen.getByTestId("custom-filter-builder-val-helper"),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(opSelect, { target: { value: "is_not_empty" } });
    });
    expect(valInput.disabled).toBe(true);

    // Back to a value-taking operator — input re-enables.
    await act(async () => {
      fireEvent.change(opSelect, { target: { value: "equals" } });
    });
    expect(valInput.disabled).toBe(false);
  });
});

describe("CustomFilterBuilder — auto-name for new operators (Task 20C-Part 2 §1)", () => {
  it("(i) auto-name for greater_than_or_equal formats correctly", async () => {
    const fileId = "file-gte";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const opSelect = screen.getByTestId(
      "custom-filter-builder-op-select",
    ) as HTMLSelectElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    // Pick property.
    await act(async () => {
      fireEvent.focus(propInput);
    });
    const option = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(option);
    });

    // greater_than_or_equal + 60.
    await act(async () => {
      fireEvent.change(opSelect, {
        target: { value: "greater_than_or_equal" },
      });
    });
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "60" } });
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // The auto-name derivation uses `replaceAll("_", " ")` so
    // multi-word operators format correctly:
    //   `greater_than_or_equal` → "greater than or equal"
    //   `is_empty`             → "is empty"
    //   `equals`               → "equals"
    const nameInput = screen.getByTestId(
      "custom-filter-builder-name-input",
    ) as HTMLInputElement;
    expect(nameInput.placeholder).toBe(
      "FireRating greater than or equal 60",
    );
  });
});

describe("CustomFilterBuilder — handleAdd guards (Task 20C-Part 2 §1)", () => {
  it("(j) handleAdd rejects non-value-agnostic operators with empty value", async () => {
    const fileId = "file-j";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const opSelect = screen.getByTestId(
      "custom-filter-builder-op-select",
    ) as HTMLSelectElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    // Pick property.
    await act(async () => {
      fireEvent.focus(propInput);
    });
    const option = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(option);
    });

    // Switch to greater_than and leave the value empty.
    await act(async () => {
      fireEvent.change(opSelect, { target: { value: "greater_than" } });
    });
    // Ensure empty.
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "" } });
    });

    // Add button must be disabled (canAdd checks selVal.trim() for
    // non-value-agnostic operators).
    expect(addBtn).toBeDisabled();

    // Try to add via click anyway — nothing should happen. The
    // rules block never renders because handleAdd early-returns.
    await act(async () => {
      fireEvent.click(addBtn);
    });

    expect(
      screen.queryByTestId("custom-filter-builder-rules"),
    ).not.toBeInTheDocument();
  });
});

describe("CustomFilterBuilder — AND/OR same-property warning (Task 20C-Part 2 §3)", () => {
  it("(k) renders the warning chip when 2+ rules target the same property", async () => {
    const fileId = "file-andor";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    async function addRule(value: string): Promise<void> {
      await act(async () => {
        fireEvent.focus(propInput);
      });
      const opt = await waitFor(() =>
        screen.getByTestId(
          "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
        ),
      );
      await act(async () => {
        fireEvent.click(opt);
      });
      await act(async () => {
        fireEvent.change(valInput, { target: { value } });
      });
      await act(async () => {
        fireEvent.click(addBtn);
      });
    }

    // First rule — no warning yet.
    await addRule("60");
    expect(
      screen.queryByTestId("same-property-warning"),
    ).not.toBeInTheDocument();

    // Second rule on the same property — warning chip appears.
    await addRule("90");
    expect(
      screen.getByTestId("same-property-warning"),
    ).toBeInTheDocument();
  });

  it("(k2) does not render the warning chip when rules target different properties", async () => {
    const fileId = "file-andor2";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [
        ["Pset_WallCommon", "FireRating"],
        ["Pset_WallCommon", "IsExternal"],
      ]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    async function addRule(qualified: string, value: string): Promise<void> {
      await act(async () => {
        fireEvent.focus(propInput);
      });
      const opt = await waitFor(() =>
        screen.getByTestId(
          `custom-filter-builder-prop-option-${qualified}`,
        ),
      );
      await act(async () => {
        fireEvent.click(opt);
      });
      await act(async () => {
        fireEvent.change(valInput, { target: { value } });
      });
      await act(async () => {
        fireEvent.click(addBtn);
      });
    }

    await addRule("Pset_WallCommon.FireRating", "60");
    await addRule("Pset_WallCommon.IsExternal", "true");

    expect(
      screen.queryByTestId("same-property-warning"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 20D — OR-group UI + editing mode + combinator pills
// ---------------------------------------------------------------------------

describe("CustomFilterBuilder — OR-group UI (Task 20D)", () => {
  it("renders a single AND group with one rule by default (create mode)", async () => {
    const fileId = "file-or-1";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    await act(async () => {
      fireEvent.focus(propInput);
    });
    const option = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(option);
    });
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "60" } });
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // One group card, combinator pill = AND.
    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-group-0"),
      ).toBeInTheDocument();
    });
    const pill = screen.getByTestId(
      "custom-filter-builder-group-0-combinator",
    );
    expect(pill.textContent).toBe("AND");

    // + OR group button is present.
    expect(
      screen.getByTestId("custom-filter-builder-add-or-group"),
    ).toBeInTheDocument();
    // + AND group button is present.
    expect(
      screen.getByTestId("custom-filter-builder-add-and-group"),
    ).toBeInTheDocument();
  });

  it("+ OR group adds a second group with OR combinator", async () => {
    const fileId = "file-or-2";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    await act(async () => {
      fireEvent.focus(propInput);
    });
    const opt = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(opt);
    });
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "60" } });
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-group-0"),
      ).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("custom-filter-builder-add-or-group"),
      );
    });

    // Now there are 2 groups; group 1 is the new OR group.
    expect(
      screen.getByTestId("custom-filter-builder-group-1"),
    ).toBeInTheDocument();
    const pill = screen.getByTestId(
      "custom-filter-builder-group-1-combinator",
    );
    expect(pill.textContent).toBe("OR");
  });

  it("toggling a group combinator pill flips AND <-> OR", async () => {
    const fileId = "file-or-3";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    await act(async () => {
      fireEvent.focus(propInput);
    });
    const opt = await waitFor(() =>
      screen.getByTestId(
        "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
      ),
    );
    await act(async () => {
      fireEvent.click(opt);
    });
    await act(async () => {
      fireEvent.change(valInput, { target: { value: "60" } });
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-group-0-combinator"),
      ).toBeInTheDocument();
    });

    const pill = screen.getByTestId(
      "custom-filter-builder-group-0-combinator",
    );
    expect(pill.textContent).toBe("AND");

    await act(async () => {
      fireEvent.click(pill);
    });
    expect(pill.textContent).toBe("OR");

    await act(async () => {
      fireEvent.click(pill);
    });
    expect(pill.textContent).toBe("AND");
  });

  it("same-property warning does NOT fire for repeated properties in an OR group", async () => {
    // The filter-parity trap: a user builds
    //   group-1: FireRating = 60 OR FireRating = 90
    // This is legitimate OR composition; the warning must NOT fire.
    const fileId = "file-or-warn";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    async function addRule(value: string): Promise<void> {
      await act(async () => {
        fireEvent.focus(propInput);
      });
      const opt = await waitFor(() =>
        screen.getByTestId(
          "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
        ),
      );
      await act(async () => {
        fireEvent.click(opt);
      });
      await act(async () => {
        fireEvent.change(valInput, { target: { value } });
      });
      await act(async () => {
        fireEvent.click(addBtn);
      });
    }

    // First rule (defaults to AND-group).
    await addRule("60");
    // Flip the group to OR, then add the second rule.
    const pill = await waitFor(() =>
      screen.getByTestId("custom-filter-builder-group-0-combinator"),
    );
    await act(async () => {
      fireEvent.click(pill);
    });
    expect(pill.textContent).toBe("OR");
    await addRule("90");

    expect(
      screen.queryByTestId("same-property-warning"),
    ).not.toBeInTheDocument();
  });

  it("same-property warning copy mentions OR group + in operator", async () => {
    const fileId = "file-warn-copy";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_WallCommon", "FireRating"]]),
    );

    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId={fileId}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const propInput = screen.getByTestId(
      "custom-filter-builder-prop-input",
    ) as HTMLInputElement;
    const valInput = screen.getByTestId(
      "custom-filter-builder-val-input",
    ) as HTMLInputElement;
    const addBtn = screen.getByTestId("custom-filter-builder-add");

    async function addRule(value: string): Promise<void> {
      await act(async () => {
        fireEvent.focus(propInput);
      });
      const opt = await waitFor(() =>
        screen.getByTestId(
          "custom-filter-builder-prop-option-Pset_WallCommon.FireRating",
        ),
      );
      await act(async () => {
        fireEvent.click(opt);
      });
      await act(async () => {
        fireEvent.change(valInput, { target: { value } });
      });
      await act(async () => {
        fireEvent.click(addBtn);
      });
    }

    await addRule("60");
    await addRule("90"); // same property — fires warning
    const warn = await waitFor(() =>
      screen.getByTestId("same-property-warning"),
    );
    // New copy mentions both affordances.
    expect(warn.textContent).toMatch(/OR group/);
    expect(warn.textContent).toMatch(/in operator/);
  });
});

describe("CustomFilterBuilder — editing mode (Task 20D)", () => {
  it("header text reads 'Edit filter' when editingPreset is supplied", async () => {
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-edit-1"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        editingPreset={{
          id: "preset-edit-1",
          name: "My filter",
          combinator: "AND",
          groups: [
            {
              id: "g1",
              combinator: "AND",
              rules: [
                {
                  id: "r1",
                  property: "Pset_WallCommon.FireRating",
                  operator: "equals",
                  value: "60",
                },
              ],
            },
          ],
        }}
      />,
    );
    const title = await waitFor(() =>
      screen.getByTestId("custom-filter-builder-title"),
    );
    expect(title.textContent).toBe("Edit filter");
  });

  it("save button label flips to 'Update filter' in edit mode", async () => {
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-edit-2"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        editingPreset={{
          id: "preset-edit-2",
          name: "My filter",
          combinator: "AND",
          groups: [
            {
              id: "g1",
              combinator: "AND",
              rules: [
                {
                  id: "r1",
                  property: "Pset_WallCommon.FireRating",
                  operator: "equals",
                  value: "60",
                },
              ],
            },
          ],
        }}
      />,
    );
    const saveBtn = await waitFor(() =>
      screen.getByTestId("custom-filter-builder-save"),
    );
    expect(saveBtn.textContent).toBe("Update filter");
  });

  it("hydrates activeGroups from editingPreset.groups on open", async () => {
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-edit-3"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        editingPreset={{
          id: "preset-edit-3",
          name: "X",
          combinator: "AND",
          groups: [
            {
              id: "g1",
              combinator: "AND",
              rules: [
                {
                  id: "r1",
                  property: "Pset_WallCommon.FireRating",
                  operator: "equals",
                  value: "60",
                },
              ],
            },
          ],
        }}
      />,
    );
    // The rules block renders immediately on edit (because
    // editingPreset has 1 rule).
    await waitFor(() => {
      expect(
        screen.getByTestId("custom-filter-builder-rules"),
      ).toBeInTheDocument();
    });
    // The rule pill is rendered.
    expect(
      screen.getByTestId("custom-filter-builder-rule-r1"),
    ).toBeInTheDocument();
  });

  it("submitted preset preserves editingPreset.id", async () => {
    const onSubmit = vi.fn();
    renderWithDataSource(
      <CustomFilterBuilder
        open
        fileId="file-edit-4"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        editingPreset={{
          id: "preset-preserve",
          name: "Original",
          combinator: "AND",
          groups: [
            {
              id: "g1",
              combinator: "AND",
              rules: [
                {
                  id: "r1",
                  property: "Pset_WallCommon.FireRating",
                  operator: "equals",
                  value: "60",
                },
              ],
            },
          ],
        }}
      />,
    );
    const saveBtn = await waitFor(() =>
      screen.getByTestId("custom-filter-builder-save"),
    );
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0]![0] as {
      id: string;
      name: string;
      combinator: string;
      groups: unknown[];
    };
    expect(submitted.id).toBe("preset-preserve");
    expect(submitted.name).toBe("Original");
  });
});
