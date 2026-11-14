// Entry route: a fresh load of the bare app root opens in Models.
import { describe, expect, it, vi } from "vitest";

import { ENTRY_ROUTE, redirectEntryToModels } from "../../src/shell/entryRoute";

function fakeHistory() {
  return { state: { k: 1 }, replaceState: vi.fn() };
}

describe("redirectEntryToModels", () => {
  it("rewrites / to /models without adding a history entry", () => {
    const history = fakeHistory();
    const done = redirectEntryToModels(
      { pathname: "/", search: "", hash: "" },
      history,
    );
    expect(done).toBe(true);
    expect(ENTRY_ROUTE).toBe("/models");
    expect(history.replaceState).toHaveBeenCalledWith({ k: 1 }, "", "/models");
  });

  it("keeps query string and hash (e.g. dev tools like ?ff-export-seed=1)", () => {
    const history = fakeHistory();
    redirectEntryToModels(
      { pathname: "/", search: "?ff-export-seed=1", hash: "#x" },
      history,
    );
    expect(history.replaceState).toHaveBeenCalledWith(
      { k: 1 },
      "",
      "/models?ff-export-seed=1#x",
    );
  });

  it.each(["/models", "/documents", "/users", "/finish-sign-in", "/sign-in"])(
    "leaves %s alone",
    (pathname) => {
      const history = fakeHistory();
      expect(
        redirectEntryToModels({ pathname, search: "", hash: "" }, history),
      ).toBe(false);
      expect(history.replaceState).not.toHaveBeenCalled();
    },
  );
});
