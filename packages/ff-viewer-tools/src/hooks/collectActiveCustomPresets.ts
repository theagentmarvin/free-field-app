// apps/models/src/hooks/collectActiveCustomPresets.ts
//
// Task 23 — extract the "collect active custom presets" helper
// from `useModelsToolFilter` so the new `useViewerExpressIdMaps`
// can use it too. The two hooks need the same active-preset
// list (one to resolve visibility, the other to populate
// `customToExpressIds`); sharing the helper keeps the
// active/hidden semantics in one place.
//
// An "active" preset is one whose leaf id appears in its
// parent group's `customActive` set AND is NOT in the
// corresponding `customHidden` set (the eye-off toggles win
// over the funnel-on toggles — same precedence as the auto
// folders).
//
// Returns an array of `FilterPreset` — the order is "leftmost
// leaf first" (depth-first walk of the customTree), which is
// the order they appear in the sidebar. Order doesn't affect
// AND-joined results, but for OR-joined presets it does affect
// WHICH matching preset wins (irrelevant for visibility since
// the result is the union of express IDs, but documented for
// clarity).

import type { FilterPreset } from "../modelsToolStore";
import { useModelsToolStore } from "../modelsToolStore";

export function collectActiveCustomPresets(): FilterPreset[] {
  const state = useModelsToolStore.getState();
  const out: FilterPreset[] = [];
  const visit = (
    folderId: string,
    children: ReadonlyArray<{
      id: string;
      kind: "user" | "filter";
      preset?: FilterPreset;
    }>,
  ): void => {
    const active = state.filters.customActive.get(folderId);
    const hidden = state.filters.customHidden.get(folderId);
    for (const child of children) {
      if (child.kind !== "filter") continue;
      // A leaf is "active" if the parent group has it in
      // customActive (or the group has empty active — wildcard
      // for the group — see filterResolution.ts §3). Hidden
      // wins over active.
      const isActive =
        active === undefined ||
        active.size === 0 ||
        active.has(child.id);
      const isHidden = hidden?.has(child.id) ?? false;
      if (!isActive || isHidden) continue;
      if (child.preset) out.push(child.preset);
    }
  };
  // Walk the tree depth-first. The top-level customTree carries
  // the leaves for each root folder; nested folders re-enter via
  // `visit` on their `children`. We don't care about folder
  // structure here — just the leaves.
  const walk = (
    folders: ReadonlyArray<{
      id: string;
      kind: "user";
      children: ReadonlyArray<{
        id: string;
        kind: "user" | "filter";
        children?: ReadonlyArray<unknown>;
        preset?: FilterPreset;
      }>;
    }>,
  ): void => {
    for (const folder of folders) {
      if (folder.kind !== "user") continue;
      // Collect direct filter leaves + recurse into sub-folders.
      const leaves = folder.children.filter((c) => c.kind === "filter");
      visit(folder.id, leaves);
      const subFolders = folder.children.filter(
        (c): c is typeof folder => c.kind === "user",
      );
      walk(subFolders);
    }
  };
  walk(state.filters.customTree);
  return out;
}
