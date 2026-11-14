// apps/settings — wave 63 "Sign out": clears the project choice, the
// sign-in email key and the IndexedDB tile cache.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }));

vi.mock("@ff/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/auth")>();
  return {
    ...actual,
    isDemoAuth: () => false,
    useAuth: () => ({
      user: { uid: "u1", email: "u1@x.test", emailVerified: true, claims: {} },
      loading: false,
      signOut: h.signOut,
    }),
    useRole: () => "viewer",
  };
});

import LeftRail from "@shell/LeftRail";
import { PROJECT_CHOICE_KEY } from "@shell/projectChoice";
import {
  TILE_CACHE_DB_NAME,
  TILE_CACHE_PURGE_PENDING_KEY,
  purgeTileCache,
  resumePendingTileCachePurge,
  signOutAndClear,
} from "@shell/signOut";

async function createTileCacheDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(TILE_CACHE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tiles");
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

async function tileCacheExists(): Promise<boolean> {
  const dbs = await indexedDB.databases();
  return dbs.some((d) => d.name === TILE_CACHE_DB_NAME);
}

beforeEach(() => {
  localStorage.clear();
  h.signOut.mockClear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("signOutAndClear", () => {
  it("signs out and clears the choice, the email key and the tile cache", async () => {
    await createTileCacheDb();
    localStorage.setItem(PROJECT_CHOICE_KEY, "p1");
    localStorage.setItem("emailForSignIn", "u1@x.test");

    await signOutAndClear(h.signOut);

    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();
    expect(localStorage.getItem("emailForSignIn")).toBeNull();
    expect(await tileCacheExists()).toBe(false);
    expect(localStorage.getItem(TILE_CACHE_PURGE_PENDING_KEY)).toBeNull();
  });

  it("still clears local state when the sign-out call fails", async () => {
    await createTileCacheDb();
    localStorage.setItem(PROJECT_CHOICE_KEY, "p1");
    const failing = vi.fn(async () => {
      throw new Error("network");
    });

    await expect(signOutAndClear(failing)).rejects.toThrow("network");

    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();
    expect(await tileCacheExists()).toBe(false);
  });

  it("keeps the purge pending while a connection blocks the delete, and resumes it on boot", async () => {
    // Hold a connection open that ignores versionchange → delete blocks.
    const held = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open(TILE_CACHE_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("tiles");
      req.onsuccess = () => resolve(req.result);
    });
    localStorage.setItem(TILE_CACHE_PURGE_PENDING_KEY, "1");

    expect(await purgeTileCache(50)).toBe(false);
    expect(localStorage.getItem(TILE_CACHE_PURGE_PENDING_KEY)).toBe("1");

    held.close();
    await waitFor(async () => expect(await tileCacheExists()).toBe(false));
    // Next boot: nothing left to do, the flag is cleared.
    localStorage.setItem(TILE_CACHE_PURGE_PENDING_KEY, "1");
    expect(await resumePendingTileCachePurge()).toBe(true);
    expect(localStorage.getItem(TILE_CACHE_PURGE_PENDING_KEY)).toBeNull();
  });
});

describe("<LeftRail> Sign out", () => {
  it("shows a Sign out button in real mode that signs out and clears the choice", async () => {
    localStorage.setItem(PROJECT_CHOICE_KEY, "p1");
    render(
      <MemoryRouter initialEntries={["/documents"]}>
        <LeftRail />
      </MemoryRouter>,
    );
    const button = screen.getByTestId("left-rail-icon-sign-out");
    fireEvent.click(button);
    await waitFor(() => expect(h.signOut).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();
  });
});
