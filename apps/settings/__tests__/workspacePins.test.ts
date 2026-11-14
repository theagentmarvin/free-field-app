// @vitest-environment node
// Wave 64 — dependency pins (docs/integration/2026-11-13-w63-settings-pins-request.md).
//
// - `@thatopen/fragments` must be EXACT 3.6.0 everywhere: pnpm-workspace
//   patches 3.6.0 only, and a caret range could resolve a later 3.6.x
//   that silently drops the FreeField patch.
// - `typescript` must be exact 5.6.3 everywhere (one compiler per repo).
// - `react-firebase-hooks` stays removed (nothing imports it).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");

function workspaceManifests(): Array<{ dir: string; pkg: Record<string, Record<string, string>> }> {
  const dirs = ["."];
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(root, group))) {
      if (existsSync(join(root, group, name, "package.json"))) dirs.push(`${group}/${name}`);
    }
  }
  return dirs.map((dir) => ({
    dir,
    pkg: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")),
  }));
}

function deps(pkg: Record<string, Record<string, string>>): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
}

describe("workspace dependency pins", () => {
  const manifests = workspaceManifests();

  it("pins @thatopen/fragments to exactly 3.6.0", () => {
    const bad = manifests
      .filter(({ pkg }) => deps(pkg)["@thatopen/fragments"] !== undefined)
      .filter(({ pkg }) => deps(pkg)["@thatopen/fragments"] !== "3.6.0")
      .map(({ dir, pkg }) => `${dir}: ${deps(pkg)["@thatopen/fragments"]}`);
    expect(bad).toEqual([]);
  });

  it("pins typescript to exactly 5.6.3", () => {
    const bad = manifests
      .filter(({ pkg }) => deps(pkg).typescript !== undefined)
      .filter(({ pkg }) => deps(pkg).typescript !== "5.6.3")
      .map(({ dir, pkg }) => `${dir}: ${deps(pkg).typescript}`);
    expect(bad).toEqual([]);
  });

  it("resolves a single TypeScript version in the lockfile", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const versions = new Set([...lock.matchAll(/\btypescript@(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
    expect([...versions]).toEqual(["5.6.3"]);
  });

  it("does not depend on react-firebase-hooks", () => {
    const users = manifests.filter(({ pkg }) => deps(pkg)["react-firebase-hooks"] !== undefined);
    expect(users.map((m) => m.dir)).toEqual([]);
  });
});
