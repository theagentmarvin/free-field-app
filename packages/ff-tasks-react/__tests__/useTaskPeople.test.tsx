// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const getDocs = vi.fn();
const getDoc = vi.fn();

vi.mock("firebase/firestore", () => ({
  getDoc: (...a: unknown[]) => getDoc(...a),
  getDocs: (...a: unknown[]) => getDocs(...a),
  query: (...a: unknown[]) => a,
  where: (...a: unknown[]) => a,
}));
vi.mock("@ff/firestore", () => ({
  membersCollection: () => "members",
  userDoc: (_db: unknown, uid: string) => ({ uid }),
}));
vi.mock("@ff/auth", () => ({ useAuth: () => ({ user: { uid: "u1", email: "a@b.c" } }) }));

import { useTaskPeople } from "../src/useTaskPeople";

beforeEach(() => {
  getDocs.mockReset();
  getDoc.mockReset();
  getDoc.mockImplementation(async (ref: { uid: string }) => ({
    data: () => ({ displayName: `Name ${ref.uid}` }),
  }));
  getDocs.mockResolvedValue({ docs: [{ id: "u1" }, { id: "u2" }] });
});

describe("useTaskPeople (cloud)", () => {
  it("loads active members on its own, without ensureMembers()", async () => {
    const db = {} as never;
    const { result } = renderHook(() => useTaskPeople(db, "p1"));
    expect(result.current.members).toBeNull();
    await waitFor(() => expect(result.current.members).not.toBeNull());
    expect(result.current.members).toEqual([
      { uid: "u1", name: "Name u1" },
      { uid: "u2", name: "Name u2" },
    ]);
    expect(getDocs).toHaveBeenCalledTimes(1);
  });

  it("stays null (no crash) when the roster read fails", async () => {
    getDocs.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTaskPeople({} as never, "p1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.members).toBeNull();
  });

  it("demo mode (null db) returns the demo roster and never reads", () => {
    const { result } = renderHook(() => useTaskPeople(null, undefined));
    expect(result.current.members?.length).toBeGreaterThan(0);
    expect(getDocs).not.toHaveBeenCalled();
  });
});
