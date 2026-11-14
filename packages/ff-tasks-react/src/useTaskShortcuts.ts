import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts for the Tasks list. `resolveShortcut` is pure (the
 * hook only feeds it key events) so every rule is unit-testable.
 *
 *   N new task · / or Ctrl/Cmd+K search · J/K next/previous row ·
 *   Enter open · E edit · X select row · Esc clear · ? cheat-sheet
 *
 * Single-key shortcuts never fire while typing in a field, with a
 * modifier held, or while a sheet/dialog is open (`blocked`).
 */

export type ShortcutAction =
  | "new"
  | "search"
  | "next"
  | "prev"
  | "open"
  | "edit"
  | "toggle-select"
  | "escape"
  | "help";

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

export interface ShortcutContext {
  /** a sheet / dialog / popover owns the keyboard */
  blocked: boolean;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "button" || tag === "a" || el.getAttribute?.("role") === "button";
}

export function resolveShortcut(e: ShortcutKeyEvent, ctx: ShortcutContext): ShortcutAction | null {
  const key = e.key;
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "k") return ctx.blocked ? null : "search";
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (ctx.blocked) return null;
  if (isTypingTarget(e.target)) return null;
  switch (key) {
    case "n":
    case "N":
      return "new";
    case "/":
      return "search";
    case "j":
    case "J":
      return "next";
    case "k":
    case "K":
      return "prev";
    case "e":
    case "E":
      return "edit";
    case "x":
    case "X":
      return "toggle-select";
    case "Enter":
      return isInteractiveTarget(e.target) ? null : "open";
    case "?":
      return "help";
    case "Escape":
      return "escape";
    default:
      return null;
  }
}

export function useTaskShortcuts(
  handler: (action: ShortcutAction, e: KeyboardEvent) => void,
  ctx: ShortcutContext
): void {
  const h = useRef(handler);
  h.current = handler;
  const blocked = useRef(ctx.blocked);
  blocked.current = ctx.blocked;
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.defaultPrevented) return;
      const action = resolveShortcut(e, { blocked: blocked.current });
      if (!action) return;
      h.current(action, e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export const SHORTCUT_HELP: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ["N"], label: "New task" },
  { keys: ["/", "Ctrl+K"], label: "Search" },
  { keys: ["J", "K"], label: "Next / previous task" },
  { keys: ["Enter"], label: "Open the focused task" },
  { keys: ["E"], label: "Open the focused task and edit it" },
  { keys: ["X"], label: "Select / deselect the focused task" },
  { keys: ["Esc"], label: "Close · clear selection · clear focus" },
  { keys: ["Alt+←", "Alt+→"], label: "Board: move the focused card between columns" },
  { keys: ["Shift+Click"], label: "Table: select a range of rows" },
  { keys: ["?"], label: "Show this cheat-sheet" },
];
