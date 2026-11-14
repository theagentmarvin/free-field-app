// Wave 64 — the shell's "database updated in another tab" banner
// replaces @ff/data's confirm() fallback.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { installDatabaseLifecycle } from "@ff/data/db/database";
import {
  DB_BLOCKED_MESSAGE,
  DB_UPDATED_MESSAGE,
  DatabaseUpdateBanner,
} from "@shell/DatabaseUpdateBanner";

type Handler = (e?: unknown) => unknown;

/** A stand-in Dexie target: captures the lifecycle handlers. */
function fakeDexie() {
  const handlers: Record<string, Handler> = {};
  const target = {
    on: (name: string, cb: Handler) => {
      handlers[name] = cb;
    },
    close: vi.fn(),
  };
  installDatabaseLifecycle(target as never);
  return { handlers, target };
}

afterEach(() => cleanup());

describe("<DatabaseUpdateBanner>", () => {
  it("shows a Reload banner on versionchange instead of confirm()", () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    const reload = vi.fn();
    const { handlers, target } = fakeDexie();
    render(<DatabaseUpdateBanner reload={reload} />);
    expect(screen.queryByTestId("db-update-banner")).toBeNull();

    act(() => {
      handlers.versionchange?.({ newVersion: 12 });
    });
    expect(target.close).toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("db-update-banner")).toHaveTextContent(DB_UPDATED_MESSAGE);

    fireEvent.click(screen.getByTestId("db-update-reload"));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("shows the blocked notice (no Reload) and can be dismissed", () => {
    const { handlers } = fakeDexie();
    render(<DatabaseUpdateBanner reload={vi.fn()} />);
    act(() => {
      handlers.blocked?.();
    });
    expect(screen.getByTestId("db-update-banner")).toHaveTextContent(DB_BLOCKED_MESSAGE);
    expect(screen.queryByTestId("db-update-reload")).toBeNull();
    fireEvent.click(screen.getByTestId("db-update-dismiss"));
    expect(screen.queryByTestId("db-update-banner")).toBeNull();
  });

  it("unsubscribes on unmount (the confirm() fallback is restored)", () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    const { handlers } = fakeDexie();
    const { unmount } = render(<DatabaseUpdateBanner reload={vi.fn()} />);
    unmount();
    handlers.versionchange?.({ newVersion: 12 });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
